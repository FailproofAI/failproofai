/**
 * The steps that finish an npm upgrade on this machine, shared by
 * `failproofai update` and by `failproofai config`.
 *
 * `update` runs all of them. `config` runs them after a setup that applied,
 * when this CLI version has not finished them here yet (`updatedVersionFile`):
 * the first setup after `npm i -g failproofai` (or on a fresh machine) would
 * otherwise leave a running Hermes or OpenClaw gateway on the plugin it loaded
 * before, or with no plugin at all, until someone thought to run `update`.
 * Setup has already brought the daemon to this version and the CLI entry has
 * already migrated the home, so `config` skips those two.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { updatedVersionFile } from "./fp-home";
import type { GatewayRestart } from "./gateway-restart";

export interface UpdateStepsOptions {
  /** Migrate the home layout (`update`); `config` relies on the CLI entry's. */
  layout: boolean;
  /** Bring the daemon to this CLI's version (`update` without --no-daemon). */
  daemon: boolean;
  /** Restart running, service-managed Hermes and OpenClaw gateways. */
  restart: boolean;
  /** Say the daemon was skipped on purpose (`update --no-daemon`). */
  noteSkippedDaemon?: boolean;
}

export interface UpdateStepsResult {
  /** Report lines, grouped by step with blank lines between. */
  lines: string[];
  ok: boolean;
  /** True when the layout is NEWER than this CLI: nothing else ran. */
  futureLayout?: { found: number; speaks: number };
  migrationsRan: number;
  migrationFailed: boolean;
  hermesOk: boolean;
  hermesMigrated: number;
  /** Something a person should see: a migration, a daemon change, a restart. */
  changed: boolean;
  /** Every gateway restart attempted, Hermes and OpenClaw, in report order. */
  restarts: GatewayRestart[];
}

export async function runUpdateSteps(opts: UpdateStepsOptions): Promise<UpdateStepsResult> {
  const lines: string[] = [];
  let migrationsRan = 0;
  let migrationFailed = false;
  let changed = false;

  if (opts.layout) {
    const { detectLayout } = await import("./fp-config");
    const { LAYOUT_VERSION } = await import("./fp-home");
    const { runMigrations } = await import("./migrations");
    const state = detectLayout();
    if (state.kind === "future") {
      return {
        lines: [],
        ok: false,
        futureLayout: { found: state.found, speaks: LAYOUT_VERSION },
        migrationsRan: 0,
        migrationFailed: false,
        hermesOk: true,
        hermesMigrated: 0,
        changed: false,
        restarts: [],
      };
    }
    if (state.kind === "stale") {
      const run = runMigrations(state.found);
      migrationsRan = run.steps.length;
      migrationFailed = Boolean(run.failed);
      changed = changed || migrationsRan > 0;
      for (const step of run.steps) {
        lines.push(`  ${step.ok ? "migrated" : "FAILED  "} layout ${step.from} → ${step.to}`);
      }
      if (run.backedUp.length > 0) lines.push("", `Saved first: ${run.backedUp.join(", ")}`);
      // Each failing half marks its own line (the daemon's lines arrive with
      // their ✕ already): the report opens on whatever ran first, often a
      // success, and printReport's guess would put the ✕ there.
      if (run.failed) {
        lines.push(
          "",
          `✕ Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`,
          `  The home is still marked layout ${state.found} and will be retried.`,
        );
      }
    } else {
      lines.push(`Home is at layout ${LAYOUT_VERSION}; no migration was needed.`);
    }
  }

  // The daemon is refreshed even when a step failed, and deliberately: the
  // binary and the layout are independent halves, and leaving a version-skewed
  // daemon behind on top of a failed migration is strictly worse than fixing
  // the half that can be fixed. The exit code still reports the failure.
  let daemonOk = true;
  const svc = await import("./daemon-service");
  if (opts.noteSkippedDaemon) {
    lines.push("", "Skipped the daemon (--no-daemon). Its version may not match this CLI.");
  } else if (opts.daemon) {
    if (!svc.isDaemonSupportedPlatform()) {
      lines.push("", `failproofaid does not run on ${process.platform}; nothing to update.`);
    } else {
      // `refreshDaemonToCliVersion` answers "is there a service at all" itself,
      // so there is no separate installed check to get out of step with it.
      const result = await svc.refreshDaemonToCliVersion();
      lines.push("", ...result.lines);
      daemonOk = result.ok;
      changed = changed || !result.lines.some((l) => /nothing to update/.test(l));
    }
  }

  // Hermes is migrated AFTER the daemon, and gated on what the daemon that is
  // now running can do: the native plugin needs `policyEvaluation`, which
  // ≤1.0.5 daemons lack, so when the swap above could not happen (a sudo
  // system service with no sudo) the shell hooks stay and this fails loudly.
  // Gateways are restarted only onto a daemon that is current AND running:
  // "nothing to update" on a machine with no service, or an unsupported
  // platform, is also `daemonOk`.
  const restartsGateways =
    opts.restart && daemonOk && svc.isDaemonSupportedPlatform() && svc.daemonServiceStatus() === "running";
  let hermesOk = true;
  let hermesMigrated = 0;
  const restarts: GatewayRestart[] = [];
  try {
    const { runHermesUpdateMigration } = await import("./hermes-update");
    const restart = await import("./gateway-restart");
    const hermesResult = await runHermesUpdateMigration({
      daemonSupportsPolicyEvaluation: () => svc.probeDaemonPolicyEvaluation(),
      restartGateway: restartsGateways
        ? (p) => {
            const r = restart.restartHermesGateway(p);
            restarts.push(r);
            return r;
          }
        : undefined,
    });
    if (hermesResult.lines.length > 0) {
      // Its lines open on a "Hermes:" heading over one row per profile; on a
      // failure the heading carries the ✕ and the rows say which profile.
      const [heading, ...rest] = hermesResult.lines;
      lines.push("", hermesResult.ok ? heading : `✕ ${heading}`, ...rest);
    }
    hermesOk = hermesResult.ok;
    hermesMigrated = hermesResult.profiles.filter((p) => p.status === "migrated").length;
    // "already current" with no gateway touched is not news.
    changed =
      changed || !hermesOk || hermesMigrated > 0 || mentionsGateway(hermesResult.lines);
  } catch (err) {
    lines.push("", `✕ Hermes migration failed: ${err instanceof Error ? err.message : String(err)}`);
    hermesOk = false;
  }

  if (restartsGateways) {
    try {
      const restart = await import("./gateway-restart");
      const openclaw = restart.restartOpenClawGateways();
      restarts.push(...openclaw);
      const restartLines = restart.openclawRestartLines(openclaw);
      if (restartLines.length > 0) {
        lines.push("", ...restartLines);
        changed = true;
      }
    } catch {
      // Restarting is a convenience; the update itself already succeeded.
    }
  }

  return {
    lines,
    ok: daemonOk && !migrationFailed && hermesOk,
    migrationsRan,
    migrationFailed,
    hermesOk,
    hermesMigrated,
    changed,
    restarts,
  };
}

/**
 * `config`'s whole report of these steps: one line, or nothing. Built from
 * update's own row words ("gateway restarting", "restart the gateway"), so
 * setup gains no new wording and no second report.
 */
export function setupGatewayLine(restarts: GatewayRestart[]): { ok: boolean; text: string } | null {
  const named = (r: GatewayRestart) => `${r.host}/${r.profile}`;
  const manual = restarts.filter((r) => r.status === "not-supervised" || r.status === "failed").map(named);
  if (manual.length > 0) return { ok: false, text: `${manual.join(", ")}: restart the gateway` };
  const restarting = restarts.filter((r) => r.status === "restarting").map(named);
  if (restarting.length > 0) return { ok: true, text: `${restarting.join(", ")}: gateway restarting` };
  return null;
}

/** A Hermes or OpenClaw profile whose gateway loads FailproofAI's plugin when it starts. */
export interface PluggedProfile {
  host: "hermes" | "openclaw";
  name: string;
  home: string;
}

export async function pluggedProfiles(): Promise<PluggedProfile[]> {
  const { hermesProfileHealth } = await import("./integrations");
  const { openclawProfilesUsingFailproofai } = await import("./gateway-restart");
  return [
    ...hermesProfileHealth()
      .filter((p) => p.pluginInstalled && p.pluginEnabled && !p.pluginDisabled)
      .map((p): PluggedProfile => ({ host: "hermes", name: p.name, home: p.home })),
    ...openclawProfilesUsingFailproofai().map((p): PluggedProfile => ({ host: "openclaw", ...p })),
  ];
}

export interface NewlyPluggedDeps {
  plugged?: () => Promise<PluggedProfile[]>;
  daemonRunning?: () => Promise<boolean>;
  restartHermes?: (p: { name: string; home: string }) => GatewayRestart;
  restartOpenClaw?: (p: { name: string; home: string }) => GatewayRestart;
}

/**
 * Restart the gateways of profiles this setup run plugged in, given
 * `pluggedProfiles()` from before it. A profile created after the version's
 * first setup gets the plugin on disk, but its gateway is already running and
 * would go on without it, unchecked, until something restarted it.
 */
export async function restartNewlyPlugged(
  before: PluggedProfile[],
  deps: NewlyPluggedDeps = {},
): Promise<GatewayRestart[]> {
  const key = (p: PluggedProfile) => `${p.host}/${p.name}`;
  const had = new Set(before.map(key));
  const fresh = (await (deps.plugged ?? pluggedProfiles)()).filter((p) => !had.has(key(p)));
  if (fresh.length === 0) return [];
  const daemonRunning =
    deps.daemonRunning ??
    (async () => {
      const svc = await import("./daemon-service");
      return svc.isDaemonSupportedPlatform() && svc.daemonServiceStatus() === "running";
    });
  if (!(await daemonRunning())) return [];
  const restart = await import("./gateway-restart");
  const hermes = deps.restartHermes ?? ((p) => restart.restartHermesGateway(p));
  const openclaw = deps.restartOpenClaw ?? ((p) => restart.restartOpenClawGateway(p));
  return fresh.map((p) => (p.host === "hermes" ? hermes(p) : openclaw(p)));
}

function mentionsGateway(lines: string[]): boolean {
  return lines.some((l) => /gateway/.test(l));
}

/** The CLI version whose upgrade steps last finished here, or null. */
export function readUpdatedVersion(home?: string): string | null {
  try {
    const v = readFileSync(updatedVersionFile(home), "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Record that this version's upgrade steps finished. Best effort. */
export function markUpdated(version: string, home?: string): void {
  try {
    const file = updatedVersionFile(home);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${version}\n`, { mode: 0o600 });
  } catch {
    // A missing marker only means the next setup runs these steps again.
  }
}

/** Whether `config` should run the upgrade steps after a setup that applied. */
export function setupNeedsUpdateSteps(version: string, home?: string): boolean {
  return readUpdatedVersion(home) !== version;
}
