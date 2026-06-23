/**
 * `failproofai audit` — run a local audit of your agent-CLI history, then open
 * the dashboard to view it.
 *
 *   failproofai audit          Scan, then launch the dashboard at /audit.
 *   failproofai audit --help   Show usage.
 *
 * `runAudit()` is a pure local function (no network, no account). We run it,
 * render the same four progress stages the dashboard's RunProgress shows,
 * pre-warm the dashboard cache (~/.failproofai/audit-dashboard.json), then start
 * the bundled dashboard server and open the browser to /audit — which renders
 * instantly from that cache.
 *
 * No arguments yet — a bare `failproofai audit` does a full scan (all CLIs, all
 * history). Flags (--since, --cli, --project, --port, --no-open) are easy
 * follow-ups against `RunAuditOptions`.
 */
import { runAudit } from "./index";
import { writeDashboardCache } from "./dashboard-cache";
import type { AuditResult, RunAuditOptions } from "./types";
import { trackHookEvent } from "../hooks/hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import { openWhenReady } from "./open-browser";

/** Port the bundled dashboard binds to. Matches `scripts/launch.ts`'s default
 *  for `start` mode, which `failproofai` (bare) already uses. */
const DASHBOARD_PORT = 8020;

/**
 * Mirror of `app/audit/_components/run-progress.tsx`'s `STAGES`. Kept identical
 * so the CLI and the dashboard's in-progress view tell the same story — the
 * dashboard even renders a mock `$ failproofai audit` terminal, and this is the
 * real thing. `audit-cli.test.ts` guards against drift between the two.
 */
export const AUDIT_STAGES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "discovering transcripts", detail: "walking ~/.claude, ~/.codex, ~/.cursor, …" },
  { label: "parsing session logs", detail: "reading JSONL + sqlite session stores" },
  { label: "running policy checks", detail: "replaying through 30 builtin policies" },
  { label: "aggregating results", detail: "counting hits, ranking by frequency" },
];

const HELP = `
failproofai audit — audit your AI agent's behavior, then open the dashboard

USAGE
  failproofai audit          Scan your agent-CLI session history for risky and
                             wasteful patterns, then open the audit dashboard.
  failproofai audit --help   Show this help.

WHAT IT DOES
  1. Scans past sessions from every installed agent CLI (Claude, Codex, Cursor,
     Copilot, OpenCode, Pi, Gemini) — entirely on your machine.
  2. Starts the local dashboard and opens
     http://localhost:${DASHBOARD_PORT}/audit with your results.

  Runs fully offline — no account or network required. Press Ctrl+C to stop the
  dashboard server when you're done.
`.trimStart();

// ── ANSI helpers ────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const PINK = "\x1b[38;5;204m";
const GREEN = "\x1b[38;5;120m";
const CYAN = "\x1b[38;5;81m";
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

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runAuditCli(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // No arguments supported yet — reject typos rather than silently doing a bare
  // audit, so a future `failproofai audit --since 7d` doesn't quietly no-op.
  const stray = args.find((a) => a !== "--help" && a !== "-h");
  if (stray) {
    die(
      `\`audit\` takes no arguments yet (got: ${stray}).\n` +
        `Run \`failproofai audit\` to scan your history and open the dashboard.`,
    );
  }

  const instanceId = getInstanceId();
  void trackHookEvent(instanceId, "cli_audit_started", { source: "cli" });

  printHeader();

  // Full scan: all CLIs, all history, per-transcript cache on.
  const opts: RunAuditOptions = {};

  let result: AuditResult;
  try {
    result = await runWithProgress(opts);
  } catch (err) {
    void trackHookEvent(instanceId, "cli_audit_failed", {
      source: "cli",
      error_type: err instanceof Error ? err.name : "unknown",
    });
    die(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  printSummary(result);

  void trackHookEvent(instanceId, "cli_audit_completed", {
    source: "cli",
    events_scanned: result.eventsScanned,
    sessions_scanned: result.transcripts.scanned,
    total_hits: result.totals.hits,
    findings: result.results.length,
  });

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
