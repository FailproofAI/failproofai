/**
 * Version and capability probes for the framework adapters.
 *
 * Peer dependencies express a *floor*, not enforcement: most users already have
 * the framework and will never read our peer range. So the real check happens
 * here, at `instrument()` time, in three tiers:
 *
 * 1. **framework not importable** -> a hard error whose message contains the
 *    literal install command. Instrumenting is an explicit user action, so
 *    silently doing nothing is never the right answer.
 * 2. **importable but outside the declared range** -> a warning, once, then
 *    best-effort. A ceiling exists because without one a clean install a year
 *    from now pulls the next major, the callback API shifts, and the adapter
 *    stops receiving events *while throwing nothing*.
 * 3. **a capability probe fails** -> warn and no-op **that hook only**, never
 *    the whole adapter.
 *
 * `FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1` promotes every warning here to an
 * exception. Warn-by-default is only defensible because there is a supported
 * way to make it fail loudly.
 *
 * ## Why the version comparison is naive
 *
 * This package is contractually zero-dependency, so it cannot use `semver`.
 * `parseVersion` reads the **leading numeric components only** and stops at the
 * first component that is not purely numeric:
 *
 *     "1.5.2"          -> [1, 5, 2]
 *     "2.0.0-beta.1"   -> [2, 0, 0]      # pre-release suffix ignored
 *     "0.14.23+build"  -> [0, 14, 23]    # build metadata ignored
 *
 * That means `2.0.0-beta.1` compares **equal** to `2.0.0`, so a pre-release of
 * a major we have declared a ceiling against will not be flagged. That is
 * deliberate: the alternative is shipping a semver parser, and being wrong
 * about a release candidate is much cheaper than a runtime dependency.
 */

import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { logger } from "../logger.js";
import {
  appImportsReachCommonJs,
  importModule,
  isRequired,
  nodeRequire,
  resolveEsm,
  resolveFrom,
} from "../node-require.js";

/** A framework is outside the range this adapter was written against. */
export class FailproofAICompatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailproofAICompatError";
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Read a boolean env var. Shared with `core.ts` so both flags parse alike. */
export function envFlag(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").trim().toLowerCase());
}

// Cached, because it is read on every warning and every `safe()` failure, and
// resettable, because a test that cannot flip the switch cannot test the policy.
let strictIntegrationsValue: boolean | null = null;

export function strictIntegrations(): boolean {
  strictIntegrationsValue ??= envFlag("FAILPROOFAI_SDK_STRICT_INTEGRATIONS");
  return strictIntegrationsValue;
}

/** Override the flag. `null` re-reads the environment variable. */
export function setStrictIntegrations(value: boolean | null): void {
  strictIntegrationsValue = value;
}

const warned = new Set<string>();

/** Forget which warnings have already fired (tests; also `uninstrument()`). */
export function resetWarnings(): void {
  warned.clear();
}

/**
 * Warn once per `key`, or throw if strict.
 *
 * Deduplicated because these fire from `install()` *and* from hot callbacks: a
 * per-call warning on a chatty framework is its own outage.
 */
export function warn(message: string, key?: string): void {
  if (strictIntegrations()) throw new FailproofAICompatError(message);
  const dedup = key ?? message;
  if (warned.has(dedup)) return;
  warned.add(dedup);
  logger.warn(message);
}

/** Leading numeric components of a version string. See the module comment. */
export function parseVersion(text: string): number[] {
  const parts: number[] = [];
  for (const chunk of String(text).split(".")) {
    let digits = "";
    for (const character of chunk) {
      if (character < "0" || character > "9") break;
      digits += character;
    }
    if (digits === "") break;
    parts.push(Number.parseInt(digits, 10));
    if (digits.length !== chunk.length) {
      // A partially numeric component ("0-beta", "3+build") ends the numeric
      // prefix — everything after it is a pre-release or build segment.
      break;
    }
  }
  return parts;
}

function compare(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * The installed version of a package, or null if it is not installed.
 *
 * Reads `package.json` rather than a `version` export: that export is not
 * guaranteed to exist and most of the frameworks we target do not define one.
 * Resolution is anchored at the consuming APPLICATION (see `node-require.ts`),
 * so it finds a framework installed beside the app even when this SDK itself
 * lives somewhere isolated — a pnpm store, a workspace link.
 */
export function versionString(pkg: string): string | null {
  const manifest = resolveFrom(`${pkg}/package.json`);
  if (manifest !== null) {
    try {
      const parsed = nodeRequire(manifest) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // A manifest that will not load is not a reason to refuse to instrument.
    }
  }
  // `package.json` is not always in a package's `exports` map. Fall back to the
  // package root's own resolution and walk up to the manifest beside it, rather
  // than reporting "not installed" for a package that is merely strict about
  // what it exports.
  const entry = resolveFrom(pkg);
  if (entry === null) return null;
  const marker = `${sep}node_modules${sep}`;
  const index = entry.lastIndexOf(marker + pkg.split("/")[0]);
  if (index === -1) return null;
  const root = join(entry.slice(0, index + marker.length), ...pkg.split("/"));
  try {
    const parsed = nodeRequire(join(root, "package.json")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function versionTuple(pkg: string): number[] | null {
  const text = versionString(pkg);
  return text ? parseVersion(text) : null;
}

/**
 * Import a framework module or throw with the literal install command.
 *
 * Tier 1. `instrument("langchain")` on a machine without LangChain is a mistake
 * the user can fix in one command, so we hand them the command.
 */
export async function requireModule(specifier: string, install: string): Promise<unknown> {
  const copies = await requireModuleCopies(specifier, install);
  return copies[0]!;
}

/**
 * Every in-memory copy of `specifier` the application can be using — the one
 * it loads first. Adapters that patch or subscribe must do so on EACH.
 *
 * ## Why there can be two
 *
 * A dual-published framework ships an ES-module build and a CommonJS build of
 * every module, and Node loads them as two unrelated module instances: two
 * `CallbackManager` classes, two `Agent.prototype`s, two `Settings` singletons.
 * Patching one does nothing to the other. The first release of these adapters
 * resolved with `createRequire` and so always patched the CommonJS copy — in an
 * ES-module application, which is the default for a new TypeScript project,
 * `instrument()` returned success and not one event was ever recorded.
 *
 * ## Which copies
 *
 *   1. The copy the application's own imports reach: CommonJS when the process
 *      entry point is CommonJS, the ES-module build otherwise — and always the
 *      ES-module build inside a Next.js server, whose CommonJS launcher
 *      `import()`s every external package (`appImportsReachCommonJs`). A
 *      framework Next BUNDLES is a third copy no resolution can reach; only
 *      the call-site helpers see it. Loaded if it is
 *      not loaded yet — instrumenting before the framework's first import is
 *      the documented order, and loading it then is exactly what the
 *      application is about to do anyway.
 *   2. The CommonJS copy as well, but ONLY if something has already
 *      `require`d it — an ES-module application with a CommonJS dependency
 *      that pulls the framework in. It is never loaded speculatively: a second
 *      copy that nothing uses costs memory at best, and at worst the framework
 *      notices — LlamaIndex prints "llamaindex was already imported. This
 *      breaks constructor checks" to the customer's terminal.
 *
 * The one arrangement this cannot see is the mirror image of (2): a CommonJS
 * application whose ESM-only dependency imports the framework's ES-module
 * build. Node keeps no inspectable registry of loaded ES modules, so there is
 * nothing to detect it with short of a loader hook. Call-site helpers
 * (`langchainHandler()`, `telemetry()`) cover that case, as they cover a
 * bundled application where neither copy in `node_modules` is the one running.
 */
export async function requireModuleCopies(specifier: string, install: string): Promise<unknown[]> {
  // Resolve against the APPLICATION. A bare `import(specifier)` resolves
  // relative to this file, which under pnpm or a workspace cannot see the
  // caller's dependencies at all — so the framework the user definitely has
  // installed reports as missing.
  const cjsPath = resolveFrom(specifier);
  const esmPath = resolveEsm(specifier);
  const dual = cjsPath !== null && esmPath !== null && esmPath !== cjsPath;

  const load = async (path: string | null, viaRequire: boolean): Promise<unknown> =>
    viaRequire && path !== null
      ? nodeRequire(path)
      : await importModule(path === null ? specifier : pathToFileURL(path).href);

  const copies: unknown[] = [];
  try {
    if (!dual) {
      copies.push(await load(cjsPath ?? esmPath, false));
    } else if (appImportsReachCommonJs()) {
      copies.push(await load(cjsPath, true));
    } else {
      copies.push(await load(esmPath, false));
      if (isRequired(cjsPath)) copies.push(nodeRequire(cjsPath));
    }
  } catch (error) {
    throw new Error(
      `cannot instrument ${JSON.stringify(specifier)} because it is not importable. ` +
        `Install it with:  ${install}`,
      { cause: error },
    );
  }
  return [...new Set(copies)];
}

/**
 * Tier 2. True when `pkg` is inside [minimum, below); warns once if not.
 *
 * Returns true (best effort) for an unknown version too — a framework installed
 * from a git checkout or a workspace link has no usable manifest, and refusing
 * to instrument it would be a worse answer than trying.
 */
export function checkVersion(
  framework: string,
  pkg: string,
  options: { minimum?: string; below?: string; reason?: string } = {},
): boolean {
  const found = versionString(pkg);
  if (found === null) return true;
  const got = parseVersion(found);
  if (got.length === 0) return true;

  if (options.minimum !== undefined && compare(got, parseVersion(options.minimum)) < 0) {
    warn(
      `${pkg} ${found} is older than the ${options.minimum} this ${framework} adapter was ` +
        `written against${options.reason ? ` (${options.reason})` : ""}. ` +
        "Instrumenting anyway; some events may be missing.",
      `${framework}:${pkg}:min`,
    );
    return false;
  }
  if (options.below !== undefined && compare(got, parseVersion(options.below)) >= 0) {
    warn(
      `${pkg} ${found} is newer than the <${options.below} this ${framework} adapter was ` +
        "written against. Instrumenting anyway, but a callback API change would make it " +
        "stop recording silently — please report this.",
      `${framework}:${pkg}:max`,
    );
    return false;
  }
  return true;
}

/**
 * Tier 3. Run a capability probe; on failure warn and disable ONE hook.
 *
 * A missing capability is never a reason to abandon the whole adapter: the
 * other 90% of the events are still correct and still worth having.
 */
export function probe(framework: string, hook: string, check: () => unknown): boolean {
  let ok: boolean;
  try {
    ok = Boolean(check());
  } catch (error) {
    warn(
      `${framework} capability probe for ${JSON.stringify(hook)} failed ` +
        `(${error instanceof Error ? error.message : String(error)}); that hook is disabled, ` +
        "the rest of the adapter is unaffected.",
      `${framework}:${hook}`,
    );
    return false;
  }
  if (!ok) {
    warn(
      `${framework} does not provide ${JSON.stringify(hook)} in this version; that hook is ` +
        "disabled, the rest of the adapter is unaffected.",
      `${framework}:${hook}`,
    );
  }
  return ok;
}
