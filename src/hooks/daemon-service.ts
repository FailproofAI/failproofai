/**
 * Installs/uninstalls/checks failproofaid as a real OS-level user service
 * (systemd `--user` on Linux, launchd `LaunchAgent` on macOS) so it's
 * "constant" — starts at login, restarts on crash — without ever needing
 * elevation. User-scope only, matching the daemon itself.
 *
 * No public `failproofai daemon install`-style subcommand exists —
 * `configure-wizard.ts` calls the functions here directly, the same
 * relationship it already has with `manager.ts`'s `installHooks()`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { hookLogWarn } from "./hook-logger";
import { getConfigPathForScope } from "./hooks-config";
import { downloadFailproofaidBinary, installFromNpmPackage, installedBinaryPath } from "./daemon-download";
import { logsDir } from "./fp-home";
import { version } from "../../package.json";
import { readVersionFile, updateConfig, writeVersionFile } from "./fp-config";

/**
 * Every `systemctl --user` / `launchctl` call is bounded. Both talk to a
 * per-user session bus or to launchd, and a wedged session makes an
 * unbounded `execFileSync` block forever — inside the interactive wizard
 * that reads as a hang with no output at all (`stdio: "ignore"`), right
 * after the user pressed "apply". A timeout throws instead, which the
 * existing `catch` already turns into a clean `{ installed: false, reason }`.
 */
const SERVICE_CMD_TIMEOUT_MS = 10_000;

/**
 * How long to wait for the service manager to actually get the daemon into
 * a running state after `enable --now` / `load -w`. Both commands return as
 * soon as the job is accepted, which is well before the process has proven
 * it can stay up.
 */
const SERVICE_START_TIMEOUT_MS = 5_000;
const SERVICE_START_POLL_MS = 100;
/**
 * How long a unit has to still be running after it first reports running.
 * `systemctl --user is-active` calls a `Type=simple` unit active the moment
 * it forks, so a daemon that dies immediately still reports active once —
 * a single check would wave through exactly the crash-at-startup case this
 * is here to catch. Comfortably longer than the unit's `RestartSec=2`
 * head start, so a daemon that already died reads as
 * `activating (auto-restart)` by the time of the re-check.
 */
const SERVICE_SETTLE_MS = 750;

/**
 * How long `sudo -v` may sit at its password prompt. Unlike every other
 * timeout here, this one is waiting on a human typing, not on a service
 * manager — three attempts at a password is well inside two minutes, and
 * sudo gives up on its own long before that.
 */
const SUDO_PROMPT_TIMEOUT_MS = 120_000;

/**
 * Writes (or clears) the machine-wide `daemonConfigured` marker in
 * `~/.failproofai/policies-config.json`.
 *
 * This flag is what makes `bin/failproofai.mjs` fail *closed* — deny every
 * hook event rather than fall back to in-process evaluation — so it has to
 * track "this machine has a daemon", not "a service manager once accepted a
 * job". Install only sets it after the daemon is verified running; uninstall
 * clears it, so removing the service restores the in-process path instead of
 * leaving the machine denying every tool call across all 11 CLIs against a
 * socket that no longer exists.
 *
 * Global scope only: whether *this machine* runs a daemon is not a
 * per-project setting.
 */
export function setDaemonConfigured(value: boolean, installedVersion?: string): void {
  try {
    updateConfig({ daemon: { configured: value } });
    // The version lives in VERSION, not here. One file is ABOUT versions and
    // one copy cannot disagree with itself; keeping a second in config.toml
    // would be a field that drifts out of step with the file beside it —
    // exactly the class of bug the single path module exists to prevent.
    // Cleared on uninstall: a recorded binary version for a service that is no
    // longer configured is a claim about this machine that is no longer true.
    writeVersionFile({ daemon: value ? installedVersion : undefined, clearDaemon: !value });
  } catch {
    /* best-effort: never fail a completed setup (or uninstall) over this flag */
  }
}

export type DaemonServiceStatus = "running" | "stopped" | "not-installed" | "unsupported-platform";

/** Linux + macOS only, per the plan's platform scope — full stop. */
export function isDaemonSupportedPlatform(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

export type PlatformKey = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

function platformKey(): PlatformKey | null {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) return null;
  return `${os}-${arch}` as PlatformKey;
}

/**
 * Locates the real, compiled `failproofaid` binary — never the JS bin
 * shim (`bin/failproofaid-shim.mjs`), which only exists so a user can run
 * `failproofaid` by hand. A service manager needs a direct path to the
 * actual native binary, not a wrapper it would have to keep alive itself.
 *
 * Resolution order: an explicit test/dev override, the binary downloaded
 * from this version's GitHub Release (see `daemon-download.ts`), then a
 * locally-built dev binary under `target/{release,debug}/failproofaid`
 * relative to the package root — so this works when driving the wizard from
 * a source checkout (`bun run daemon:dev`-style flows) with nothing
 * downloaded at all.
 *
 * Read-only by design: it reports what is already on disk and never fetches.
 * `ensureFailproofaidBinary` is the one that may reach the network, so the
 * hook path — which calls this — can never block on a download.
 */
export function resolveFailproofaidBinaryPath(): string | null {
  if (process.env.FAILPROOFAI_DAEMON_BINARY) return process.env.FAILPROOFAI_DAEMON_BINARY;

  const downloaded = installedBinaryPath();
  if (existsSync(downloaded)) return downloaded;

  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (packageRoot) {
    for (const profile of ["release", "debug"]) {
      const candidate = resolve(packageRoot, "target", profile, "failproofaid");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Resolves the binary, installing one if it is not already on disk.
 *
 * Only the install path calls this — `failproofai config` choosing the global
 * scope is the moment a machine that opted into a daemon actually acquires
 * one. Two channels, in this order:
 *
 *   1. The `@failproofai/failproofaid-<os>-<arch>` platform package, which a
 *      plain `npm install failproofai` already brought down as an optional
 *      dependency. No network, so it is also the only channel that works
 *      air-gapped or behind a proxy that blocks github.com.
 *   2. The GitHub Release asset for this exact version, checksum-verified.
 *      Covers installs that skipped optional dependencies, older tarballs, and
 *      anyone installing the daemon standalone.
 */
export async function ensureFailproofaidBinary(): Promise<{ path?: string; reason?: string }> {
  const existing = resolveFailproofaidBinaryPath();
  if (existing) return { path: existing };

  const key = platformKey();
  if (!key) {
    return { reason: `failproofaid has no prebuilt binary for ${process.platform}/${process.arch}` };
  }

  const fromNpm = installFromNpmPackage(key);
  if (fromNpm.path) return { path: fromNpm.path };

  const result = await downloadFailproofaidBinary(key);
  if (result.path) return { path: result.path };
  // Both channels are worth reporting: "not installed" alone reads as a broken
  // package, and the download error alone hides that npm could have supplied it.
  return {
    reason: result.error
      ? `${result.error} (${fromNpm.error})`
      : "failproofaid binary could not be installed",
  };
}

/**
 * Resolves the command the daemon should use to spawn its warm worker,
 * passed through as `FAILPROOFAI_WORKER_CMD` in the service's own
 * environment.
 *
 * This is NOT optional the way it might look — `crates/failproofaid`'s
 * built-in fallback (`node dist/worker.mjs`, used only when
 * `FAILPROOFAI_WORKER_CMD` is unset) is a *relative* path, correct only
 * when the daemon happens to be spawned with the npm package's own
 * directory as its cwd. A service manager spawns processes from an
 * arbitrary cwd (typically `/` or the user's home), so that fallback
 * would silently fail to find the bundled worker in every real service
 * install — caught by actually starting the installed service in a clean
 * container rather than by reasoning about it. Resolving an absolute path
 * here, once, at install time, and handing it to the daemon via the
 * environment closes that gap entirely.
 */
export function resolveWorkerCommand(): string | null {
  if (process.env.FAILPROOFAI_WORKER_CMD) return process.env.FAILPROOFAI_WORKER_CMD;

  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (!packageRoot) return null;
  const workerScript = resolve(packageRoot, "dist", "worker.mjs");
  if (!existsSync(workerScript)) return null;
  // Both paths are shell-quoted: the daemon runs this value through `sh -c`
  // (`WorkerCommand::Shell` in crates/failproofaid/src/worker.rs), so an
  // unquoted path splits on its spaces and the worker never starts. Not
  // hypothetical on macOS, where `/Users/First Last/...` is ordinary — and
  // more exposed since execPath replaced a bare `node`, because execPath is
  // home-derived. systemd's own `Environment="..."` quoting does not help
  // here; that protects the unit parse, not the later shell split.
  //
  // `process.execPath`, not a bare `node`. A system-scope service does not
  // inherit a login environment, so its PATH is the system default — and the
  // single most common way to install Node is nvm, which puts it under
  // ~/.nvm/versions/node/*/bin and nowhere on that PATH. A bare `node` would
  // resolve fine when the wizard runs it and then fail inside the service,
  // silently, on exactly the machines least likely to notice. execPath is
  // whatever runtime is executing this CLI right now (node for the published
  // bin, bun in a source checkout), absolute either way.
  return `${shellQuote(process.execPath)} ${shellQuote(workerScript)}`;
}

/**
 * Resolves the command the daemon should use to run a one-shot `failproofai`
 * CLI task — today the scheduled audit — passed through as
 * `FAILPROOFAI_CLI_CMD` in the service's own environment.
 *
 * Everything `resolveWorkerCommand` says about `process.execPath` and the
 * shell quoting applies here verbatim, for the same reason: a system-scope
 * unit gets no login environment, so its PATH is the system default, and the
 * single most common Node install (nvm) is on no system PATH. The difference
 * is the consequence of getting it wrong. A worker that cannot start makes the
 * daemon visibly unhealthy; an audit that cannot start is SILENT — the config
 * says the scan is on, nothing ever runs, and the only symptom is a dashboard
 * that quietly stops moving.
 *
 * `dist/cli.mjs` (package.json's `bin.failproofai`), not `bin/failproofai.mjs`
 * — the latter has a `#!/usr/bin/env bun` shebang and uses syntax node cannot
 * load (a bare `import … from "../package.json"`, extensionless `.ts`
 * specifiers). Only the bundle is node-runnable, and it sits beside the
 * `dist/worker.mjs` the worker command already points at.
 */
export function resolveCliCommand(): string | null {
  if (process.env.FAILPROOFAI_CLI_CMD) return process.env.FAILPROOFAI_CLI_CMD;

  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (!packageRoot) return null;
  const cliScript = resolve(packageRoot, "dist", "cli.mjs");
  if (!existsSync(cliScript)) return null;
  return `${shellQuote(process.execPath)} ${shellQuote(cliScript)}`;
}

/** POSIX single-quoting: everything is literal inside '…', and a literal
 *  quote is closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment the service definition carries, built once so the systemd
 * and launchd renderers cannot drift apart — a variable added to one and not
 * the other is invisible until somebody runs the other platform.
 *
 * Order is fixed rather than incidental: `upgradedServiceDefinition` rebuilds
 * a definition from these renderers, so a stable order is what makes a
 * rewritten unit byte-identical to a freshly installed one rather than merely
 * equivalent — which is the difference between a diff a human can read and one
 * they stop reading.
 */
/**
 * Characters that cannot appear in a value interpolated into a systemd unit.
 *
 * A newline ENDS THE DIRECTIVE, so a path containing one injects arbitrary
 * settings into a file that is installed root-owned at `/etc/systemd/system`
 * and loaded at every boot. A double quote closes `Environment="..."` early and
 * does the same; a backslash is systemd's own escape character inside a quoted
 * value and makes the result unpredictable rather than merely wrong.
 *
 * The mechanism is demonstrated by this repo's own test, which sets
 * `FAILPROOFAI_CLI_CMD` to `/usr/bin/true"\nUser=failproofai-no-such-user` and
 * relies on systemd HONOURING the injected `User=` — it passes only because the
 * injected user does not exist. A valid one (`User=root`, or an added
 * `ExecStartPre=`) would have succeeded silently, undoing the
 * "root-installed but never root-run" invariant the whole design rests on.
 *
 * These values are resolved paths and commands; none can legitimately contain
 * any of these characters. So this REJECTS rather than escaping — a unit that
 * refuses to be written is a clear failure, and inventing an escaping scheme
 * for systemd's grammar is a larger surface than the problem.
 */
const UNIT_UNSAFE_RE = /["\\\r\n]/;

/** Throws when a value cannot be safely interpolated into a unit file. */
function assertUnitSafe(value: string, field: string): string {
  if (UNIT_UNSAFE_RE.test(value)) {
    throw new Error(
      `refusing to write a service definition: ${field} contains a quote, backslash or newline ` +
        `(${JSON.stringify(value)}), which would inject directives into a root-owned unit file`,
    );
  }
  return value;
}

function serviceEnvironment(workerCmd: string | null, cliCmd: string | null): [string, string][] {
  const entries: [string, string][] = [];
  if (workerCmd) entries.push(["FAILPROOFAI_WORKER_CMD", workerCmd]);
  if (cliCmd) entries.push(["FAILPROOFAI_CLI_CMD", cliCmd]);
  return entries;
}

/**
 * The account the daemon runs as. The service is root-*installed* but never
 * root-*run*: everything it touches (the socket, the lock, the policy config)
 * lives in one user's home and is peer-checked against that user's uid.
 */
function serviceUser(): string {
  return userInfo().username;
}

/**
 * `/etc/systemd/system/failproofaid@<user>.service`.
 *
 * The `@<user>` suffix is systemd's convention for a per-user instance, but
 * this is a concrete unit file rather than an instance of a template: every
 * field that matters is user-specific (the ExecStart path is under the user's
 * own ~/.failproofai/bin, so is HOME, so is the worker command), so a shared
 * template would need a per-instance drop-in for all of them and buy nothing.
 * Naming it per-user is what keeps a second user's install from silently
 * stealing the first's unit — a single `failproofaid.service` would.
 */
function systemdUnitName(user: string = serviceUser()): string {
  return `failproofaid@${user}.service`;
}

function systemdUnitPath(user: string = serviceUser()): string {
  return resolve("/etc/systemd/system", systemdUnitName(user));
}

/**
 * The pre-1.0.0-beta.1 user-scope unit. Still removed on install and
 * uninstall: it holds the same flock the new service needs, so leaving one
 * behind means the system unit starts, loses the singleton race, and the
 * machine sits fail-closed against a daemon that never came up.
 */
function legacySystemdUserUnitPath(): string {
  return resolve(homedir(), ".config", "systemd", "user", "failproofaid.service");
}

/**
 * Per user, for the same reason the systemd unit is: a LaunchDaemon's
 * contents are entirely user-specific — `UserName`, the ExecStart path under
 * that user's `~/.failproofai/bin`, the log paths under that user's home — so
 * one shared label means the second user's install silently overwrites the
 * first's daemon, and their uninstall deletes it.
 */
function launchdLabel(user: string = serviceUser()): string {
  return `ai.failproof.failproofaid.${user}`;
}

function launchdPlistPath(user: string = serviceUser()): string {
  return `/Library/LaunchDaemons/${launchdLabel(user)}.plist`;
}

/** The pre-1.0.0-beta.1 LaunchAgent. */
function legacyLaunchAgentPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", "ai.failproof.failproofaid.plist");
}

/**
 * The 1.0.0-beta.1 LaunchDaemon, before the label was namespaced. Removed on
 * install like the LaunchAgent is: it holds the same singleton flock, so
 * leaving it would leave two daemons racing for one socket.
 */
function legacySharedLaunchDaemonPath(): string {
  return "/Library/LaunchDaemons/ai.failproof.failproofaid.plist";
}

/**
 * The service-definition file `installDaemonService` would write on this
 * platform (the systemd unit or the launchd plist) — exposed so the config
 * wizard's review screen can show it alongside every other file it's about
 * to change, `null` on an unsupported platform.
 */
export function daemonServiceFilePath(): string | null {
  if (!isDaemonSupportedPlatform()) return null;
  return process.platform === "linux" ? systemdUnitPath() : launchdPlistPath();
}

/**
 * The command a user runs to inspect their own daemon — surfaced so the
 * wizard can print it instead of leaving people to discover which service
 * manager, and which scope, is involved.
 */
export function daemonStatusCommand(): string | null {
  if (!isDaemonSupportedPlatform()) return null;
  return process.platform === "linux"
    ? `systemctl status ${systemdUnitName()}`
    : `sudo launchctl print system/${launchdLabel()}`;
}

/**
 * The command that restarts the daemon, for the places where a config change
 * only takes effect on the next start.
 *
 * `--disconnect` is the motivating case: the collector manager starts once for
 * the daemon's lifetime and the uploader caches its bearer key at construction,
 * so removing the credential file changes nothing about the process already
 * running.
 */
export function daemonRestartCommand(): string | null {
  if (!isDaemonSupportedPlatform()) return null;
  return process.platform === "linux"
    ? `sudo systemctl restart ${systemdUnitName()}`
    : `sudo launchctl kickstart -k system/${launchdLabel()}`;
}

/**
 * Acquires sudo credentials up front, prompting in the terminal if needed.
 *
 * `sudo -v` refreshes the user's sudo timestamp and returns; every later
 * `sudo -n` in this run then succeeds against that cached credential. Doing it
 * here, once, at a known point in the wizard is what makes the rest of the
 * install non-interactive — the alternative, an interactive sudo firing from
 * underneath a half-drawn TUI screen, is a password prompt the user cannot
 * see.
 *
 * NOT the same as running the whole CLI under sudo, which is actively wrong:
 * `homedir()` would become /root, so the hooks, the policy config, the
 * downloaded binary and the unit's own `User=` would all be root's rather
 * than the user's, quietly configuring the wrong account.
 *
 * `stdio: "inherit"` so the prompt and the typed password go straight to the
 * real terminal. The timeout is generous because a human is typing.
 */
export function primeElevation(): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  if (canElevate()) return true; // NOPASSWD, or already primed
  try {
    execFileSync("sudo", ["-v"], { stdio: "inherit", timeout: SUDO_PROMPT_TIMEOUT_MS });
    return canElevate();
  } catch {
    // Wrong password, no sudo rights, or the user pressed ctrl-C. All of them
    // mean the same thing here: carry on without a daemon.
    return false;
  }
}

/**
 * True when privileged commands can run without prompting for a password.
 *
 * Exported because onboarding re-checks it: `needs_root` is the most common
 * reason setup aborts, and it is the one most likely to stop being true (the
 * user gets sudo rights, or primes their timestamp in another terminal). One
 * `sudo -n true`, no prompt, milliseconds — and never on the hook path, which
 * does not reach the first-run gate at all.
 */
export function canElevate(): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: SERVICE_CMD_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one privileged command, non-interactively.
 *
 * `sudo -n` on purpose: the wizard owns the terminal, and a sudo password
 * prompt fired from underneath a TUI is unreadable at best. A machine that
 * cannot elevate silently gets a clear reason and the manual commands
 * instead — it keeps working exactly as it did, on the in-process path.
 */
function runPrivileged(command: string, args: string[]): void {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const [cmd, argv] = root ? [command, args] : ["sudo", ["-n", command, ...args]];
  execFileSync(cmd, argv, { stdio: "ignore", timeout: SERVICE_CMD_TIMEOUT_MS });
}

/**
 * Installs a file into a root-owned location via a temp file, because the
 * caller is not root and cannot write there directly. `install -m` sets the
 * mode in the same step, so the file is never briefly world-writable.
 */
function writePrivilegedFile(destination: string, contents: string, mode = "0644"): void {
  // mkdtempSync, not a name built from pid + timestamp in the shared tmpdir.
  // That name is guessable, and `writeFileSync` follows a symlink already
  // sitting at the path — so on a multi-user box another local user could
  // pre-create it and have `install` copy content they control into
  // /etc/systemd/system as root. mkdtemp gives a 0700 directory with a name
  // they cannot predict, so there is nothing to pre-create.
  const stagingDir = mkdtempSync(resolve(tmpdir(), "failproofaid-stage-"));
  const staging = resolve(stagingDir, "service-definition");
  try {
    writeFileSync(staging, contents, "utf8");
    runPrivileged("install", ["-m", mode, staging, destination]);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Removes a daemon installed by an earlier version into the user's own
 * session scope. Best-effort and never privileged — these paths are all
 * inside the user's home.
 */
function removeLegacyUserService(): void {
  try {
    if (process.platform === "linux") {
      const legacy = legacySystemdUserUnitPath();
      if (!existsSync(legacy)) return;
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "failproofaid.service"], {
          stdio: "ignore",
          timeout: SERVICE_CMD_TIMEOUT_MS,
        });
      } catch {
        // Not loaded — removing the file is still the point.
      }
      unlinkSync(legacy);
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], {
          stdio: "ignore",
          timeout: SERVICE_CMD_TIMEOUT_MS,
        });
      } catch {
        /* best-effort */
      }
    } else {
      const legacyAgent = legacyLaunchAgentPlistPath();
      if (existsSync(legacyAgent)) {
        try {
          execFileSync("launchctl", ["unload", "-w", legacyAgent], {
            stdio: "ignore",
            timeout: SERVICE_CMD_TIMEOUT_MS,
          });
        } catch {
          /* not loaded */
        }
        unlinkSync(legacyAgent);
      }

      // The 1.0.0-beta.1 daemon, before the label was per-user. Privileged,
      // and only reachable on a path that has already elevated.
      const legacyDaemon = legacySharedLaunchDaemonPath();
      if (existsSync(legacyDaemon)) {
        try {
          runPrivileged("launchctl", ["unload", "-w", legacyDaemon]);
        } catch {
          /* not loaded */
        }
        runPrivileged("rm", ["-f", legacyDaemon]);
      }
    }
  } catch (err) {
    hookLogWarn(`could not remove the legacy user-scope daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function systemdUnitContents(
  binaryPath: string,
  workerCmd: string | null,
  cliCmd: string | null = null,
): string {
  // Quoted because every value here contains a space or a path — systemd's
  // Environment= requires quoting whenever the value does.
  const envLines = serviceEnvironment(workerCmd, cliCmd)
    .map(([key, value]) => `Environment="${key}=${assertUnitSafe(value, key)}"\n`)
    .join("");
  const user = assertUnitSafe(serviceUser(), "User");
  assertUnitSafe(binaryPath, "ExecStart");
  assertUnitSafe(homedir(), "HOME");
  return `[Unit]
Description=failproofai background daemon (failproofaid) for ${user}
After=network.target

[Service]
Type=simple
User=${user}
# Set explicitly rather than relying on systemd deriving it from User=:
# failproofaid is user-scope by construction and refuses to start without
# HOME ("HOME is not set; failproofaid is user-scope only"), so the one
# variable it cannot do without is not left to a version-dependent default.
Environment="HOME=${homedir()}"
${envLines}ExecStart=${binaryPath}
Restart=on-failure
RestartSec=2

[Install]
# multi-user.target, not default.target: this is the whole point of a
# system unit — it starts at boot, with no login and no lingering, and
# keeps running after the installing user logs out.
WantedBy=multi-user.target
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string): string {
  // &amp; last, or an escaped `&amp;lt;` would come back as `<`.
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Exported for the same reason `systemdUnitContents` is: it is the only way to
 * assert the plist's shape from a Linux CI runner, and this is the half of the
 * pair no Linux test run can otherwise reach.
 */
export function launchdPlistContents(
  binaryPath: string,
  logDir: string,
  workerCmd: string | null,
  cliCmd: string | null = null,
): string {
  const env = serviceEnvironment(workerCmd, cliCmd);
  const envBlock = env.length
    ? `    <key>EnvironmentVariables</key>
    <dict>
${env.map(([key, value]) => `        <key>${key}</key>\n        <string>${escapeXml(value)}</string>`).join("\n")}
    </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(launchdLabel())}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(binaryPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- A LaunchDaemon runs as root unless told otherwise. This is the
         launchd half of the systemd unit's User=: loaded at boot by the
         system, executed as the one user whose home, socket and lock it
         is allowed to touch. -->
    <key>UserName</key>
    <string>${escapeXml(serviceUser())}</string>
${envBlock}    <key>StandardOutPath</key>
    <string>${escapeXml(resolve(logDir, "failproofaid.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(resolve(logDir, "failproofaid.err.log"))}</string>
</dict>
</plist>
`;
}

export interface DaemonInstallResult {
  installed: boolean;
  reason?: string;
}

/**
 * The privileged commands an install performs — returned verbatim so a
 * machine that cannot elevate can be told exactly what to run rather than
 * just that something failed.
 */
function daemonInstallCommands(
  binaryPath: string,
  workerCmd: string | null,
  cliCmd: string | null,
): string[] {
  if (process.platform === "linux") {
    return [
      `sudo tee ${systemdUnitPath()} <<'EOF'\n${systemdUnitContents(binaryPath, workerCmd, cliCmd)}EOF`,
      "sudo systemctl daemon-reload",
      `sudo systemctl enable --now ${systemdUnitName()}`,
    ];
  }
  return [
    `sudo tee ${launchdPlistPath()} < the plist failproofai config would write`,
    `sudo launchctl load -w ${launchdPlistPath()}`,
  ];
}

/**
 * Writes and enables the service unit, starting it immediately. Safe to
 * call repeatedly — re-running replaces the unit file (picking up a
 * changed binary path after an upgrade) and re-enables it.
 */
export async function installDaemonService(): Promise<DaemonInstallResult> {
  if (!isDaemonSupportedPlatform()) {
    return { installed: false, reason: `failproofaid is not supported on ${process.platform} yet` };
  }

  // May reach the network: the npm package carries no binary, so this is
  // where a machine opting into the daemon fetches the one built for its
  // platform from this version's release.
  const { path: binaryPath, reason: binaryReason } = await ensureFailproofaidBinary();
  if (!binaryPath) {
    return { installed: false, reason: binaryReason ?? "failproofaid binary not found for this platform" };
  }
  // Best-effort, not required: a null workerCmd just leaves the daemon to
  // its own built-in (relative-path) fallback, which only works when the
  // daemon happens to be started from the npm package's own directory.
  // Resolving it here — where FAILPROOFAI_PACKAGE_ROOT is reliably set —
  // and threading it through as an absolute path in the service's
  // environment is what makes a *service-managed* daemon actually find its
  // worker regardless of what cwd the service manager starts it from.
  const workerCmd = resolveWorkerCommand();
  // Same best-effort footing as the worker command, and null is survivable in
  // the same way — the daemon just has no way to run an audit. Unlike the
  // worker, there is no relative-path fallback to degrade to, which is exactly
  // why it is resolved here where FAILPROOFAI_PACKAGE_ROOT is reliably set.
  const cliCmd = resolveCliCommand();

  // The service is installed system-wide, which needs root. Check before
  // writing anything, so a machine that cannot elevate gets the exact
  // commands to run instead of a half-installed service.
  if (!canElevate()) {
    return {
      installed: false,
      reason:
        "root privileges are required to install the failproofaid system service, and sudo credentials were not available. " +
        "Re-run `failproofai config` and approve the sudo prompt — do NOT run the CLI itself under sudo, which would " +
        "configure root's account instead of yours. To install by hand: " +
        daemonInstallCommands(binaryPath, workerCmd, cliCmd).join(" && "),
    };
  }

  // A daemon left over from a pre-1.0.0-beta.1 install holds the same
  // singleton lock the new one needs, so the system unit would start, lose
  // the flock race, and leave the machine fail-closed against a daemon that
  // never came up. Clear it first, every time.
  removeLegacyUserService();

  try {
    if (process.platform === "linux") {
      writePrivilegedFile(systemdUnitPath(), systemdUnitContents(binaryPath, workerCmd, cliCmd));
      runPrivileged("systemctl", ["daemon-reload"]);
      runPrivileged("systemctl", ["enable", "--now", systemdUnitName()]);
    } else {
      const plistPath = launchdPlistPath();
      const logDir = logsDir();
      mkdirSync(logDir, { recursive: true });
      // Unload any previously-loaded copy first — reloading with a changed
      // binary path (e.g. after an upgrade) is a no-op under plain `load`
      // if launchd thinks the label is already loaded.
      try {
        runPrivileged("launchctl", ["unload", plistPath]);
      } catch {
        // Wasn't loaded — fine, this is the common case on a fresh install.
      }
      writePrivilegedFile(plistPath, launchdPlistContents(binaryPath, logDir, workerCmd, cliCmd));
      runPrivileged("launchctl", ["load", "-w", plistPath]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hookLogWarn(`daemon service install failed: ${msg}`);
    return { installed: false, reason: msg };
  }

  // `enable --now` / `load -w` returning 0 only means the job was accepted.
  // A daemon that dies at startup (missing shared library, a crash-looping
  // worker, a binary the service manager can't execute) still gets a clean
  // exit status here — and the caller would then set `daemonConfigured`,
  // which makes every hook event on this machine fail closed against a
  // daemon that isn't there. Confirm it actually reached a running state
  // before reporting success.
  if (!(await waitForDaemonRunning())) {
    const reason = `failproofaid was installed but did not reach a running state within ${SERVICE_START_TIMEOUT_MS}ms (status: ${daemonServiceStatus()})`;
    hookLogWarn(`daemon service install failed: ${reason}`);
    return { installed: false, reason };
  }

  // NOTE: this reports that the SERVICE is installed and running, which is all
  // it can honestly claim. Whether the daemon can actually evaluate a hook is a
  // separate question, answered by `probeDaemonEndToEnd()` — and the caller
  // must ask it before setting `daemonConfigured`, because that flag is what
  // makes an unanswering daemon deny every tool call. `configure-wizard.ts`
  // does exactly that. Keeping the two apart matters: "the unit was written and
  // systemd started it" is testable against a stub binary, and folding the
  // probe in here would mean this function could never be tested without a real
  // failproofaid.
  return { installed: true };
}

/**
 * How long the health probe waits for the daemon to answer a real hook.
 *
 * Far below the hook path's 30s: this runs from an interactive command, and
 * the cold start it is most likely to be waiting on (`worker.rs` pre-warms the
 * worker, ~700ms of Node startup) is comfortably inside it. A daemon that
 * cannot answer a trivial event in this long is not one to hand a machine's
 * fail-closed enforcement to.
 */
const DAEMON_PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask the daemon to evaluate a real hook, end to end.
 *
 * The thing this catches that nothing else did: a unit that is *running* while
 * the worker behind it cannot start. `ExecStart` bakes in `process.execPath`
 * and an absolute `dist/worker.mjs`, so an `nvm uninstall 20` leaves a service
 * systemd reports as perfectly active and a worker that dies on every spawn.
 * Every existing check passes that machine — `waitForDaemonRunning()` asks the
 * service manager, `Ping` is answered in `server.rs` without ever touching the
 * worker, a null `resolveWorkerCommand()` is treated as best-effort, and
 * `Worker::warm()` swallows its own failure. `daemonConfigured` then gets set,
 * and because that flag makes every hook fail closed, the machine denies every
 * tool call across all 12 CLIs — including `UserPromptSubmit`, so the user
 * cannot even talk to their agent to ask why.
 *
 * `SessionStart` rather than a tool event: it traverses the identical path
 * (socket → daemon → worker → `evaluateHookEvent`) but describes nothing a
 * policy would deny and records no tool decision, so probing cannot itself
 * change what the machine does.
 */
export async function probeDaemonEndToEnd(): Promise<boolean> {
  try {
    const { attemptDaemonHook } = await import("./daemon-client");
    const attempt = await attemptDaemonHook(
      {
        hookEvent: "SessionStart",
        cli: "claude",
        stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "failproofai-health-probe" }),
      },
      { responseTimeoutMs: DAEMON_PROBE_TIMEOUT_MS },
    );
    // A protocol mismatch is a REACHABLE daemon of the wrong vintage. The hook
    // path already falls back rather than denying for that case, so it is not
    // the lockout this probe exists to find.
    return attempt.ok || attempt.failure === "protocol-mismatch";
  } catch {
    return false;
  }
}

/**
 * Waits for the service to report running, then re-checks after a settle
 * window (see `SERVICE_SETTLE_MS`) so a daemon that dies at startup doesn't
 * pass on the strength of one optimistic reading.
 */
async function waitForDaemonRunning(): Promise<boolean> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  for (;;) {
    if (daemonServiceStatus() === "running") break;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, SERVICE_START_POLL_MS));
  }
  await new Promise((r) => setTimeout(r, SERVICE_SETTLE_MS));
  return daemonServiceStatus() === "running";
}

// ── Upgrading a service definition that predates a variable ──────────────────
//
// A machine that installed the daemon before `FAILPROOFAI_CLI_CMD` existed
// keeps its old unit forever: `npm i -g failproofai@latest` replaces the CLI
// and never touches /etc/systemd/system, and the wizard's own "already
// installed and running — leaving it alone" branch skips it too. The daemon
// then has no way to spawn an audit while `config.toml` says the scheduled
// scan is on, and nothing anywhere reports a fault. This is the single most
// likely way the whole feature ends up dead on real machines, so it gets an
// explicit detect-and-rewrite rather than an assumption that reinstalls happen.

/** Reads the installed unit / plist, or null when no service is installed. */
function readInstalledServiceDefinition(): string | null {
  if (!isDaemonSupportedPlatform()) return null;
  const path = daemonServiceFilePath();
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Unreadable is not "absent": claiming no service is installed would let a
    // caller reinstall over something it cannot see. Treated as "nothing to
    // upgrade" by the one caller below, which is the inert direction.
    return null;
  }
}

/**
 * Reads one variable back out of an installed service definition.
 *
 * Used to carry values FORWARD across a rewrite. A rewrite resolves each
 * command from this process, and a resolution that comes back null (no
 * `FAILPROOFAI_PACKAGE_ROOT`, a `dist/` that moved) must never be allowed to
 * silently DELETE a working line from a working unit — the rewrite exists to
 * add a variable, not to drop one.
 */
function installedEnvValue(definition: string, name: string): string | null {
  if (process.platform === "linux") {
    const m = new RegExp(`^Environment="${name}=(.*)"$`, "m").exec(definition);
    return m ? m[1] : null;
  }
  const m = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(definition);
  return m ? unescapeXml(m[1]) : null;
}

/**
 * The binary an installed definition currently starts.
 *
 * Preserved across a rewrite rather than re-resolved, because the two disagree
 * in exactly the upgrade case this is for: `installedBinaryPath()` is
 * version-stamped (`failproofaid-<version>`), so right after a CLI upgrade the
 * binary for the NEW version is not on disk yet and resolution returns null,
 * while the unit still points at the older binary that is there and running.
 * Re-resolving would either refuse to rewrite or repoint a live service at a
 * file that does not exist.
 */
function installedExecStart(definition: string): string | null {
  if (process.platform === "linux") {
    const m = /^ExecStart=(.+)$/m.exec(definition);
    return m ? m[1].trim() : null;
  }
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(definition);
  return m ? unescapeXml(m[1]) : null;
}

/**
 * True when a service IS installed but its definition predates
 * `FAILPROOFAI_CLI_CMD`.
 *
 * Deliberately a content check against the definition on disk, not a revision
 * number mirrored into `config.toml`. The mirror is the tempting shape — it is
 * how `daemon.installed_version` is modelled — but that field is declared,
 * read and cleared and has never once been WRITTEN (both `setDaemonConfigured`
 * call sites pass no version), which is precisely how a mirror fails: it
 * reports "current" for a unit nobody updated. A false negative here is the
 * permanently-inert audit lane this function exists to catch, and the unit
 * itself cannot lie about what it contains.
 */
export function daemonServiceNeedsUpgrade(): boolean {
  const definition = readInstalledServiceDefinition();
  if (definition === null) return false;
  return !definition.includes("FAILPROOFAI_CLI_CMD");
}

/**
 * The definition an installed one should become: regenerated by the same
 * renderers a fresh install uses, carrying forward everything this process
 * cannot re-resolve. `null` when the input has no readable start command,
 * which means it is not a definition failproofai wrote and must be left alone.
 *
 * Split out from `ensureDaemonServiceCurrent` and kept pure — no privilege, no
 * service manager, no writes — because the rewrite itself can only be
 * exercised end-to-end on a machine with root AND the matching service
 * manager. That is nowhere on a Linux CI runner for the launchd half, and
 * nowhere at all on a developer box without passwordless sudo, so the one
 * transformation that must not be wrong would otherwise be the one thing no
 * ordinary test run ever executes.
 */
export function upgradedServiceDefinition(
  definition: string,
  cliCmd: string,
  logDir: string,
): string | null {
  const binaryPath = installedExecStart(definition);
  if (!binaryPath) return null;
  const workerCmd = resolveWorkerCommand() ?? installedEnvValue(definition, "FAILPROOFAI_WORKER_CMD");
  try {
    return process.platform === "linux"
      ? systemdUnitContents(binaryPath, workerCmd, cliCmd)
      : launchdPlistContents(binaryPath, logDir, workerCmd, cliCmd);
  } catch (err) {
    // A value that cannot be safely interpolated is reported as "no usable
    // definition" rather than thrown: this runs against a HEALTHY, RUNNING
    // daemon and the caller's contract is an outcome, not an exception. The
    // refusal happens before anything is written or stopped, so the machine is
    // left exactly as it was.
    hookLogWarn(
      `service definition not rewritten: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export type DaemonUpgradeOutcome =
  /** No service installed, or its definition already carries the variable. */
  | "current"
  /** The definition was rewritten and the service came back running. */
  | "rewritten"
  /** It needed a rewrite and did not get one. `reason` says why. */
  | "failed";

export interface DaemonUpgradeResult {
  outcome: DaemonUpgradeOutcome;
  reason?: string;
  /**
   * Whether failproofaid is running when this returns — probed, never
   * inferred from what the commands returned.
   *
   * Set on every outcome that touched the service, because on a
   * `daemonConfigured` machine a stopped daemon is not a lost feature: every
   * hook event fails closed, across all 12 CLIs, until somebody hand-edits
   * `policies-config.json`. The caller needs to know that specifically, not
   * just that "the refresh failed".
   */
  daemonRunning?: boolean;
}

/**
 * Restart the systemd unit, clearing any start-limit latch first.
 *
 * The unit ships `Restart=on-failure` with `RestartSec=2`, so a definition
 * systemd accepts but cannot run (a poisoned `User=`, a missing binary) does
 * not fail once — it cycles, and within `DefaultStartLimitIntervalSec` (10s) it
 * trips `DefaultStartLimitBurst` (5) and latches into "start request repeated
 * too quickly". On systemd 255 — what ubuntu-24.04 and GitHub's runners ship —
 * that latch is sticky at the unit level: a later `systemctl restart` is refused
 * even after the definition on disk has been REPLACED with a good one. A
 * rollback that restores a perfectly runnable unit then still cannot start it,
 * and the machine stays fail-closed against a daemon that never comes back.
 * `reset-failed` clears the failure counter so the restart is deterministic; on
 * a healthy unit it is a no-op. Best-effort — a `reset-failed` that errors (the
 * unit was never failed) must never abort the restart that is the real step.
 */
function restartSystemdUnit(): void {
  try {
    runPrivileged("systemctl", ["reset-failed", systemdUnitName()]);
  } catch {
    // The restart below is the operative step; do not let a reset-failed
    // that errored on an already-clean unit swallow it.
  }
  runPrivileged("systemctl", ["restart", systemdUnitName()]);
}

/**
 * Puts a previous service definition back and starts the service again,
 * answering whether failproofaid is running once it has.
 *
 * `ensureDaemonServiceCurrent` is the only caller, and it runs exclusively
 * against a machine whose daemon is UP — which is what makes a half-applied
 * rewrite so much worse than no rewrite. Stopping a healthy daemon and failing
 * to start it again trades a dead audit lane for a machine that denies every
 * tool call, so the refresh must be able to undo itself.
 *
 * Best-effort and never throws: it only ever runs where something has already
 * gone wrong. The return value is `waitForDaemonRunning()` rather than "the
 * commands succeeded" on purpose — the common rollback failure is a lost sudo
 * credential, which means nothing was written and the daemon was never down.
 */
async function restoreServiceDefinition(previous: string): Promise<boolean> {
  try {
    if (process.platform === "linux") {
      writePrivilegedFile(systemdUnitPath(), previous);
      runPrivileged("systemctl", ["daemon-reload"]);
      // reset-failed first: the failed rewrite we are undoing has been cycling
      // under Restart=on-failure and may have tripped systemd's start-limit,
      // which on systemd 255 refuses to start even this restored, good unit.
      restartSystemdUnit();
    } else {
      const plistPath = launchdPlistPath();
      try {
        runPrivileged("launchctl", ["unload", plistPath]);
      } catch {
        // Already unloaded — getting the old definition loaded is the point.
      }
      writePrivilegedFile(plistPath, previous);
      runPrivileged("launchctl", ["load", "-w", plistPath]);
    }
  } catch (err) {
    hookLogWarn(
      `daemon service definition rollback failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Not a verdict on the daemon — fall through to the probe below, which is.
  }
  return waitForDaemonRunning();
}

/**
 * The one exit for every way a refresh can fail after it started touching the
 * service. Rolls back when there is something to roll back to, then reports
 * the daemon's actual state.
 */
async function refreshFailed(message: string, previous: string | null): Promise<DaemonUpgradeResult> {
  hookLogWarn(`daemon service unit refresh failed: ${message}`);
  const running =
    previous === null ? daemonServiceStatus() === "running" : await restoreServiceDefinition(previous);
  return {
    outcome: "failed",
    daemonRunning: running,
    reason: running
      ? message
      : `${message}. The previous service definition could not be restored either, so failproofaid is NOT running`,
  };
}

/**
 * Brings an already-installed service definition up to date, in place.
 *
 * Narrower than `installDaemonService` on purpose, and it is the narrowness
 * that makes it safe to run against a healthy machine: it never downloads, it
 * never touches a machine that has no service, and it keeps the ExecStart and
 * any environment value it cannot re-resolve. Everything past the first
 * privileged write is undone by `restoreServiceDefinition` if the daemon does
 * not come back, so the worst outcome really is the machine it started with —
 * and when even the rollback cannot get the daemon up, that fact rides out on
 * `daemonRunning` rather than being folded into a generic failure, because the
 * caller has to stop asserting `daemonConfigured` over a daemon that is gone.
 *
 * It DOES restart the service, which `installDaemonService` does not do on
 * Linux (`enable --now` is a no-op against an already-active unit, so a
 * rewritten unit's environment reaches the running process only at the next
 * boot). Without the restart this "fix" would leave the audit lane inert for
 * however long the machine stays up — which is the bug, not a smaller version
 * of it. The restart costs a sub-second window in which a hook can find no
 * daemon and fail closed, so it is confined to the wizard: `failproofai
 * config` is an explicit, attended reconfiguration, and the same window
 * already exists on macOS, where install unloads and reloads on every run.
 */
export async function ensureDaemonServiceCurrent(): Promise<DaemonUpgradeResult> {
  const definition = readInstalledServiceDefinition();
  if (definition === null || definition.includes("FAILPROOFAI_CLI_CMD")) {
    return { outcome: "current" };
  }

  const cliCmd = resolveCliCommand();
  if (!cliCmd) {
    return {
      outcome: "failed",
      reason:
        "the failproofai CLI entry point (dist/cli.mjs) could not be located, so there is nothing to " +
        "write into the unit. Re-run `failproofai config` from a complete install.",
    };
  }

  const logDir = logsDir();
  const upgraded = upgradedServiceDefinition(definition, cliCmd, logDir);
  if (!upgraded) {
    return {
      outcome: "failed",
      reason:
        `no safe replacement could be composed for the service definition at ${daemonServiceFilePath()} — ` +
        `either it has no readable start command (it looks hand-edited) or a value that would go into it ` +
        `contains a quote, backslash or newline. It was left alone.`,
      // Reported because nothing was touched: the refusal happens before any
      // write and before any stop, so whatever was running still is. The
      // wizard branches on this to decide whether to clear `daemonConfigured`,
      // and omitting it here would have read as "the daemon may be down" on a
      // machine whose daemon is perfectly healthy — which on a
      // `daemonConfigured` box is the difference between a lost audit lane and
      // every tool call denied.
      daemonRunning: daemonServiceStatus() === "running",
    };
  }

  if (!canElevate()) {
    return {
      outcome: "failed",
      reason: `root privileges are required to rewrite ${daemonServiceFilePath()}, and sudo credentials were not available`,
    };
  }

  // What to put back if this goes wrong, and from which point. Set BEFORE the
  // step that can leave the machine changed, not after it succeeds: on Linux
  // `writePrivilegedFile` is an `install` copy straight onto the unit path, so
  // a failure part-way through leaves a truncated unit behind, and on macOS
  // the unload has already stopped the daemon before anything is written.
  let previous: string | null = null;

  try {
    if (process.platform === "linux") {
      previous = definition;
      writePrivilegedFile(systemdUnitPath(), upgraded);
      runPrivileged("systemctl", ["daemon-reload"]);
      // `restart`, not `enable --now`: the unit is already enabled and active,
      // so `--now` would return success having changed nothing and the daemon
      // would keep the environment it was started with. reset-failed first so a
      // machine that arrived here with an already-latched start-limit (a prior
      // failed refresh) can still be upgraded.
      restartSystemdUnit();
    } else {
      const plistPath = launchdPlistPath();
      mkdirSync(logDir, { recursive: true });
      previous = definition;
      try {
        runPrivileged("launchctl", ["unload", plistPath]);
      } catch {
        // Not loaded — the rewrite is still the point.
      }
      writePrivilegedFile(plistPath, upgraded);
      runPrivileged("launchctl", ["load", "-w", plistPath]);
    }
  } catch (err) {
    return refreshFailed(err instanceof Error ? err.message : String(err), previous);
  }

  // The service was running when this started, so anything short of running
  // now is a regression this call caused — and on a daemon-configured machine
  // that is every tool call failing closed. A unit that parses but will not
  // start is exactly the case `systemctl restart`'s exit code does not catch,
  // so this is the check that hands it to the rollback.
  if (!(await waitForDaemonRunning())) {
    return refreshFailed(
      `the service definition was refreshed but failproofaid did not come back within ${SERVICE_START_TIMEOUT_MS}ms (status: ${daemonServiceStatus()})`,
      previous,
    );
  }
  return { outcome: "rewritten", daemonRunning: true };
}

/**
 * Stops and removes the service, and clears the `daemonConfigured` marker
 * so this machine goes back to in-process evaluation. Best-effort: never
 * throws.
 *
 * The flag is cleared **first and unconditionally**: leaving it set with no
 * daemon to reach is strictly worse than any failure this function can hit,
 * because `bin/failproofai.mjs` fails closed on it and would deny every hook
 * event on the machine with no recovery short of hand-editing
 * `~/.failproofai/policies-config.json`.
 */
export async function uninstallDaemonService(): Promise<void> {
  setDaemonConfigured(false);
  if (!isDaemonSupportedPlatform()) return;

  // Always attempted, and never privileged: a legacy user-scope daemon is
  // the one thing this can still clean up on a machine that cannot elevate.
  removeLegacyUserService();

  try {
    if (process.platform === "linux") {
      const unitPath = systemdUnitPath();
      if (!existsSync(unitPath)) return;
      try {
        runPrivileged("systemctl", ["disable", "--now", systemdUnitName()]);
      } catch {
        // Already stopped/not enabled — removing the unit is still the point.
      }
      runPrivileged("rm", ["-f", unitPath]);
      try {
        runPrivileged("systemctl", ["daemon-reload"]);
      } catch {
        // Best-effort.
      }
    } else {
      const plistPath = launchdPlistPath();
      if (!existsSync(plistPath)) return;
      try {
        runPrivileged("launchctl", ["unload", "-w", plistPath]);
      } catch {
        // Already unloaded — fine.
      }
      runPrivileged("rm", ["-f", plistPath]);
    }
  } catch (err) {
    // `daemonConfigured` is already cleared above, so a machine that cannot
    // elevate is back on the in-process path even though the unit file
    // survives — it fails open, not closed.
    hookLogWarn(
      `daemon service uninstall failed (the service may need removing by hand: ${daemonStatusCommand()}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reports the service's actual current state, not just whether the unit
 * file exists — a unit can be installed but crash-looped into a stopped
 * state.
 */
/**
 * Whether the installed daemon is a different version than this CLI expects.
 *
 * The expected version is this CLI's OWN — no lookup, no registry call, no
 * network. `package.json` and `Cargo.toml` are held identical by CI, and every
 * downstream path (the download URL, the binary filename, the npm pin) is
 * derived from that one number, so a CLI can never want a daemon version that
 * was not published alongside it.
 *
 * Returns null when the question does not apply, and the exclusions are the
 * point:
 *
 *   • FAILPROOFAI_DAEMON_BINARY — someone named a binary explicitly; its
 *     version is their business, not ours to second-guess.
 *   • a locally-built target/{release,debug} binary — the developer's own
 *     build. Reporting it "stale" on every command would be noise about the
 *     exact setup this repo tells contributors to use.
 *
 * Only the managed `~/.failproofai/bin/failproofaid-<version>` path is
 * checked, because it is the only one whose version we actually own.
 */
export function daemonVersionSkew(): { installed: string; expected: string } | null {
  if (process.env.FAILPROOFAI_DAEMON_BINARY) return null;
  const recorded = readVersionFile()?.daemon;
  if (!recorded) return null;
  // Managed installs only — see the exclusions above.
  if (!existsSync(installedBinaryPath(recorded))) return null;
  return recorded === version ? null : { installed: recorded, expected: version };
}

export function daemonServiceStatus(): DaemonServiceStatus {
  if (!isDaemonSupportedPlatform()) return "unsupported-platform";

  if (process.platform === "linux") {
    if (!existsSync(systemdUnitPath())) return "not-installed";
    try {
      // Unprivileged on purpose: reading a system unit's state needs no
      // root, so status works for the owning user with no sudo at all.
      const out = execFileSync("systemctl", ["is-active", systemdUnitName()], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SERVICE_CMD_TIMEOUT_MS,
      })
        .toString()
        .trim();
      return out === "active" ? "running" : "stopped";
    } catch {
      // `systemctl is-active` exits non-zero (and execFileSync throws) for
      // every non-"active" state — inactive, failed, or the command not
      // working at all (no systemd user session, systemctl missing). All
      // of those are indistinguishable from "stopped" from here, and the
      // unit file existing is what already ruled out "not-installed".
      return "stopped";
    }
  }

  const plistPath = launchdPlistPath();
  if (!existsSync(plistPath)) return "not-installed";
  try {
    // A LaunchDaemon lives in launchd's system domain, which an unprivileged
    // `launchctl list` cannot see — unlike systemd, reading the state needs
    // the same elevation installing it did.
    const root = typeof process.getuid === "function" && process.getuid() === 0;
    const args = ["print", `system/${launchdLabel()}`];
    const out = root
      ? execFileSync("launchctl", args, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: SERVICE_CMD_TIMEOUT_MS,
        }).toString()
      : execFileSync("sudo", ["-n", "launchctl", ...args], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: SERVICE_CMD_TIMEOUT_MS,
        }).toString();
    // `state = running` is launchd's own wording; a loaded-but-dead job
    // prints `state = not running` and must not read as healthy.
    return /state\s*=\s*running/.test(out) ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}
