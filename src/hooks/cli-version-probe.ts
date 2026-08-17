/**
 * Resolve an agent CLI's version by running `<binary> --version`.
 *
 * Two constraints shape every line of this file, both of them properties of the
 * warm worker that calls it:
 *
 * 1. **Nothing here may produce a promise.** There is no
 *    `process.on("unhandledRejection")` anywhere in the worker path, and Node's
 *    default is `--unhandled-rejections=throw`, so a single floating rejection
 *    kills the worker — and on a daemon-configured machine a dead worker denies
 *    the in-flight tool call. So this is callback-based `spawn`, never
 *    `execFile`-with-promise, never `async`. The `error` listener is mandatory
 *    rather than defensive: an unhandled `error` event on a ChildProcess throws
 *    out of the EventEmitter, which is an uncaught exception, which is the same
 *    dead worker.
 *
 * 2. **PATH cannot be trusted.** The worker inherits the daemon's environment,
 *    and the daemon is a system-scope service — systemd builds its PATH without
 *    ever reading a login shell, and launchd is worse. Every agent CLI here is
 *    installed by npm-global, a vendor installer, or Homebrew, none of which are
 *    on that PATH. `which copilot` from inside the worker returns nothing on a
 *    machine with copilot plainly installed, and it fails silently. So we search
 *    the install locations directly, the same way `scripts/dev-hook.mjs` already
 *    has to for bun.
 *
 * A probe that fails is not an error: it reports `null` and the caller records
 * that it tried. An uninstalled CLI, a renamed flag and a hung binary are all
 * the same answer here — "no version" — because none of them is worth a retry
 * storm on the hook path.
 */
import { spawn } from "node:child_process";
import { constants, accessSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Binary names per integration, matching `detectInstalled()` in
 * `integrations.ts`. Kept as a list because two integrations ship under more
 * than one name depending on install route.
 */
const CLI_BINARIES: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude", "claude-code"],
  codex: ["codex"],
  copilot: ["copilot"],
  // `integrations.ts` also accepts a bare `agent` for cursor. Deliberately NOT
  // repeated here: `detectInstalled()` only asks whether something with that
  // name is on PATH, while this module EXECUTES what it finds, across ~15
  // guessed directories. `agent` is a name plenty of unrelated programs use,
  // and one of those directories is writable by the agent we supervise.
  cursor: ["cursor-agent"],
  opencode: ["opencode"],
  pi: ["pi"],
  hermes: ["hermes"],
  openclaw: ["openclaw"],
  factory: ["droid"],
  devin: ["devin"],
  antigravity: ["agy"],
  goose: ["goose"],
};

/** Vendor install dirs, relative to HOME. `install-clis.sh` is the source. */
const HOME_BIN_DIRS = [
  ".local/bin",
  "bin",
  ".bun/bin",
  ".npm-global/bin",
  ".opencode/bin",
  ".factory/bin",
  ".cursor/bin",
  ".codex/bin",
  ".hermes/bin",
  ".openclaw/bin",
  ".pi/bin",
] as const;

const SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] as const;

/** Generous: the slowest CLI measured locally is ~1.2s, and this is off the hook path. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function probeTimeoutMs(): number {
  const raw = process.env.FAILPROOFAI_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

/** A `--version` that prints a banner must not be able to buffer without bound. */
const MAX_OUTPUT_BYTES = 4096;

function homeDir(): string {
  return process.env.HOME || homedir();
}

/**
 * The child's environment, with the running Node's own directory on PATH.
 *
 * Most of these CLIs are npm packages whose bin is a `#!/usr/bin/env node`
 * shim. The daemon is a system-scope service whose PATH is built without ever
 * reading a login shell — on a normal machine that is
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`, and nvm's node is on
 * none of them. The shebang then fails with `/usr/bin/env: ‘node’: No such
 * file or directory` and the CLI never runs at all: observed live on a real
 * daemon for codex, copilot and pi, on a machine where all three work
 * perfectly from a shell.
 *
 * `process.execPath` is the node actually executing this code, which is by
 * construction a node that exists. It is the same fix, for the same reason,
 * that the installed service unit already applies to the worker command.
 */
function childEnv(): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);
  const current = process.env.PATH ?? "";
  const alreadyThere = current.split(delimiter).includes(nodeDir);
  return alreadyThere ? process.env : { ...process.env, PATH: `${nodeDir}${delimiter}${current}` };
}

/**
 * Every directory that might hold an agent CLI, PATH first so an operator's own
 * choice wins over our guesses.
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  for (const entry of (process.env.PATH || "").split(delimiter)) push(entry);

  const home = homeDir();
  for (const rel of HOME_BIN_DIRS) push(join(home, rel));
  for (const dir of SYSTEM_BIN_DIRS) push(dir);

  // Every nvm-managed node version's bin dir. `npm i -g <cli>` lands the binary
  // in exactly ONE version's bin, so `nvm use <another>` hides it — the same
  // trap dev-hook.mjs documents for bun. Newest first.
  try {
    const nvmRoot = join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(nvmRoot).sort().reverse()) {
      push(join(nvmRoot, version, "bin"));
    }
  } catch {
    // No nvm on this machine.
  }

  return dirs;
}

/** Absolute path to the CLI's binary, or null when it is not installed. */
export function resolveCliBinary(cli: string): string | null {
  const names = CLI_BINARIES[cli];
  if (!names) return null;
  for (const dir of candidateDirs()) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        // `existsSync` alone accepts a directory or a non-executable file, and
        // resolution would stop there — leaving a genuinely installed CLI
        // permanently unprobeable behind a same-named decoy earlier on PATH.
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Missing, unreadable, or not executable — keep looking.
      }
    }
  }
  return null;
}

/**
 * First version-looking token in the output, or null.
 *
 * Loose about FORMAT — these vendors print anything from a bare `1.43.0` to
 * `droid version 0.171.0 (build abc123)` — but strict about there being a
 * version at all. An earlier version fell back to the whole first line when no
 * digit-led token was found, on the theory that recording something we can
 * eyeball beats recording nothing. Live on a real daemon that produced
 * `version: "/usr/bin/env: ‘node’: No such file or directory"` for three CLIs:
 * the probe had failed, and the fallback dressed the failure up as an answer.
 * A wrong version is worse than a missing one — it is the exact
 * claim-that-outlives-its-evidence this whole feature exists to catch — so
 * output with no version-shaped token is now simply no version.
 */
export function parseCliVersionOutput(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!line) return null;
  const match = line.match(/\d[\w.+-]*/);
  if (!match) return null;
  // Trailing punctuation is sentence punctuation, not part of the version.
  // Copilot prints `GitHub Copilot CLI 1.0.80.` — recording `1.0.80.` would
  // make every comparison against a real version string fail.
  const trimmed = match[0].replace(/[^0-9A-Za-z]+$/, "");
  return trimmed ? trimmed.slice(0, 64) : null;
}

/**
 * Run `<cli> --version`, calling `done` exactly once with the version or null.
 *
 * Never throws and never returns a promise. `done` is invoked inside a
 * try/catch because a throw from the caller's callback would otherwise surface
 * as an uncaught exception on the event loop, killing the worker for a
 * diagnostic.
 *
 * The child is `unref`'d, so this call does NOT hold the process open — which
 * is what we want inside the worker (whose listening socket keeps the loop
 * alive anyway, so the callback always lands) and is a trap anywhere else: a
 * short-lived script that starts a probe and has nothing else pending exits
 * before the callback fires, silently.
 */
export function probeCliVersion(cli: string, done: (version: string | null) => void): void {
  let settled = false;
  const finish = (version: string | null): void => {
    if (settled) return;
    settled = true;
    try {
      done(version);
    } catch {
      // A diagnostic must never take the process with it.
    }
  };

  let binary: string | null = null;
  try {
    binary = resolveCliBinary(cli);
  } catch {
    binary = null;
  }
  if (!binary) {
    finish(null);
    return;
  }

  try {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv(),
    });

    let out = "";
    const collect = (chunk: Buffer): void => {
      if (out.length >= MAX_OUTPUT_BYTES) return;
      out += chunk.toString("utf8");
    };

    // Our own deadline rather than spawn's `timeout` option, which sends one
    // SIGTERM and never escalates — a binary that ignores it is then never
    // reaped, `close` never fires, and the caller's in-flight latch is stuck
    // for the life of the worker. SIGKILL cannot be ignored.
    const deadline = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(parse(out));
    }, probeTimeoutMs());
    deadline.unref?.();

    const settle = (): void => {
      clearTimeout(deadline);
      finish(parse(out));
    };

    // Mandatory, not defensive — see the file header. An unhandled `error`
    // event throws out of the EventEmitter, which is an uncaught exception.
    child.on("error", () => {
      clearTimeout(deadline);
      finish(null);
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", collect);
    // Some vendors print the version to stderr; recording nothing for those
    // would be indistinguishable from "not installed".
    child.stderr?.on("data", collect);
    // `exit` fires when the process dies; `close` additionally waits for the
    // stdio streams, which a grandchild holding the pipe open can delay
    // indefinitely. Listening to both means the deadline is the only thing
    // that can be waiting on us.
    child.on("exit", settle);
    child.on("close", settle);
    child.unref?.();
  } catch {
    // spawn() throws synchronously on a bad path or an EMFILE.
    finish(null);
  }
}

/** Parsing is inside the caller's guarded path; keep it unable to throw here. */
function parse(out: string): string | null {
  try {
    return parseCliVersionOutput(out);
  } catch {
    return null;
  }
}
