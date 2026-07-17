#!/usr/bin/env node
/**
 * failproofai DEV-ONLY hook launcher — for THIS repo's dogfood configs only.
 *
 * End users never run this. They install `npx -y failproofai --hook <Event>`
 * (see `src/hooks/integrations.ts`), which resolves the published package.
 * This file exists because this repo dogfoods itself from source, and doing so
 * has two prerequisites that silently rot:
 *
 *   1. `bun` on the hook's PATH. `bin/failproofai.mjs` cannot run under node —
 *      it does a bare `import { version } from "../package.json"` (node needs
 *      `with { type: "json" }`) and `await import("../src/hooks/handler")`,
 *      an extensionless TypeScript specifier node cannot resolve. But bun is
 *      routinely absent from a hook's PATH even when it's on yours: `npm i -g
 *      bun` installs into ONE nvm version's bin dir, so `nvm use <other>` drops
 *      it; a macOS GUI launch gets a launchd PATH built without ~/.zshrc.
 *      When that happens every hook exits 127 and the session runs with ZERO
 *      policy enforcement — silently.
 *
 *   2. `dist/index.js`. The committed policies in `.failproofai/policies/`
 *      `import from 'failproofai'`, which `findDistIndex()` resolves to that
 *      bundle. Without it all three fail-open and only builtins enforce.
 *
 * So: locate bun (installing it via npm if we must), make sure the bundle
 * exists, then hand off to the real binary. If we cannot enforce, say so in
 * one line rather than failing silently.
 *
 * INVARIANT — never write to stdout. Most CLIs' deny contracts are JSON on
 * stdout (Copilot `{decision:"block"}`, Cursor `{followup_message}`, Devin,
 * Factory-on-Stop, Antigravity). A single stray byte corrupts the parse and
 * turns a denial into an allow. Diagnostics go to stderr; subprocesses we run
 * for our own purposes get their stdout discarded, never inherited.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC_BIN = resolve(REPO_ROOT, "bin", "failproofai.mjs");
const BUNDLE = resolve(REPO_ROOT, "dist", "index.js");
const CACHE_DIR = resolve(REPO_ROOT, "node_modules", ".cache", "failproofai-dev");
const LOCK_DIR = join(CACHE_DIR, ".lock");

/** A lock older than this belonged to a process that died mid-install. */
const LOCK_STALE_MS = 5 * 60_000;
/** 120 × 250ms = 30s, under the tightest hook timeout (Factory/Antigravity). */
const LOCK_WAIT_TRIES = 120;
const LOCK_WAIT_MS = 250;

/**
 * @typedef {object} Deps
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [platform]
 * @property {string} [execPath]
 * @property {string} [home]
 * @property {(p: string) => boolean} [exists]
 * @property {(p: string) => string[]} [readdir]
 */

function warn(msg) {
  process.stderr.write(`[failproofai-dev] ${msg}\n`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readdirSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Executable basenames to probe, most specific first. */
function exeNames(base, platform) {
  return platform === "win32" ? [`${base}.exe`, `${base}.cmd`, base] : [base];
}

/** First existing `<dir>/<name>` across dirs × names, or null. */
function probe(dirs, names, exists) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Absolute path to a bun executable, or null. NEVER spawns a subprocess —
 * this runs on every hook, so it is an existsSync walk and nothing more.
 * @param {Deps} deps
 */
export function findBun(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? readdirSafe;

  const dirs = [];
  const push = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };

  // 1. PATH — the common case, and the only one that costs nothing.
  for (const p of (env.PATH ?? "").split(delimiter)) push(p);
  // 2. An explicit bun install root.
  if (env.BUN_INSTALL) push(join(env.BUN_INSTALL, "bin"));
  // 3. Where bun.sh's installer puts it. The macOS GUI-launch case: launchd's
  //    PATH has /usr/local/bin but never ~/.bun/bin.
  push(join(home, ".bun", "bin"));
  // 4. Package-manager prefixes.
  if (platform !== "win32") {
    push("/opt/homebrew/bin");
    push("/usr/local/bin");
  }
  // 5. Every nvm-managed node version's bin dir. Load-bearing: `npm i -g bun`
  //    lands bun in exactly ONE version's bin, so `nvm use <another>` makes it
  //    vanish from PATH entirely while it's still perfectly usable on disk.
  //    Descending so the newest version wins deterministically.
  const nvmRoot = join(home, ".nvm", "versions", "node");
  for (const v of readdir(nvmRoot).sort().reverse()) push(join(nvmRoot, v, "bin"));
  // 6. Next to the running node. For our own `node scripts/dev-hook.mjs` form
  //    this is a strict subset of (1) — node was resolved from PATH — so it is
  //    a no-op. Kept only for a caller that spawns node by absolute path.
  push(dirname(execPath));

  // Cache from a previous npm-install (see installBun). Last, so a real bun
  // that reappears on PATH always wins over our vendored copy.
  push(join(CACHE_DIR, "node_modules", ".bin"));

  return probe(dirs, exeNames("bun", platform), exists);
}

/** Absolute path to npm, or null. PATH only — npm ships beside node. */
export function findNpm(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return probe(dirs, exeNames("npm", platform), exists);
}

/**
 * `{ cmd, args }` to run the real binary, or null when bun is unfindable.
 * Shared with `.opencode/plugins/failproofai.mjs`, which spawns bun itself.
 * @param {Deps} deps
 */
export function resolveDevSpawn(deps = {}) {
  const bun = findBun(deps);
  return bun ? { cmd: bun, args: [SRC_BIN] } : null;
}

/** One actionable line. Keep it to one — this can fire on 26 events. */
export function bunMissingMessage() {
  return (
    "bun not found and npm unavailable to install it — this repo's dogfood hooks are NOT " +
    "enforcing. Install bun: curl -fsSL https://bun.sh/install | bash"
  );
}

/**
 * Run `doWork` at most once across concurrently-firing hooks. `mkdirSync` is
 * atomic, so it doubles as the lock: EEXIST means another process got there.
 * Losers wait for the artifact rather than duplicating the work.
 */
function ensureOnce(isDone, doWork) {
  if (isDone()) return true;
  mkdirSync(CACHE_DIR, { recursive: true });

  for (let i = 0; i < LOCK_WAIT_TRIES; i++) {
    if (isDone()) return true;
    try {
      mkdirSync(LOCK_DIR);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } else {
          sleepSync(LOCK_WAIT_MS);
        }
      } catch {
        /* lock vanished under us — retry immediately */
      }
      continue;
    }
    try {
      doWork();
    } finally {
      try {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        /* best effort; a leaked lock goes stale in LOCK_STALE_MS */
      }
    }
    return isDone();
  }
  return isDone();
}

/**
 * Vendor bun into node_modules/.cache via npm. bun ships as an npm package, so
 * npm is the one bootstrap that works when bun is genuinely absent — building
 * `dist/cli.mjs` to run under node can't, because `build:cli` is itself
 * `bun build`.
 */
function installBun(deps = {}) {
  const npm = findNpm(deps);
  if (!npm) return null;
  ensureOnce(
    () => findBun(deps) !== null,
    () => {
      warn("bun not found — installing it into node_modules/.cache (one time, ~15s)");
      const r = spawnSync(
        npm,
        ["install", "bun", "--prefix", CACHE_DIR, "--no-save", "--no-audit", "--no-fund", "--loglevel=error"],
        // NOT "inherit" on stdout: npm prints there, and our stdout is a deny
        // channel. stderr passes through so a failed install is visible.
        { stdio: ["ignore", "ignore", "inherit"], cwd: REPO_ROOT },
      );
      if (r.status !== 0) warn("npm install bun failed — see the error above");
    },
  );
  return findBun(deps);
}

/**
 * Build dist/index.js if absent, so `.failproofai/policies/*.mjs` can resolve
 * `import ... from 'failproofai'`. Non-fatal: builtins enforce without it.
 */
export function ensureBundle(bunPath) {
  return ensureOnce(
    () => existsSync(BUNDLE),
    () => {
      warn("dist/index.js missing — building it so .failproofai/policies/ can load (one time)");
      const r = spawnSync(
        bunPath,
        ["build", "--target=node", "--format=cjs", "--outfile=dist/index.js", "src/index.ts"],
        { stdio: ["ignore", "ignore", "inherit"], cwd: REPO_ROOT },
      );
      if (r.status !== 0) warn("build failed — policies in .failproofai/policies/ will NOT load");
    },
  );
}

function main() {
  const bun = findBun() ?? installBun();
  if (!bun) {
    warn(bunMissingMessage());
    process.exit(1);
  }
  ensureBundle(bun);

  // stdio:"inherit" hands the child our actual fds: the payload on stdin and
  // any decision JSON on stdout flow byte-exact, unbuffered, unparsed by us.
  // No cwd override — the child must see whatever cwd the agent CLI chose,
  // exactly as it did when the config spawned bun directly.
  const r = spawnSync(bun, [SRC_BIN, ...process.argv.slice(2)], { stdio: "inherit" });

  // Exit codes are a contract, not a status: 2 means DENY on Claude/Factory/
  // Goose. Propagate verbatim. Never synthesize 2 (would deny) or 0 (would
  // silently allow).
  if (r.error) {
    warn(`could not run bun (${r.error.code ?? r.error.message}) — hooks are NOT enforcing`);
    process.exit(1);
  }
  if (r.status === null && r.signal) {
    // Mirror what `sh` reports for a signalled child, which is what the agent
    // CLI saw before this launcher sat in between.
    process.exit(128 + (constants.signals[r.signal] ?? 15));
  }
  process.exit(r.status ?? 1);
}

// Only run when executed, not when `.opencode/plugins/failproofai.mjs` imports
// the resolver. realpath so a symlinked or relative argv[1] still matches.
let invokedDirectly = false;
try {
  invokedDirectly = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) main();
