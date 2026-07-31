/**
 * Utilities for loading ESM hook/eval modules from user-provided .js files.
 *
 * Handles three problems:
 * 1. ESM/CJS: .js files with `import` syntax fail if package.json lacks "type":"module".
 *    Fix: writes a temp .mjs copy (Node.js always treats .mjs as ESM).
 * 2. Module resolution: `from 'failproofai'` (or legacy `from 'claudeye'`) won't resolve when running in-repo.
 *    Fix: rewrites the specifier to the absolute dist/index.js path via an ESM shim.
 * 3. Transitive imports: files imported by the entry point also need rewriting.
 *    Fix: recursively follows local relative imports and rewrites all reachable files.
 *
 * The ESM shim includes hooks API exports.
 */
import { readFile, writeFile, unlink, access } from "fs/promises";
import { resolve, dirname, relative } from "path";
import { pathToFileURL } from "url";

export const TMP_SUFFIX = ".__failproofai_tmp__.mjs";

/** Regex to find local relative import specifiers (ESM). */
const LOCAL_IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:[\s\S]*?\s+from\s+))(['"])(\.\.?\/[^'"]+)\1/g;

/** Regex to find local relative require specifiers (CJS). */
const LOCAL_REQUIRE_RE = /require\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findDistIndex(): Promise<string | null> {
  // Env var set by scripts/dev.ts, scripts/start.ts, bin/failproofai.mjs
  const distPath = process.env.FAILPROOFAI_DIST_PATH;
  if (distPath) {
    const candidate = resolve(distPath, "index.js");
    if (await fileExists(candidate)) return candidate;
  }

  // Fallback: check common locations
  const candidates = [
    // Packaged binary: dist is bundled at {binaryDir}/../assets/dist/
    resolve(dirname(process.execPath), "..", "assets", "dist", "index.js"),
    resolve(process.cwd(), "dist", "index.js"),
    resolve(process.cwd(), "node_modules", "failproofai", "dist", "index.js"),
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

/**
 * Resolve a relative import specifier to an actual file path.
 * Tries the path as-is, then with .js, .mjs, .ts, and /index.js extensions.
 */
export async function resolveLocalImport(
  fromDir: string,
  specifier: string,
): Promise<string | null> {
  const base = resolve(fromDir, specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, resolve(base, "index.js")];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

/**
 * Create an ESM shim that re-exports from the CJS dist module.
 * Exports the full public API of failproofai: customPolicies, allow, deny, instruct,
 * getCustomHooks, clearCustomHooks.
 */
export async function createEsmShim(
  distIndex: string,
  distUrl: string,
  tmpSuffix = TMP_SUFFIX,
): Promise<{ shimPath: string; shimUrl: string }> {
  const shimPath = `${distIndex}${tmpSuffix}.shim.mjs`;
  const shimCode = [
    `import _cjs from '${distUrl}';`,
    `export const customPolicies = _cjs.customPolicies;`,
    `export const getCustomHooks = _cjs.getCustomHooks;`,
    `export const clearCustomHooks = _cjs.clearCustomHooks;`,
    `export const allow = _cjs.allow;`,
    `export const deny = _cjs.deny;`,
    `export const instruct = _cjs.instruct;`,
    `export default _cjs;`,
  ].join("\n");
  await writeFile(shimPath, shimCode, "utf-8");
  return { shimPath, shimUrl: pathToFileURL(shimPath).href };
}

/**
 * Rewrite `from 'failproofai'`/`from 'claudeye'` and local relative imports in all files
 * reachable from the entry point. Returns the list of temp files created (including the shim).
 */
export async function rewriteFileTree(
  entryPath: string,
  distUrl: string | null,
  distIndex: string | null,
  tmpSuffix = TMP_SUFFIX,
): Promise<string[]> {
  const queue: string[] = [entryPath];
  const visited = new Set<string>();
  const tmpFiles: string[] = [];

  let esmShimUrl: string | null = null;
  if (distIndex && distUrl) {
    const shim = await createEsmShim(distIndex, distUrl, tmpSuffix);
    tmpFiles.push(shim.shimPath);
    esmShimUrl = shim.shimUrl;
  }

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    let code = await readFile(filePath, "utf-8");

    // Rewrite 'failproofai' or legacy 'claudeye' imports to the ESM shim (or direct CJS for require)
    if (esmShimUrl) {
      code = code.replace(
        /from\s+(['"])(?:claudeye|failproofai)\1/g,
        `from '${esmShimUrl}'`,
      );
    }
    if (distIndex) {
      code = code.replace(
        /require\s*\(\s*(['"])(?:claudeye|failproofai)\1\s*\)/g,
        `require('${distIndex.replace(/\\/g, "\\\\")}')`
      );
    }

    // Find local relative imports and collect specifier → replacement mappings
    const dir = dirname(filePath);
    const rewrites = new Map<string, string>();
    for (const re of [LOCAL_IMPORT_RE, LOCAL_REQUIRE_RE]) {
      const freshRe = new RegExp(re.source, re.flags);
      let match: RegExpExecArray | null;
      while ((match = freshRe.exec(code)) !== null) {
        const specifier = match[2];
        if (rewrites.has(specifier)) continue;
        const resolved = await resolveLocalImport(dir, specifier);
        if (!resolved) continue;
        if (!visited.has(resolved) && !queue.includes(resolved)) {
          queue.push(resolved);
        }
        let relPath = relative(dir, resolved + tmpSuffix).split("\\").join("/");
        if (!relPath.startsWith(".")) relPath = "./" + relPath;
        rewrites.set(specifier, relPath);
      }
    }

    // Rewrite collected specifiers to point to temp versions
    const sortedSpecs = [...rewrites.keys()].sort((a, b) => b.length - a.length);
    for (const specifier of sortedSpecs) {
      const replacement = rewrites.get(specifier)!;
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      code = code.replace(new RegExp(`'${escaped}'`, "g"), `'${replacement}'`);
      code = code.replace(new RegExp(`"${escaped}"`, "g"), `"${replacement}"`);
    }

    const tmpPath = filePath + tmpSuffix;
    await writeFile(tmpPath, code, "utf-8");
    tmpFiles.push(tmpPath);
  }

  return tmpFiles;
}

export async function cleanupTmpFiles(tmpFiles: string[]): Promise<void> {
  for (const tmp of tmpFiles) {
    try { await unlink(tmp); } catch { /* ignore cleanup errors */ }
  }
}
