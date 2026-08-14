/**
 * `failproofai audit --schedule [days]` / `--no-schedule` / `--status`.
 *
 * ## Why this exists
 *
 * Until now the only way to turn scheduled audits on was the dashboard's
 * settings page — a browser. `failproofaid` is a SYSTEM service:
 * `WantedBy=multi-user.target`, starts at boot, needs no login, survives
 * logout. That design exists for headless boxes, detached tmux, cron and CI
 * runners, and not one of those can open a settings page. The feature was
 * built for machines that had no way to switch it on.
 *
 * ## Parity is structural, not a promise
 *
 * Every write here goes through the same `updateConfig` the dashboard's server
 * actions call, and the session goes through the same `auth-store`. There is
 * one `config.json`, one `audit/session.json`, and one writer function for
 * each — so "the CLI and the dashboard are always in sync" is a consequence of
 * the shape rather than something to keep true by hand. Two files, or two
 * writers, is where that promise starts needing tests to defend it.
 *
 * Two doc comments in `app/actions/` used to claim `failproofai config` already
 * wrote these keys. It never did — the wizard calls `updateConfig` zero times.
 * Those comments are corrected in this change rather than left describing a
 * command that did not exist.
 */
import { readConfig, updateConfig } from "../hooks/fp-config";
import { daemonServiceStatus, isDaemonSupportedPlatform } from "../hooks/daemon-service";
import { readAuth } from "../../lib/auth/auth-store";
import { readAuditSchedule } from "./audit-schedule";
import { readDashboardCacheMeta } from "./dashboard-cache";
import { readMachineIdentity } from "./machine-store";
import { ensureSignedIn, LoginError } from "./cli-login";
import { ANSI_DIM, ANSI_RESET, brandAnsi } from "../hooks/tui";

/** Mirrors `fp-config`'s own bounds so the error can name them before writing. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;

export class ScheduleCliError extends Error {}

const pink = (s: string) => `${brandAnsi("pink")}${s}${ANSI_RESET}`;
const green = (s: string) => `${brandAnsi("guide")}${s}${ANSI_RESET}`;
const dim = (s: string) => `${ANSI_DIM}${s}${ANSI_RESET}`;

/**
 * Turn scheduled audits on, signing in first if needed.
 *
 * Scheduling and mailing are ONE decision — the reason to put a scan on a timer
 * is to be told what it found — so this requires a session, exactly as the
 * dashboard's `setAutoAuditAction` does. A timer set with nobody to tell is a
 * switch that reads as on and produces nothing, discoverable only by noticing
 * that no digest ever arrives.
 *
 * The interval is written and then RE-READ, so what is printed is what the
 * config actually kept — `readIntervalDays` owns the 1..90 clamp and a second
 * copy of those bounds here would be one more thing to drift.
 */
export async function runScheduleOn(daysArg: string | undefined): Promise<void> {
  let days: number | undefined;
  if (daysArg !== undefined) {
    const parsed = Number(daysArg);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ScheduleCliError(
        `\`--schedule\` takes a whole number of days (got: ${daysArg}).`,
      );
    }
    if (parsed < MIN_DAYS || parsed > MAX_DAYS) {
      throw new ScheduleCliError(
        `\`--schedule\` must be between ${MIN_DAYS} and ${MAX_DAYS} days (got: ${parsed}).`,
      );
    }
    days = parsed;
  }

  const user = await ensureSignedIn();

  const next = updateConfig({
    audit: { auto: true, ...(days !== undefined ? { intervalDays: days } : {}) },
  });
  const interval = next.audit.intervalDays;

  process.stdout.write(
    `\n${green("✓")} Scheduled audits are on.\n` +
      `  Scanning every ${interval} day${interval === 1 ? "" : "s"}, ` +
      `emailing ${user.email} when a scan finds something harmful.\n`,
  );

  // The switch is config; whether anything RUNS is the daemon. Saying "on"
  // without checking would be the same "on but silent" state the settings panel
  // exists to make visible.
  warnIfDaemonWontRun();
  process.stdout.write(dim(`\n  failproofai audit --status   to see when the next scan is due\n`));
}

export function runScheduleOff(): void {
  const before = readConfig().audit.auto;
  const next = updateConfig({ audit: { auto: false } });
  process.stdout.write(
    next.audit.auto
      ? "Could not turn scheduled audits off.\n"
      : before
        ? `\n${green("✓")} Scheduled audits are off. Nothing runs on a timer and nothing is sent.\n` +
          dim("  Your session is untouched — sign out from the dashboard if you want that too.\n")
        : "\nScheduled audits were already off.\n",
  );
}

/**
 * What this machine is actually doing.
 *
 * The one command with no equivalent anywhere else: on a headless box there was
 * previously no way to ask whether scheduling was on, when the last scan ran, or
 * whether the daemon was even up. Every value is read from the same places the
 * dashboard reads them.
 */
export function runScheduleStatus(): void {
  const config = readConfig();
  const auth = readAuth();
  const sched = readAuditSchedule();
  const meta = readDashboardCacheMeta();
  const machine = readMachineIdentity();
  const daemon = daemonServiceStatus();

  const on = config.audit.auto;
  const out: string[] = [];

  out.push("");
  out.push(`  ${pink("scheduled audit")}   ${on ? green("on") : dim("off")}`);
  if (on) {
    out.push(`  ${dim("every")}             ${config.audit.intervalDays} days`);
  }

  out.push(
    `  ${dim("reports to")}        ${auth ? auth.user.email : dim("— signed out")}`,
  );
  if (on && !auth) {
    // The state the reporter surfaces as "signed-out". Named here for the same
    // reason the settings panel names it: the scans keep running, so silence
    // about the digests would look like the feature failing.
    out.push(`                    ${pink("scans continue; digests are paused until you sign in")}`);
  }

  out.push(`  ${dim("daemon")}            ${describeDaemon(daemon)}`);

  if (sched?.nextDueAtMs != null && on) {
    out.push(`  ${dim("next scan")}         ${untilPhrase(sched.nextDueAtMs)}`);
  }
  if (sched?.lastRunAtMs != null) {
    const exit = sched.lastExitCode;
    const suffix = exit != null && exit !== 0 && exit !== 75 ? pink(` (exit ${exit})`) : "";
    out.push(`  ${dim("last scheduled")}    ${agoPhrase(sched.lastRunAtMs)}${suffix}`);
  }
  out.push(
    `  ${dim("last result")}       ${meta?.cachedAt ? agoPhrase(Date.parse(meta.cachedAt)) : dim("none yet")}`,
  );
  if (machine?.last_reported_at) {
    out.push(`  ${dim("last reported")}     ${agoPhrase(Date.parse(machine.last_reported_at))}`);
  }
  out.push("");

  process.stdout.write(out.join("\n"));
}

function describeDaemon(status: ReturnType<typeof daemonServiceStatus>): string {
  switch (status) {
    case "running":
      return green("running");
    case "stopped":
      return pink("stopped — run `failproofai config` to repair it");
    case "not-installed":
      return pink("not installed — run `failproofai config`");
    case "condition-failed":
      return pink("installed but its binary is missing — run `failproofai config`");
    default:
      return isDaemonSupportedPlatform()
        ? dim(String(status))
        : dim("unavailable on this platform");
  }
}

/** Printed after turning scheduling on, where the answer changes what to do. */
function warnIfDaemonWontRun(): void {
  const status = daemonServiceStatus();
  if (status === "running") return;
  if (!isDaemonSupportedPlatform()) {
    process.stderr.write(
      `\n  ${pink("!")} The background service is not available on this platform,\n` +
        `    so nothing will run on the timer here. \`failproofai audit\` still works.\n`,
    );
    return;
  }
  process.stderr.write(
    `\n  ${pink("!")} The background service is ${status.replace("-", " ")}, ` +
      `so nothing will run on the timer yet.\n` +
      `    Run \`failproofai config\` to install or repair it.\n`,
  );
}

function untilPhrase(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "due now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  if (d > 0) return `in ${d}d${h > 0 ? ` ${h}h` : ""}`;
  if (h > 0) return `in ${h}h`;
  return `in ${Math.max(1, Math.floor(diff / 60_000))}m`;
}

function agoPhrase(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor(diff / 60_000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

/** Turn a `LoginError` into the CLI's own error type, keeping its message. */
export function asScheduleError(err: unknown): never {
  if (err instanceof LoginError || err instanceof ScheduleCliError) {
    throw new ScheduleCliError(err.message);
  }
  throw err;
}
