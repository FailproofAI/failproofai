/**
 * A CommonJS `require` this package can use from either module system.
 *
 * The adapters need three things Node only offers through `require`: reading a
 * framework's `package.json` for its version, asking whether a package
 * resolves at all, and inspecting `require.cache`. Reaching for them the
 * obvious way — `createRequire(import.meta.url)` — compiles under ESM and is a
 * syntax error under CommonJS, so a package that ships both builds cannot use
 * it without a bundler shim. This module has none.
 *
 * The anchor is the **consuming application's working directory**, not this
 * file. That is also the better answer on the merits: the frameworks we detect
 * are the application's dependencies, and under pnpm or a workspace this
 * package may sit somewhere that cannot see them at all. `resolveFrom` tries
 * the application first and this package second, so a hoisted install and an
 * isolated one both work.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// `createRequire` wants a file path to resolve relative to; the file need not
// exist, only its directory is used.
const appRequire = createRequire(join(process.cwd(), "__failproofai_anchor__.js"));

export const nodeRequire: NodeJS.Require = appRequire;

/** Every `require.cache` key currently loaded, for "is this already imported". */
export function loadedModulePaths(): string[] {
  try {
    return Object.keys(appRequire.cache);
  } catch {
    return [];
  }
}

/** The resolved filename for `specifier`, or null when it cannot be found. */
export function resolveFrom(specifier: string): string | null {
  const roots: (string[] | undefined)[] = [undefined, [process.cwd()]];
  for (const paths of roots) {
    try {
      return appRequire.resolve(specifier, paths ? { paths } : undefined);
    } catch {
      // Either the package is absent or its `exports` map does not expose this
      // subpath. Both are ordinary; try the next root.
    }
  }
  return null;
}

/**
 * Whether the process entry point is a CommonJS module.
 *
 * `require.main` is the entry module under CommonJS and `undefined` when the
 * entry is an ES module — and the entry's module system decides which copy of
 * a dual-published framework the application's own imports reach. That is the
 * copy an adapter has to patch; see `resolveCopies`.
 */
export function entryIsCommonJs(): boolean {
  try {
    return appRequire.main !== undefined;
  } catch {
    return false;
  }
}

/** Whether `path` is in the CommonJS module cache, i.e. has been `require`d. */
export function isRequired(path: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(appRequire.cache, path);
  } catch {
    return false;
  }
}

/**
 * The file an ES-module `import(specifier)` from the application would load,
 * or null when it cannot be worked out.
 *
 * A dual-published framework (`@langchain/core`, `@mastra/core`, `llamaindex`,
 * …) ships two copies of every module — `exports["./x"].import` and
 * `exports["./x"].require` — and they are two different objects in memory.
 * `resolveFrom` can only ever name the `require` one, because `createRequire`
 * resolves with CommonJS conditions. Patching that copy in an ES-module
 * application is a silent no-op: `instrument()` reports success, the app's own
 * imports reach the untouched ESM copy, and no event is ever recorded.
 *
 * `import.meta.resolve` would answer this directly, but it does not exist in
 * the CommonJS build and cannot take a parent URL without a flag — and the
 * parent has to be the APPLICATION, not this file (see the module comment). So
 * this reads the package's `exports` map itself, with Node's ESM conditions
 * (`node`, `import`, `default`). It only has to handle what packages actually
 * publish: condition objects, arrays, and single-`*` subpath patterns.
 */
export function resolveEsm(specifier: string): string | null {
  const { name, subpath } = splitSpecifier(specifier);
  if (name === null) return null;
  const root = packageRoot(name, specifier);
  if (root === null) return null;
  let manifest: { exports?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  if (manifest.exports === undefined) {
    // No exports map: Node's ESM loader reads `main` exactly as `require`
    // does, so there is only one copy and CommonJS resolution already names it.
    return null;
  }
  const target = matchExports(manifest.exports, subpath, ESM_CONDITIONS);
  if (target === null || !target.startsWith("./")) return null;
  const file = join(root, target);
  return existsSync(file) ? file : null;
}

const ESM_CONDITIONS: readonly string[] = ["node", "import", "default"];

function splitSpecifier(specifier: string): { name: string | null; subpath: string } {
  const parts = specifier.split("/");
  const scoped = specifier.startsWith("@");
  if (scoped && parts.length < 2) return { name: null, subpath: "." };
  const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const rest = parts.slice(scoped ? 2 : 1);
  return { name, subpath: rest.length === 0 ? "." : `./${rest.join("/")}` };
}

/**
 * The directory holding `name`'s `package.json`, as the application sees it.
 *
 * CommonJS resolution of the package (or of the requested subpath) is used
 * first, because that is precisely the install the application would load —
 * under pnpm, a workspace, or nested `node_modules` alike — and then walked up
 * to the manifest that names it. Only when CommonJS cannot resolve it at all
 * (an ESM-only package whose `exports` has no `require` condition) does this
 * fall back to walking `node_modules` up from the working directory.
 */
function packageRoot(name: string, specifier: string): string | null {
  for (const candidate of [specifier, name, `${name}/package.json`]) {
    const entry = resolveFrom(candidate);
    if (entry === null) continue;
    let dir = dirname(entry);
    for (;;) {
      if (manifestNames(join(dir, "package.json"), name)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (manifestNames(join(candidate, "package.json"), name)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function manifestNames(path: string, name: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown }).name === name;
  } catch {
    return false;
  }
}

/** Node's `PACKAGE_EXPORTS_RESOLVE`, reduced to what packages publish. */
function matchExports(exports: unknown, subpath: string, conditions: readonly string[]): string | null {
  const isSubpathMap =
    typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."));
  if (!isSubpathMap) {
    return subpath === "." ? resolveTarget(exports, conditions, null) : null;
  }
  const map = exports as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(map, subpath) && !subpath.includes("*")) {
    return resolveTarget(map[subpath], conditions, null);
  }
  // Longest matching `prefix*suffix` pattern wins, as in Node.
  let best: { key: string; match: string } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length &&
      (best === null || prefix.length > best.key.indexOf("*"))
    ) {
      best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  return best === null ? null : resolveTarget(map[best.key], conditions, best.match);
}

function resolveTarget(target: unknown, conditions: readonly string[], match: string | null): string | null {
  if (typeof target === "string") {
    return match === null ? target : target.replaceAll("*", match);
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveTarget(entry, conditions, match);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (typeof target === "object" && target !== null) {
    for (const [key, value] of Object.entries(target)) {
      if (key !== "default" && !conditions.includes(key)) continue;
      const resolved = resolveTarget(value, conditions, match);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/** `require(specifier)`, or null on any failure. Never throws. */
export function tryRequire<T = unknown>(specifier: string): T | null {
  try {
    return appRequire(specifier) as T;
  } catch {
    return null;
  }
}

/**
 * A real dynamic `import()`, in both halves of the dual build.
 *
 * TypeScript downlevels `import(x)` to `require(x)` when it emits CommonJS,
 * which is exactly wrong for the packages this SDK reaches for: the Vercel AI
 * SDK is ESM-only, so the CommonJS build would report the framework as "not
 * importable" for the users most likely to have it. Building the import through
 * the `Function` constructor hides it from that transform, so both builds
 * perform a genuine dynamic import and both can load an ESM-only framework.
 *
 * The `Function` here takes no caller-controlled input: the body is this fixed
 * literal and the specifier arrives as an argument.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- fixed literal body, no caller input; see above
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

export async function importModule(specifier: string): Promise<unknown> {
  return await dynamicImport(specifier);
}
