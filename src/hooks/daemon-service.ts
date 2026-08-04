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
export function setDaemonConfigured(value: boolean): void {
  const path = getConfigPathForScope("user");
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(path)) config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return; // a malformed global config is the install path's problem, not ours
  }
  if (value) config.daemonConfigured = true;
  else delete config.daemonConfigured;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
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

/** POSIX single-quoting: everything is literal inside '…', and a literal
 *  quote is closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

/** True when privileged commands can run without prompting for a password. */
function canElevate(): boolean {
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

export function systemdUnitContents(binaryPath: string, workerCmd: string | null): string {
  // Quoted because both values contain a space or a path — systemd's
  // Environment= requires quoting whenever the value does.
  const envLine = workerCmd ? `Environment="FAILPROOFAI_WORKER_CMD=${workerCmd}"\n` : "";
  const user = serviceUser();
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
${envLine}ExecStart=${binaryPath}
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

function launchdPlistContents(binaryPath: string, logDir: string, workerCmd: string | null): string {
  const envBlock = workerCmd
    ? `    <key>EnvironmentVariables</key>
    <dict>
        <key>FAILPROOFAI_WORKER_CMD</key>
        <string>${escapeXml(workerCmd)}</string>
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
function daemonInstallCommands(binaryPath: string, workerCmd: string | null): string[] {
  if (process.platform === "linux") {
    return [
      `sudo tee ${systemdUnitPath()} <<'EOF'\n${systemdUnitContents(binaryPath, workerCmd)}EOF`,
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
        daemonInstallCommands(binaryPath, workerCmd).join(" && "),
    };
  }

  // A daemon left over from a pre-1.0.0-beta.1 install holds the same
  // singleton lock the new one needs, so the system unit would start, lose
  // the flock race, and leave the machine fail-closed against a daemon that
  // never came up. Clear it first, every time.
  removeLegacyUserService();

  try {
    if (process.platform === "linux") {
      writePrivilegedFile(systemdUnitPath(), systemdUnitContents(binaryPath, workerCmd));
      runPrivileged("systemctl", ["daemon-reload"]);
      runPrivileged("systemctl", ["enable", "--now", systemdUnitName()]);
    } else {
      const plistPath = launchdPlistPath();
      const logDir = resolve(homedir(), ".failproofai", "logs");
      mkdirSync(logDir, { recursive: true });
      // Unload any previously-loaded copy first — reloading with a changed
      // binary path (e.g. after an upgrade) is a no-op under plain `load`
      // if launchd thinks the label is already loaded.
      try {
        runPrivileged("launchctl", ["unload", plistPath]);
      } catch {
        // Wasn't loaded — fine, this is the common case on a fresh install.
      }
      writePrivilegedFile(plistPath, launchdPlistContents(binaryPath, logDir, workerCmd));
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
  return { installed: true };
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
