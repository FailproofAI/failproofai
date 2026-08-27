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
import {
  ANSI_BOLD,
  ANSI_DIM,
  ANSI_RESET,
  brandAnsi,
  colorsEnabled,
  optsFor,
  outro,
  printBlock,
  rows as kitRows,
  stack,
  step,
  title,
} from "../hooks/tui";

/** Mirrors `fp-config`'s own bounds so the error can name them before writing. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;

export class ScheduleCliError extends Error {}

/**
 * Colour and the spine answer to ONE gate, checked at call time.
 *
 * They used to disagree: these helpers emitted ANSI unconditionally while the
 * frame asked `colorsEnabled`, so a piped `--status` came out as escape codes
 * with no structure — the worst of both. `colorsEnabled` is false off a TTY and
 * under `NO_COLOR`, which is exactly when a readout should be plain text.
 */
const styled = () => colorsEnabled(process.stdout);
const wrap = (open: string, s: string) => (styled() ? `${open}${s}${ANSI_RESET}` : s);
const pink = (s: string) => wrap(brandAnsi("pink"), s);
const green = (s: string) => wrap(brandAnsi("guide"), s);
const dim = (s: string) => wrap(ANSI_DIM, s);
const bold = (s: string) => wrap(ANSI_BOLD, s);

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

  // Two rows rather than one long one: at 80 columns the combined sentence
  // wrapped, and a wrapped summary loses the spine on its second row.
  // The third row enumerates what leaves the machine, and it is not optional.
  // This is the ONLY opt-in path on the headless boxes the whole feature was
  // built for — the settings panel says "sends: counts, redacted examples, and
  // this machine's name" and argues in its own comment that a checkable list
  // beats a stronger claim, and that reasoning applies here at least as much.
  // The list is the real payload from `report-harm.ts`: machine id, hostname,
  // platform, the window bounds and the redacted examples.
  const summary = [
    `every ${interval} day${interval === 1 ? "" : "s"} · reports to ${user.email}`,
    "you only hear from it when a scan finds something harmful",
    "each report sends: finding counts, redacted example commands, this machine's name",
  ];

  if (prompted) {
    // A sign-in just drew the frame, so the result continues it and the `└`
    // closes both at once — rather than the frame ending and a loose line
    // appearing underneath.
    step("scheduled audits are on", summary);
  } else {
    // Nothing was asked, so nothing was a flow: a spine here would open a frame
    // that has no beginning.
    process.stdout.write(
      `\n${green("✓")}  ${bold("scheduled audits are on")}\n` +
        summary.map((r) => `   ${dim(r)}\n`).join(""),
    );
  }

  // The switch is config; whether anything RUNS is the daemon. Saying "on"
  // without checking would be the same "on but silent" state the settings panel
  // exists to make visible.
  warnIfDaemonWontRun();

  if (prompted) {
    outro("failproofai audit --status  ·  when the next scan is due");
  } else {
    process.stdout.write(dim(`\n   failproofai audit --status   when the next scan is due\n\n`));
  }
}

export function runScheduleOff(): void {
  const before = readConfig().audit.auto;
  const next = updateConfig({ audit: { auto: false } });
  if (next.audit.auto) {
    process.stdout.write("Could not turn scheduled audits off.\n");
    return;
  }
  if (!before) {
    process.stdout.write(dim("\nScheduled audits were already off.\n\n"));
    return;
  }
  process.stdout.write(
    `\n${green("✓")}  ${bold("scheduled audits are off")}\n` +
      `   ${dim("nothing runs on a timer and nothing is sent")}\n` +
      `   ${dim("your session is untouched — sign out from the dashboard for that")}\n\n`,
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
  const opts = optsFor(process.stdout);
  const detail: Array<[string, string]> = [];

  // The state first, because everything below is detail about a machine that is
  // either doing this or not, and reading the detail first answers a question
  // nobody has asked yet. It is a ROW like the rest, though: the headline used
  // to be hand-padded to a different column than `row()` used, which is why this
  // readout printed its first value at column 21 and every other at 18.
  detail.push([
    "scheduled audit",
    on
      ? `${green("on")}${dim(`  every ${config.audit.intervalDays} days`)}`
      : dim("off"),
  ]);

  // A session whose refresh window has closed cannot mint another access token,
  // so it is a destination in name only. Showing the address for one would tell
  // somebody their digests are going somewhere they are not.
  const live = auth && auth.refresh_expires_at * 1000 > Date.now() ? auth : null;
  detail.push(["reports to", live ? live.user.email : dim("— signed out")]);
  if (on && !live) {
    // The state the reporter surfaces as "signed-out". Named here for the same
    // reason the settings panel names it: the scans keep running, so silence
    // about the digests would look like the feature failing.
    detail.push(["", pink("scans continue; digests are paused until you sign in")]);
  } else if (on && config.audit.reportsConsentedAt === undefined) {
    // Signed in, scheduled, and still not sending: this machine set `audit.auto`
    // when it only meant "scan locally", so nothing has consented to the digest
    // leaving the box. Without this row the status screen would show a healthy
    // schedule and a live address and still mail nothing, with no explanation
    // anywhere the user can see.
    detail.push([
      "",
      pink("scans continue; digests need a fresh opt-in — run `--schedule` to turn them on"),
    ]);
  }

  detail.push(["daemon", describeDaemon(daemon)]);

  if (sched?.nextDueAtMs != null && on) {
    detail.push(["next scan", untilPhrase(sched.nextDueAtMs)]);
  }
  if (sched?.lastRunAtMs != null) {
    const exit = sched.lastExitCode;
    const failed = exit != null && exit !== 0 && exit !== 75;
    detail.push([
      "last scheduled",
      agoPhrase(sched.lastRunAtMs) + (failed ? `  ${pink(`exit ${exit}`)}` : ""),
    ]);
  }
  detail.push([
    "last result",
    meta?.cachedAt ? agoPhrase(Date.parse(meta.cachedAt)) : dim("none yet"),
  ]);
  if (machine?.last_reported_at) {
    detail.push(["last reported", agoPhrase(Date.parse(machine.last_reported_at))]);
  }

  printBlock(
    process.stdout,
    stack(
      // The meta carries a fact, not the word "status" — a heading that repeats
      // the command name tells the reader nothing they did not just type.
      title(
        "failproofai audit",
        on ? `scheduled · every ${config.audit.intervalDays} days` : "not scheduled",
        opts,
      ),
      kitRows(detail, opts),
    ),
  );
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
  // "unknown" is not "broken", and on macOS it is the ORDINARY reading.
  // `daemonServiceStatus` needs `sudo -n` to interrogate a LaunchDaemon, and a
  // Mac with no cached sudo credential — the overwhelmingly common state —
  // answers "unknown" for a service that is running perfectly. Treating every
  // non-`running` value as a fault told those users "nothing will run on the
  // timer yet" in the same breath as confirming their schedule was on. The
  // dashboard already special-cases it; this is the same call.
  if (status === "unknown") return;
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
