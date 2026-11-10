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
import { ensureSignedIn, invalidEmail, LoginError } from "./cli-login";
import { INDENT, optsFor, paint, printBlock, screenKit, stack, type TTYOut } from "../hooks/tui";

/** Mirrors `fp-config`'s own bounds so the error can name them before writing. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;

export class ScheduleCliError extends Error {}

/**
 * The 2026-10 kit for one stream, read at call time: colour only on a terminal
 * and never under NO_COLOR, so a piped `--status` is plain text. The daemon
 * warning goes to stderr, which can be a terminal when stdout is not, so it is
 * asked about separately.
 */
const kitFor = (stream: TTYOut = process.stdout) => screenKit(optsFor(stream));

/** `every 7 days`, `every day`. */
function everyPhrase(days: number): string {
  return days === 1 ? "every day" : `every ${days} days`;
}

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
export async function runScheduleOn(
  daysArg: string | undefined,
  emailArg?: string,
): Promise<void> {
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

  // Checked here, beside the day count and before anything is drawn or sent: a
  // typo'd flag should read as a usage error, not as a sign-in that opened a
  // frame and then gave up.
  if (emailArg !== undefined) {
    const bad = invalidEmail(emailArg);
    if (bad) throw new ScheduleCliError(bad);
  }

  const { user, prompted } = await ensureSignedIn(emailArg);

  const next = updateConfig({
    // Stamped in the SAME call that sets `auto`, never separately: this records
    // that a person completed a sign-in and read the disclosure printed below,
    // and it is what `reportHarm` gates sending on. A machine that inherited
    // `auto` from a release where it meant "scan locally" has no stamp and
    // sends nothing until it comes through here.
    audit: {
      auto: true,
      reportsConsentedAt: Date.now(),
      ...(days !== undefined ? { intervalDays: days } : {}),
    },
  });
  const interval = next.audit.intervalDays;
  const k = kitFor();

  // The second line enumerates what leaves the machine, and it is not optional.
  // `reportsConsentedAt`, stamped above, records that a person READ it before
  // anything is sent, so it is part of the consent rather than fine print — the
  // one explanatory line the redesign keeps (decision D6). This is the ONLY
  // opt-in path on the headless boxes the whole feature was built for, and the
  // settings panel argues in its own comment that a checkable list beats a
  // stronger claim. The list is the real payload from `report-harm.ts`: machine
  // id, hostname, platform, the window bounds and the redacted examples.
  const result = [
    k.ok(`Scheduled audits to report to ${user.email} ${everyPhrase(interval)}.`),
    `${INDENT}${paint(optsFor(process.stdout).color).ink3("Each report sends finding counts, redacted example commands and this machine's name.")}`,
  ];
  // A sign-in just drew this screen's header, so the result continues it;
  // otherwise this is the screen, and it opens with its own.
  process.stdout.write(`\n${(prompted ? result : [k.header("Audit"), "", ...result]).join("\n")}\n`);

  // The switch is config; whether anything RUNS is the daemon. Saying "on"
  // without checking would be the same "on but silent" state the settings panel
  // exists to make visible.
  warnIfDaemonWontRun();

  process.stdout.write(`\nSee when the next scan runs:  ${k.cmd("failproofai audit --status")}\n\n`);
}

export function runScheduleOff(): void {
  const before = readConfig().audit.auto;
  const next = updateConfig({ audit: { auto: false } });
  const k = kitFor();
  const say = (line: string) => printBlock(process.stdout, [k.header("Audit"), "", line]);
  if (next.audit.auto) {
    say(k.fail("Could not turn scheduled audits off."));
    return;
  }
  if (!before) {
    say("Scheduled audits were already off.");
    return;
  }
  // Nothing scans on a timer once this is off, so nothing is sent either. The
  // sign-in is kept, so turning them back on costs no second code.
  say(k.ok("Turned off scheduled audits."));
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
  const k = kitFor();
  const detail: Array<[string, string]> = [];
  // One ▲ per distinct problem, the one that stops scans before the one that
  // stops digests.
  const problems: string[] = [];

  // The state first, because everything below is detail about a machine that is
  // either doing this or not, and reading the detail first answers a question
  // nobody has asked yet. It is a ROW like the rest, on the one column every
  // row shares.
  const every = everyPhrase(config.audit.intervalDays);
  detail.push(["scans", on ? `${k.on} ${every[0].toUpperCase()}${every.slice(1)}` : `${k.off} Off`]);

  // A session whose refresh window has closed cannot mint another access token,
  // so it is a destination in name only. Showing the address for one would tell
  // somebody their digests are going somewhere they are not.
  const live = auth && auth.refresh_expires_at * 1000 > Date.now() ? auth : null;
  detail.push(["reports to", live ? live.user.email : "Signed out"]);

  const daemonRow = describeDaemon(daemon, k);
  detail.push(["daemon", daemonRow.value]);
  if (daemonRow.problem) problems.push(daemonRow.problem);

  if (on && !live) {
    // The state the reporter surfaces as "signed-out". Named here for the same
    // reason the settings panel names it: the scans keep running, so silence
    // about the digests would look like the feature failing.
    problems.push(k.caution("Scans continue, but digests are paused until you sign in.", "failproofai audit --schedule"));
  } else if (on && config.audit.reportsConsentedAt === undefined) {
    // Signed in, scheduled, and still not sending: this machine set `audit.auto`
    // when it only meant "scan locally", so nothing has consented to the digest
    // leaving the box. Without this line the status screen would show a healthy
    // schedule and a live address and still mail nothing, with no explanation
    // anywhere the user can see.
    problems.push(k.caution("Scans continue, but digests need a fresh opt-in.", "failproofai audit --schedule"));
  }

  if (sched?.nextDueAtMs != null && on) {
    detail.push(["next scan", untilPhrase(sched.nextDueAtMs)]);
  }
  if (sched?.lastRunAtMs != null) {
    const exit = sched.lastExitCode;
    const failed = exit != null && exit !== 0 && exit !== 75;
    detail.push(["last scheduled", agoPhrase(sched.lastRunAtMs) + (failed ? `, failed with exit ${exit}` : "")]);
  }
  detail.push(["last result", meta?.cachedAt ? agoPhrase(Date.parse(meta.cachedAt)) : "None yet"]);
  if (machine?.last_reported_at) {
    detail.push(["last reported", agoPhrase(Date.parse(machine.last_reported_at))]);
  }

  printBlock(process.stdout, stack([k.header("Audit")], [k.head("Schedule"), ...k.kv(detail)], problems));
}

/**
 * The daemon's row, and the ▲ that goes with it when it needs fixing. The fix
 * is named whether or not scheduling is on: the daemon is what every scheduled
 * scan would run under, and this is the screen people open to ask about it.
 */
function describeDaemon(
  status: ReturnType<typeof daemonServiceStatus>,
  k: ReturnType<typeof kitFor>,
): { value: string; problem?: string } {
  switch (status) {
    case "running":
      return { value: `${k.on} Running` };
    case "stopped":
      return { value: `${k.off} Stopped`, problem: k.caution("The daemon is stopped.", "failproofai config") };
    case "not-installed":
      return {
        value: `${k.off} Not installed`,
        problem: k.caution("The daemon is not installed.", "failproofai config"),
      };
    case "condition-failed":
      return {
        value: `${k.off} Binary missing`,
        problem: k.caution("The daemon is installed but its binary is missing.", "failproofai config"),
      };
    case "unknown":
      // Only macOS without a cached sudo credential reads this, about a daemon
      // that is usually running perfectly — not a fault to fix.
      return { value: "Unknown" };
    default:
      return { value: isDaemonSupportedPlatform() ? String(status) : "Unavailable on this platform" };
  }
}

/** Printed after turning scheduling on, where the answer changes what to do. */
function warnIfDaemonWontRun(): void {
  const status = daemonServiceStatus();
  if (status === "running") return;
  // "unknown" is not "broken", and on macOS it is the ORDINARY reading.
  // `daemonServiceStatus` needs `sudo -n` to interrogate a LaunchDaemon, and a
  // Mac with no cached sudo credential — the overwhelmingly common state —
  // answers "unknown" for a service that is running perfectly. Treating every
  // non-`running` value as a fault told those users "nothing will run on the
  // timer yet" in the same breath as confirming their schedule was on. The
  // dashboard already special-cases it; this is the same call.
  if (status === "unknown") return;
  const k = kitFor(process.stderr);
  if (!isDaemonSupportedPlatform()) {
    process.stderr.write(`\n${k.caution("The daemon is not available on this platform, so nothing will run on the timer.")}\n`);
    return;
  }
  const state =
    status === "not-installed" ? "not installed" : status === "condition-failed" ? "missing its binary" : status.replace(/-/g, " ");
  process.stderr.write(
    `\n${k.caution(`The daemon is ${state}, so nothing will run on the timer yet.`, "failproofai config")}\n`,
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
