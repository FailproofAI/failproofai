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

import { createRequire } from "node:module";
import { join } from "node:path";

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
