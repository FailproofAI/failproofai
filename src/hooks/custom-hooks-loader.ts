/**
 * Loads user-authored policy files with ESM import rewriting.
 * Supports transitive local imports and `import { ... } from 'failproofai'`.
 *
 * Two loading modes:
 * 1. Explicit: a single file via `customPoliciesPath` in policies-config.json
 * 2. Convention: auto-discovered *policies.{js,mjs,ts} files from
 *    .failproofai/policies/ at project and user level (git-hooks style)
 *
 * Fail-open: any error (file not found, syntax error, import failure) is logged
 * and results in an empty hook list for that file. Builtins continue normally.
 */
import { resolve, isAbsolute, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { hookLogWarn, hookLogError, hookLogInfo } from "./hook-logger";
import { getCustomHooks, clearCustomHooks } from "./custom-hooks-registry";
import { findDistIndex, rewriteFileTree, TMP_SUFFIX, cleanupTmpFiles } from "./loader-utils";
import { findProjectConfigDir } from "./hooks-config";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import type { CustomHook } from "./policy-types";

const LOADING_KEY = "__FAILPROOFAI_LOADING_HOOKS__";

/** Regex matching convention policy filenames: *policies.{js,mjs,ts} */
const CONVENTION_FILE_RE = /policies\.(js|mjs|ts)$/;

/**
 * Monotonic counter used to cache-bust each dynamic import. Loading N files
 * creates N module instances rather than reusing one; every caller here is
 * either a one-shot CLI command or a short-lived hook process, so the
 * lifetime cost is bounded by the process, not by uptime.
 */
let loadSequence = 0;

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
          !e.name.endsWith(".d.ts"),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Load a single policy file into the globalThis custom hooks registry.
 * Does NOT clear the registry — caller is responsible for that.
 */
async function loadSingleFile(
  absPath: string,
  opts?: { strict?: boolean; conventionScope?: "project" | "user" },
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g[LOADING_KEY] = true;

  let tmpFiles: string[] = [];
  try {
    const distIndex = await findDistIndex();
    const distUrl = distIndex ? pathToFileURL(distIndex).href : null;

    tmpFiles = await rewriteFileTree(absPath, distUrl, distIndex);

    const entryTmp = absPath + TMP_SUFFIX;
    // Cache-bust the specifier. NOTE this works under Node but NOT under Bun,
    // which caches by resolved path and ignores the query — and the shipped
    // binary runs under Bun. It is kept because it makes repeat loads behave
    // the same on both runtimes where it can, but nothing may DEPEND on a
    // repeat load re-executing; callers dedupe paths instead (see above).
    // The temp path is deterministic, so a second
    // load of the same file inside one process hit the ESM module cache, the
    // module body never re-ran, no `customPolicies.add` fired, and the caller
    // saw zero hooks — indistinguishable from a broken policy file. That is
    // exactly what `failproofai policies` rendered as "failed to load" for
    // every file when it walked a shared project/user directory twice.
    // A distinct query string makes it a distinct module to the loader.
    const fileUrl = `${pathToFileURL(entryTmp).href}?v=${++loadSequence}`;
    await import(/* webpackIgnore: true */ fileUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorType = /Cannot find module|MODULE_NOT_FOUND|ENOENT/i.test(msg)
      ? "module_not_found"
      : /SyntaxError|Unexpected token/i.test(msg)
        ? "syntax_error"
        : "runtime_error";
    void trackHookEvent(getInstanceId(), "custom_hooks_load_error", {
      error_type: errorType,
      is_convention: !!opts?.conventionScope,
      convention_scope: opts?.conventionScope ?? null,
      file_basename: basename(absPath),
    });
    if (opts?.strict) throw new Error(`Failed to load custom hooks from ${absPath}: ${msg}`);
    hookLogError(`failed to load custom hooks from ${absPath}: ${msg}`);
  } finally {
    g[LOADING_KEY] = false;
    await cleanupTmpFiles(tmpFiles);
  }
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

export async function loadAllCustomHooks(
  customPoliciesPath: string | undefined,
  opts?: { sessionCwd?: string; customPoliciesEnabled?: boolean },
): Promise<LoadAllResult> {
  clearCustomHooks();

  const conventionSources: ConventionSource[] = [];

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

  // 1. Explicit customPoliciesPath (existing behavior)
  if (customPoliciesPath) {
    const absPath = isAbsolute(customPoliciesPath)
      ? customPoliciesPath
      : resolve(projectRoot, customPoliciesPath);
    if (existsSync(absPath)) {
      loadedPaths.add(absPath);
      await loadSingleFile(absPath);
    } else {
      hookLogWarn(`customPoliciesPath not found: ${absPath}`);
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
  if (conventionEnabled) warnSkippedPolicyFiles(projectDir, "project");
  const projectFiles = conventionEnabled
    ? discoverPolicyFiles(projectDir).filter((f) => !loadedPaths.has(f))
    : [];
  for (const file of projectFiles) {
    loadedPaths.add(file);
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: "project" });
    const newHooks = getCustomHooks().slice(hooksBefore);
    if (newHooks.length > 0) {
      conventionSources.push({
        scope: "project",
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
  const userDir = resolve(homedir(), ".failproofai", "policies");
  if (conventionEnabled && userDir !== projectDir) warnSkippedPolicyFiles(userDir, "user");
  const userFiles =
    conventionEnabled && userDir !== projectDir
      ? discoverPolicyFiles(userDir).filter((f) => !loadedPaths.has(f))
      : [];
  for (const file of userFiles) {
    loadedPaths.add(file);
    const hooksBefore = getCustomHooks().length;
    await loadSingleFile(file, { conventionScope: "user" });
    const newHooks = getCustomHooks().slice(hooksBefore);
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

  return { hooks: allHooks, conventionSources };
}
