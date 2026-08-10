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
import { readFile, writeFile, unlink, access, mkdir, lstat } from "fs/promises";
import { tmpdir } from "os";
import { resolve, dirname, relative, join } from "path";
import { pathToFileURL } from "url";
import { createHash } from "crypto";
import { shimsDir } from "./fp-home";
import { hookLogWarn } from "./hook-logger";

export const TMP_SUFFIX = ".__failproofai_tmp__.mjs";

/**
 * Anything this loader generated, by name.
 *
 * The temporary tree is written BESIDE the user's sources, because that is the
 * only place a rewritten relative import still resolves. That was harmless
 * while the name was fixed — an abnormally terminated hook left at most one
 * stale file per source, overwritten on the next load — but the name now
 * carries a pid and a sequence number, so every kill (a CLI hook timeout, a
 * Ctrl-C) leaves a uniquely-named file behind forever.
 *
 * Two consequences, and the second is the visible one: the directory fills up,
 * and `findSkippedPolicyFiles` reports each leftover back to the user as a
 * policy file that will not load — an accusation about a file failproofai
 * wrote itself.
 */
const TMP_ARTIFACT_RE = /\.__failproofai_tmp__\./;

/** True for a file this loader generated rather than one the user wrote. */
export function isTmpArtifact(name: string): boolean {
  return TMP_ARTIFACT_RE.test(name);
}

/**
 * How stale a generated file must be before a sweep will remove it.
 *
 * Another process may be mid-load right now, and its temporary tree is live
 * until its `import()` resolves. Well past the 10s a module load is allowed,
 * so a sweep can never delete a file another loader is still using.
 */
const TMP_SWEEP_MIN_AGE_MS = 60_000;

/**
 * Remove generated files left behind by a load that was killed.
 *
 * Best-effort and never throws: this runs on the hook path, and failing to
 * tidy up is not worth failing an evaluation over.
 */
export async function sweepStaleTmpArtifacts(dir: string, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    const { readdir, stat } = await import("fs/promises");
    for (const name of await readdir(dir)) {
      if (!isTmpArtifact(name)) continue;
      const path = resolve(dir, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < TMP_SWEEP_MIN_AGE_MS) continue;
        await unlink(path);
        removed++;
      } catch {
        /* raced with another sweep, or not ours to remove */
      }
    }
  } catch {
    /* unreadable directory — nothing to sweep */
  }
  return removed;
}

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
/**
 * Create the ESM shim that lets a policy file's `import ... from 'failproofai'`
 * resolve, and return where it landed.
 *
 * NOT beside `dist/index.js`, which is where this used to go. That directory
 * belongs to whoever installed the package, and on a system-wide install
 * (`sudo npm i -g`, a container image, a shared build host, a CI runner) it is
 * root-owned — so every non-root user running a hook failed with EACCES, the
 * policy never loaded, and the hook exited 0. Builtins kept firing while
 * cloud-managed and custom policies silently stopped, so the machine looked
 * protected. That is the worst available failure for a policy engine.
 *
 * Two locations, and the ORDER OF OPERATIONS matters more than the choice:
 *
 *  1. `<home>/state/shims` — created at 0700 and owned by the user running the
 *     hook. Unlike a shared `/tmp`, no other local user can pre-plant a file at
 *     a path we are about to `import`.
 *  2. `os.tmpdir()` — only when the first is unusable.
 *
 * **The write lives inside the same `try` as the mkdir on purpose.** `mkdir`
 * with `recursive` RESOLVES on a directory that already exists, whatever its
 * mode — so a `state/shims` left behind unwritable (a container that ran the
 * CLI as root and then dropped to a non-root user; this very function creates
 * that chain) would sail past a mkdir-only guard and throw EACCES on the write,
 * reproducing the exact fail-open this function exists to fix. Any failure of
 * either step falls through to the fallback, and says so — a silent slide into
 * the weaker path is the same class of bug again.
 */
async function writeShim(
  dir: string,
  name: string,
  code: string,
  exclusive: boolean,
): Promise<string> {
  const shimPath = join(dir, name);
  // 0600 explicitly: an unset mode is `0666 & ~umask`, and `umask 000` is
  // routine in containers — which in the fallback means a world-writable file
  // in shared /tmp that this process then imports.
  await writeFile(shimPath, code, {
    encoding: "utf-8",
    mode: 0o600,
    ...(exclusive ? { flag: "wx" as const } : {}),
  });
  return shimPath;
}

export async function createEsmShim(
  _distIndex: string,
  distUrl: string,
  tmpSuffix = TMP_SUFFIX,
): Promise<{ shimPath: string; shimUrl: string }> {
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
  // The name still carries `tmpSuffix` (pid + load sequence + a random id).
  // `fingerprintTemporaryTree` normalises exactly that substring away before
  // hashing, so the policy module cache still hits; a name it could not
  // normalise would force a cold module load on every single hook call.
  const name = `failproofai-dist${tmpSuffix}.shim.mjs`;

  try {
    const dir = shimsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir` accepts a pre-existing SYMLINK here and a plain write would
    // follow it out of the home. Confirm we got a real directory we own,
    // unreadable to anyone else, before writing something we are about to
    // execute.
    const st = await lstat(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid) || st.mode & 0o077) {
      throw new Error(`${dir} is not a private directory owned by this user`);
    }
    const shimPath = await writeShim(dir, name, shimCode, false);
    return { shimPath, shimUrl: pathToFileURL(shimPath).href };
  } catch (err) {
    hookLogWarn(
      `policy shim directory unusable (${err instanceof Error ? err.message : String(err)}); falling back to ${tmpdir()}`,
    );
  }

  // Predictable name in a shared directory, so O_EXCL: refuse rather than write
  // through something another user planted.
  const shimPath = await writeShim(tmpdir(), name, shimCode, true);
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
  /**
   * SHA-256 the ENTRY file's raw bytes must match, re-checked here at the moment
   * they are read for rewriting and import. Cloud-managed policies pass their
   * pinned digest so the bytes that get imported are the same bytes that were
   * verified — closing a TOCTOU where an earlier caller hashed the file, then
   * this function independently re-read it (a window in which a same-user
   * attacker could swap the bytes so a verified file imports unverified code).
   * Only the entry is content-addressed; transitive local imports are not.
   */
  entrySha256?: string | null,
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

    let code: string;
    if (entrySha256 && filePath === entryPath) {
      // Read the raw bytes, verify the pin against THEM, then decode and rewrite
      // that same in-memory content — filePath is never read again, so the bytes
      // imported below are exactly the bytes verified here.
      const buf = await readFile(filePath);
      const actual = createHash("sha256").update(buf).digest("hex");
      if (actual !== entrySha256) {
        throw new Error(
          `cloud-managed policy failed integrity re-verification at load: expected ${entrySha256}, got ${actual}`,
        );
      }
      code = buf.toString("utf-8");
    } else {
      code = await readFile(filePath, "utf-8");
    }

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
