/**
 * `failproofai audit` — run a local audit of your agent-CLI history, then open
 * the dashboard to view it.
 *
 *   failproofai audit                Scan, then launch the dashboard at /audit.
 *   failproofai audit --schedule     Put scans on a timer and mail the findings.
 *   failproofai audit --no-schedule  Stop the timer.
 *   failproofai audit --status       What this machine is scheduled to do.
 *   failproofai audit -h, --help     Show usage.
 *
 * `runAudit()` is a pure local function (no network, no account). We run it,
 * render the same four progress stages the dashboard's RunProgress shows,
 * pre-warm the dashboard cache (~/.failproofai/audit-dashboard.json), then start
 * the bundled dashboard server and open the browser to /audit — which renders
 * instantly from that cache.
 *
 * A bare `failproofai audit` does a full scan (all CLIs, all history); the
 * scheduling flags above write config and never scan. Scan-shaping flags
 * (--since, --cli, --project, --port, --no-open) are easy follow-ups against
 * `RunAuditOptions`.
 *
 * `--scheduled` is the one exception, and it is not a flag on the interactive
 * command so much as a second entry point sharing its name: it runs the same
 * scan with no TTY, no browser and no server, and reports its outcome through
 * an exit code. See `runScheduledAudit`.
 */
import { runAudit } from "./index";
import { acquireAuditLock, type AuditLockInfo } from "./audit-lock";
import { writeDashboardCache } from "./dashboard-cache";
import type { AuditResult, RunAuditOptions } from "./types";
import { trackHookEvent } from "../hooks/hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import { sanitizeErrorMessage } from "../../lib/telemetry-sanitize";
import { openWhenReady } from "./open-browser";
import { describeOutcome, reportHarm } from "./report-harm";
import { brandAnsi, ANSI_RESET, ANSI_BOLD, ANSI_DIM } from "../hooks/tui";

/** Port the bundled dashboard binds to. Matches `scripts/launch.ts`'s default
 *  for `start` mode, which `failproofai` (bare) already uses. */
const DASHBOARD_PORT = 8020;

/**
 * `EX_TEMPFAIL` from sysexits.h — "another audit already holds the lock".
 *
 * A distinct code rather than 1, because the scheduler that spawns the headless
 * run has to tell the two apart: a failure deserves a report, while losing the
 * lock means only "come back in fifteen minutes". Collapsing them would make a
 * healthy machine that simply ran two audits close together look broken.
 */
export const EXIT_AUDIT_ALREADY_RUNNING = 75;

/**
 * Mirror of `app/audit/_components/run-progress.tsx`'s `STAGES`. Kept identical
 * so the CLI and the dashboard's in-progress view tell the same story — the
 * dashboard even renders a mock `$ failproofai audit` terminal, and this is the
 * real thing. `audit-cli.test.ts` guards against drift between the two.
 */
export const AUDIT_STAGES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "discovering transcripts", detail: "walking ~/.claude, ~/.codex, ~/.cursor, …" },
  { label: "parsing session logs", detail: "reading JSONL + sqlite session stores" },
  { label: "running policy checks", detail: "replaying every policy against each tool call" },
  { label: "aggregating results", detail: "counting hits, ranking by frequency" },
];

/** Column the description text starts at. The widest command line is 37 wide. */
const HELP_DESC_COL = 40;

/**
 * `audit --help`.
 *
 * A function rather than a module-level string because the command names are
 * coloured through `c()`, which reads `colorOn()` at CALL time — a const would
 * bake in whatever the TTY looked like at import, and this module is imported
 * by the bundled CLI long before anyone asks for help.
 *
 * `--scheduled` is deliberately absent: it is not a flag a person types but a
 * second entry point the daemon spawns (see the module header), and listing a
 * machine-facing flag one letter away from `--schedule` in the same block is
 * how somebody ends up running a 100-second scan when they meant to configure
 * one. It still works, and still refuses every argument it always refused.
 */
export function helpText(): string {
  const row = (command: string, lines: string[]): string => {
    // Padding is measured on the RAW command — `c()` adds escape bytes that
    // occupy no columns, so colouring first would misalign every row.
    const pad = " ".repeat(Math.max(1, HELP_DESC_COL - 2 - command.length));
    return lines
      .map((line, i) =>
        i === 0 ? `  ${c(CYAN, command)}${pad}${line}` : `${" ".repeat(HELP_DESC_COL)}${line}`,
      )
      .join("\n");
  };

  return [
    `${c(BOLD, "failproofai audit")} — review your agent CLIs for risky and wasteful patterns.`,
    c(DIM, "Everything runs on this machine; only a scheduled digest ever leaves it."),
    "",
    c(BOLD, "USAGE"),
    row("failproofai audit", [
      "Scan your session history, then open",
      `http://localhost:${DASHBOARD_PORT}/audit`,
    ]),
    row("failproofai audit --schedule [days]", [
      "Scan on a timer and email the findings.",
      "Default 7 days, range 1-90.",
      "Signs you in the first time; add",
      "--email <address> to skip a prompt.",
    ]),
    row("failproofai audit --no-schedule", ["Stop the timer. Leaves you signed in."]),
    row("failproofai audit --status", [
      "Whether scheduling is on, where reports",
      "go, the daemon's state, and when the",
      "next scan is due.",
    ]),
    row("failproofai audit -h, --help", ["Show this help."]),
    "",
  ].join("\n");
}

// ── ANSI helpers ────────────────────────────────────────────────────────────
// Colours come from the shared brand palette in hooks/tui.ts, so `audit` reads
// as the same product as `config`. This file used to define its own 256-colour
// set (a green and a blue that appear nowhere in the brand). The palette has
// two accents rather than three, so success and command/URL text share the
// teal — the glyph (✓) and the surrounding copy already distinguish them.
const RESET = ANSI_RESET;
const DIM = ANSI_DIM;
const BOLD = ANSI_BOLD;
const PINK = brandAnsi("pink");
const GREEN = brandAnsi("guide"); // success — brand teal
const CYAN = brandAnsi("guide"); // commands & URLs — brand teal
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function colorOn(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR) return true;
  return !!process.stdout.isTTY;
}

/** Wrap `s` in an ANSI code when color is enabled, else return it bare. */
function c(code: string, s: string): string {
  return colorOn() ? `${code}${s}${RESET}` : s;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Print an error and exit 1. We exit directly rather than throwing a `CliError`
 * because, in the shipped single-file bundle (`dist/cli.mjs`), the entrypoint's
 * dynamically-imported `CliError` is a different class instance than the one
 * bundled here, so `err instanceof CliError` fails and the message degrades to
 * "Unexpected error" + exit 2. Exiting here keeps the audit command's failures
 * clean in both source and bundled runs.
 */
function die(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

// ── Progress animation ───────────────────────────────────────────────────────

interface Progress {
  /** Mark every stage done and stop the timers. */
  finish(): void;
  /** Stop the timers without marking done (used on error). */
  fail(): void;
}

/**
 * Render the four audit stages with a live spinner, redrawing in place. Like the
 * dashboard's RunProgress, the stages are time-driven (runAudit emits no phase
 * events) and the last stage is *held* until `finish()` is called, so it never
 * claims "done" before the real work resolves. TTY-only — the caller picks the
 * plain-text path when stdout isn't a terminal.
 */
function startProgress(): Progress {
  const n = AUDIT_STAGES.length;
  let stage = 0;
  let tick = 0;
  let done = false;
  let printed = false;

  const lineFor = (i: number): string => {
    const s = AUDIT_STAGES[i];
    if (done || i < stage) return `  ${c(GREEN, "✓")} ${c(DIM, s.label)}`;
    if (i === stage) {
      return `  ${c(PINK, SPINNER[tick % SPINNER.length])} ${s.label}  ${c(DIM, s.detail)}`;
    }
    return `  ${c(DIM, "○")} ${c(DIM, s.label)}`;
  };

  const render = (): void => {
    const lines = Array.from({ length: n }, (_, i) => lineFor(i));
    // Move the cursor back up over the previously-drawn block, then clear and
    // rewrite each line in place.
    if (printed) process.stdout.write(`\x1b[${n}A`);
    process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    printed = true;
  };

  render();
  const spinTimer = setInterval(() => {
    tick++;
    render();
  }, 90);
  // Advance through stages on a fixed cadence, holding on the last one until
  // finish() flips `done`.
  const stageTimer = setInterval(() => {
    if (stage < n - 1) {
      stage++;
      render();
    }
  }, 1100);

  const stop = (): void => {
    clearInterval(spinTimer);
    clearInterval(stageTimer);
  };

  return {
    finish() {
      stop();
      done = true;
      render();
    },
    fail() {
      stop();
      process.stdout.write("\n");
    },
  };
}

/** Run the audit, showing animated progress on a TTY or a single line elsewhere. */
async function runWithProgress(opts: RunAuditOptions): Promise<AuditResult> {
  if (!process.stdout.isTTY) {
    process.stdout.write("  scanning your agent session history — this can take a moment…\n");
    return runAudit(opts);
  }
  const progress = startProgress();
  try {
    const result = await runAudit(opts);
    progress.finish();
    return result;
  } catch (err) {
    progress.fail();
    throw err;
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

function printHeader(): void {
  process.stdout.write(`\n  ${c(PINK, "🛡  failproofai audit")}  ${c(DIM, "· beta")}\n\n`);
  process.stdout.write(`  ${c(DIM, "starting audit…")}\n\n`);
}

/**
 * The post-run summary lines (no leading indent, no trailing newlines). Pure so
 * it's unit-testable; `printSummary` handles the indentation + stdout.
 */
export function buildSummary(result: AuditResult): string[] {
  const sessions = result.transcripts.scanned;
  const events = result.eventsScanned;
  const projects = result.projectsScanned.length;
  const enabledRows = result.results.filter((r) => r.source === "builtin" && r.enabledInConfig);
  const slippingRows = result.results.filter((r) => !(r.source === "builtin" && r.enabledInConfig));

  const lines: string[] = [];
  lines.push(
    `${c(GREEN, "✓ audit complete")}  ${c(DIM, "·")}  ` +
      `${c(BOLD, num(events))} tool call${events === 1 ? "" : "s"} across ` +
      `${num(sessions)} session${sessions === 1 ? "" : "s"}` +
      (projects > 0 ? ` ${c(DIM, "·")} ${num(projects)} project${projects === 1 ? "" : "s"}` : ""),
  );

  if (result.totals.hits === 0) {
    // Only call it a "clean run" when we actually scanned something — for zero
    // events the caller prints "no agent sessions found yet" guidance instead.
    if (events > 0) lines.push(c(DIM, "clean run — nothing flagged. nice."));
    return lines;
  }

  const parts: string[] = [];
  if (slippingRows.length > 0) {
    parts.push(
      `${c(PINK, String(slippingRows.length))} ${slippingRows.length === 1 ? "pattern" : "patterns"} slipping through`,
    );
  }
  if (enabledRows.length > 0) {
    parts.push(`${c(GREEN, String(enabledRows.length))} already blocked by your policies`);
  }
  if (parts.length > 0) lines.push(parts.join(`  ${c(DIM, "·")}  `));
  return lines;
}

function printSummary(result: AuditResult): void {
  process.stdout.write("\n");
  for (const line of buildSummary(result)) process.stdout.write(`  ${line}\n`);
}

// ── Audit telemetry ──────────────────────────────────────────────────────────

/**
 * Which entry point ran the audit. `onboarding` is the automatic post-setup run;
 * `cli` is an explicit `failproofai audit`; `scheduled` is the headless run the
 * daemon spawns. Carried on every cli_audit_* event so the first audit a user
 * ever runs, a deliberate one, and one nobody was present for stay distinct —
 * without which an opt-in scheduled scan would silently inflate the counts that
 * describe what people actually do by hand.
 */
type AuditSource = "cli" | "onboarding" | "scheduled";

/** Shared so both entry points report cli_audit_completed identically. */
function auditCompletedProps(source: AuditSource, result: AuditResult) {
  return {
    source,
    events_scanned: result.eventsScanned,
    sessions_scanned: result.transcripts.scanned,
    total_hits: result.totals.hits,
    findings: result.results.length,
  };
}

/** One line naming whoever holds the lock, for a refusal message. */
function heldByLine(held: AuditLockInfo | null): string {
  if (!held) return "another audit is already running";
  const ageS = Math.max(0, Math.round((Date.now() - held.startedAt) / 1000));
  return `another audit is already running (pid ${held.pid}, started by ${held.source} ${ageS}s ago)`;
}

// ── Headless (scheduled) audit ───────────────────────────────────────────────

/**
 * Run the audit with nobody watching: no TTY animation, no browser, no prompts,
 * no dashboard server left behind.
 *
 * This is the entry point the scheduler spawns, and it must be a SEPARATE
 * short-lived process. `src/hooks/worker-server.ts` serialises every request
 * through one promise chain that `crates/failproofaid/src/worker.rs` caps at
 * 30s, and `daemon-client.ts` turns that timeout into a DENY — so a ~104-second
 * audit on the warm worker would be a machine-wide fail-closed denial across
 * all 12 CLIs for as long as it ran.
 *
 * Returns the exit code instead of exiting, so the caller owns the exit and
 * this stays callable from a test:
 *   0  the scan completed (whether or not it found anything)
 *   1  the scan failed, or its result could not be persisted
 *  75  another audit holds the lock — not an error, come back later
 */
export async function runScheduledAudit(): Promise<number> {
  const attempt = acquireAuditLock("scheduled");
  if (!attempt.ok) {
    // Deliberately ahead of cli_audit_started: a run that never started must
    // not be counted as one that did.
    process.stderr.write(`failproofai: ${heldByLine(attempt.heldBy)}; skipping this scheduled run\n`);
    return EXIT_AUDIT_ALREADY_RUNNING;
  }

  const instanceId = getInstanceId();
  try {
    // Every event here is awaited, unlike runAuditCli's fire-and-forget
    // `started`. Nothing keeps this process alive once the audit settles — no
    // dashboard server, no user — and there is nobody waiting on latency
    // either, so the bounded (5s, never-throws) send costs nothing that matters.
    await trackHookEvent(instanceId, "cli_audit_started", { source: "scheduled" });

    let result: AuditResult;
    try {
      result = await runAudit({});
    } catch (err) {
      await trackHookEvent(instanceId, "cli_audit_failed", {
        source: "scheduled",
        error_type: err instanceof Error ? err.name : "unknown",
        error_message: sanitizeErrorMessage(err),
      });
      process.stderr.write(
        `failproofai: scheduled audit failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }

    await trackHookEvent(instanceId, "cli_audit_completed", auditCompletedProps("scheduled", result));

    // No cache write for an empty scan, matching both interactive paths — and it
    // matters more here. This run is unattended, so overwriting a real earlier
    // audit's cached result with an empty one (after a history rotation, or on a
    // service unit whose HOME resolves somewhere else) would blank the dashboard
    // with nobody present to notice why.
    if (result.eventsScanned > 0 && !writeDashboardCache({}, result)) {
      // The cache is the only channel by which this run's result reaches
      // anyone, so failing to write it is a failed run, not a footnote.
      process.stderr.write("failproofai: scheduled audit ran but its result could not be saved\n");
      return 1;
    }

    process.stdout.write(
      `failproofai: audit complete — ${num(result.eventsScanned)} tool calls across ` +
        `${num(result.transcripts.scanned)} sessions, ${num(result.totals.hits)} hits\n`,
    );

    // Report harmful findings upstream, if the user switched emailed reports on.
    //
    // AFTER the dashboard cache is written and AFTER the success line, because
    // the scan is the product and this is an optional extra on top of it.
    // `reportHarm` never throws — every failure inside it is an outcome — so a
    // dead network, an expired session or an api-server having a bad day cannot
    // turn a successful scan into exit 1. A machine that never opted in prints
    // nothing at all and does no work here.
    //
    // Scheduled runs ONLY. An interactive `failproofai audit` has a person
    // sitting in front of the result, so mailing it to them is noise, and it
    // would also make the manual command do a network call that
    // `audit --help` promises it does not.
    const outcome = await reportHarm(result);
    const line = describeOutcome(outcome);
    if (line) {
      // Anything other than a successful send goes to stderr: on a scheduled run
      // the journal is the only reader, and "the email did not go out" is the
      // half worth finding with a grep.
      const stream = outcome.kind === "sent" ? process.stdout : process.stderr;
      stream.write(`${line}\n`);
    }

    return 0;
  } finally {
    attempt.lock.release();
  }
}

// ── Post-setup background audit ────────────────────────────────────────────────

/**
 * Run the audit *pipeline* (scan + cache write + summary) once the setup flow
 * completes, right before the dashboard boots. Pre-warms
 * `~/.failproofai/audit-dashboard.json` so the dashboard renders instantly, and
 * immediately shows the user what's slipping through.
 *
 * Shows the same animated stages as `failproofai audit`. The scan runs to
 * completion; Ctrl+C interrupts it the usual way (default SIGINT). Best-effort:
 * never throws, never exits the process; the caller boots the dashboard
 * afterward. Opt out with `FAILPROOFAI_NO_AUTO_AUDIT=1`.
 */
export async function runPostSetupAudit(): Promise<void> {
  if (process.env.FAILPROOFAI_NO_AUTO_AUDIT === "1") return;

  // Take the same cross-process cache lock the scheduled run, `failproofai
  // audit` and the dashboard re-run take. This onboarding scan writes the very
  // same sha1-keyed per-transcript cache and single-slot dashboard cache, so it
  // is the fourth writer and must serialise with the other three — a scheduled
  // daemon child can already be mid-scan when setup finishes. Held ⇒ skip, best
  // effort: the dashboard boots on whatever the holder's run leaves behind, and
  // this is pre-warming, not a result anyone is waiting on. `onboarding` matches
  // the telemetry source below and the lock source declared in audit-lock.ts.
  const attempt = acquireAuditLock("onboarding");
  if (!attempt.ok) {
    process.stdout.write(
      `\n  ${c(DIM, "an audit is already running — the dashboard will show its result.")}\n\n`,
    );
    return;
  }

  try {
    const instanceId = getInstanceId();
    // Fire-and-forget, as in runAuditCli: the multi-second scan below keeps the
    // process alive long enough for this to land, and the completed/failed event
    // that follows is awaited.
    void trackHookEvent(instanceId, "cli_audit_started", { source: "onboarding" });

    process.stdout.write(
      `\n  ${c(PINK, "✦")} ${c(BOLD, "failproofai audit now running")}  ${c(DIM, "· ctrl+c to stop")}\n\n`,
    );

    let result: AuditResult;
    try {
      result = await runWithProgress({});
    } catch (err) {
      // Awaited: this function returns straight into the dashboard boot, and a
      // fire-and-forget fetch would race it.
      await trackHookEvent(instanceId, "cli_audit_failed", {
        source: "onboarding",
        error_type: err instanceof Error ? err.name : "unknown",
        error_message: sanitizeErrorMessage(err),
      });
      process.stdout.write(
        `  ${c(PINK, "!")} ${c(DIM, "audit couldn't finish — run")} ${c(CYAN, "failproofai audit")} ${c(DIM, "later.")}\n\n`,
      );
      return;
    }

    // Reported before the empty-history return below, so an onboarding audit that
    // finds nothing is still counted — matching runAuditCli, which reports
    // completed regardless of what the scan turned up.
    await trackHookEvent(instanceId, "cli_audit_completed", auditCompletedProps("onboarding", result));

    if (result.eventsScanned === 0) {
      process.stdout.write(
        `\n  ${c(DIM, "no agent sessions to audit yet — come back after using your agent.")}\n\n`,
      );
      return;
    }
    writeDashboardCache({}, result);
    printSummary(result);
    process.stdout.write("\n");
  } finally {
    attempt.lock.release();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runAuditCli(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(helpText());
    process.exit(0);
  }
  // The headless path, spawned rather than typed. Handled ahead of the
  // rejection below so that adding it costs the interactive path nothing: it
  // still refuses every argument it has always refused.
  //
  // `--scheduled` (run one now, headlessly) and `--schedule` (put runs on a
  // timer) differ by one letter and do completely different things, so this
  // is checked FIRST and exactly: a `--schedule` typo must not silently start
  // a 100-second scan, and `--scheduled` must never be read as configuration.
  if (args.includes("--scheduled")) {
    const extra = args.find((a) => a !== "--scheduled");
    if (extra) die(`\`audit --scheduled\` takes no other arguments (got: ${extra}).`);
    process.exit(await runScheduledAudit());
  }

  // The scheduling controls. These write config and exit; none of them scan.
  if (args.includes("--status")) {
    const extra = args.find((a) => a !== "--status");
    if (extra) die(`\`audit --status\` takes no other arguments (got: ${extra}).`);
    const { runScheduleStatus } = await import("./schedule-cli");
    runScheduleStatus();
    process.exit(0);
  }

  if (args.includes("--no-schedule")) {
    const extra = args.find((a) => a !== "--no-schedule");
    if (extra) die(`\`audit --no-schedule\` takes no other arguments (got: ${extra}).`);
    const { runScheduleOff } = await import("./schedule-cli");
    runScheduleOff();
    process.exit(0);
  }

  const scheduleAt = args.indexOf("--schedule");
  if (scheduleAt !== -1) {
    // Parsed POSITIONALLY rather than by matching values against a set: an
    // address and a day count are both just strings, and "have I already seen
    // this string" cannot tell the argument of one flag from the argument of
    // another.
    let days: string | undefined;
    let email: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === "--schedule") {
        // The day count is OPTIONAL, so the next token counts only when it is
        // not itself a flag — `--schedule --email x` must not read "--email"
        // as a number of days.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          days = next;
          i += 1;
        }
        continue;
      }
      if (a === "--email" || a.startsWith("--email=")) {
        // Both forms, because both are what people type.
        if (a.startsWith("--email=")) {
          email = a.slice("--email=".length);
        } else {
          email = args[i + 1];
          i += 1;
        }
        if (email === undefined || email.length === 0 || email.startsWith("-")) {
          die("`--email` needs an address, e.g. `--email you@yourdomain.com`.");
        }
        continue;
      }
      die(`\`audit --schedule\` does not take ${a}.`);
    }

    const { runScheduleOn, ScheduleCliError } = await import("./schedule-cli");
    const { LoginError } = await import("./cli-login");
    try {
      await runScheduleOn(days, email);
    } catch (err) {
      // Both are "the user needs to read one sentence and try again", not a
      // stack trace: a wrong day count, a cancelled prompt, an api-server that
      // is not running.
      if (err instanceof ScheduleCliError || err instanceof LoginError) die(err.message);
      throw err;
    }
    process.exit(0);
  }

  // Anything else is rejected rather than silently doing a bare audit, so a
  // typo like `--sched` does not quietly scan and exit 0 looking like it worked.
  const stray = args.find((a) => a !== "--help" && a !== "-h");
  if (stray) {
    die(
      `\`audit\` does not take ${stray}.\n` +
        `Run \`failproofai audit\` to scan your history and open the dashboard,\n` +
        `or \`failproofai audit --help\` for the scheduling commands.`,
    );
  }

  // Taken before any telemetry so a refused run is not counted as a started
  // one, and released the moment the SCAN is done — see below, well before
  // launch() parks this process on the dashboard.
  const attempt = acquireAuditLock("cli");
  if (!attempt.ok) {
    process.stderr.write(
      `Error: ${heldByLine(attempt.heldBy)}.\n` +
        `Two audits write the same cache files, so this one won't start. Try again shortly.\n`,
    );
    process.exit(EXIT_AUDIT_ALREADY_RUNNING);
  }

  const instanceId = getInstanceId();
  // Fire-and-forget is safe for `started`: the multi-second audit below (and the
  // awaited cli_audit_completed / cli_audit_failed) keep the process alive long
  // enough for this fetch to land. Awaiting it would add up to a 5s pre-audit
  // stall on a flaky network for no reliability gain.
  void trackHookEvent(instanceId, "cli_audit_started", { source: "cli" });

  printHeader();

  // Full scan: all CLIs, all history, per-transcript cache on.
  const opts: RunAuditOptions = {};

  let result: AuditResult;
  try {
    result = await runWithProgress(opts);
  } catch (err) {
    // Await before die(): die() calls process.exit(1), which would kill an
    // in-flight fire-and-forget fetch and drop this event. trackHookEvent is
    // bounded (5s timeout) and never throws, so this can't hang or mask the error.
    await trackHookEvent(instanceId, "cli_audit_failed", {
      source: "cli",
      error_type: err instanceof Error ? err.name : "unknown",
      error_message: sanitizeErrorMessage(err),
    });
    die(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  printSummary(result);

  // Await before the empty-history branch below, which calls process.exit(0) and
  // would otherwise drop this event. On the dashboard path launch() keeps the
  // process alive, but awaiting makes delivery reliable on every exit path.
  // Bounded (5s) and never throws.
  await trackHookEvent(instanceId, "cli_audit_completed", auditCompletedProps("cli", result));

  // No sessions on disk — guide the user instead of opening an empty dashboard.
  if (result.eventsScanned === 0) {
    process.stdout.write(
      `\n  ${c(DIM, "no agent sessions found yet.")}\n` +
        `  install hooks with ${c(CYAN, "failproofai policies --install")} ` +
        `${c(DIM, "and come back after using your agent.")}\n\n`,
    );
    process.exit(0);
  }

  // Pre-warm the dashboard cache — the /audit page reads this file directly, so
  // the page renders our result instantly with no in-browser re-run.
  const persisted = writeDashboardCache(opts, result);
  if (!persisted) {
    process.stdout.write(
      `\n  ${c(PINK, "!")} ${c(DIM, "couldn't save the audit cache; the dashboard may show an empty state.")}\n`,
    );
  }

  // Released here, not in a `finally`: the lock covers the SCAN, and launch()
  // below keeps this process alive for as long as the user leaves the dashboard
  // open. Holding it that long would block every scheduled run until the
  // one-hour stale ceiling expired. The exit paths above (die(), the
  // empty-history exit) are covered by the handle's own process-exit hook.
  attempt.lock.release();

  const url = `http://localhost:${DASHBOARD_PORT}/audit`;
  process.stdout.write(
    `\n  ${c(DIM, "starting the dashboard…")}\n` +
      `  ${c(PINK, "✦")} ${c(BOLD, "here's your audit")}  ${c(DIM, "→")}  ${c(CYAN, url)}\n` +
      `  ${c(DIM, "(opening in your browser — press Ctrl+C to stop the server)")}\n\n`,
  );

  // Open the page once the server answers (best-effort, detached), then start
  // the server. `launch("start")` blocks-by-keeping-alive — it spawns the
  // bundled standalone dashboard and the process stays up serving it.
  openWhenReady(DASHBOARD_PORT, "/audit");
  const { launch } = await import("../../scripts/launch");
  launch("start");
  // Intentionally no process.exit(): launch() keeps this process alive running
  // the dashboard until the user stops it.
}
