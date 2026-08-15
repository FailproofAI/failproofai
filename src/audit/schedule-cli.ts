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
  outro,
  step,
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
 * The readout's left margin.
 *
 * Deliberately NOT the `│` spine the sign-in uses. A spine means "a flow is
 * happening, with a beginning and an end"; `--status` is a snapshot of a
 * machine, and hanging one off a frame that never opened reads as an unfinished
 * wizard. Alignment does the work here instead.
 */
const rail = () => " ";

/**
 * One labelled row of the `--status` readout.
 *
 * A fixed label column so the values line up into a second column that can be
 * read straight down — the whole point of this command is answering "what is
 * this machine doing" at a glance, and a ragged left edge makes four facts read
 * as four sentences.
 */
const LABEL_WIDTH = 15;
function row(label: string, value: string, note?: string): string {
  const gap = " ".repeat(Math.max(1, LABEL_WIDTH - label.length));
  return `${rail()}  ${dim(label)}${gap}${value}${note ? `  ${dim(note)}` : ""}`;
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

  // Two rows rather than one long one: at 80 columns the combined sentence
  // wrapped, and a wrapped summary loses the spine on its second row.
  const summary = [
    `every ${interval} day${interval === 1 ? "" : "s"} · reports to ${user.email}`,
    "you only hear from it when a scan finds something harmful",
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
  const out: string[] = [""];

  // The state first and alone, in the accent that matches it — everything below
  // is detail about a machine that is either doing this or not, and reading the
  // detail first is reading the answer to a question nobody asked yet.
  out.push(
    `${rail()}  ${bold("scheduled audit")}   ${on ? green("on") : dim("off")}` +
      (on ? dim(`  every ${config.audit.intervalDays} days`) : ""),
  );
  out.push(rail());

  out.push(row("reports to", auth ? auth.user.email : dim("— signed out")));
  if (on && !auth) {
    // The state the reporter surfaces as "signed-out". Named here for the same
    // reason the settings panel names it: the scans keep running, so silence
    // about the digests would look like the feature failing.
    out.push(row("", pink("scans continue; digests are paused until you sign in")));
  }

  out.push(row("daemon", describeDaemon(daemon)));

  if (sched?.nextDueAtMs != null && on) {
    out.push(row("next scan", untilPhrase(sched.nextDueAtMs)));
  }
  if (sched?.lastRunAtMs != null) {
    const exit = sched.lastExitCode;
    out.push(
      row(
        "last scheduled",
        agoPhrase(sched.lastRunAtMs),
        exit != null && exit !== 0 && exit !== 75 ? pink(`exit ${exit}`) : undefined,
      ),
    );
  }
  out.push(
    row("last result", meta?.cachedAt ? agoPhrase(Date.parse(meta.cachedAt)) : dim("none yet")),
  );
  if (machine?.last_reported_at) {
    out.push(row("last reported", agoPhrase(Date.parse(machine.last_reported_at))));
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
