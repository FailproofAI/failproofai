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
 * The anchor is the **consuming application**, not this file: the frameworks
 * we detect are the application's dependencies, and under pnpm or a workspace
 * this package may sit somewhere that cannot see them at all. Where the
 * application IS has two answers and neither is always right — see `anchors()`.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

// `createRequire` wants a file path to resolve relative to; the file need not
// exist, only its directory is used.
const requireAt = (dir: string): NodeJS.Require => createRequire(join(dir, "__failproofai_anchor__.js"));
const appRequire = requireAt(process.cwd());

/**
 * The directories to resolve the application's dependencies from, best first.
 *
 * The working directory alone was the first answer, and it is wrong twice: a
 * service started with no working directory set runs from `/`, where nothing
 * resolves and `instrument()` reports it found no framework; and in a monorepo
 * whose root hoists a different `@langchain/core` than the app's own nested
 * one, it resolved the ROOT copy — patched a class the app never loads, and
 * reported success.
 *
 * The entry script's directory is the better anchor whenever the entry is the
 * application's own code. It is not when the entry is a launcher living in
 * `node_modules` (`next start`, a process manager's wrapper): resolving from
 * there finds whatever the launcher's package sits beside, so the working
 * directory keeps precedence in that case. Both are always tried; which one is
 * asked FIRST only matters when they disagree.
 */
function anchors(): string[] {
  const cwd = process.cwd();
  const entry = process.argv[1];
  const dirs: string[] = [];
  if (typeof entry === "string" && entry !== "" && isAbsolute(entry)) {
    const dir = dirname(entry);
    const launcher = dir.split(/[\\/]/).includes("node_modules");
    if (launcher) dirs.push(cwd, dir);
    else dirs.push(dir, cwd);
  } else {
    dirs.push(cwd);
  }
  return [...new Set(dirs)];
}

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
  const found: string[] = [];
  for (const dir of anchors()) {
    try {
      const path = requireAt(dir).resolve(specifier);
      if (!found.includes(path)) found.push(path);
    } catch {
      // Either the package is absent from here or its `exports` map does not
      // expose this subpath. Both are ordinary; try the next anchor.
    }
  }
  // A copy something has already `require`d is the one in use, whichever
  // anchor found it.
  return found.find(isRequired) ?? found[0] ?? null;
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
    return isCommonJsMain(appRequire.main);
  } catch {
    return false;
  }
}

/**
 * Whether a `require.main` value names a CommonJS entry module.
 *
 * Node answers `undefined` for an ES-module entry; Deno answers `null`. A bare
 * `!== undefined` read Deno's `null` as "CommonJS", so an ES-module Deno app
 * had its frameworks' CommonJS copies patched while its own imports reached the
 * untouched ES-module copies: `instrument()` returned success and nothing was
 * recorded. Only an actual module object counts.
 */
export function isCommonJsMain(main: unknown): boolean {
  return typeof main === "object" && main !== null;
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
const CJS_CONDITIONS: readonly string[] = ["node", "require", "default"];

/**
 * The file `subpath` of the package installed at `root` resolves to, for an
 * `import` or a `require` — or null. `root` is a package directory found on
 * disk rather than by resolution (see `nestedCopies`), so there is no
 * specifier to hand Node's resolver; this reads the package's own `exports`.
 */
export function resolveExportsAt(root: string, subpath: string, kind: "import" | "require"): string | null {
  let manifest: { exports?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  let target: string | null;
  if (manifest.exports === undefined) {
    if (subpath !== ".") return null;
    target = typeof manifest.main === "string" ? manifest.main : "index.js";
    if (!target.startsWith("./")) target = `./${target}`;
  } else {
    target = matchExports(manifest.exports, subpath, kind === "import" ? ESM_CONDITIONS : CJS_CONDITIONS);
  }
  if (target === null || !target.startsWith("./")) return null;
  const file = join(root, target);
  return existsSync(file) ? file : null;
}

/** Bounds on `nestedCopies`' walk: it runs once, at `instrument()`, over a tree nobody sized. */
const NESTED_MAX_DEPTH = 4;
const NESTED_MAX_DIRS = 20_000;

/**
 * Every OTHER installed copy of package `name` the application can end up
 * running: the real directories of the copies nested BENEATH some dependency
 * (`node_modules/<dep>/node_modules/<name>`, at any depth up to a bound), in
 * every `node_modules` on the application's resolution chain — plus, under
 * pnpm, every version in the virtual store (`node_modules/.pnpm/<name>@<v>`).
 *
 * A copy exists there because a dependency could not share the application's
 * — it pinned a different version as a hard dependency — and everything that
 * dependency builds is built on it. `resolveFrom` can never name one: Node's
 * resolution from the application stops at the application's own copy.
 *
 * Deliberately NOT included: a `<name>` sitting directly in some ancestor
 * `node_modules`. The nearest one is the application's own copy, and a farther
 * one is a monorepo root's hoist the application's imports never reach.
 */
export function nestedCopies(name: string): string[] {
  const found = new Map<string, true>();
  const seen = new Set<string>();
  let budget = NESTED_MAX_DIRS;
  const real = (path: string): string | null => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const candidate = (dir: string): void => {
    const path = real(dir);
    if (path !== null && manifestNames(join(path, "package.json"), name)) found.set(path, true);
  };
  const scan = (modules: string, depth: number): void => {
    const key = real(modules);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    for (const entry of list(modules)) {
      if (budget <= 0) return;
      if (entry === ".pnpm") {
        // pnpm's virtual store: one directory per installed version.
        const prefix = `${name.replace("/", "+")}@`;
        for (const version of list(join(modules, entry))) {
          if (version.startsWith(prefix)) candidate(join(modules, entry, version, "node_modules", name));
        }
        continue;
      }
      if (entry.startsWith(".")) continue;
      const packages = entry.startsWith("@") ? list(join(modules, entry)).map((sub) => join(modules, entry, sub)) : [join(modules, entry)];
      for (const pkg of packages) {
        if (budget-- <= 0) return;
        // The top level of a scanned `node_modules` is never a candidate.
        if (depth > 0 && pkg === join(modules, name)) {
          candidate(pkg);
          continue;
        }
        if (depth < NESTED_MAX_DEPTH) {
          const inner = join(pkg, "node_modules");
          if (existsSync(inner)) scan(inner, depth + 1);
        }
      }
    }
  };
  for (const anchor of anchors()) {
    let dir = anchor;
    for (;;) {
      const modules = join(dir, "node_modules");
      if (existsSync(modules)) scan(modules, 0);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...found.keys()];
}

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
 * fall back to walking `node_modules` up from each of `anchors()`.
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
  for (const anchor of anchors()) {
    let dir = anchor;
    for (;;) {
      const candidate = join(dir, "node_modules", name);
      if (manifestNames(join(candidate, "package.json"), name)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
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
