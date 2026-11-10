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
 * `runAudit()` is a pure local function (no network, no account). We run it
 * behind a progress screen — a bar per agent, fed by `runAudit`'s progress
 * callback, and running counts of what was found — pre-warm the dashboard cache
 * (~/.failproofai/audit-dashboard.json), then start the bundled dashboard server
 * and open the browser to /audit, which renders instantly from that cache.
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
import { getDetectorByName } from "./detectors";
import { hasInstalledPacks } from "../hooks/pack-manifest";
import { CORE_SOURCE } from "../hooks/pack-store";
import { acquireAuditLock, type AuditLockInfo } from "./audit-lock";
import { writeDashboardCache } from "./dashboard-cache";
import type { AuditResult, RunAuditOptions } from "./types";
import { trackHookEvent } from "../hooks/hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import { sanitizeErrorMessage } from "../../lib/telemetry-sanitize";
import { openWhenReady } from "./open-browser";
import { describeOutcome, reportHarm } from "./report-harm";
import {
  INDENT,
  optsFor,
  screenKit,
  type ScreenKitOpts,
  type TTYOut,
} from "../hooks/tui";
import { version } from "../../package.json";

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
 * Mirror of `app/audit/_components/run-progress.tsx`'s `STAGES`: the four
 * time-driven stages the dashboard animates while its own run is in flight.
 *
 * The CLI no longer animates them. By decision D16 of the 2026-10 redesign it
 * draws real progress instead — a bar per agent from `runAudit`'s progress
 * callback, and running counts of what was found — so the screen moves when the
 * scan does rather than on a timer. What the two still share is these words:
 * the CLI labels the one phase it has no bars for, listing transcripts, with
 * the first stage's label, and the per-agent bars stand for the middle two.
 * `audit-cli.test.ts` keeps this list identical to the dashboard's, so a stage
 * renamed there is renamed here too.
 */
export const AUDIT_STAGES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "discovering transcripts", detail: "walking ~/.claude, ~/.codex, ~/.cursor, …" },
  { label: "parsing session logs", detail: "reading JSONL + sqlite session stores" },
  { label: "running policy checks", detail: "replaying every policy against each tool call" },
  { label: "aggregating results", detail: "counting hits, ranking by frequency" },
];

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
  // The same page every `<command> --help` is: usage, options and examples,
  // built from the 2026-10 kit. Descriptions are prose and may be shortened to
  // fit a terminal; nothing is ever cut in a pipe.
  const kit = screenKit({ ...optsFor(process.stdout), fit: !!process.stdout.isTTY, version });
  const lines = kit.helpPage({
    name: "audit",
    usage: [
      ["failproofai audit", "Scan your agents' history and open the results"],
      ["failproofai audit [options]", "Manage scheduled scans"],
    ],
    options: [
      ["--schedule [days]", "Scan every N days (1-90, default 7) and email the findings"],
      // Its own row rather than a clause inside --schedule's, so the flag and
      // its placeholder can never be split across a wrap.
      ["--email <address>", "With --schedule: sign in as this address; reports go there"],
      ["--no-schedule", "Stop scheduled scans"],
      ["--status", "Show the schedule and when the next scan runs"],
      ["-h, --help", "Show this help"],
    ],
    examples: ["failproofai audit", "failproofai audit --schedule 7 --email you@example.com"],
    optionsCol: 20,
  });
  // The margins `printBlock` would add, spelled out because this one returns
  // its text for a caller to write rather than writing it.
  return ["", ...lines, ""].join("\n") + "\n";
}

// ── Colour ──────────────────────────────────────────────────────────────────
// Every line below is built by `screenKit()` from the shared palette in
// hooks/tui.ts, and coloured on exactly the terms every other screen is:
// `optsFor(stdout)` — a terminal, and no NO_COLOR. `FORCE_COLOR` is not read
// here, as it is read nowhere else; audit used to be the one screen that
// honoured it, so `FORCE_COLOR=1 failproofai audit | less -R` was the one
// place colour reached a pipe.

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** `1 session`, `1,284 sessions`. */
function counted(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
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

// ── The audit screen ─────────────────────────────────────────────────────────

/** What the audit screen is drawn from: everything `runAudit` has reported so far. */
export interface AuditScreenState {
  /**
   * The agents with sessions to scan, in scan order, and how far each has got.
   * `null` until every agent's transcripts have been listed.
   */
  agents: Array<{ cli: string; total: number; done: number }> | null;
  /** How many policies each tool call is replayed against. */
  policies: number;
  /** Hits so far, by policy or detector name. */
  hits: Record<string, number>;
}

export interface AuditScreenOpts extends ScreenKitOpts {
  /** The finished scan. With it the screen is the final one: every bar done, the summary in place of the key hint. */
  result?: AuditResult;
  /** The scan stopped without a result: the screen as far as it got, with no key hint. */
  stopped?: boolean;
}

/** The "found" rows, in order. */
const FOUND_LABELS = ["would block", "would warn", "audit only"] as const;

/**
 * Which "found" row a finding counts under, as an index into `FOUND_LABELS`:
 * what the policy would do if it were on.
 *
 * Every `warn-*` builtin instructs, so it would warn. `sanitize-*` denies, but
 * on PostToolUse, after the call has already run: it can tell the agent about a
 * secret and stop nothing, so it would warn too — filing it under "would block"
 * is the over-count #669 took out of the block numbers. Every other builtin
 * (`block-*`, `protect-*`, `prefer-*`) denies before the call, so it would
 * block. Deliberately not `severityForBuiltin`: that is the score's heuristic,
 * and it files `protect-env-vars` and `prefer-package-manager` under warn
 * although both deny. The audit-only detectors have no runtime policy at all,
 * so they get a row of their own rather than a "would".
 */
function foundRow(name: string): number {
  if (getDetectorByName(name)) return 2;
  const short = name.slice(name.indexOf("/") + 1);
  return short.startsWith("warn-") || short.startsWith("sanitize-") ? 1 : 0;
}

/**
 * `7: block-env-files 4, block-sudo 2, …` — the total, then the names that
 * make it up, most hits first.
 *
 * A name is whole or absent, never cut: when `room` runs out the list ends on
 * `…`, and the first name is always shown, however narrow the terminal.
 */
function foundValue(items: Array<[string, number]>, room: number): string {
  if (items.length === 0) return num(0);
  const total = items.reduce((sum, [, n]) => sum + n, 0);
  items.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let text = `${num(total)}: `;
  for (let i = 0; i < items.length; i += 1) {
    const piece = `${i > 0 ? ", " : ""}${items[i][0]} ${num(items[i][1])}`;
    // Room for the `, …` this item would have to end on, unless it is the last.
    const tail = i < items.length - 1 ? 3 : 0;
    if (i > 0 && text.length + piece.length + tail > room) return `${text}, …`;
    text += piece;
  }
  return text;
}

/**
 * The `failproofai audit` screen, as lines. Pure, so it is asserted at any
 * width and colour tier without a terminal.
 *
 * Live, it is the design's progress screen: a bar per agent with sessions to
 * scan, and what the scan has found so far. Given the result it finishes in
 * place — every bar done, the headings in the past tense, and the summary where
 * the key hint was — so the screen that stays in scrollback is the one the scan
 * was drawn on.
 */
export function buildAuditScreen(state: AuditScreenState, opts: AuditScreenOpts = {}): string[] {
  const k = screenKit(opts);
  const result = opts.result;
  const out = [k.header("Audit"), ""];

  if (state.agents === null) {
    // Still listing transcripts: the one phase with no bars to draw, named in
    // the dashboard's own words for it. A finished scan that never said what it
    // found has no rows to draw, and is left to its summary.
    if (!result) out.push(k.head("Scanning history", AUDIT_STAGES[0].label));
  } else if (state.agents.length > 0) {
    const agents = result ? state.agents.map((a) => ({ ...a, done: a.total })) : state.agents;
    out.push(
      k.head(
        result ? "Scanned history" : "Scanning history",
        `${counted(agents.length, "agent")}, ${counted(state.policies, "policy", "policies")}`,
      ),
    );
    // The bar gives up width before the counts do: it is decoration, and the
    // counts are the facts. Thirty cells where there is room, ten at the least.
    const nameCol = Math.max(10, ...agents.map((a) => a.cli.length + 2));
    const widest = Math.max(...agents.map((a) => `${num(a.total)} of ${counted(a.total, "session")}`.length));
    const barWidth = Math.max(10, Math.min(30, k.cols - INDENT.length - nameCol - 2 - widest));
    for (const a of agents) {
      const tally =
        a.done >= a.total ? k.ok(counted(a.total, "session")) : `${num(a.done)} of ${counted(a.total, "session")}`;
      out.push(`${INDENT}${a.cli.padEnd(nameCol)}${k.bar(barWidth, a.total > 0 ? a.done / a.total : 1)}  ${tally}`);
    }

    // The result's own counts once there is one — they are what the dashboard
    // shows — and the running tally until then.
    const hits = result ? Object.fromEntries(result.results.map((r) => [r.name, r.hits])) : state.hits;
    const groups: Array<Array<[string, number]>> = FOUND_LABELS.map(() => []);
    for (const [name, n] of Object.entries(hits)) {
      if (n > 0) groups[foundRow(name)].push([name.slice(name.indexOf("/") + 1), n]);
    }
    // The column `kv` starts these values at: its widest label (or nine), plus two.
    const valueCol = INDENT.length + Math.max(9, ...FOUND_LABELS.map((label) => label.length)) + 2;
    const room = opts.fit ? k.cols - valueCol : Number.POSITIVE_INFINITY;
    out.push(
      "",
      k.head(result ? "Found" : "Found so far"),
      ...k.kv(FOUND_LABELS.map((label, i): [string, string] => [label, foundValue(groups[i], room)])),
    );
  }

  // One blank line before the closing block, never two: with nothing to scan
  // there are no blocks above it, only the header's own gap.
  const closing = result ? buildSummary(result, opts) : opts.stopped ? [] : [k.keys(["ctrl+c stop"])];
  if (out[out.length - 1] !== "") out.push("");
  out.push(...closing);
  while (out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * The finished scan in at most two sentences: what was read, then how much of
 * what it found your policies already cover. Pure; the audit screen ends on it.
 *
 * "Covered", not "blocked": a policy that is on may warn rather than block, and
 * what is counted is patterns a policy you have switched on already answers.
 */
export function buildSummary(result: AuditResult, opts: ScreenKitOpts = {}): string[] {
  const k = screenKit(opts);
  const sessions = result.transcripts.scanned;
  const events = result.eventsScanned;
  const projects = result.projectsScanned.length;
  const covered = result.results.filter((r) => r.source === "builtin" && r.enabledInConfig).length;
  const slipping = result.results.length - covered;

  const lines = [
    k.ok(
      `Scanned ${counted(events, "tool call")} across ${counted(sessions, "session")}` +
        (projects > 0 ? ` in ${counted(projects, "project")}` : "") +
        ".",
    ),
  ];
  if (result.totals.hits === 0) {
    // Only when something was actually read. With no tool calls at all the
    // caller says what to do instead, and "nothing was flagged" would read as
    // a clean bill of health for a history that was never there.
    if (events > 0) lines.push(`${INDENT}Nothing was flagged.`);
    return lines;
  }
  const patterns = (n: number): string => `${num(n)} ${n === 1 ? "pattern is" : "patterns are"}`;
  if (slipping > 0 && covered > 0) {
    lines.push(
      `${INDENT}${patterns(slipping)} slipping through, and ${num(covered)} ${covered === 1 ? "is" : "are"} already covered by your policies.`,
    );
  } else if (slipping > 0) {
    lines.push(`${INDENT}${patterns(slipping)} slipping through.`);
  } else if (covered > 0) {
    lines.push(`${INDENT}${patterns(covered)} already covered by your policies.`);
  }
  return lines;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Run the audit behind its screen, and return once the finished screen is on
 * the terminal.
 *
 * On a terminal that takes colour the screen is live: it redraws in place as
 * `runAudit` reports, at most every 100 ms and ONE write per frame, through the
 * kit's `live()`. The spinner it replaces wrote its cursor-up and its lines as
 * separate chunks, and advanced on a timer that knew nothing about the scan.
 *
 * Piped, or under NO_COLOR, nothing is drawn while the scan runs: the finished
 * screen prints once, with no escapes and no frames.
 */
async function runWithProgress(opts: RunAuditOptions): Promise<AuditResult> {
  const out: TTYOut = process.stdout;
  const render = optsFor(out);
  const animate = !!out.isTTY && render.color;
  // Prose may be shortened to fit a terminal, never a pipe (decision D9).
  const view: AuditScreenOpts = { ...render, fit: !!out.isTTY };
  const state: AuditScreenState = { agents: null, policies: 0, hits: {} };
  const region = animate ? screenKit(view).live(out) : null;
  // The width is read per frame, so a terminal resized mid-scan gets frames
  // that fit it.
  const frame = (extra: AuditScreenOpts = {}): string[] => [
    "",
    ...buildAuditScreen(state, { ...view, cols: out.columns || view.cols, ...extra }),
  ];

  region?.draw(frame);
  let result: AuditResult;
  try {
    result = await runAudit({
      ...opts,
      onProgress: (progress) => {
        if (progress.kind === "discovered") {
          state.policies = progress.policies;
          state.agents = progress.agents
            .filter((a) => a.transcripts > 0)
            .map((a) => ({ cli: a.cli, total: a.transcripts, done: 0 }));
        } else {
          const agent = state.agents?.find((a) => a.cli === progress.cli);
          if (agent) agent.done += 1;
          for (const [name, n] of Object.entries(progress.hitsByName)) {
            state.hits[name] = (state.hits[name] ?? 0) + n;
          }
        }
        region?.draw(frame);
      },
    });
  } catch (err) {
    // Left as far as it got, without the key hint: nothing is running now.
    region?.done(frame({ stopped: true }));
    throw err;
  }
  const finished = frame({ result });
  if (region) region.done(finished);
  else out.write(finished.join("\n") + "\n");
  return result;
}

/** A block printed under the screen: a blank line above it and one below. */
function printAfter(lines: string[]): void {
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
}

/**
 * The closing line when there was nothing to read. What changes that is using
 * the agent: the audit reads each agent's own history, which exists with or
 * without failproofai's hooks.
 */
function nothingToScan(k: ReturnType<typeof screenKit>): string {
  return `Run it again after using your agent:  ${k.cmd("failproofai audit")}`;
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
 * Shows the same screen as `failproofai audit`. The scan runs to completion;
 * Ctrl+C interrupts it the usual way (the screen gives the cursor back and lets
 * the SIGINT through). Best-effort: never throws, never exits the process; the
 * caller boots the dashboard afterward. Opt out with
 * `FAILPROOFAI_NO_AUTO_AUDIT=1`.
 */
export async function runPostSetupAudit(): Promise<void> {
  if (process.env.FAILPROOFAI_NO_AUTO_AUDIT === "1") return;
  const k = screenKit(optsFor(process.stdout));

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
    printAfter(["Another audit is already running. The dashboard will show its result."]);
    return;
  }

  try {
    const instanceId = getInstanceId();
    // Fire-and-forget, as in runAuditCli: the multi-second scan below keeps the
    // process alive long enough for this to land, and the completed/failed event
    // that follows is awaited.
    void trackHookEvent(instanceId, "cli_audit_started", { source: "onboarding" });

    // No line of its own before the scan: the screen opens with its own header
    // and closes on its own key hint.
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
      printAfter([k.fail("The audit could not finish.", "failproofai audit")]);
      return;
    }

    // Reported before the empty-history return below, so an onboarding audit that
    // finds nothing is still counted — matching runAuditCli, which reports
    // completed regardless of what the scan turned up.
    await trackHookEvent(instanceId, "cli_audit_completed", auditCompletedProps("onboarding", result));

    if (result.eventsScanned === 0) {
      printAfter([nothingToScan(k)]);
      return;
    }
    writeDashboardCache({}, result);
    // The audit says what ALREADY happened; nothing here says how to stop it
    // happening again. This is the first thing a new machine runs, and setup
    // installs no policies by design, so without this the whole first session
    // ends on a count of findings and no way to act on it.
    if (!hasInstalledPacks()) {
      printAfter([k.caution("None of this is enforced yet.", `failproofai policies add ${CORE_SOURCE}`)]);
    } else {
      process.stdout.write("\n");
    }
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

  // Full scan: all CLIs, all history, per-transcript cache on. The screen opens
  // with its own header, so nothing is printed ahead of it.
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

  // Await before the empty-history branch below, which calls process.exit(0) and
  // would otherwise drop this event. On the dashboard path launch() keeps the
  // process alive, but awaiting makes delivery reliable on every exit path.
  // Bounded (5s) and never throws.
  await trackHookEvent(instanceId, "cli_audit_completed", auditCompletedProps("cli", result));

  const k = screenKit(optsFor(process.stdout));

  // Nothing to read — say what changes that instead of opening an empty dashboard.
  if (result.eventsScanned === 0) {
    printAfter([nothingToScan(k)]);
    process.exit(0);
  }

  // Pre-warm the dashboard cache — the /audit page reads this file directly, so
  // the page renders our result instantly with no in-browser re-run.
  const persisted = writeDashboardCache(opts, result);

  // Released here, not in a `finally`: the lock covers the SCAN, and launch()
  // below keeps this process alive for as long as the user leaves the dashboard
  // open. Holding it that long would block every scheduled run until the
  // one-hour stale ceiling expired. The exit paths above (die(), the
  // empty-history exit) are covered by the handle's own process-exit hook.
  attempt.lock.release();

  // The hand-off: where the audit is, and how to stop the server that shows it.
  // No logomark here — the design keeps it to bare `failproofai` and `config`.
  const url = `http://localhost:${DASHBOARD_PORT}/audit`;
  printAfter([
    ...(persisted ? [] : [k.caution("Could not save the audit, so the dashboard may show nothing.")]),
    k.ok(`The audit is ready:  ${k.cmd(url)}`),
    "",
    k.keys(["ctrl+c stop the dashboard"]),
  ]);

  // Open the page once the server answers (best-effort, detached), then start
  // the server. `launch("start")` blocks-by-keeping-alive — it spawns the
  // bundled standalone dashboard and the process stays up serving it.
  openWhenReady(DASHBOARD_PORT, "/audit");
  const { launch } = await import("../../scripts/launch");
  launch("start", { screen: false });
  // Intentionally no process.exit(): launch() keeps this process alive running
  // the dashboard until the user stops it.
}
