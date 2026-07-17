/**
 * Detects when `failproofai` on the user's PATH is shadowed by a different,
 * older install — typically a leftover `bun link` from a prior dev session, or
 * a `bun install -g failproofai` whose prefix sorts ahead of npm's on PATH.
 *
 * Used by:
 *   - scripts/launch.ts — when .next/standalone/server.js is missing, produce a
 *     shadow-shaped error if the cause is a shadow rather than a genuinely
 *     broken build.
 *
 * Pure Node.js built-ins, no external dependencies. Every probe is wrapped in
 * try/catch — diagnoseShadow() is guaranteed not to throw.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const PKG_NAME = "failproofai";

/**
 * Walk up from `start` looking for a package.json whose name === "failproofai".
 * Returns its directory, or null when no such package.json is reachable.
 */
function findPackageRoot(start) {
  try {
    let dir = realpathSync(start);
    // If `start` was a file (e.g. /usr/local/bin/failproofai), step up to its dir.
    if (existsSync(dir) && !existsSync(resolve(dir, "package.json"))) {
      dir = dirname(dir);
    }
    while (true) {
      const pkgPath = resolve(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg.name === PKG_NAME) return dir;
        } catch {
          // unreadable or non-JSON — fall through to parent
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/** Read `version` from a package.json; null on any error. */
function readPackageVersion(packageRoot) {
  if (!packageRoot) return null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Find which `failproofai` PATH would resolve. POSIX: `command -v`; Win32: `where`. */
function resolvePathFirstBinary() {
  try {
    const isWin = platform() === "win32";
    const res = isWin
      ? spawnSync("where", [PKG_NAME], { encoding: "utf8" })
      : spawnSync("sh", ["-c", `command -v ${PKG_NAME}`], { encoding: "utf8" });
    if (res.status !== 0) return null;
    const first = (res.stdout || "").split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** Locate the npm global install of failproofai, if any. */
function locateNpmGlobal() {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (res.status !== 0) return null;
    const root = (res.stdout || "").trim();
    if (!root) return null;
    const candidate = resolve(root, PKG_NAME);
    return existsSync(resolve(candidate, "package.json")) ? candidate : null;
  } catch {
    return null;
  }
}

/** Locate the bun global install of failproofai, if any. */
function locateBunGlobal() {
  try {
    const candidate = resolve(homedir(), ".bun", "install", "global", "node_modules", PKG_NAME);
    return existsSync(resolve(candidate, "package.json")) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Build a copy-pasteable cleanup command for the offending install.
 *
 * The signal we trust is `pathFirstBin` — the un-resolved binary location PATH
 * pointed to. For bun-link shadows the realpath'd package root is the dev tree
 * (not under ~/.bun/), so checking the package root would mis-classify those
 * shadows as npm and recommend the wrong cleanup.
 */
function buildRecommendation(pathFirstBin) {
  if (!pathFirstBin) return null;
  const bunBinPrefix = resolve(homedir(), ".bun", "bin") + "/";
  const bunGlobalPrefix = resolve(homedir(), ".bun", "install", "global") + "/";
  const isBun = pathFirstBin.startsWith(bunBinPrefix) || pathFirstBin.startsWith(bunGlobalPrefix);
  if (isBun) {
    return `rm -f ~/.bun/bin/${PKG_NAME} && rm -rf ~/.bun/install/global/node_modules/${PKG_NAME}`;
  }
  return `npm rm -g ${PKG_NAME}`;
}

/**
 * Diagnose whether the running binary is being shadowed on PATH by a different
 * failproofai install.
 *
 * @param {{ selfPackageRoot: string, selfVersion: string | null }} self
 *   The package root and version of the binary calling diagnoseShadow().
 *   Callers (scripts/launch.ts) already have these values; passing them in keeps
 *   the helper deterministic and free of import.meta.url assumptions.
 */
export function diagnoseShadow(self) {
  const selfPackageRoot = (() => {
    try { return self?.selfPackageRoot ? realpathSync(self.selfPackageRoot) : null; }
    catch { return self?.selfPackageRoot ?? null; }
  })();
  const selfVersion = self?.selfVersion ?? null;

  const pathFirstBin = resolvePathFirstBinary();
  const pathFirstPackageRoot = pathFirstBin ? findPackageRoot(pathFirstBin) : null;
  const pathFirstVersion = readPackageVersion(pathFirstPackageRoot);

  const npmGlobalPath = locateNpmGlobal();
  const npmGlobalVersion = readPackageVersion(npmGlobalPath);

  const bunGlobalPath = locateBunGlobal();
  const bunGlobalVersion = readPackageVersion(bunGlobalPath);

  // "Shadow" covers two scenarios:
  //   1. Postinstall case — `selfPackageRoot` is the just-installed copy and
  //      PATH resolves elsewhere. Flag when the two roots differ.
  //   2. Runtime case — the running binary IS the shadow (so selfPackageRoot
  //      === pathFirstPackageRoot), but a *different* failproofai install
  //      exists at the npm or bun global. Flag when one of those differs from
  //      pathFirstPackageRoot.
  let shadowed = false;
  if (selfPackageRoot && pathFirstPackageRoot && pathFirstPackageRoot !== selfPackageRoot) {
    shadowed = true;
  } else if (pathFirstPackageRoot) {
    if (npmGlobalPath && npmGlobalPath !== pathFirstPackageRoot) shadowed = true;
    else if (bunGlobalPath && bunGlobalPath !== pathFirstPackageRoot) shadowed = true;
  }

  const recommendation = shadowed ? buildRecommendation(pathFirstBin) : null;

  // A short human-readable summary used by callers that want a one-liner.
  let shadowDescription = null;
  if (shadowed) {
    shadowDescription =
      `PATH resolves to ${pathFirstPackageRoot}` +
      (pathFirstVersion ? ` (v${pathFirstVersion})` : "") +
      `, but you just installed ${selfPackageRoot}` +
      (selfVersion ? ` (v${selfVersion})` : "") + ".";
  }

  return {
    selfPackageRoot,
    selfVersion,
    pathFirstBin,
    pathFirstPath: pathFirstPackageRoot,
    pathFirstVersion,
    npmGlobalPath,
    npmGlobalVersion,
    bunGlobalPath,
    bunGlobalVersion,
    shadowed,
    shadowDescription,
    recommendation,
  };
}
