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
 *
 * ## Two different questions, deliberately kept apart
 *
 * "Is the config still the shape the vendor accepts" is answered by
 * `config-drift.ts`, and `--fix` repairs it here, on this machine. "Is what the
 * vendor SENDS still something our maps can read" is answered by
 * `contract-compare.ts` — and nothing on this machine can fix that one. It
 * needs a release. Folding them together would make `--fix` look broken on a
 * box it repaired perfectly, so they get separate sections and separate
 * remedies.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { detectConfigDrift, driftFindings, type ConfigDriftReport } from "./config-drift";
import { repairConfigDrift, type RepairOutcome } from "./config-repair";
import { getHookActivityPage, getHookActivityPageCount } from "./hook-activity-store";
import { compareContractTable, type ContractComparison, type ContractFinding } from "./contract-compare";
import { readCachedPack, refreshContractPack } from "./contract-pack-client";
import { contractTableFile } from "./fp-home";
import type { HookScope } from "./types";

/**
 * How many recent project directories to check.
 *
 * Read from the newest activity page only — 25 rows — rather than the whole
 * store. `getAllHookActivityEntries()` loads every page file ever written, and
 * on a machine with months of history that is thousands of files read in full,
 * which does not fail loudly: it degrades into a timeout, and a repair lane that
 * quietly stops running is the exact failure this feature exists to remove.
 */
const MAX_RECENT_PROJECTS = 8;

/**
 * How many activity pages to walk back through, newest first.
 *
 * One page is 25 rows and that turned out to be too thin a window: every
 * `failproofai` CLI invocation writes a SessionStart health-probe row carrying
 * no cwd at all, so a handful of ordinary commands evicts the real project
 * directories and the sweep goes quiet — looking exactly like a machine with no
 * projects. Four pages is still a bounded read; what it must never become is
 * `getAllHookActivityEntries()`, which loads every page ever written and
 * degrades into a timeout rather than an error.
 */
const MAX_ACTIVITY_PAGES = 4;

/**
 * The project directories agents have actually been working in.
 *
 * The daemon has no session cwd — `PROTOCOL.md` forbids it inventing one — so
 * project-scope configs would otherwise be unreachable from a scheduled run.
 * They are not unknowable though: every hook event we recorded carries the cwd
 * it fired in, so the machine already knows which projects are live without the
 * hook path doing any work at all. That matters because the alternative was
 * repairing inline on a tool call, and this path is fail-closed: file I/O there
 * buys latency on every call and risks a denial on a slow disk.
 */
export function recentProjectCwds(): string[] {
  const rows: { cwd?: string }[] = [];
  try {
    const pages = Math.min(getHookActivityPageCount(), MAX_ACTIVITY_PAGES);
    for (let page = 1; page <= pages; page++) {
      rows.push(...getHookActivityPage(page));
      if (rows.length > MAX_ACTIVITY_PAGES * 50) break;
    }
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= MAX_RECENT_PROJECTS) break;
    const cwd = row.cwd;
    if (!cwd || seen.has(cwd)) continue;
    // HOME is not a project. Treating it as one makes project scope resolve to
    // the very files user scope owns — `~/.claude/settings.json` and its
    // siblings — and the two scopes disagree by design: project installs write
    // the portable `npx` form, user installs an absolute binary path. So the
    // same file reads `ok` as user and drifted as project, and repairing the
    // project view would rewrite a working user-scope install into a shape it
    // was deliberately not given.
    if (resolve(cwd) === resolve(process.env.HOME || homedir())) continue;
    try {
      // A recorded cwd can be long gone — a deleted checkout, a container that
      // no longer exists. Repairing a path that is not there would create
      // directories nobody asked for.
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(cwd);
  }
  return [...seen];
}

export interface DoctorResult {
  lines: string[];
  exitCode: number;
}

interface DoctorOptions {
  fix: boolean;
  json: boolean;
  scheduled: boolean;
  scopes?: readonly HookScope[];
  /** Also sweep the project dirs recent hook activity came from. */
  recentProjects: boolean;
  /** Fetch the lab's pack before answering. Consumed by the async front door. */
  refresh: boolean;
}

function parseArgs(argv: readonly string[]): DoctorOptions | { error: string } {
  // Default: user scope PLUS the projects agents are actually working in.
  // Naming a scope explicitly narrows to it.
  const opts: DoctorOptions = {
    fix: false,
    json: false,
    scheduled: false,
    recentProjects: true,
    refresh: false,
  };
  for (const arg of argv) {
    if (arg === "--fix") opts.fix = true;
    else if (arg === "--json") opts.json = true;
    // How the daemon's lane invokes it: same work, output shaped for a log
    // rather than a terminal.
    else if (arg === "--scheduled") opts.scheduled = true;
    // Handled by runDoctorCommandAsync before the sync pass; accepted here so
    // the argument parser does not reject it.
    else if (arg === "--refresh") opts.refresh = true;
    else if (arg === "--user") {
      opts.scopes = ["user"];
      opts.recentProjects = false;
    } else if (arg === "--project") {
      opts.scopes = ["project"];
      opts.recentProjects = false;
    }
    else return { error: `Unexpected argument: ${arg}` };
  }
  return opts;
}

/** `cli · scope` wide enough to line up, without a table library. */
function label(r: { cli: string; scope: string }): string {
  return `${r.cli.padEnd(12)} ${r.scope.padEnd(8)}`;
}

/**
 * Project rows are per-directory, so without the path two different checkouts
 * render as the same line twice and a reader cannot tell which one is broken.
 */
function suffix(r: ConfigDriftReport): string {
  return r.scope === "project" ? `  (${r.settingsPath})` : "";
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

interface Target {
  scopes: readonly HookScope[];
  cwd?: string;
}

/**
 * What to inspect.
 *
 * An explicit scope means exactly that scope and nothing else. Otherwise: user
 * scope, plus project scope in each directory agents have recently worked in —
 * because "the project configs on this machine" is not a fixed set, it is
 * whichever checkouts are live, and only the activity log knows that.
 */
function targetsFor(opts: DoctorOptions): Target[] {
  if (opts.scopes) return [{ scopes: opts.scopes }];
  const targets: Target[] = [{ scopes: ["user"] }];
  if (opts.recentProjects) {
    for (const cwd of recentProjectCwds()) targets.push({ scopes: ["project"], cwd });
  }
  return targets;
}

export function runDoctorCommand(argv: readonly string[] = []): DoctorResult {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return { lines: [parsed.error, "Run `failproofai doctor --help` for usage."], exitCode: 2 };
  }

  const targets = targetsFor(parsed);

  let before: ConfigDriftReport[];
  try {
    before = dedupeByPath(targets.flatMap((t) => detectConfigDrift(t)));
  } catch (err) {
    // Exit 2, not 1: we did not find a problem, we failed to look.
    const why = err instanceof Error ? err.message : String(err);
    return { lines: [`Could not check this machine: ${why}`], exitCode: 2 };
  }

  let repairs: RepairOutcome[] | null = null;
  if (parsed.fix) {
    const attempted = targets.map((t) => safeRepair(t));
    if (attempted.some((r) => r === "failed")) {
      return { lines: ["Could not repair: the repair pass itself failed."], exitCode: 2 };
    }
    repairs = attempted.flatMap((r) => (r === "failed" ? [] : r));
  }

  // Re-read after repairing so the verdict reflects the machine as it is NOW,
  // not as it was before we changed it.
  const after = parsed.fix ? dedupeByPath(targets.flatMap((t) => detectConfigDrift(t))) : before;
  const findings = driftFindings(after);

  const contract = contractComparisons();
  const contractFindings = exitWorthyContract(contract);
  // Deliberately NOT exit-worthy: the lab may have driven a newer vendor
  // version than this machine runs, so a finding there is a warning about what
  // an upgrade will bring, not a statement about this machine right now. The
  // local table is the only authority for that, and it is already counted.
  const fromLab = packComparisons(contract);

  if (parsed.json) {
    return {
      lines: [
        JSON.stringify(
          { reports: after, repairs: repairs ?? [], findings, contracts: contract, lab: fromLab },
          null,
          2,
        ),
      ],
      exitCode: exitFor(findings, contractFindings),
    };
  }

  return {
    lines: render(after, repairs, findings, parsed, contract, fromLab),
    exitCode: exitFor(findings, contractFindings),
  };
}

/**
 * One file, one verdict.
 *
 * Two targets can resolve to the same settings file — nested checkouts, or a
 * recorded cwd that happens to sit above another — and the same file inspected
 * under two scopes can legitimately disagree, because the scopes install
 * different commands. Reporting both is confusing; acting on both is worse.
 * First wins, and user scope is always first.
 */
function dedupeByPath(reports: readonly ConfigDriftReport[]): ConfigDriftReport[] {
  const seen = new Set<string>();
  const out: ConfigDriftReport[] = [];
  for (const r of reports) {
    if (seen.has(r.settingsPath)) continue;
    seen.add(r.settingsPath);
    out.push(r);
  }
  return out;
}

function safeRepair(target: Target): RepairOutcome[] | "failed" {
  try {
    return repairConfigDrift(target);
  } catch {
    return "failed";
  }
}

/**
 * `unreadable` is a finding, so it exits non-zero — but it is NOT the same as
 * drift, and the caller can tell them apart from the text. What it must not do
 * is exit 0.
 */
function exitFor(findings: readonly ConfigDriftReport[], contract: readonly ContractFinding[]): number {
  return findings.length > 0 || contract.length > 0 ? 1 : 0;
}

/**
 * Compare what the CLIs on this machine have actually sent against what this
 * build can read.
 *
 * Absent is the normal case, not an error: the table only exists once a
 * daemon-configured machine has handled a hook, so a fresh install has none and
 * this section simply does not appear.
 */
function contractComparisons(): ContractComparison[] {
  try {
    const raw = readFileSync(contractTableFile(), "utf8");
    return compareContractTable(JSON.parse(raw));
  } catch {
    // No table, unreadable, or not JSON. None of those are findings about a
    // vendor, and this must never be the reason doctor cannot run.
    return [];
  }
}

/**
 * What the LAB saw, narrowed to the CLIs this machine actually uses.
 *
 * The local table is bounded by what this machine happened to do: an agent that
 * has never written a file has no Write shape recorded, so a renamed Write key
 * is invisible here until the moment it matters. The lab drives every CLI
 * through the same tool call daily, so its pack covers the vendor rather than
 * the usage — which is the coverage the local table cannot have.
 *
 * Filtered to CLIs already in the local table on purpose. Reporting findings
 * about the nine integrations somebody does not use is noise, and noise is how
 * the two lines that matter get skipped.
 */
function packComparisons(local: readonly ContractComparison[]): ContractComparison[] {
  const pack = readCachedPack();
  if (!pack) return [];
  const used = new Set(local.map((c) => c.cli));
  try {
    return compareContractTable(pack).filter((c) => used.has(c.cli) && c.findings.length > 0);
  } catch {
    return [];
  }
}

/**
 * Which contract findings are worth a non-zero exit.
 *
 * `inert-tool-input` and `unroutable-event` are arithmetic on names — a key we
 * need is not derivable, or an event routes nowhere — so they are true wherever
 * they are computed. `unmapped-tool` is a heuristic: it reads an untranslated
 * tool carrying a gated tool's keys as a rename, which is right in a lab that
 * chose the prompt and wrong on a real machine carrying somebody's custom tool
 * named `open_file`. It is still shown, because the reader can tell the
 * difference and we cannot; it just does not fail the run.
 */
function exitWorthyContract(comparisons: readonly ContractComparison[]): ContractFinding[] {
  return comparisons
    .flatMap((c) => c.findings)
    .filter((f) => f.severity === "high" && f.kind !== "unmapped-tool");
}

/** One contract finding, as a line somebody reads in a log hours later. */
function describeContract(f: ContractFinding): string {
  const where = f.tool ? `${f.tool} ` : "";
  const seen = f.observed && f.observed.length > 0 ? `[${f.observed.join(", ")}]` : "no keys";
  if (f.kind === "inert-tool-input") {
    return `${where}arrives as ${seen} — no ${(f.missing ?? []).join(" or ")}; ${f.why ?? "policies reading it cannot fire"}`;
  }
  if (f.kind === "unroutable-event") return `event "${f.event}" routes to no policy`;
  // The heuristic case is worth its own wording: "not translated" reads as
  // housekeeping, and when the keys say it is a renamed gated tool it is the
  // most serious line on the page.
  if (f.severity === "high") {
    return `tool "${f.tool}" ${seen} is not translated, and carries a gated tool's keys — likely renamed`;
  }
  return `tool "${f.tool}" is not translated ${seen} (fine if it is third-party)`;
}

/**
 * What the CLIs are sending, and whether we can still read it.
 *
 * Only CLIs with something to say are listed. A machine has twelve
 * integrations, most people run two, and a healthy roster printed in full is
 * how the one broken line gets missed.
 */
function renderContracts(
  comparisons: readonly ContractComparison[],
  opts: DoctorOptions,
): string[] {
  if (comparisons.length === 0) return [];
  const withFindings = comparisons.filter((c) => c.findings.length > 0);

  if (opts.scheduled) {
    if (withFindings.length === 0) return [];
    const total = withFindings.reduce((n, c) => n + c.findings.length, 0);
    return [`doctor: ${total} payload-translation finding(s) across ${withFindings.length} CLI(s)`];
  }

  const lines = ["", "Payload translation — what these CLIs actually send", ""];
  if (withFindings.length === 0) {
    lines.push(`  every key we read is still where we expect it (${comparisons.length} CLI(s))`);
    return lines;
  }
  for (const c of withFindings) {
    const version = c.version ? ` ${c.version}` : "";
    for (const f of c.findings) {
      lines.push(`  ${(c.cli + version).padEnd(22)} ${describeContract(f)}`);
    }
  }
  // The remedy differs from every other line doctor prints, and saying so is
  // the difference between a useful report and one that reads as "--fix is
  // broken".
  lines.push("");
  lines.push("These are not repairable here — they need a failproofai update.");
  return lines;
}

function render(
  reports: readonly ConfigDriftReport[],
  repairs: readonly RepairOutcome[] | null,
  findings: readonly ConfigDriftReport[],
  opts: DoctorOptions,
  contracts: readonly ContractComparison[],
  fromLab: readonly ContractComparison[] = [],
): string[] {
  const lines: string[] = [];
  const acted = (repairs ?? []).filter((r) => r.action !== "skipped");

  if (!opts.scheduled) {
    lines.push("failproofai doctor — hook configs on this machine", "");
    for (const r of reports) {
      // A machine has twelve CLIs and most people install two. Listing ten
      // "not installed here" lines buries the two that matter.
      if (r.status === "absent") continue;
      lines.push(`  ${label(r)} ${describe(r)}${suffix(r)}`);
    }
    if (reports.every((r) => r.status === "absent")) {
      lines.push("  no agent CLI has failproofai hooks installed on this machine");
    }
  }

  if (acted.length > 0) {
    if (!opts.scheduled) lines.push("");
    for (const r of acted) lines.push(`  ${label(r)} ${describeRepair(r)}  (${r.settingsPath})`);
  }

  if (findings.length === 0) {
    // "Nothing to fix." above a list of problems reads as a contradiction, so
    // it narrows to what it actually covers when the next section has content.
    const alsoContracts = contracts.some((c) => c.findings.length > 0);
    lines.push(
      opts.scheduled
        ? `doctor: ${reports.filter((r) => r.status === "ok").length} config(s) ok, nothing to repair`
        : alsoContracts
          ? "\nNo hook-config problems to fix."
          : "\nNothing to fix.",
    );
    return [...lines, ...renderContracts(contracts, opts), ...renderLab(fromLab, opts)];
  }

  lines.push("");
  lines.push(`${findings.length} config(s) need attention.`);
  if (!opts.fix) {
    // Naming the exact command beats "run doctor with --fix": the reader is
    // usually looking at this in a log, hours later, out of context.
    lines.push("Run `failproofai doctor --fix` to repair them.");
  }
  return [...lines, ...renderContracts(contracts, opts), ...renderLab(fromLab, opts)];
}

/** What the lab has seen that this machine has not exercised yet. */
function renderLab(fromLab: readonly ContractComparison[], opts: DoctorOptions): string[] {
  if (fromLab.length === 0) return [];
  const total = fromLab.reduce((n, c) => n + c.findings.length, 0);
  if (opts.scheduled) return [`doctor: ${total} finding(s) the contracts lab saw for CLIs you run`];

  const lines = ["", "Seen by the contracts lab — not (yet) by this machine", ""];
  for (const c of fromLab) {
    for (const f of c.findings) {
      lines.push(`  ${(c.cli + (c.version ? ` ${c.version}` : "")).padEnd(22)} ${describeContract(f)}`);
    }
  }
  return lines;
}

/**
 * The async front door.
 *
 * Everything else here is pure — argv in, lines out — which is what makes it
 * testable without a CLI or a process. Fetching is the one thing that cannot
 * be, so it lives here alone, and the sync function stays the one every test
 * and the daemon lane can reason about.
 */
export async function runDoctorCommandAsync(argv: readonly string[] = []): Promise<DoctorResult> {
  // Only on the paths that asked for it: the scheduled lane, or an explicit
  // --refresh. An interactive `doctor` must never wait on the network.
  if (argv.includes("--scheduled") || argv.includes("--refresh")) {
    try {
      await refreshContractPack({ force: argv.includes("--refresh") });
    } catch {
      // A pack is extra information; failing to get one changes no answer.
    }
  }
  return runDoctorCommand(argv);
}
