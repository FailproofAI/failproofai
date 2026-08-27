/**
 * Loads user-authored policy files with ESM import rewriting.
 * Supports transitive local imports and `import { ... } from 'failproofai'`.
 *
 * Two loading modes:
 * 1. Explicit: files via `customPoliciesPaths` in policies-config.json
 * 2. Convention: auto-discovered *policies.{js,mjs,ts} files from
 *    .failproofai/policies/ at project and user level (git-hooks style)
 *
 * Fail-open: any error (file not found, syntax error, import failure) is logged
 * and results in an empty hook list for that file. Builtins continue normally.
 */
import { resolve, isAbsolute, basename } from "node:path";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { hookLogWarn, hookLogError, hookLogInfo } from "./hook-logger";
import { customPolicies, getCustomHooks, clearCustomHooks } from "./custom-hooks-registry";
import {
  findDistIndex,
  rewriteFileTree,
  TMP_SUFFIX,
  cleanupTmpFiles,
  isTmpArtifact,
  sweepStaleTmpArtifacts,
} from "./loader-utils";
import { findProjectConfigDir } from "./hooks-config";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import type { CustomHook, PolicyCatalogEntry } from "./policy-types";
import type { CloudManagedPolicyArtifact } from "./cloud-managed-policies";
import type { ResolvedPack } from "./pack-manifest";
import { customPoliciesDir, shimsDir } from "./fp-home";

const LOADING_KEY = "__FAILPROOFAI_LOADING_HOOKS__";

/** Regex matching convention policy filenames: *policies.{js,mjs,ts} */
const CONVENTION_FILE_RE = /policies\.(js|mjs|ts)$/;

/** Monotonic suffix for physically distinct temporary module trees. Bun
 * ignores URL query strings when caching imports, so a query-only cache
 * buster silently drops custom policies after the first request in the warm
 * daemon worker. A unique filename is honored by both Bun and Node. */
let loadSequence = 0;

interface CachedPolicyModule {
  fingerprint: string;
  hooks: CustomHook[];
}

/** One retained module instance per source entry. Reusing its registered hook
 * functions prevents an unbounded ESM module-cache leak in the resident worker.
 * A source-tree change replaces this entry and imports one new module. */
const policyModuleCache = new Map<string, CachedPolicyModule>();
/**
 * Cap, for the reason `gitBranchCache` states and this cache did not carry
 * over: a warm worker touching many projects over its lifetime must not grow
 * this unboundedly. Keyed by absolute policy-file path and holding cloned hook
 * closures, so the entries are not small. Cleared wholesale rather than evicted
 * one at a time — the next load simply re-imports, which is the same cost the
 * cache exists to avoid paying twice, not a correctness change.
 */
const POLICY_MODULE_CACHE_MAX_ENTRIES = 500;

/** Script extensions we could load, used to spot near-miss filenames. */
const LOADABLE_EXT_RE = /\.(js|mjs|ts)$/;

/**
 * Scan a directory for convention policy files (*policies.{js,mjs,ts}).
 * Returns sorted absolute paths. Returns [] if the directory doesn't exist.
 */
export function discoverPolicyFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && CONVENTION_FILE_RE.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => resolve(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Script files sitting in a policies directory that the convention will NOT
 * load, because the name doesn't end in `policies.{js,mjs,ts}`.
 *
 * The failure this exists for is silent and total: a file in exactly the right
 * directory, exporting exactly the right thing, named `block-foo.mjs` instead
 * of `block-foo-policies.mjs`, is skipped with no warning — it looks installed
 * and enforces nothing. This repo shipped `block-version-bumps.mjs` that way,
 * so the guard written after a bad version bump had never once run. Callers
 * surface these as a warning rather than loading them, since a file that opts
 * out of the naming convention may well not be a policy file at all.
 */
export function findSkippedPolicyFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          LOADABLE_EXT_RE.test(e.name) &&
          !CONVENTION_FILE_RE.test(e.name) &&
          !e.name.endsWith(".d.ts") &&
          // Never our own generated files. They are `.mjs` and never match the
          // convention, so each one a killed load left behind was reported to
          // the user as a policy file that would not load.
          !isTmpArtifact(e.name),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * How long a policy module gets to finish evaluating its top level.
 *
 * Matches the 10s `handler.ts` gives a policy's `fn` to run, for the same
 * reason: a policy file is user code, and user code that hangs must cost one
 * skipped policy rather than the process.
 *
 * `FAILPROOFAI_POLICY_LOAD_TIMEOUT_MS` shortens it for tests — a suite proving
 * the deadline fires should not have to sit out the real one.
 */
function moduleLoadTimeoutMs(): number {
  const override = Number(process.env.FAILPROOFAI_POLICY_LOAD_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 10_000;
}

/**
 * `import()`, but it cannot hang forever.
 *
 * A bare `await import(...)` on a module whose top level contains an `await`
 * that never resolves never settles — it does not reject, so no `catch` and no
 * `finally` anywhere above it ever runs. In the one-shot hook path that costs
 * one hook process, which the agent CLI's own timeout reaps. In the warm daemon
 * worker it holds `worker-server.ts`'s serialization chain forever, and every
 * subsequent hook on the machine queues behind it and fail-closed denies.
 *
 * Losing the race does NOT cancel the import — nothing can. It stops us
 * *waiting* on it, which is the part that matters, and the caller's `catch`
 * below reports the file as failed to load. The abandoned module keeps its
 * half-initialized entry in the ESM cache, but each load writes a uniquely
 * named temporary tree, so a retry imports a different specifier and is never
 * poisoned by it.
 */
async function importWithDeadline(fileUrl: string): Promise<void> {
  const budget = moduleLoadTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      import(/* webpackIgnore: true */ fileUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out loading module after ${budget}ms`)),
          budget,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load a single policy file into the globalThis custom hooks registry.
 * Does NOT clear the registry — caller is responsible for that.
 */
export interface PolicyLoadFailure {
  type: "module_not_found" | "syntax_error" | "load_timeout" | "runtime_error" | "path_missing";
  reason: string;
}

async function loadSingleFile(
  absPath: string,
  opts?: {
    strict?: boolean;
    conventionScope?: "project" | "user";
    /** Cloud-managed policies pass their pinned digest for load-time re-verification. */
    verifyEntrySha?: string;
  },
): Promise<PolicyLoadFailure | null> {
  const g = globalThis as Record<string, unknown>;
  g[LOADING_KEY] = true;

  let tmpFiles: string[] = [];
  try {
    const distIndex = await findDistIndex();
    const distUrl = distIndex ? pathToFileURL(distIndex).href : null;

    const sequence = ++loadSequence;
    // pid + sequence is not unique enough on its own: two containers sharing a
    // mounted HOME, or two pid namespaces, can collide — and on the shim's
    // fallback path a collision means EEXIST, which fails the load OPEN. A
    // random id removes the class. It costs nothing: `fingerprintTemporaryTree`
    // normalises the whole suffix away, so the module cache still hits.
    const tmpSuffix = `${TMP_SUFFIX}.${process.pid}.${sequence}.${randomUUID()}.mjs`;
    tmpFiles = await rewriteFileTree(
      absPath,
      distUrl,
      distIndex,
      tmpSuffix,
      opts?.verifyEntrySha,
    );

    const fingerprint = await fingerprintTemporaryTree(tmpFiles, tmpSuffix);
    const cached = policyModuleCache.get(absPath);
    if (cached?.fingerprint === fingerprint) {
      for (const hook of cached.hooks) customPolicies.add({ ...hook });
      return null;
    }

    const entryTmp = absPath + tmpSuffix;
    const fileUrl = pathToFileURL(entryTmp).href;
    const hooksBefore = getCustomHooks().length;
    await importWithDeadline(fileUrl);
    if (policyModuleCache.size >= POLICY_MODULE_CACHE_MAX_ENTRIES) policyModuleCache.clear();
    policyModuleCache.set(absPath, {
      fingerprint,
      hooks: getCustomHooks()
        .slice(hooksBefore)
        .map((hook) => ({ ...hook })),
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorType = /Cannot find module|MODULE_NOT_FOUND|ENOENT/i.test(msg)
      ? "module_not_found"
      : /SyntaxError|Unexpected token/i.test(msg)
        ? "syntax_error"
        : /timed out loading module/i.test(msg)
          ? "load_timeout"
          : "runtime_error";
    void trackHookEvent(getInstanceId(), "custom_hooks_load_error", {
      error_type: errorType,
      is_convention: !!opts?.conventionScope,
      convention_scope: opts?.conventionScope ?? null,
      file_basename: basename(absPath),
    });
    if (opts?.strict) throw new Error(`Failed to load custom hooks from ${absPath}: ${msg}`);
    hookLogError(`failed to load custom hooks from ${absPath}: ${msg}`);
    return { type: errorType, reason: msg };
  } finally {
    g[LOADING_KEY] = false;
    await cleanupTmpFiles(tmpFiles);
  }
}

async function fingerprintTemporaryTree(tmpFiles: string[], tmpSuffix: string): Promise<string> {
  const hash = createHash("sha256");
  for (const tmpFile of [...tmpFiles].sort()) {
    // The generated filenames change per load. Normalize both the logical path
    // and rewritten import specifiers so identical source graphs hash equally.
    hash.update(tmpFile.replaceAll(tmpSuffix, TMP_SUFFIX));
    const contents = await readFile(tmpFile, "utf8");
    hash.update(contents.replaceAll(tmpSuffix, TMP_SUFFIX));
  }
  return hash.digest("hex");
}

/**
 * Load a single explicit custom hooks file (legacy API).
 * Clears the registry, loads the file, returns registered hooks.
 */
export async function loadCustomHooks(
  customPoliciesPath: string | undefined,
  opts?: { strict?: boolean; sessionCwd?: string },
): Promise<CustomHook[]> {
  if (!customPoliciesPath) return [];

  const absPath = isAbsolute(customPoliciesPath)
    ? customPoliciesPath
    : resolve(opts?.sessionCwd ?? process.cwd(), customPoliciesPath);

  if (!existsSync(absPath)) {
    if (opts?.strict) throw new Error(`Custom hooks file not found: ${absPath}`);
    hookLogWarn(`customPoliciesPath not found: ${absPath}`);
    return [];
  }

  clearCustomHooks();
  await loadSingleFile(absPath, opts);
  return getCustomHooks();
}

/** Source metadata for a loaded convention policy file. */
export interface ConventionSource {
  scope: "project" | "user";
  file: string;
  hookNames: string[];
}

/** Result of loadAllCustomHooks with source metadata. */
export interface LoadAllResult {
  hooks: CustomHook[];
  conventionSources: ConventionSource[];
  /** Import failures keyed by pack id, including artifacts that registered no hooks. */
  packFailures: Map<string, PolicyLoadFailure>;
}

export function customPolicyId(file: string, name: string): string {
  return `custom:${file}:${name}`;
}

export function conventionPolicyId(scope: "project" | "user", file: string, name: string): string {
  return `convention:${scope}:${file}:${name}`;
}

/**
 * Load ALL custom hooks: explicit customPoliciesPath + convention-discovered files.
 *
 * Load order:
 * 1. Explicit customPoliciesPath (if configured)
 * 2. Project convention: {cwd}/.failproofai/policies/*policies.{js,mjs,ts} (alphabetical)
 * 3. User convention: ~/.failproofai/policies/*policies.{js,mjs,ts} (alphabetical)
 *
 * Each file is loaded independently (fail-open per file).
 * Convention hooks are tagged with __conventionScope so the handler can build scoped prefixes.
 */
/**
 * Warn once per directory about script files the naming convention will skip.
 * Fires on the hook path, so it must stay cheap (one readdir) and must never
 * throw — a warning is not worth failing a tool call over.
 */
function warnSkippedPolicyFiles(dir: string, scope: "project" | "user"): void {
  const skipped = findSkippedPolicyFiles(dir);
  if (skipped.length === 0) return;
  const suggest = (n: string) => n.replace(/\.(js|mjs|ts)$/, "-policies.$1");
  hookLogWarn(
    `${scope} policies: ${skipped.length} file(s) in ${dir} are NOT loaded — ` +
      `the convention only loads names ending in "policies.js|mjs|ts". ` +
      skipped.map((n) => `${n} → rename to ${suggest(n)}`).join("; "),
  );
}

/**
 * A pack's manifest declares what it contains; its artifact decides what runs.
 * Nothing binds the two, so they can disagree — and the disagreement is silent
 * in both directions and worse in one.
 *
 * A policy the artifact registers but the manifest omits is enforcement that no
 * `failproofai policies` listing will ever show. A policy the manifest declares
 * but the artifact never registers is the dangerous one: the listing says the
 * machine is protected against something nothing is checking.
 *
 * Both are announced rather than corrected. The artifact is digest-pinned, so
 * what it registers IS what the publisher shipped and dropping any of it would
 * be inventing a third answer; the manifest is what needs fixing, upstream.
 */
function reconcilePackManifest(pack: ResolvedPack | undefined, loaded: CustomHook[]): void {
  if (!pack || pack.policies.length === 0) return;
  const declared = new Set(pack.policies.map((p) => p.name));
  const registered = new Set(loaded.map((h) => h.name));
  const missing = [...declared].filter((n) => !registered.has(n));
  const extra = [...registered].filter((n) => !declared.has(n));
  if (missing.length > 0) {
    hookLogWarn(
      `pack ${pack.id}@${pack.version} declares ${missing.join(", ")} but its artifact does not ` +
        `register ${missing.length === 1 ? "it" : "them"} — listed as protection that never runs`,
    );
  }
  if (extra.length > 0) {
    hookLogWarn(
      `pack ${pack.id}@${pack.version} registers undeclared ${extra.join(", ")} — ` +
        `${extra.length === 1 ? "it enforces" : "they enforce"} but will not appear in listings`,
    );
  }
}

export async function loadAllCustomHooks(
  customPoliciesPaths: string | string[] | undefined,
  opts?: {
    sessionCwd?: string;
    customPoliciesEnabled?: boolean;
    cloudManagedPolicies?: CloudManagedPolicyArtifact[];
    packs?: ResolvedPack[];
  },
): Promise<LoadAllResult> {
  clearCustomHooks();

  const conventionSources: ConventionSource[] = [];
  const packFailures = new Map<string, PolicyLoadFailure>();

  const projectRoot = findProjectConfigDir(opts?.sessionCwd ?? process.cwd());

  // Convention discovery can be switched off from config without renaming or
  // deleting anything. Absent means on, so dropping a file in works with no
  // config at all and upgrades don't silently disable anyone's rules. An
  // explicit `customPoliciesPath` is NOT gated by this: that one was named on
  // purpose, so switching off *discovery* shouldn't silently drop it too.
  const conventionEnabled = opts?.customPoliciesEnabled !== false;

  // Every file already imported this call, by resolved absolute path. Loading
  // one twice is never right: `customPolicies.add` is an unconditional push, so
  // the second import registers every hook a second time and the policy runs
  // twice per event. Seeded by the explicit path below and consulted by both
  // convention passes.
  const loadedPaths = new Set<string>();

  // Cloud policies keyed by the artifact they resolve to — and artifacts are
  // CONTENT-ADDRESSED, so two policies whose source is byte-identical share one
  // path. Building this map with a plain `new Map(entries)` let the last one win
  // silently, and since `loadedPaths` then loads that file exactly once, the
  // other policy vanished: its id never appeared in `failproofai policies` or in
  // the decision log, and — the part that matters — ITS EFFECT DECIDED NOTHING.
  // An `enforce` policy sharing bytes with an `observe` one was downgraded to
  // observation, which is a silent enforcement gap, and the reverse turned a
  // measurement-only rollout into live denials.
  //
  // It could not happen before the flattening: `deployments/<n>/<id>.mjs` gave
  // every policy its own path even when the bytes matched.
  //
  // One module instance is right — `customPolicies.add` is an unconditional
  // push, so importing the file twice would register every hook twice and run
  // the policy twice per event. So the collision is resolved rather than
  // avoided, and it resolves toward ENFORCEMENT: over-enforcing is visible to
  // whoever hits it, while under-enforcing is exactly the silent failure this
  // codebase exists to remove. It is also announced, so an operator can give the
  // two policies distinguishable source instead of living with the merge.
  const cloudManagedByPath = new Map<string, CloudManagedPolicyArtifact>();
  for (const policy of opts?.cloudManagedPolicies ?? []) {
    const key = resolve(policy.path);
    const existing = cloudManagedByPath.get(key);
    if (!existing) {
      cloudManagedByPath.set(key, policy);
      continue;
    }
    hookLogWarn(
      `cloud-managed policies ${existing.id} and ${policy.id} have identical source, so they share ` +
        `one artifact and load as one policy; enforcing it if either asks to enforce`,
    );
    if (existing.effect !== "enforce" && policy.effect === "enforce") {
      cloudManagedByPath.set(key, policy);
    }
  }

  // Installed packs, keyed by artifact path — the same content-addressing, and
  // therefore the same collision, as the cloud map above: two packs whose entry
  // file is byte-identical resolve to ONE artifact, `loadedPaths` imports it
  // once, and the loser would vanish silently with its effect deciding nothing.
  // Resolved the same way and for the same reason — toward ENFORCEMENT, because
  // over-enforcing is visible to whoever hits it and under-enforcing is the
  // silent failure — and announced, so an operator can act on it.
  /** `null` means "all of it" on both `enabled` and `clis`, so it absorbs any
   *  list. Two lists become their union — never their intersection, which is
   *  what dropping one of them amounted to. */
  const unionSelection = (a: string[] | null, b: string[] | null): string[] | null =>
    a === null || b === null ? null : [...new Set([...a, ...b])];

  /**
   * The CATALOGS have to merge for the same reason the selections do, and the
   * union of `enabled` is what made it load-bearing: it lets the loser's policy
   * run, and the catalog is where a pack declares that policy's PARAMS SCHEMA.
   * `registerPolicy` reads the schema off `pack.policies` by name, so a policy
   * present only in the loser's catalog registered with none — and a policy with
   * no schema gets no defaults, so every value its publisher declared silently
   * arrived as `undefined` in `ctx.params`. Enforcement running on the wrong
   * numbers is the same silent-wrong as enforcement not running.
   *
   * Two packs sharing bytes is most likely a fork or a re-publish, and a fork
   * that only re-declares a default changes no source at all — so differing
   * catalogs behind one artifact is the EXPECTED shape here, not a corner.
   *
   * Winner precedence on a name both declare, because the merged record carries
   * the winner's id and version and there is no merging two different defaults.
   */
  const unionCatalog = (
    winner: PolicyCatalogEntry[],
    other: PolicyCatalogEntry[],
  ): PolicyCatalogEntry[] => [
    ...winner,
    ...other.filter((p) => !winner.some((w) => w.name === p.name)),
  ];

  const packByPath = new Map<string, ResolvedPack>();
  for (const pack of opts?.packs ?? []) {
    const key = resolve(pack.path);
    const existing = packByPath.get(key);
    if (!existing) {
      packByPath.set(key, pack);
      continue;
    }
    hookLogWarn(
      `packs ${existing.id} and ${pack.id} have identical source, so they share one artifact ` +
        `and load as one pack; enforcing it if either asks to enforce, and taking ` +
        `the union of what each has enabled and of the agents each guards`,
    );
    // The EFFECT was resolved toward enforcement here and the SELECTIONS were
    // not, which made the collapse silently subtractive.
    //
    // Only the winner's `enabled` reached the tag, and `handler.ts` gates every
    // hook on that one list — so two packs sharing bytes, one having taken
    // `foo` and the other `bar`, registered whichever list won and dropped the
    // other's policy entirely. `pack-failclosed.ts` ignores a pack absent from
    // the registered map, so nothing reported it: a policy the user had
    // installed and enabled simply never ran. `clis` had the same shape — a
    // pack scoped to one agent decided the scope for both.
    //
    // Unioned, for the reason the effect is resolved toward enforcement: over-
    // enforcing is visible to whoever hits it, under-enforcing is silent. `null`
    // means "everything" on both fields, so it absorbs any list rather than
    // being intersected away.
    const winner = existing.effect !== "enforce" && pack.effect === "enforce" ? pack : existing;
    const other = winner === existing ? pack : existing;
    packByPath.set(key, {
      ...winner,
      policies: unionCatalog(winner.policies, other.policies),
      enabled: unionSelection(winner.enabled, other.enabled),
      clis: unionSelection(winner.clis, other.clis),
    });
  }

  // 1. Explicit custom policy paths. Accept a string for callers/configs using
  // the legacy singular form.
  for (const customPoliciesPath of typeof customPoliciesPaths === "string"
    ? [customPoliciesPaths]
    : customPoliciesPaths ?? []) {
    // resolve() also normalizes absolute paths, so aliases containing `.` or
    // `..` share a dedup key with convention-discovered canonical paths.
    const absPath = resolve(projectRoot, customPoliciesPath);
    const cloudManaged = cloudManagedByPath.get(absPath);
    const pack = packByPath.get(absPath);
    if (existsSync(absPath)) {
      if (!loadedPaths.has(absPath)) {
        loadedPaths.add(absPath);
        const hooksBefore = getCustomHooks().length;
        // A cloud-managed policy re-verifies its pinned digest at load, binding
        // the imported bytes to what desired-state promised.
        // A pack re-verifies its pinned digest at load for the same reason a
        // cloud policy does: the manifest read and the import are two moments,
        // and only this one binds the bytes actually executed to what was
        // promised.
        const failure = await loadSingleFile(absPath, {
          verifyEntrySha:
            cloudManaged?.sha256 ?? pack?.sha256,
        });
        if (failure && pack) packFailures.set(pack.id, failure);
        for (const hook of getCustomHooks().slice(hooksBefore)) {
          const tagged = hook as CustomHook & {
            __policyId?: string;
            __cloudManaged?: CloudManagedPolicyArtifact;
            __pack?: ResolvedPack;
          };
          if (cloudManaged) {
            tagged.__cloudManaged = cloudManaged;
            tagged.__policyId = `cloud:${cloudManaged.id}@${cloudManaged.version}:${hook.name}`;
          } else if (pack) {
            tagged.__pack = pack;
            tagged.__policyId = `pack:${pack.id}@${pack.version}:${hook.name}`;
          } else {
            tagged.__policyId = customPolicyId(absPath, hook.name);
          }
        }
        reconcilePackManifest(pack, getCustomHooks().slice(hooksBefore));
      }
    } else {
      hookLogWarn(`custom policy path not found: ${absPath}`);
      if (pack) packFailures.set(pack.id, { type: "path_missing", reason: `path missing: ${absPath}` });
    }
  }

  const hooksBeforeConvention = getCustomHooks().length;

  // 2. Project convention: {projectRoot}/.failproofai/policies/*policies.{js,mjs,ts}
  //
  // A `customPoliciesPath` pointing INTO this directory at a file whose name
  // also matches the convention (`*policies.{js,mjs,ts}`) is an ordinary setup —
  // `failproofai policies -i -c .failproofai/policies/my-policies.mjs` produces
  // exactly that — and it is discovered here as well. Skip what step 1 loaded,
  // or the file is imported twice and every hook in it fires twice per event.
  const projectDir = resolve(projectRoot, ".failproofai", "policies");
  // Clear out generated files a killed load left behind, before anything scans
  // this directory. The temporary tree has to be written beside the sources for
  // a rewritten relative import to resolve, and its name now carries a pid and
  // sequence number — so unlike the old fixed name, each abnormal termination
  // leaks one file permanently rather than leaving one that the next load
  // overwrites. Best-effort and age-gated, so it can never remove a tree
  // another process is still importing.
  // WHICH SCOPE this directory is depends on whether it IS the user directory.
  // Run an agent CLI with the cwd set to $HOME and `<cwd>/.failproofai/policies`
  // resolves to `~/.failproofai/policies` — the user scope itself. Layout 3 made
  // that reachable by collapsing `customPoliciesDir()` onto `policiesDir()`;
  // layout 2 nested the user directory one level deeper, so the two could never
  // be the same path.
  //
  // Tagging it `project` there would make a policy's id depend on where the
  // agent happened to be launched from — `convention:project:x-policies.mjs:foo`
  // from $HOME and `convention:user:x-policies.mjs:foo` from anywhere else — and
  // a disable is RECORDED AGAINST THAT ID. So a user who switched a policy off
  // would find it firing again whenever they worked out of their home
  // directory, with nothing to explain it. The files are the user's global
  // policies; that the cwd also points at them is incidental.
  const projectScope: "project" | "user" = projectDir === customPoliciesDir() ? "user" : "project";
  if (conventionEnabled) {
    void sweepStaleTmpArtifacts(projectDir);
    warnSkippedPolicyFiles(projectDir, projectScope);
  }
  // The shim directory leaks the same way and is swept on the same terms. It is
  // ours alone and outside the policy tree, so nothing else would ever reap it;
  // the age gate is what keeps this from removing a shim another process is
  // still importing.
  void sweepStaleTmpArtifacts(shimsDir());
  const projectFiles = conventionEnabled
    ? discoverPolicyFiles(projectDir).filter((f) => !loadedPaths.has(f))
    : [];
  for (const file of projectFiles) {
    loadedPaths.add(file);
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: projectScope });
    const newHooks = getCustomHooks().slice(hooksBefore);
    for (const hook of newHooks) {
      (hook as CustomHook & { __policyId?: string }).__policyId = conventionPolicyId(projectScope, basename(file), hook.name);
    }
    if (newHooks.length > 0) {
      conventionSources.push({
        scope: projectScope,
        file: basename(file),
        hookNames: newHooks.map((h) => h.name),
      });
    }
  }

  // 3. User convention: ~/.failproofai/policies/*policies.{js,mjs,ts}
  //
  // Skipped entirely when it resolves to the directory already loaded above —
  // which happens whenever the project root IS the home directory, a normal
  // setup for a gateway. Without this, every file is loaded a second time and
  // `customPolicies.add` (an unconditional push) registers each hook twice, so
  // every policy fires twice per event. For a counting policy that means the
  // count doubles and its ceiling trips at half the real number.
  //
  // Today that is masked by the runtime rather than prevented: Bun caches
  // dynamic imports by resolved path and IGNORES the `?v=` cache-buster below,
  // so the second import is a no-op — but Node honours the query and would
  // double-register. The binary runs under Bun and the tests under Node, so the
  // bug is invisible from both sides. Do not rely on that; dedupe the paths.
  const userDir = customPoliciesDir();
  if (conventionEnabled && userDir !== projectDir) {
    void sweepStaleTmpArtifacts(userDir);
    warnSkippedPolicyFiles(userDir, "user");
  }
  const userFiles =
    conventionEnabled && userDir !== projectDir
      ? discoverPolicyFiles(userDir).filter((f) => !loadedPaths.has(f))
      : [];
  for (const file of userFiles) {
    loadedPaths.add(file);
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: "user" });
    const newHooks = getCustomHooks().slice(hooksBefore);
    for (const hook of newHooks) {
      (hook as CustomHook & { __policyId?: string }).__policyId = conventionPolicyId("user", basename(file), hook.name);
    }
    if (newHooks.length > 0) {
      conventionSources.push({
        scope: "user",
        file: basename(file),
        hookNames: newHooks.map((h) => h.name),
      });
    }
  }

  const allHooks = getCustomHooks();
  const conventionCount = allHooks.length - hooksBeforeConvention;

  if (!conventionEnabled) {
    // Say so. Silently loading nothing is exactly the failure this feature set
    // exists to remove — a user who forgot the flag would see their policies
    // do nothing with no way to tell why.
    hookLogInfo(
      "convention policies: DISABLED via customPoliciesEnabled:false — " +
        "no .failproofai/policies/ files loaded",
    );
  } else if (projectFiles.length > 0 || userFiles.length > 0) {
    hookLogInfo(
      `convention policies: ${projectFiles.length} project file(s), ${userFiles.length} user file(s), ${conventionCount} hook(s)`,
    );
  }

  // Tag convention hooks with their scope so the handler can build scoped prefixes.
  // Build a name→scope map from conventionSources, then tag by object reference
  // to avoid mis-tagging an explicit custom hook that shares the same name.
  const hookNameToScope = new Map<string, string>();
  for (const source of conventionSources) {
    for (const name of source.hookNames) {
      hookNameToScope.set(name, source.scope);
    }
  }
  const conventionHookRefs = new Set<CustomHook>();
  for (const hook of allHooks.slice(hooksBeforeConvention)) {
    conventionHookRefs.add(hook);
  }
  for (const hook of allHooks) {
    if (conventionHookRefs.has(hook)) {
      (hook as CustomHook & { __conventionScope?: string }).__conventionScope =
        hookNameToScope.get(hook.name) ?? "project";
    }
  }

  return { hooks: allHooks, conventionSources, packFailures };
}
