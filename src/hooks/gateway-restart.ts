/**
 * Restart running Hermes and OpenClaw gateways after `failproofai update`, when
 * they are next idle.
 *
 * A gateway is one long-lived process that imported our plugin when it
 * started. npm replaces the plugin files on disk, but the gateway keeps running
 * the code it already imported until it restarts — which nobody told it to.
 *
 * Both hosts ship a restart that waits for in-flight work, so this never has to
 * judge "idle" itself:
 *   - Hermes: `hermes gateway restart` (SIGUSR1: refuse new turns, drain, exit;
 *     the service manager relaunches it).
 *   - OpenClaw: `openclaw gateway restart --safe` (restart after active work
 *     drains, bounded).
 *
 * Only a gateway a service manager is running is touched. Without one,
 * `hermes gateway restart` stops the gateway and runs the new one in the
 * FOREGROUND of the caller — `update` would hang holding someone's gateway. A
 * hand-run gateway (tmux, `gateway run`) is left alone and reported as such.
 *
 * The restart is spawned detached, so `update` returns immediately while the
 * host waits out its drain.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { listOpenClawProfiles, OPENCLAW_DEFAULT_PROFILE } from "../../lib/openclaw-profiles";
import { logsDir } from "./fp-home";

// integrations.ts's OPENCLAW_PLUGIN_ID; restated rather than imported so this
// module does not pull the whole integration table into `update`.
const OPENCLAW_PLUGIN_ID = "failproofai";

export type GatewayRestartStatus = "restarting" | "not-running" | "not-supervised" | "failed";

export interface GatewayRestart {
  host: "hermes" | "openclaw";
  profile: string;
  status: GatewayRestartStatus;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
}

export interface GatewayRestartDeps {
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult;
  spawnDetached?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => boolean;
  openclawProfiles?: () => Array<{ name: string; home: string }>;
}

const STATUS_TIMEOUT_MS = 20_000;

function defaultRun(cmd: string, args: string[], env: NodeJS.ProcessEnv): CommandResult {
  const out = spawnSync(cmd, args, {
    env,
    encoding: "utf8",
    timeout: STATUS_TIMEOUT_MS,
    // SIGTERM is the default, and a status command that handles it and stays
    // stuck kept `update` from ever printing its report.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: out.error ? null : out.status, stdout: `${out.stdout ?? ""}${out.stderr ?? ""}` };
}

function restartLogPath(): string {
  return `${logsDir()}/gateway-restart.log`;
}

/**
 * The gateways' restart output, owner-only like daemon.log. An existing file
 * from before this was set is tightened too.
 * @internal exported for tests
 */
export function openRestartLog(): number {
  const log = restartLogPath();
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, "a", 0o600);
  chmodSync(log, 0o600);
  return fd;
}

function defaultSpawnDetached(cmd: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  let fd: number | undefined;
  try {
    fd = openRestartLog();
    const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", () => {});
    child.unref();
    return typeof child.pid === "number";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * What `hermes gateway status` prints when a service manager is running the
 * gateway, verified on Hermes 0.20.0 and 0.21.3:
 *   - systemd: `✓ User gateway service is running` (`System …` for the system
 *     scope, which needs root to restart and is left alone);
 *   - launchd: `✓ Gateway is supervised by launchd (PID n)`.
 * A detached fallback or hand-run gateway prints neither.
 */
const HERMES_SUPERVISED = [/user gateway service is running/i, /supervised by launchd \(PID/i];
export function restartHermesGateway(
  profile: { name: string; home: string },
  deps: GatewayRestartDeps = {},
): GatewayRestart {
  try {
    return restartHermesGatewayUnsafe(profile, deps);
  } catch {
    return { host: "hermes", profile: profile.name, status: "failed" };
  }
}

function restartHermesGatewayUnsafe(
  profile: { name: string; home: string },
  deps: GatewayRestartDeps,
): GatewayRestart {
  const run = deps.run ?? defaultRun;
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const env = { ...process.env, HERMES_HOME: profile.home };
  const result = (status: GatewayRestartStatus): GatewayRestart => ({ host: "hermes", profile: profile.name, status });

  const status = run("hermes", ["gateway", "status"], env);
  if (status.status === null) return result("failed");
  if (HERMES_SUPERVISED.some((line) => line.test(status.stdout))) {
    return result(spawnDetached("hermes", ["gateway", "restart"], env) ? "restarting" : "failed");
  }
  // Running, but not under a service we may restart (system scope, a detached
  // fallback, or by hand): every such status names the gateway's PID.
  if (/gateway service is running|\(PID \d+\)/i.test(status.stdout)) return result("not-supervised");
  return result("not-running");
}

interface OpenClawStatus {
  service?: { loaded?: boolean; runtime?: { status?: string } };
}

export function restartOpenClawGateway(
  profile: { name: string; home: string },
  deps: GatewayRestartDeps = {},
): GatewayRestart {
  try {
    return restartOpenClawGatewayUnsafe(profile, deps);
  } catch {
    return { host: "openclaw", profile: profile.name, status: "failed" };
  }
}

function restartOpenClawGatewayUnsafe(
  profile: { name: string; home: string },
  deps: GatewayRestartDeps,
): GatewayRestart {
  const run = deps.run ?? defaultRun;
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const profileArgs = profile.name === OPENCLAW_DEFAULT_PROFILE ? [] : ["--profile", profile.name];
  const env = openclawProfileEnv(profile);
  const result = (status: GatewayRestartStatus): GatewayRestart => ({ host: "openclaw", profile: profile.name, status });

  const out = run("openclaw", [...profileArgs, "gateway", "status", "--json"], env);
  if (out.status === null) return result("failed");
  let parsed: OpenClawStatus;
  try {
    const start = out.stdout.indexOf("{");
    parsed = JSON.parse(start >= 0 ? out.stdout.slice(start) : out.stdout) as OpenClawStatus;
  } catch {
    return result("failed");
  }
  if (parsed.service?.runtime?.status !== "running") return result("not-running");
  if (parsed.service.loaded !== true) return result("not-supervised");

  // `--safe` waits for active work. Older OpenClaw has no such flag; a plain
  // restart there would cut a turn off, so it is left to the user.
  const help = run("openclaw", ["gateway", "restart", "--help"], env);
  if (!/--safe\b/.test(help.stdout)) return result("not-supervised");
  return result(
    spawnDetached("openclaw", [...profileArgs, "gateway", "restart", "--safe"], env) ? "restarting" : "failed",
  );
}

/**
 * The environment that selects exactly `profile`, and no other. Every OpenClaw
 * profile selector inherited from the caller's shell is dropped: left in, the
 * default row inherited an `OPENCLAW_PROFILE=ops` and acted on `ops`. A default
 * profile living somewhere non-standard is named by its state directory.
 */
export function openclawProfileEnv(
  profile: { name: string; home: string },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH"]) {
    delete env[key];
  }
  // The account default is ~/.openclaw itself; a default profile anywhere else
  // (a relocated `/srv/claw/.openclaw` included) is named by its directory.
  if (profile.name === OPENCLAW_DEFAULT_PROFILE && resolve(profile.home) !== resolve(homedir(), ".openclaw")) {
    env.OPENCLAW_STATE_DIR = profile.home;
  }
  return env;
}

/** Profiles whose openclaw.json loads our plugin; only their gateways run it. */
export function openclawProfilesUsingFailproofai(): Array<{ name: string; home: string }> {
  return listOpenClawProfiles().filter((profile) => {
    try {
      const settings = JSON.parse(readFileSync(join(profile.home, "openclaw.json"), "utf8")) as {
        plugins?: { entries?: Record<string, { enabled?: unknown }> };
      };
      return settings.plugins?.entries?.[OPENCLAW_PLUGIN_ID]?.enabled === true;
    } catch {
      return false;
    }
  });
}

export function restartOpenClawGateways(deps: GatewayRestartDeps = {}): GatewayRestart[] {
  const profiles = (deps.openclawProfiles ?? openclawProfilesUsingFailproofai)();
  return profiles.map((profile) => restartOpenClawGateway(profile, deps));
}

/**
 * `update`'s OpenClaw block, shaped like its Hermes block: a heading over one
 * row per profile, and nothing at all when no gateway had anything to report.
 */
export function openclawRestartLines(restarts: GatewayRestart[]): string[] {
  const rows = restarts.filter((r) => GATEWAY_STATUS_LABEL[r.status]);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => `openclaw/${r.profile}`.length));
  return [
    "OpenClaw:",
    ...rows.map((r) => `  ${`openclaw/${r.profile}`.padEnd(width)}  ${GATEWAY_STATUS_LABEL[r.status]}`),
  ];
}

/** The word appended to a gateway's existing report row. */
export const GATEWAY_STATUS_LABEL: Record<GatewayRestartStatus, string> = {
  restarting: "gateway restarting",
  "not-running": "",
  "not-supervised": "restart the gateway",
  failed: "restart the gateway",
};
