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
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { hookLogWarn } from "./hook-logger";

const requireFromHere = createRequire(import.meta.url);

export type DaemonServiceStatus = "running" | "stopped" | "not-installed" | "unsupported-platform";

/** Linux + macOS only, per the plan's platform scope — full stop. */
export function isDaemonSupportedPlatform(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

type PlatformKey = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

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
 * Resolution order: an explicit test/dev override, the installed
 * per-platform npm package (`@failproofai/failproofaid-<os>-<arch>`, see
 * the npm packaging design), then a locally-built dev binary under
 * `target/{release,debug}/failproofaid` relative to the package root —
 * so this works when driving the wizard from a source checkout (`bun run
 * daemon:dev`-style flows) without needing the npm packages installed at
 * all.
 */
export function resolveFailproofaidBinaryPath(): string | null {
  if (process.env.FAILPROOFAI_DAEMON_BINARY) return process.env.FAILPROOFAI_DAEMON_BINARY;

  const key = platformKey();
  if (key) {
    try {
      const pkgJsonPath = requireFromHere.resolve(`@failproofai/failproofaid-${key}/package.json`);
      const candidate = resolve(dirname(pkgJsonPath), "bin", "failproofaid");
      if (existsSync(candidate)) return candidate;
    } catch {
      // Optional platform package not installed — fall through.
    }
  }

  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (packageRoot) {
    for (const profile of ["release", "debug"]) {
      const candidate = resolve(packageRoot, "target", profile, "failproofaid");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function systemdUnitPath(): string {
  return resolve(homedir(), ".config", "systemd", "user", "failproofaid.service");
}

function launchdPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", "ai.failproof.failproofaid.plist");
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

function systemdUnitContents(binaryPath: string): string {
  return `[Unit]
Description=failproofai background daemon (failproofaid)
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchdPlistContents(binaryPath: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.failproof.failproofaid</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(binaryPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
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
 * Writes and enables the service unit, starting it immediately. Safe to
 * call repeatedly — re-running replaces the unit file (picking up a
 * changed binary path after an upgrade) and re-enables it.
 */
export async function installDaemonService(): Promise<DaemonInstallResult> {
  if (!isDaemonSupportedPlatform()) {
    return { installed: false, reason: `failproofaid is not supported on ${process.platform} yet` };
  }

  const binaryPath = resolveFailproofaidBinaryPath();
  if (!binaryPath) {
    return {
      installed: false,
      reason: "failproofaid binary not found for this platform (no matching @failproofai/failproofaid-* package)",
    };
  }

  try {
    if (process.platform === "linux") {
      const unitPath = systemdUnitPath();
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, systemdUnitContents(binaryPath), "utf8");
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", "failproofaid.service"], { stdio: "ignore" });
    } else {
      const plistPath = launchdPlistPath();
      const logDir = resolve(homedir(), ".failproofai", "logs");
      mkdirSync(dirname(plistPath), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      writeFileSync(plistPath, launchdPlistContents(binaryPath, logDir), "utf8");
      // Unload any previously-loaded copy first — reloading with a changed
      // binary path (e.g. after an upgrade) is a no-op under plain `load`
      // if launchd thinks the label is already loaded.
      try {
        execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
      } catch {
        // Wasn't loaded — fine, this is the common case on a fresh install.
      }
      execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "ignore" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hookLogWarn(`daemon service install failed: ${msg}`);
    return { installed: false, reason: msg };
  }
  return { installed: true };
}

/** Stops and removes the service. Best-effort: never throws. */
export async function uninstallDaemonService(): Promise<void> {
  if (!isDaemonSupportedPlatform()) return;
  try {
    if (process.platform === "linux") {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "failproofaid.service"], { stdio: "ignore" });
      } catch {
        // Already stopped/not installed — fine.
      }
      const unitPath = systemdUnitPath();
      if (existsSync(unitPath)) unlinkSync(unitPath);
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      } catch {
        // Best-effort.
      }
    } else {
      const plistPath = launchdPlistPath();
      try {
        execFileSync("launchctl", ["unload", "-w", plistPath], { stdio: "ignore" });
      } catch {
        // Already unloaded/not installed — fine.
      }
      if (existsSync(plistPath)) unlinkSync(plistPath);
    }
  } catch (err) {
    hookLogWarn(`daemon service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
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
      const out = execFileSync("systemctl", ["--user", "is-active", "failproofaid.service"], {
        stdio: ["ignore", "pipe", "ignore"],
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
    const out = execFileSync("launchctl", ["list"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.includes("ai.failproof.failproofaid") ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}
