/**
 * `failproofai doctor` — is this machine's enforcement actually wired up?
 *
 * Pure: it takes argv and returns lines plus an exit code, so the behaviour is
 * testable without a CLI, a TTY or a process. `bin/failproofai.mjs` only prints
 * what comes back — the same split `harness-cli.ts` uses, and for the same
 * reason: `.mjs` sits outside tsconfig, so anything living there is never
 * type-checked.
 *
 * ## The exit codes are a contract, not a convention
 *
 * The daemon's repair lane runs this unattended and can only act on the number:
 *
 *   0  nothing wrong, or everything wrong was repaired
 *   1  findings remain that a human should look at
 *   2  we could not tell — refusing to answer, rather than answering "fine"
 *
 * 2 is deliberately distinct from 1. On a headless box "I checked and it is
 * broken" and "I could not check" demand different responses, and collapsing
 * them into one non-zero is how a detector that has silently stopped working
 * gets mistaken for a machine that is merely unhealthy.
 */
import { detectConfigDrift, driftFindings, type ConfigDriftReport } from "./config-drift";
import { repairConfigDrift, type RepairOutcome } from "./config-repair";
import type { HookScope } from "./types";

export interface DoctorResult {
  lines: string[];
  exitCode: number;
}

interface DoctorOptions {
  fix: boolean;
  json: boolean;
  scheduled: boolean;
  scopes?: readonly HookScope[];
}

function parseArgs(argv: readonly string[]): DoctorOptions | { error: string } {
  const opts: DoctorOptions = { fix: false, json: false, scheduled: false };
  for (const arg of argv) {
    if (arg === "--fix") opts.fix = true;
    else if (arg === "--json") opts.json = true;
    // How the daemon's lane invokes it: same work, output shaped for a log
    // rather than a terminal.
    else if (arg === "--scheduled") opts.scheduled = true;
    else if (arg === "--user") opts.scopes = ["user"];
    else if (arg === "--project") opts.scopes = ["project"];
    else return { error: `Unexpected argument: ${arg}` };
  }
  return opts;
}

/** `cli · scope` wide enough to line up, without a table library. */
function label(r: { cli: string; scope: string }): string {
  return `${r.cli.padEnd(12)} ${r.scope.padEnd(8)}`;
}

function describe(report: ConfigDriftReport): string {
  switch (report.status) {
    case "ok":
      return "ok";
    case "absent":
      return "not installed here";
    case "stale":
      return report.detail === "unrecognised-shape"
        ? "DRIFTED — our hook is there but the format around it moved"
        : "DRIFTED — reinstalling would change this file";
    case "stale_path":
      return "ok (installed by a different failproofai path)";
    case "unreadable":
      return `UNREADABLE — ${report.detail ?? "could not parse"}; needs a human`;
    case "dogfood":
      return "skipped — this repo's dev config";
    case "unsupported":
      return "not checkable — regenerating it would write to disk";
  }
}

function describeRepair(outcome: RepairOutcome): string {
  switch (outcome.action) {
    case "repaired":
      return `REPAIRED — ${outcome.reason}`;
    case "rolled_back":
      return `ROLLED BACK — ${outcome.reason}; the previous file is restored`;
    case "failed":
      return `FAILED — ${outcome.reason}`;
    case "skipped":
      return `skipped — ${outcome.reason}`;
  }
}

export function runDoctorCommand(argv: readonly string[] = []): DoctorResult {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return { lines: [parsed.error, "Run `failproofai doctor --help` for usage."], exitCode: 2 };
  }

  let reports: ConfigDriftReport[];
  try {
    reports = detectConfigDrift({ scopes: parsed.scopes });
  } catch (err) {
    // Exit 2, not 1: we did not find a problem, we failed to look.
    const why = err instanceof Error ? err.message : String(err);
    return { lines: [`Could not check this machine: ${why}`], exitCode: 2 };
  }

  const repairs = parsed.fix ? safeRepair(parsed.scopes) : null;
  if (repairs === "failed") {
    return { lines: ["Could not repair: the repair pass itself failed."], exitCode: 2 };
  }

  // Re-read after repairing so the verdict reflects the machine as it is NOW,
  // not as it was before we changed it.
  const after = parsed.fix ? detectConfigDrift({ scopes: parsed.scopes }) : reports;
  const findings = driftFindings(after);

  if (parsed.json) {
    return {
      lines: [JSON.stringify({ reports: after, repairs: repairs ?? [], findings }, null, 2)],
      exitCode: exitFor(findings),
    };
  }

  return { lines: render(after, repairs, findings, parsed), exitCode: exitFor(findings) };
}

function safeRepair(scopes: readonly HookScope[] | undefined): RepairOutcome[] | "failed" {
  try {
    return repairConfigDrift({ scopes });
  } catch {
    return "failed";
  }
}

/**
 * `unreadable` is a finding, so it exits non-zero — but it is NOT the same as
 * drift, and the caller can tell them apart from the text. What it must not do
 * is exit 0.
 */
function exitFor(findings: readonly ConfigDriftReport[]): number {
  return findings.length > 0 ? 1 : 0;
}

function render(
  reports: readonly ConfigDriftReport[],
  repairs: readonly RepairOutcome[] | null,
  findings: readonly ConfigDriftReport[],
  opts: DoctorOptions,
): string[] {
  const lines: string[] = [];
  const acted = (repairs ?? []).filter((r) => r.action !== "skipped");

  if (!opts.scheduled) {
    lines.push("failproofai doctor — hook configs on this machine", "");
    for (const r of reports) {
      // A machine has twelve CLIs and most people install two. Listing ten
      // "not installed here" lines buries the two that matter.
      if (r.status === "absent") continue;
      lines.push(`  ${label(r)} ${describe(r)}`);
    }
    if (reports.every((r) => r.status === "absent")) {
      lines.push("  no agent CLI has failproofai hooks installed on this machine");
    }
  }

  if (acted.length > 0) {
    if (!opts.scheduled) lines.push("");
    for (const r of acted) lines.push(`  ${label(r)} ${describeRepair(r)}`);
  }

  if (findings.length === 0) {
    lines.push(
      opts.scheduled
        ? `doctor: ${reports.filter((r) => r.status === "ok").length} config(s) ok, nothing to repair`
        : "\nNothing to fix.",
    );
    return lines;
  }

  lines.push("");
  lines.push(`${findings.length} config(s) need attention.`);
  if (!opts.fix) {
    // Naming the exact command beats "run doctor with --fix": the reader is
    // usually looking at this in a log, hours later, out of context.
    lines.push("Run `failproofai doctor --fix` to repair them.");
  }
  return lines;
}
