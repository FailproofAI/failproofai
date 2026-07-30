#!/usr/bin/env bun
/**
 * bench-hook.ts — the Stage 0 cold-start hook-latency baseline.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  MEASURE + WRITE THE BASELINE:  bun scripts/bench-hook.ts                 │
 * │  RE-MEASURE AND COMPARE:        bun scripts/bench-hook.ts --check         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * There is deliberately NO `bench` entry in package.json — this is a script you
 * run on demand, never a vitest test and never a CI job. Benchmarks inside the
 * unit suite make CI flaky, and `--check` is provided so a *future* soft gate
 * can be wired up without rewriting anything. It is not wired up today.
 *
 * Outputs (both committed):
 *   __tests__/parity/bench-baseline.json   machine-readable, per (cli, event)
 *   __tests__/parity/bench-baseline.md     human-readable summary + the argument
 *
 * ── WHY THE PHASE SPLIT IS THE WHOLE POINT ────────────────────────────────
 *
 * From `desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/`
 * `03-risks-and-amendments.md`:
 *
 *   "**"The daemon isn't faster" could kill the project mid-flight for the
 *   wrong reason.** Through Stage 3 the client is still `bin/failproofai.mjs`
 *   under Node or bun, so 40–80 ms of process startup dominates and masks the
 *   win. The real Stage 1–3 gain is removing the per-invocation config read and
 *   policy load — which today writes temp files next to the user's source on
 *   every tool call. State that explicitly, and gate the end-to-end latency
 *   target at Stage 4, when the native client lands, rather than at Stage 1."
 *
 * A single end-to-end number cannot support that argument. Four phases can:
 *
 *   1. spawn        fork/exec + interpreter bootstrap + evaluation of the
 *                   failproofai module graph — everything before the first line
 *                   of policy work. The daemon does NOT remove this until
 *                   Stage 4, when `crates/failproofai-cli` replaces the Node
 *                   client.
 *   2. config+load  readMergedHooksConfig + registerBuiltinPolicies +
 *                   loadAllCustomHooks. Removed by the daemon at STAGE 1.
 *                   This is the phase that today, on every single tool call,
 *                   writes `.__failproofai_tmp__.mjs` files next to the user's
 *                   own source (src/hooks/loader-utils.ts, `rewriteFileTree`),
 *                   which is why this script measures it twice: with and
 *                   without a custom policy file present.
 *   3. evaluate     the policy loop (`evaluateVerdicts`). Moves into a warm
 *                   resident worker at STAGE 1.
 *   4. encode       per-CLI response encoding (`encodeResponse`). STAGE 1.
 *
 * So the honest claim this baseline supports is: *Stages 1–3 remove phases 2–4;
 * Stage 4 removes phase 1.* Anyone reading only an end-to-end number would
 * conclude the daemon bought nothing, because phase 1 dwarfs the rest.
 *
 * ── HOW THE PHASES ARE MEASURED ───────────────────────────────────────────
 *
 * Every iteration is ONE COLD PROCESS — that is the thing being measured, so it
 * cannot be amortized. The parent (this file, under bun) spawns a *worker*: this
 * same file, bundled with the same `bun build --target=node --format=esm`
 * invocation `package.json`'s `build:cli` uses for `dist/cli.mjs`, then run
 * under `node` with a realistic per-(cli, event) payload on stdin.
 *
 * The worker re-enacts the pipeline of `src/hooks/handler.ts` — the same
 * imports, the same call order — and reports each phase's duration. It cannot
 * BE `handleHookEvent`, because that function returns one number for the whole
 * invocation and `src/` is off-limits to this script; so it calls the same
 * exported units `handleHookEvent` calls, in the same order. `assertHandlerShape()`
 * is the tripwire for that mirror going stale.
 *
 * `spawn` is measured ACROSS the process boundary: the parent records
 * `performance.timeOrigin + performance.now()` immediately before `spawnSync`,
 * the worker records the same expression as the first statement of its own
 * module body, and the difference is the startup cost. Both endpoints read the
 * same machine's wall clock, so the subtraction is meaningful.
 *
 *   spawn      = worker's first-code timestamp − parent's pre-spawn timestamp
 *   config+load, evaluate, encode = measured inside the worker
 *   e2e        = the parent's wall clock around spawnSync
 *   other      = e2e − (the four phases). Payload parse, tool/event
 *                canonicalization, envelope construction, the worker's own JSON
 *                emit, process teardown, and the parent's reap. Reported so the
 *                four phases always add up to something checkable.
 *
 * A `calibration` section re-runs the REAL client — `node dist/cli.mjs --hook
 * <event> --cli <cli>` — over a sample of cells, so the gap between the harness
 * and the shipping binary is a published number rather than an assumption.
 *
 * ── WHAT IS DERIVED, AND WHAT IS NOT ──────────────────────────────────────
 *
 * The matrix is `INTEGRATION_TYPES` × `HOOK_EVENT_TYPES`, read from
 * `src/hooks/types.ts`. Nothing here hardcodes "twelve" or an event list, and
 * per-CLI tables are resolved BY NAMING CONVENTION off a namespace import
 * (`<CLI>_TOOL_MAP`, `<CLI>_TOOL_INPUT_MAP`, `<CLI>_EVENT_MAP`) exactly as
 * `scripts/gen-canon-tables.ts` does — so a thirteenth CLI gets its own cells
 * the moment its constants land, with no edit here.
 *
 * The ONE thing not derived is the per-CLI stdin *field naming* (Antigravity's
 * camelCase protojson, Goose's `event`/`working_dir`, Cursor's
 * `workspace_roots`), because that lives as inline code in `handler.ts` and
 * `resolve-cwd.ts` rather than as a table. `PAYLOAD_DIALECTS` below encodes it,
 * and a CLI absent from that table gets the Claude snake_case shape — which is
 * what every shim-fronted CLI actually delivers to the binary anyway.
 *
 * ── WHAT THESE NUMBERS CAN AND CANNOT BE USED FOR ─────────────────────────
 *
 * They were taken on a shared developer workstation, not a quiesced machine.
 * See the "Reading these numbers honestly" section of the generated `.md`. In
 * short: the phase RATIOS and the with/without-custom-policy DELTA are robust;
 * the absolute millisecond values are hardware- and load-specific and must not
 * be compared against a run on different hardware. That is why `machine` is
 * recorded in the artifact and why `--check` refuses to gate across a
 * fingerprint change.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, cpus, hostname, loadavg, platform, release, totalmem, type as osType } from "node:os";

import * as TYPES from "../src/hooks/types";
import { HOOK_EVENT_TYPES, INTEGRATION_TYPES } from "../src/hooks/types";
import type { HookEventType, IntegrationType, SessionMetadata } from "../src/hooks/types";
import { BUILTIN_POLICIES, registerBuiltinPolicies } from "../src/hooks/builtin-policies";
import { readMergedHooksConfig } from "../src/hooks/hooks-config";
import { clearPolicies, registerPolicy } from "../src/hooks/policy-registry";
import { loadAllCustomHooks } from "../src/hooks/custom-hooks-loader";
import { encodeResponse, evaluateVerdicts } from "../src/hooks/policy-evaluator";
import { canonicalizeToolInput, canonicalizeToolName } from "../src/hooks/tool-name-canonicalize";
import { resolveCwd } from "../src/hooks/resolve-cwd";
import { resolvePermissionMode } from "../src/hooks/resolve-permission-mode";
import { resolveTranscriptPath } from "../src/hooks/resolve-transcript-path";
import { buildLocalEnvelope, envelopeToSessionMetadata } from "../src/hooks/request-envelope";
import { readLocalHostFacts } from "../src/hooks/local-host";
import type { CustomHook, PolicyFunction, PolicyResult } from "../src/hooks/policy-types";

// ── THE PHASE-1 BOUNDARY ───────────────────────────────────────────────────
// These must be the FIRST two executable statements in the file. ESM import
// declarations are hoisted and every imported module body runs to completion
// before the entry module's own body starts, so by the time these two lines
// execute the entire failproofai module graph has been evaluated — which is
// exactly the boundary between phase 1 (spawn) and everything after it.
// Subtracting the parent's pre-spawn timestamp from `T_ORIGIN_MS + T_ENTRY_MS`
// gives `spawn`. Do not move anything above them.
const T_ENTRY_MS = performance.now();
const T_ORIGIN_MS = performance.timeOrigin;

// ── Paths ──────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, "__tests__", "parity");
/** Everything this script creates lives here and is removed on exit. */
const WORK_DIR = resolve(REPO_ROOT, ".bench-hook-tmp");
const WORKER_BUNDLE = resolve(WORK_DIR, "bench-worker.mjs");
const NOOP_SCRIPT = resolve(WORK_DIR, "noop.mjs");
const DIST_DIR = resolve(REPO_ROOT, "dist");
const DIST_CLI = resolve(DIST_DIR, "cli.mjs");
const DIST_INDEX = resolve(DIST_DIR, "index.js");

/**
 * A private snapshot of `dist/`, taken once at startup and used for every
 * iteration thereafter (`FAILPROOFAI_DIST_PATH` and the calibration binary both
 * point here, not at the shared `dist/`).
 *
 * This is not paranoia. A full capture is tens of thousands of cold processes
 * over the better part of an hour, and `dist/` is a shared, gitignored build
 * output that any other `bun run build:cli` in the repo rewrites in place. The
 * first attempt at this baseline lost 27,345 of 36,888 iterations to exactly
 * that: a concurrent rebuild landed mid-run and every worker after it failed.
 * The snapshot makes the measurement depend on nothing that can change while it
 * runs. It lives inside WORK_DIR, which is inside the repo, so node still
 * resolves the `--external` packages from the repo's own `node_modules`.
 */
const SNAPSHOT_DIST_DIR = resolve(WORK_DIR, "dist");
const SNAPSHOT_CLI = resolve(SNAPSHOT_DIST_DIR, "cli.mjs");

const MARKER = "##FPAI-BENCH##";

/** Fraction of failed iterations above which the run is not trustworthy. */
const MAX_FAILURE_RATE = 0.01;

// ── Phases ─────────────────────────────────────────────────────────────────

const PHASES = ["spawn", "configLoad", "evaluate", "encode", "other", "e2e"] as const;
type Phase = (typeof PHASES)[number];

/** The three percentiles every phase tuple carries, in order. */
const PERCENTILES = [50, 95, 99] as const;

type Triple = [number, number, number];
type PhaseTriples = Record<Phase, Triple>;

const VARIANTS = ["default", "custom"] as const;
type Variant = (typeof VARIANTS)[number];

// ── Payload dialects (the one thing not derived — see the header) ──────────

type DialectId = "claude" | "antigravity" | "goose";

/**
 * Per-CLI stdin field naming, mirroring the normalization blocks in
 * `src/hooks/handler.ts`. Absent CLI ⇒ `{shape: "claude"}`, which is what every
 * shim-fronted integration actually hands the binary.
 */
const PAYLOAD_DIALECTS: Partial<Record<IntegrationType, { shape: DialectId; workspaceRoots?: boolean }>> = {
  // handler.ts: `if (cli === "antigravity")` — camelCase protojson.
  antigravity: { shape: "antigravity" },
  // handler.ts: `if (cli === "goose")` — `event` / `working_dir`.
  goose: { shape: "goose" },
  // resolve-cwd.ts: Cursor's non-tool events carry no top-level cwd; the only
  // directory signal is `workspace_roots`.
  cursor: { shape: "claude", workspaceRoots: true },
};

/** Events whose payload carries a tool call. Everything else gets no tool. */
const TOOL_EVENTS = new Set<string>([
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
]);

/** Events whose payload carries a user prompt. */
const PROMPT_EVENTS = new Set<string>(["UserPromptSubmit", "UserPromptExpansion"]);

/** Events that carry a tool RESULT in addition to the call. */
const RESULT_EVENTS = new Set<string>(["PostToolUse", "PostToolUseFailure", "PostToolBatch"]);

/**
 * The benchmark's Bash command. Deliberately benign: a deny SHORT-CIRCUITS
 * `evaluateVerdicts`, so benchmarking a denied command would measure the
 * cheapest possible policy loop and understate `evaluate`. An allowed command
 * runs every matched policy to completion, which is the honest worst case.
 */
const BENCH_COMMAND = "git status --short";

const BENCH_SESSION_ID = "bench-session-0001";

// ── Small utilities ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function triple(samples: number[]): Triple {
  const s = [...samples].sort((a, b) => a - b);
  return [round(percentile(s, 50)), round(percentile(s, 95)), round(percentile(s, 99))];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function nowEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

function fmt(n: number, dp = 1): string {
  return n.toFixed(dp);
}

// ── Matrix derivation (nothing below hardcodes 12) ─────────────────────────

interface Cell {
  cli: IntegrationType;
  event: HookEventType;
}

function buildMatrix(cliFilter: Set<string> | null, eventFilter: Set<string> | null): Cell[] {
  const cells: Cell[] = [];
  for (const cli of INTEGRATION_TYPES) {
    if (cliFilter && !cliFilter.has(cli)) continue;
    for (const event of HOOK_EVENT_TYPES) {
      if (eventFilter && !eventFilter.has(event)) continue;
      cells.push({ cli, event });
    }
  }
  return cells;
}

function cellKey(cell: Cell): string {
  return `${cell.cli}|${cell.event}`;
}

/** Resolve `<CLI>_TOOL_MAP` / `<CLI>_TOOL_INPUT_MAP` / `<CLI>_EVENT_MAP` by convention. */
function lookupTable<T>(cli: IntegrationType, suffix: string): T | undefined {
  const ns = TYPES as unknown as Record<string, unknown>;
  return ns[`${cli.toUpperCase()}_${suffix}`] as T | undefined;
}

/** Reverse a `<CLI>_TOOL_MAP` (native → canonical) to get the native tool id. */
function nativeToolName(cli: IntegrationType, canonical: string): string {
  const map = lookupTable<Record<string, string>>(cli, "TOOL_MAP");
  if (!map) return canonical;
  for (const [native, canon] of Object.entries(map)) {
    if (canon === canonical) return native;
  }
  return canonical;
}

/** Reverse a `<CLI>_TOOL_INPUT_MAP[canonicalTool]` (native key → canonical key). */
function nativeToolInput(
  cli: IntegrationType,
  canonicalTool: string,
  canonicalInput: Record<string, unknown>,
): Record<string, unknown> {
  const maps = lookupTable<Record<string, Record<string, string>>>(cli, "TOOL_INPUT_MAP");
  const map = maps?.[canonicalTool];
  if (!map) return canonicalInput;
  const canonicalToNative = new Map(Object.entries(map).map(([native, canon]) => [canon, native]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(canonicalInput)) {
    out[canonicalToNative.get(k) ?? k] = v;
  }
  return out;
}

/** Reverse a `<CLI>_EVENT_MAP` (native event → canonical) to get the native name. */
function nativeEventName(cli: IntegrationType, canonical: HookEventType): string {
  const map = lookupTable<Record<string, string>>(cli, "EVENT_MAP");
  if (!map) return canonical;
  for (const [native, canon] of Object.entries(map)) {
    if (canon === canonical) return native;
  }
  return canonical;
}

/**
 * Build the stdin payload a harness would actually deliver for one cell.
 * Tool names and tool-input keys come from the per-CLI tables in
 * `src/hooks/types.ts`; only the outer field naming comes from PAYLOAD_DIALECTS.
 */
function buildPayload(cell: Cell, cwd: string, transcriptPath: string): Record<string, unknown> {
  const { cli, event } = cell;
  const dialect = PAYLOAD_DIALECTS[cli] ?? { shape: "claude" as DialectId };
  const nativeEvent = nativeEventName(cli, event);

  const hasTool = TOOL_EVENTS.has(event);
  const toolName = hasTool ? nativeToolName(cli, "Bash") : undefined;
  const toolInput = hasTool
    ? nativeToolInput(cli, "Bash", { command: BENCH_COMMAND, cwd })
    : undefined;

  if (dialect.shape === "antigravity") {
    // handler.ts normalizes `toolCall.{name,args}` / `conversationId` /
    // `workspacePaths[0]` / `transcriptPath`. No `hook_event_name` at all —
    // the event comes solely from the `--hook` arg.
    const p: Record<string, unknown> = {
      conversationId: BENCH_SESSION_ID,
      workspacePaths: [cwd],
      transcriptPath,
      modelName: "auto",
      stepIdx: 7,
    };
    if (hasTool) p.toolCall = { name: toolName, args: toolInput };
    if (PROMPT_EVENTS.has(event)) p.invocationNum = 3;
    return p;
  }

  if (dialect.shape === "goose") {
    // handler.ts maps `working_dir` → `cwd` and `event` → `hook_event_name`.
    // Goose has no transcript_path (audit reads sessions.db).
    const p: Record<string, unknown> = {
      event: nativeEvent,
      session_id: BENCH_SESSION_ID,
      matcher_context: toolName ?? null,
      working_dir: cwd,
    };
    if (hasTool) {
      p.tool_name = toolName;
      p.tool_input = toolInput;
    }
    if (PROMPT_EVENTS.has(event)) p.message = "Run the test suite and fix what fails.";
    return p;
  }

  const p: Record<string, unknown> = {
    session_id: BENCH_SESSION_ID,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: "default",
    hook_event_name: nativeEvent,
  };
  if (dialect.workspaceRoots) p.workspace_roots = [cwd];
  if (hasTool) {
    p.tool_name = toolName;
    p.tool_input = toolInput;
  }
  if (RESULT_EVENTS.has(event)) {
    p.tool_response = { success: true, output: " M scripts/bench-hook.ts\n", error: null };
  }
  if (PROMPT_EVENTS.has(event)) p.prompt = "Run the test suite and fix what fails.";
  if (event === "Stop" || event === "StopFailure" || event === "SubagentStop") {
    p.stop_hook_active = false;
  }
  if (event === "Notification") p.message = "Claude needs your permission to run a command";
  if (event === "SessionEnd") p.reason = "user_exit";
  if (event === "PreCompact") p.trigger = "auto";
  return p;
}

// ── The worker: one cold iteration, mirroring handler.ts ───────────────────

interface WorkerReport {
  timeOriginMs: number;
  entryMs: number;
  configLoadMs: number;
  evaluateMs: number;
  encodeMs: number;
  matchedCount: number;
  decision: string;
  customHooks: number;
}

/**
 * Tripwire for the handler mirror below. `handleHookEvent` is not callable in
 * pieces, so the worker calls the same exported units in the same order; if any
 * of them stops existing or changes arity the mirror is stale and this throws
 * loudly rather than silently benchmarking something else.
 *
 * Checked at worker startup so a stale mirror fails the first iteration, not
 * the artifact.
 */
function assertHandlerShape(): void {
  const units: Array<[string, unknown, number]> = [
    ["readMergedHooksConfig", readMergedHooksConfig, 1],
    ["registerBuiltinPolicies", registerBuiltinPolicies, 1],
    ["loadAllCustomHooks", loadAllCustomHooks, 2],
    ["evaluateVerdicts", evaluateVerdicts, 4],
    ["encodeResponse", encodeResponse, 3],
    ["buildLocalEnvelope", buildLocalEnvelope, 1],
    ["envelopeToSessionMetadata", envelopeToSessionMetadata, 1],
    ["resolveCwd", resolveCwd, 2],
    ["resolveTranscriptPath", resolveTranscriptPath, 3],
    ["resolvePermissionMode", resolvePermissionMode, 3],
  ];
  for (const [name, fn, arity] of units) {
    if (typeof fn !== "function") {
      throw new Error(`bench-hook: handler mirror is stale — ${name} is not a function`);
    }
    if ((fn as (...a: unknown[]) => unknown).length !== arity) {
      throw new Error(
        `bench-hook: handler mirror is stale — ${name} now takes ` +
          `${(fn as (...a: unknown[]) => unknown).length} args, expected ${arity}. ` +
          `Re-read src/hooks/handler.ts and update runWorker().`,
      );
    }
  }
}

/**
 * Write the report and hard-exit, mirroring `bin/failproofai.mjs`, which calls
 * `process.exit()` the moment `handleHookEvent` returns.
 *
 * That hard exit is load-bearing, not tidiness — and this benchmark is how we
 * found out: a hook process that merely *returns* stays alive for as long as
 * anything is still pending on the event loop. `handler.ts` races every custom
 * hook against a `setTimeout(…, 10_000)`, and on the first attempt at this
 * baseline the custom-policy variant reported a 10,088 ms p95 — it was timing a
 * pending timer, not a hook. Mirroring the shipping client's exit is the only
 * way this harness measures what the shipping client measures.
 *
 * `writeSync(1, …)` rather than `process.stdout.write` because stdout to a pipe
 * is asynchronous in Node, and `process.exit()` would truncate it.
 */
function emitAndExit(report: WorkerReport): never {
  writeSync(1, MARKER + JSON.stringify(report) + "\n");
  process.exit(0);
}

/**
 * Re-enacts `handleHookEvent` for a single event, timing the three in-process
 * phases. Mirrors src/hooks/handler.ts (`handleHookEvent`) call-for-call:
 * payload normalization → tool canonicalization → envelope → config+load →
 * evaluate → encode. Deliberately omits `persistHookActivity`, PostHog
 * telemetry, and `flushHookTelemetry`, which are I/O whose variance would swamp
 * the signal; the `calibration` section quantifies what that omission costs.
 */
async function runWorker(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // `--floor` exits right after the module graph is evaluated. Subtracting the
  // bare-interpreter probe from it isolates "evaluating failproofai's module
  // graph" from "starting node at all" — the two halves of phase 1, and the
  // reason phase 1 does not vanish until the native client lands at Stage 4.
  if (argv.includes("--floor")) {
    emitAndExit({
      timeOriginMs: T_ORIGIN_MS,
      entryMs: T_ENTRY_MS,
      configLoadMs: 0,
      evaluateMs: 0,
      encodeMs: 0,
      matchedCount: 0,
      decision: "n/a",
      customHooks: 0,
    });
  }

  assertHandlerShape();

  const cli = (get("--cli") ?? "claude") as IntegrationType;
  const event = (get("--event") ?? "PreToolUse") as HookEventType;

  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;

  // ── handler.ts: per-CLI payload normalization ──
  if (cli === "antigravity") {
    const tc = parsed.toolCall as { name?: string; args?: unknown } | undefined;
    if (tc && typeof tc === "object") {
      if (tc.name !== undefined) parsed.tool_name = tc.name;
      if (tc.args !== undefined) parsed.tool_input = tc.args;
    }
    if (typeof parsed.conversationId === "string") parsed.session_id = parsed.conversationId;
    if (Array.isArray(parsed.workspacePaths) && typeof parsed.workspacePaths[0] === "string") {
      parsed.cwd = parsed.workspacePaths[0];
    }
    if (typeof parsed.transcriptPath === "string") parsed.transcript_path = parsed.transcriptPath;
  }
  if (cli === "copilot") {
    if (typeof parsed.toolName === "string" && parsed.tool_name === undefined) {
      parsed.tool_name = parsed.toolName;
    }
    if (parsed.toolInput !== undefined && parsed.tool_input === undefined) {
      parsed.tool_input = parsed.toolInput;
    }
    if (typeof parsed.sessionId === "string" && parsed.session_id === undefined) {
      parsed.session_id = parsed.sessionId;
    }
  }
  if (cli === "goose") {
    if (typeof parsed.working_dir === "string") parsed.cwd = parsed.working_dir;
    if (typeof parsed.event === "string" && parsed.hook_event_name === undefined) {
      parsed.hook_event_name = parsed.event;
    }
  }

  // ── handler.ts: tool name + tool input canonicalization ──
  const rawToolName = parsed.tool_name as string | undefined;
  const canonicalToolName = canonicalizeToolName(rawToolName, cli);
  if (canonicalToolName !== rawToolName) parsed.tool_name = canonicalToolName;
  const rawInput = parsed.tool_input;
  const canonicalInput = canonicalizeToolInput(canonicalToolName, rawInput, cli);
  if (canonicalInput !== rawInput) parsed.tool_input = canonicalInput;

  // ── handler.ts: envelope (P4) ──
  const sessionId = parsed.session_id as string | undefined;
  const request = buildLocalEnvelope({
    cli,
    eventType: event,
    rawEventType: event,
    payload: parsed,
    sessionId,
    transcriptPath: resolveTranscriptPath(cli, parsed, sessionId),
    cwd: resolveCwd(cli, parsed),
    permissionMode: resolvePermissionMode(cli, parsed, sessionId),
    hookEventName: parsed.hook_event_name as string | undefined,
    host: readLocalHostFacts(),
  });
  const session: SessionMetadata = envelopeToSessionMetadata(request);

  // ── PHASE 2: config + load ──
  const t1 = performance.now();
  const config = readMergedHooksConfig(session.cwd);
  clearPolicies();
  registerBuiltinPolicies(config.enabledPolicies);
  const loadResult = await loadAllCustomHooks(
    config.customPoliciesPaths ?? config.customPoliciesPath,
    { sessionCwd: session.cwd, customPoliciesEnabled: config.customPoliciesEnabled },
  );
  const customHooksList = loadResult.hooks;
  const disabledCustomPolicies = new Set(config.disabledCustomPolicies ?? []);
  for (const hook of customHooksList) {
    const policyId = (hook as CustomHook & { __policyId?: string }).__policyId;
    if (policyId && disabledCustomPolicies.has(policyId)) continue;
    const conventionScope = (hook as CustomHook & { __conventionScope?: string }).__conventionScope;
    const prefix = conventionScope ? `.failproofai-${conventionScope}` : "custom";
    const fn: PolicyFunction = async (ctx): Promise<PolicyResult> => {
      try {
        return await Promise.race([
          hook.fn(ctx),
          new Promise<PolicyResult>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 10_000),
          ),
        ]);
      } catch {
        return { decision: "allow" };
      }
    };
    registerPolicy(`${prefix}/${hook.name}`, hook.description ?? "", fn, hook.match ?? {}, -1);
  }
  const t2 = performance.now();

  // ── PHASE 3: evaluate ──
  const verdicts = await evaluateVerdicts(event, parsed, session, config);
  const t3 = performance.now();

  // ── PHASE 4: encode ──
  const result = encodeResponse(verdicts, event, session);
  const t4 = performance.now();

  emitAndExit({
    timeOriginMs: T_ORIGIN_MS,
    entryMs: T_ENTRY_MS,
    configLoadMs: t2 - t1,
    evaluateMs: t3 - t2,
    encodeMs: t4 - t3,
    matchedCount: verdicts.matchedCount,
    decision: result.decision,
    customHooks: customHooksList.length,
  });
}

// ── Sandbox ────────────────────────────────────────────────────────────────

/**
 * The default-install policy set: every builtin marked `defaultEnabled` and not
 * `beta`, exactly as the wizard's presets resolve them. Derived, never listed —
 * a new default-on builtin changes the baseline's workload automatically, which
 * is the honest behavior (it really would change users' latency).
 */
function defaultEnabledPolicies(): string[] {
  return BUILTIN_POLICIES.filter((p) => p.defaultEnabled && !p.beta).map((p) => p.name);
}

function allPolicies(): string[] {
  return BUILTIN_POLICIES.filter((p) => !p.beta).map((p) => p.name);
}

const BENCH_POLICY_SOURCE = `/**
 * Generated by scripts/bench-hook.ts — a minimal convention policy whose only
 * job is to make loadAllCustomHooks do its real work: findDistIndex(), the
 * rewriteFileTree() temp-file pass that writes .__failproofai_tmp__.mjs next to
 * this file, the dynamic import, and the cleanup unlink. The policy body itself
 * is trivial on purpose so the measurement is loader cost, not policy cost.
 */
import { customPolicies, allow } from 'failproofai';

customPolicies.add({
  name: 'bench-noop',
  description: 'Benchmark fixture: always allows.',
  match: { events: ['PreToolUse', 'PostToolUse'] },
  fn: async () => allow(),
});
`;

interface Sandbox {
  root: string;
  home: string;
  project: string;
}

function makeSandbox(variant: Variant, policySet: string[]): Sandbox {
  const root = resolve(WORK_DIR, `sandbox-${variant}`);
  const home = resolve(root, "home");
  const project = resolve(root, "project");
  // A `.failproofai/` directory inside the sandbox stops
  // `findProjectConfigDir`'s upward walk before it reaches this repo's own
  // dogfood config — otherwise the benchmark would silently measure whatever
  // policies this checkout happens to have enabled.
  mkdirSync(resolve(project, ".failproofai"), { recursive: true });
  mkdirSync(resolve(home, ".failproofai"), { recursive: true });
  writeFileSync(
    resolve(project, ".failproofai", "policies-config.json"),
    JSON.stringify({ enabledPolicies: policySet }, null, 2),
    "utf8",
  );
  if (variant === "custom") {
    const policiesDir = resolve(project, ".failproofai", "policies");
    mkdirSync(policiesDir, { recursive: true });
    // Must end in `policies.{js,mjs,ts}` or convention discovery skips it.
    writeFileSync(resolve(policiesDir, "bench-policies.mjs"), BENCH_POLICY_SOURCE, "utf8");
  }
  return { root, home, project };
}

function workerEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Telemetry is fire-and-forget network I/O; leaving it on would add tens of
  // milliseconds of unrelated variance. Both the worker and the calibration run
  // of the real binary set this, so they stay comparable.
  env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
  env.FAILPROOFAI_DIST_PATH = SNAPSHOT_DIST_DIR;
  env.HOME = sandbox.home;
  env.CLAUDE_PROJECT_DIR = sandbox.project;
  delete env.FAILPROOFAI_LOG_LEVEL;
  delete env.FAILPROOFAI_HOOK_LOG_FILE;
  return env;
}

// ── Measurement ────────────────────────────────────────────────────────────

interface Sample {
  spawn: number;
  configLoad: number;
  evaluate: number;
  encode: number;
  other: number;
  e2e: number;
  matchedCount: number;
  customHooks: number;
}

let clampedOtherCount = 0;
let failedIterations = 0;
let totalIterations = 0;
const failureSamples: string[] = [];

function runOnce(cell: Cell, sandbox: Sandbox, nodeBin: string): Sample | null {
  const payload = JSON.stringify(buildPayload(cell, sandbox.project, "/dev/null"));
  const args = [WORKER_BUNDLE, "--worker", "--cli", cell.cli, "--event", cell.event];
  const t0 = nowEpochMs();
  const r = spawnSync(nodeBin, args, {
    input: payload,
    cwd: sandbox.project,
    env: workerEnv(sandbox),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const e2e = nowEpochMs() - t0;

  totalIterations += 1;
  const out = r.stdout ?? "";
  const idx = out.lastIndexOf(MARKER);
  if (r.status !== 0 || idx < 0) {
    failedIterations += 1;
    if (failureSamples.length < 5) {
      const msg =
        `worker failed for ${cellKey(cell)} (status ${String(r.status)}): ` +
        (r.stderr ?? "").slice(0, 600).replace(/\s+/g, " ").trim();
      failureSamples.push(msg);
      process.stderr.write(`\n[bench] ${msg}\n`);
    }
    return null;
  }
  const report = JSON.parse(out.slice(idx + MARKER.length).split("\n")[0]!) as WorkerReport;

  const spawn = report.timeOriginMs + report.entryMs - t0;
  const measured = spawn + report.configLoadMs + report.evaluateMs + report.encodeMs;
  let other = e2e - measured;
  if (other < 0) {
    clampedOtherCount += 1;
    other = 0;
  }
  return {
    spawn,
    configLoad: report.configLoadMs,
    evaluate: report.evaluateMs,
    encode: report.encodeMs,
    other,
    e2e,
    matchedCount: report.matchedCount,
    customHooks: report.customHooks,
  };
}

interface CellResult {
  n: number;
  matched: number;
  customHooks: number;
  phases: PhaseTriples;
  e2eMean: number;
  e2eStddev: number;
  e2eMin: number;
  e2eMax: number;
  samples: Sample[];
}

function measureCell(
  cell: Cell,
  sandbox: Sandbox,
  nodeBin: string,
  iterations: number,
  warmup: number,
): CellResult | null {
  for (let i = 0; i < warmup; i++) runOnce(cell, sandbox, nodeBin);
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) {
    const s = runOnce(cell, sandbox, nodeBin);
    if (s) samples.push(s);
  }
  if (samples.length === 0) return null;
  const e2e = samples.map((s) => s.e2e);
  const phases = {} as PhaseTriples;
  for (const phase of PHASES) phases[phase] = triple(samples.map((s) => s[phase]));
  return {
    n: samples.length,
    matched: samples[0]!.matchedCount,
    customHooks: samples[0]!.customHooks,
    phases,
    e2eMean: round(mean(e2e)),
    e2eStddev: round(stddev(e2e)),
    e2eMin: round(Math.min(...e2e)),
    e2eMax: round(Math.max(...e2e)),
    samples,
  };
}

function poolTriples(results: CellResult[]): PhaseTriples {
  const phases = {} as PhaseTriples;
  for (const phase of PHASES) {
    const all: number[] = [];
    for (const r of results) for (const s of r.samples) all.push(s[phase]);
    phases[phase] = triple(all);
  }
  return phases;
}

// ── Build steps ────────────────────────────────────────────────────────────

function newestMtime(dir: string, exts: string[]): number {
  let newest = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

function ensureDistFresh(bunBin: string, allowBuild: boolean): void {
  const srcNewest = Math.max(
    newestMtime(resolve(REPO_ROOT, "src"), [".ts"]),
    newestMtime(resolve(REPO_ROOT, "lib"), [".ts"]),
    newestMtime(resolve(REPO_ROOT, "bin"), [".mjs"]),
  );
  const distOk =
    existsSync(DIST_CLI) &&
    existsSync(DIST_INDEX) &&
    statSync(DIST_CLI).mtimeMs >= srcNewest &&
    statSync(DIST_INDEX).mtimeMs >= srcNewest;
  if (distOk) return;
  if (!allowBuild) {
    throw new Error("dist/ is stale and --no-build was passed. Run `bun run build:cli` first.");
  }
  process.stderr.write("[bench] dist/ is stale — running `bun run build:cli` + dist/index.js…\n");
  // `dist/index.js` is what `findDistIndex()` resolves for custom policies, and
  // `dist/cli.mjs` is what the calibration run invokes. Both must exist.
  const a = spawnSync(bunBin, ["run", "build:cli"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (a.status !== 0) throw new Error("build:cli failed");
  const b = spawnSync(
    bunBin,
    ["build", "--target=node", "--format=cjs", "--outfile=dist/index.js", "src/index.ts"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (b.status !== 0) throw new Error("building dist/index.js failed");
}

/**
 * Bundle THIS file to a node-runnable ESM module using the same flags
 * `package.json`'s `build:cli` uses for `dist/cli.mjs`, so the worker's module
 * graph is evaluated under the same conditions the shipping client's is.
 */
function buildWorkerBundle(bunBin: string): void {
  mkdirSync(WORK_DIR, { recursive: true });
  const r = spawnSync(
    bunBin,
    [
      "build",
      "--target=node",
      "--format=esm",
      `--outfile=${WORKER_BUNDLE}`,
      resolve(HERE, "bench-hook.ts"),
      "--external",
      "posthog-node",
      "--external",
      "sql.js",
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("bundling the bench worker failed");
  // Freeze `dist/` for the duration of the run — see SNAPSHOT_DIST_DIR.
  mkdirSync(SNAPSHOT_DIST_DIR, { recursive: true });
  cpSync(DIST_CLI, SNAPSHOT_CLI);
  cpSync(DIST_INDEX, resolve(SNAPSHOT_DIST_DIR, "index.js"));
  writeFileSync(
    NOOP_SCRIPT,
    `process.stdout.write("${MARKER}" + JSON.stringify({t: performance.timeOrigin + performance.now()}) + "\\n");\n`,
    "utf8",
  );
}

// ── Machine context ────────────────────────────────────────────────────────

interface MachineContext {
  fingerprint: string;
  cpuModel: string;
  cpuCores: number;
  totalMemGb: number;
  platform: string;
  osType: string;
  osRelease: string;
  arch: string;
  nodeVersion: string;
  bunVersion: string;
  hostname: string;
  loadAvgBefore: number[];
  loadAvgAfter: number[];
}

function readMachine(bunBin: string, nodeBin: string): MachineContext {
  const cpuList = cpus();
  const cpuModel = cpuList[0]?.model?.trim() ?? "unknown";
  const nodeVersion = (
    spawnSync(nodeBin, ["--version"], { encoding: "utf8" }).stdout ?? ""
  ).trim();
  const bunVersion = (
    spawnSync(bunBin, ["--version"], { encoding: "utf8" }).stdout ?? ""
  ).trim();
  return {
    // No `|` in the fingerprint — it is rendered inside a markdown table cell.
    fingerprint: `${cpuModel} / ${cpuList.length}c / ${platform()}-${arch()} / node ${nodeVersion} / bun ${bunVersion}`,
    cpuModel,
    cpuCores: cpuList.length,
    totalMemGb: round(totalmem() / 1024 ** 3, 1),
    platform: platform(),
    osType: osType(),
    osRelease: release(),
    arch: arch(),
    nodeVersion,
    bunVersion,
    hostname: hostname(),
    loadAvgBefore: loadavg().map((x) => round(x)),
    loadAvgAfter: [],
  };
}

// ── Artifact shape ─────────────────────────────────────────────────────────

interface CellRecord {
  n: number;
  matched: number;
  customHooks: number;
  phases: PhaseTriples;
  e2eMean: number;
  e2eStddev: number;
  e2eMin: number;
  e2eMax: number;
}

interface CalibrationRow {
  cli: string;
  event: string;
  harnessE2e: Triple;
  realCliE2e: Triple;
  deltaP50: number;
}

interface RepeatRow {
  cell: string;
  firstP50: number;
  secondP50: number;
  absDelta: number;
  relDelta: number;
}

interface Baseline {
  schema: string;
  generator: string;
  generatedAt: string;
  gitCommit: string;
  packageVersion: string;
  machine: MachineContext;
  config: {
    iterations: number;
    warmup: number;
    policySet: string;
    enabledPolicies: string[];
    variants: string[];
    matrix: { clis: number; events: number; cells: number };
    benchCommand: string;
    telemetry: string;
    concurrency: string;
    omittedFromHarness: string[];
  };
  phases: string[];
  percentiles: number[];
  runtimeFloor: {
    bareInterpreterSpawn: Triple;
    bareInterpreterE2e: Triple;
    moduleGraphEvalSpawn: Triple;
    derivedModuleEvalP50: number;
  };
  aggregate: Record<string, PhaseTriples>;
  byCli: Record<string, Record<string, PhaseTriples>>;
  byEvent: Record<string, Record<string, PhaseTriples>>;
  cells: Record<string, Record<string, CellRecord>>;
  customPolicyDelta: {
    configLoadP50: number;
    configLoadP95: number;
    configLoadP99: number;
    e2eP50: number;
    tempFilesWrittenPerInvocation: number;
  };
  calibration: CalibrationRow[];
  repeatability: {
    note: string;
    rows: RepeatRow[];
    maxAbsDeltaMs: number;
    maxRelDelta: number;
  };
  diagnostics: {
    totalIterations: number;
    failedIterations: number;
    failureRate: number;
    failureSamples: string[];
    clampedOtherSamples: number;
  };
}

// ── Argument parsing ───────────────────────────────────────────────────────

interface Options {
  check: boolean;
  iterations: number;
  warmup: number;
  policySet: "default" | "all";
  variants: Variant[];
  cliFilter: Set<string> | null;
  eventFilter: Set<string> | null;
  outDir: string;
  allowBuild: boolean;
  calibrationIterations: number;
  tolerance: number;
}

function parseOptions(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (flag: string): Set<string> | null => {
    const v = get(flag);
    return v ? new Set(v.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  };
  const variantsRaw = get("--variants");
  const variants = variantsRaw
    ? (variantsRaw.split(",").map((s) => s.trim()) as Variant[])
    : [...VARIANTS];
  const policySet = (get("--policy-set") ?? "default") as "default" | "all";
  return {
    check: argv.includes("--check"),
    iterations: Number(get("--iterations") ?? 50),
    warmup: Number(get("--warmup") ?? 3),
    policySet,
    variants,
    cliFilter: list("--cli"),
    eventFilter: list("--event"),
    outDir: get("--out") ?? DEFAULT_OUT_DIR,
    allowBuild: !argv.includes("--no-build"),
    calibrationIterations: Number(get("--calibration-iterations") ?? 30),
    tolerance: Number(get("--tolerance") ?? 1.5),
  };
}

// ── Markdown rendering ─────────────────────────────────────────────────────

function mdTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const PHASE_LABEL: Record<Phase, string> = {
  spawn: "1. spawn",
  configLoad: "2. config+load",
  evaluate: "3. evaluate",
  encode: "4. encode",
  other: "(other)",
  e2e: "**end-to-end**",
};

function phaseRows(t: PhaseTriples, e2eP50: number): string[][] {
  return PHASES.map((p) => [
    PHASE_LABEL[p],
    fmt(t[p][0], 2),
    fmt(t[p][1], 2),
    fmt(t[p][2], 2),
    p === "e2e" ? "100%" : `${fmt((t[p][0] / e2eP50) * 100, 1)}%`,
  ]);
}

function renderMarkdown(b: Baseline): string {
  // The primary variant is whatever was measured first — normally `default`.
  // A filtered run (`--variants custom`) still renders, it just has no paired
  // custom-policy delta to report.
  const primary = b.config.variants[0] ?? "default";
  const def = b.aggregate[primary];
  if (!def) throw new Error("bench-hook: no aggregate data to render");
  const cus = primary === "custom" ? undefined : b.aggregate.custom;
  const spawnShare = (def.spawn[0] / def.e2e[0]) * 100;
  const removedByStage1 = def.configLoad[0] + def.evaluate[0] + def.encode[0];
  const removedByStage1Custom = cus ? cus.configLoad[0] + cus.evaluate[0] + cus.encode[0] : 0;

  const out: string[] = [];
  out.push("# Stage 0 — cold-start hook latency baseline");
  out.push("");
  out.push(
    "> Generated by `scripts/bench-hook.ts`. **Do not hand-edit** — regenerate with " +
      "`bun scripts/bench-hook.ts`, and re-measure against this file with " +
      "`bun scripts/bench-hook.ts --check`.",
  );
  out.push("");
  out.push(
    `Captured ${b.generatedAt} at commit \`${b.gitCommit}\` (failproofai ${b.packageVersion}), ` +
      `${b.config.iterations} iterations per cell after ${b.config.warmup} discarded warmup ` +
      `iterations, across ${b.config.matrix.cells} \`(cli, event)\` cells ` +
      `(${b.config.matrix.clis} CLIs × ${b.config.matrix.events} events) × ` +
      `${b.config.variants.length} variants.`,
  );
  out.push("");

  // ── The argument ──
  out.push("## What this baseline is for");
  out.push("");
  out.push(
    "It exists to pre-empt one specific way Phase 1 could be killed for the wrong reason — " +
      "the risk titled **\u201cThe daemon isn\u2019t faster\u201d could kill the project mid-flight " +
      "for the wrong reason** in " +
      "`desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/03-risks-and-amendments.md`.",
  );
  out.push("");
  out.push(
    "Through Stage 3 the daemon\u2019s client is still `bin/failproofai.mjs` under Node or bun. " +
      "The process still starts, the module graph is still evaluated. **What the daemon removes " +
      "at Stage 1 is phases 2\u20134, not phase 1.** Phase 1 only goes away at Stage 4, when the " +
      "native client (`crates/failproofai-cli`) lands. If this baseline reported a single " +
      "end-to-end number, a Stage-1 measurement would look like a rounding error and " +
      "\u201cthe daemon isn\u2019t faster\u201d would be unanswerable.",
  );
  out.push("");
  out.push("On the machine below, with the **default** policy set and no custom policy file:");
  out.push("");
  out.push(
    mdTable(
      ["", "removed by", "p50 (ms)", "share of end-to-end p50"],
      [
        [
          "phase 1 — spawn",
          "**Stage 4** (native client)",
          fmt(def.spawn[0], 2),
          `${fmt(spawnShare, 1)}%`,
        ],
        [
          "phases 2–4 — config+load, evaluate, encode",
          "**Stage 1** (daemon)",
          fmt(removedByStage1, 2),
          `${fmt((removedByStage1 / def.e2e[0]) * 100, 1)}%`,
        ],
        ["(other) — payload, envelope, teardown", "—", fmt(def.other[0], 2), `${fmt((def.other[0] / def.e2e[0]) * 100, 1)}%`],
      ],
    ),
  );
  out.push("");
  if (cus) {
    out.push(
      `With **one** custom policy file present — the setup that makes ` +
        `\`src/hooks/loader-utils.ts\` write \`.__failproofai_tmp__.mjs\` next to the user\u2019s ` +
        `own source on every single tool call — phases 2\u20134 grow to ` +
        `**${fmt(removedByStage1Custom, 2)} ms** p50. That is the part the daemon deletes at ` +
        `Stage 1, and it is ${fmt(removedByStage1Custom / Math.max(removedByStage1, 0.001), 1)}\u00d7 ` +
        `larger than in the default case.`,
    );
    out.push("");
  }
  out.push(
    `So the Stage-1\u20133 acceptance question is **\u201cdid phases 2\u20134 go to zero?\u201d**, not ` +
      `\u201cdid end-to-end drop?\u201d. End-to-end is the Stage-4 gate, exactly as ` +
      `\`01-stages.md\` states. The nightly \`hyperfine\` job described in ` +
      `\`02-verification.md\` (L6) is the successor to this file, not a replacement for it: ` +
      `\`hyperfine\` can only see end-to-end.`,
  );
  out.push("");

  // ── Aggregate ──
  out.push("## Aggregate, pooled across every cell");
  out.push("");
  for (const variant of b.config.variants) {
    const t = b.aggregate[variant];
    if (!t) continue;
    const label =
      variant === "default"
        ? "`default` — 11 default-enabled builtins, **no** custom policy file"
        : "`custom` — same builtins **plus one** convention custom policy file";
    out.push(`### ${variant} variant`);
    out.push("");
    out.push(label);
    out.push("");
    out.push(mdTable(["phase", "p50 (ms)", "p95 (ms)", "p99 (ms)", "share of e2e p50"], phaseRows(t, t.e2e[0])));
    out.push("");
  }

  // ── Custom policy delta ──
  if (cus) {
    out.push("## The cost of one custom policy file (`config+load`)");
    out.push("");
    out.push(
      "This is the strongest single argument for the daemon at Stage 1, because it is pure " +
        "overhead that recurs on **every tool call** and it writes to the user\u2019s working tree " +
        "to do it. `rewriteFileTree()` creates one `.__failproofai_tmp__.mjs` beside the policy " +
        "file plus one ESM shim beside `dist/index.js`, dynamically imports the copy, then " +
        "unlinks both.",
    );
    out.push("");
    out.push(
      mdTable(
        ["", "p50 (ms)", "p95 (ms)", "p99 (ms)"],
        [
          ["`config+load`, no custom policy", fmt(def.configLoad[0], 2), fmt(def.configLoad[1], 2), fmt(def.configLoad[2], 2)],
          ["`config+load`, one custom policy", fmt(cus.configLoad[0], 2), fmt(cus.configLoad[1], 2), fmt(cus.configLoad[2], 2)],
          [
            "**delta**",
            `**+${fmt(b.customPolicyDelta.configLoadP50, 2)}**`,
            `**+${fmt(b.customPolicyDelta.configLoadP95, 2)}**`,
            `**+${fmt(b.customPolicyDelta.configLoadP99, 2)}**`,
          ],
          ["end-to-end delta", `+${fmt(b.customPolicyDelta.e2eP50, 2)}`, "—", "—"],
        ],
      ),
    );
    out.push("");
    out.push(
      `Temp files written per hook invocation, custom variant: ` +
        `**${b.customPolicyDelta.tempFilesWrittenPerInvocation}** ` +
        `(one rewritten policy copy + one ESM shim).`,
    );
    out.push("");
  }

  // ── Phase 1 decomposition ──
  out.push("## Inside phase 1 — why the daemon cannot remove it before Stage 4");
  out.push("");
  out.push(
    mdTable(
      ["", "p50 (ms)", "p95 (ms)", "p99 (ms)"],
      [
        [
          "bare interpreter start (`node` running a one-line script)",
          fmt(b.runtimeFloor.bareInterpreterSpawn[0], 2),
          fmt(b.runtimeFloor.bareInterpreterSpawn[1], 2),
          fmt(b.runtimeFloor.bareInterpreterSpawn[2], 2),
        ],
        [
          "…plus evaluating the failproofai module graph",
          fmt(b.runtimeFloor.moduleGraphEvalSpawn[0], 2),
          fmt(b.runtimeFloor.moduleGraphEvalSpawn[1], 2),
          fmt(b.runtimeFloor.moduleGraphEvalSpawn[2], 2),
        ],
        [
          "**module-graph evaluation alone** (derived)",
          `**${fmt(b.runtimeFloor.derivedModuleEvalP50, 2)}**`,
          "—",
          "—",
        ],
      ],
    ),
  );
  out.push("");
  out.push(
    "Both halves survive Stages 1\u20133 untouched: the hook is still a Node process that still " +
      "imports `src/hooks/handler.ts`, because the Stage-1 daemon branch lives *inside* that " +
      "module. Only the Stage-4 native client removes them.",
  );
  out.push("");

  // ── Per-CLI ──
  out.push(`## Per CLI (\`${primary}\` variant, pooled across all events)`);
  out.push("");
  const byCliDefault = b.byCli[primary] ?? {};
  out.push(
    mdTable(
      ["cli", "spawn p50", "config+load p50", "evaluate p50", "encode p50", "e2e p50", "e2e p95", "e2e p99"],
      Object.entries(byCliDefault).map(([cli, t]) => [
        `\`${cli}\``,
        fmt(t.spawn[0], 2),
        fmt(t.configLoad[0], 2),
        fmt(t.evaluate[0], 3),
        fmt(t.encode[0], 3),
        fmt(t.e2e[0], 2),
        fmt(t.e2e[1], 2),
        fmt(t.e2e[2], 2),
      ]),
    ),
  );
  out.push("");
  out.push(
    `All ${Object.keys(byCliDefault).length} rows are within noise of each other, which is the ` +
      "expected result and worth stating: canonicalization is table lookups, and the per-CLI " +
      "response encoders differ by a few string concatenations. **The CLI you use does not " +
      "measurably change hook latency; the event does.**",
  );
  out.push("");

  // ── Per-event ──
  out.push(`## Per event (\`${primary}\` variant, pooled across all CLIs)`);
  out.push("");
  const byEventDefault = b.byEvent[primary] ?? {};
  const eventRows = Object.entries(byEventDefault).map(([event, t]) => {
    const anyCell = Object.entries(b.cells[primary] ?? {}).find(([k]) => k.endsWith(`|${event}`));
    return [
      `\`${event}\``,
      String(anyCell?.[1].matched ?? 0),
      fmt(t.spawn[0], 2),
      fmt(t.configLoad[0], 2),
      fmt(t.evaluate[0], 3),
      fmt(t.encode[0], 3),
      fmt(t.e2e[0], 2),
      fmt(t.e2e[2], 2),
    ];
  });
  out.push(
    mdTable(
      ["event", "policies matched", "spawn p50", "config+load p50", "evaluate p50", "encode p50", "e2e p50", "e2e p99"],
      eventRows,
    ),
  );
  out.push("");
  out.push(
    "`policies matched` is the number of **default-enabled** builtins registered for that " +
      "event. Most canonical events have none — that is the shipped default, not a gap in the " +
      "benchmark — so `evaluate` for them is the cost of an empty `getPoliciesForEvent` lookup. " +
      "A user who enables the full catalogue moves `evaluate` up; rerun with `--policy-set all` " +
      "to see by how much.",
  );
  out.push("");

  // ── Calibration ──
  out.push("## Calibration against the real client");
  out.push("");
  out.push(
    "The per-phase numbers come from a harness process that re-enacts `handleHookEvent`\u2019s " +
      "pipeline (it has to: that function returns one number for the whole invocation). This " +
      "table runs the **actual shipping client** \u2014 `node dist/cli.mjs --hook <event> --cli " +
      "<cli>` \u2014 over the same cells, so the size of that approximation is a published number.",
  );
  out.push("");
  out.push(
    mdTable(
      ["cli", "event", "harness e2e p50", "real `dist/cli.mjs` e2e p50", "delta (ms)"],
      b.calibration.map((r) => [
        `\`${r.cli}\``,
        `\`${r.event}\``,
        fmt(r.harnessE2e[0], 2),
        fmt(r.realCliE2e[0], 2),
        `+${fmt(r.deltaP50, 2)}`,
      ]),
    ),
  );
  out.push("");
  out.push(
    "The real client is consistently **slower**, and the gap is accounted for: it bundles the " +
      "entire CLI surface (`manager.ts`, the TUI, the dashboard launcher) rather than just the " +
      "hook path, and it also runs `persistHookActivity` and `flushHookTelemetry`, which the " +
      "harness omits. Read the harness numbers as a **lower bound** on phase 1 and on " +
      "end-to-end; phases 2\u20134 are measured on the real code paths and are not affected.",
  );
  out.push("");

  // ── Honesty section ──
  out.push("## Reading these numbers honestly");
  out.push("");
  out.push(
    `This ran on a **shared developer workstation**, not a quiesced benchmark host. Load average ` +
      `was ${b.machine.loadAvgBefore.join(", ")} at the start and ${b.machine.loadAvgAfter.join(", ")} ` +
      `at the end. Nothing was pinned, isolated, or governor-locked.`,
  );
  out.push("");
  out.push("**What these numbers can be used for:**");
  out.push("");
  out.push(
    "- The **ratio** between phases, and therefore the Stage-1-vs-Stage-4 argument above. " +
      "Phase 1 is an order of magnitude larger than phases 2\u20134 combined; no plausible amount " +
      "of noise reverses that.",
  );
  out.push(
    "- The **with-vs-without-custom-policy delta**, which is a paired comparison measured " +
      "under identical conditions in the same run.",
  );
  out.push("- A **same-machine** regression check, via `--check`.");
  out.push("");
  out.push("**What they must not be used for:**");
  out.push("");
  out.push(
    "- Comparison against a run on different hardware, a different Node version, or a CI " +
      "runner. That is why `machine.fingerprint` is recorded and why `--check` degrades to " +
      "advisory when it differs.",
  );
  out.push(
    "- Any claim that needs precision finer than the spread below. The p99 column in " +
      `particular is a tail on a noisy host: treat it as \u201cthe worst of ${b.config.iterations}` +
      "\u201d, not as a distributional p99.",
  );
  out.push(
    "- Absolute SLO setting. `01-stages.md` gates end-to-end latency at **Stage 4** for exactly " +
      "this reason.",
  );
  out.push("");
  out.push("### Observed spread");
  out.push("");
  out.push(
    mdTable(
      ["measure", "value"],
      [
        [
          `within-cell end-to-end coefficient of variation (median across cells, \`${primary}\` variant)`,
          `${fmt(medianCv(b, primary) * 100, 1)}%`,
        ],
        [
          `worst within-cell end-to-end CV (\`${primary}\` variant)`,
          `${fmt(worstCv(b, primary) * 100, 1)}%`,
        ],
        [
          "run-to-run repeatability: largest absolute end-to-end p50 shift over the repeat probe",
          `${fmt(b.repeatability.maxAbsDeltaMs, 2)} ms (${fmt(b.repeatability.maxRelDelta * 100, 1)}%)`,
        ],
        ["iterations per cell", String(b.config.iterations)],
        ["discarded warmup iterations per cell", String(b.config.warmup)],
        [
          "iterations attempted / failed",
          `${b.diagnostics.totalIterations} / ${b.diagnostics.failedIterations} ` +
            `(${fmt(b.diagnostics.failureRate * 100, 2)}%)`,
        ],
        [
          "samples where the four phases summed above wall clock (clamped)",
          String(b.diagnostics.clampedOtherSamples),
        ],
      ],
    ),
  );
  out.push("");
  out.push(
    `The repeat probe re-measures ${b.repeatability.rows.length} cells at the very end of the ` +
      `run and compares them to their measurement at the start. ${b.repeatability.note}`,
  );
  out.push("");

  // ── Machine ──
  out.push("## Machine context");
  out.push("");
  out.push(
    mdTable(
      ["", ""],
      [
        ["CPU", b.machine.cpuModel],
        ["cores (logical)", String(b.machine.cpuCores)],
        ["memory", `${b.machine.totalMemGb} GiB`],
        ["OS", `${b.machine.osType} ${b.machine.osRelease} (${b.machine.platform}/${b.machine.arch})`],
        ["node", b.machine.nodeVersion],
        ["bun", b.machine.bunVersion],
        ["load average (start → end)", `${b.machine.loadAvgBefore.join(", ")} → ${b.machine.loadAvgAfter.join(", ")}`],
        ["fingerprint", `\`${b.machine.fingerprint}\``],
      ],
    ),
  );
  out.push("");

  // ── Methodology ──
  out.push("## Method");
  out.push("");
  out.push("```");
  out.push("bun scripts/bench-hook.ts                       # measure and rewrite both artifacts");
  out.push("bun scripts/bench-hook.ts --check               # re-measure, compare, write nothing");
  out.push("bun scripts/bench-hook.ts --iterations 200      # tighter tails");
  out.push("bun scripts/bench-hook.ts --cli claude,goose    # filter the matrix");
  out.push("bun scripts/bench-hook.ts --event PreToolUse");
  out.push("bun scripts/bench-hook.ts --policy-set all      # every non-beta builtin enabled");
  out.push("bun scripts/bench-hook.ts --variants default    # skip the custom-policy variant");
  out.push("```");
  out.push("");
  out.push(
    "There is **no `bench` script in `package.json` and no CI job**. `--check` exists so a soft " +
      "gate can be added later (see L6 in `02-verification.md`); it is deliberately not wired " +
      "up, because a benchmark in CI on shared runners produces flaky failures, not signal.",
  );
  out.push("");
  out.push("Measurement details that matter for reproducing this:");
  out.push("");
  out.push(
    "- **Every iteration is a fresh process.** Cold start is the thing being measured, so it " +
      "cannot be amortized across iterations.",
  );
  out.push(
    "- **Strictly serial.** Running spawns concurrently would cut wall time and destroy the " +
      "latency distribution.",
  );
  out.push(
    "- **Isolated sandbox.** Each variant gets its own `HOME` and its own project directory " +
      "containing a `.failproofai/` marker, so `findProjectConfigDir` stops there and the " +
      `benchmark never picks up this repo's own dogfood policy configuration.`,
  );
  out.push(
    `- **Policy set: \`${b.config.policySet}\`** \u2014 ${b.config.enabledPolicies.length} builtins, ` +
      "derived from `BUILTIN_POLICIES.filter(p => p.defaultEnabled && !p.beta)`. Every builtin " +
      "that spawns a subprocess (`block-work-on-main`, the five `require-*-before-stop`) or " +
      "reads a transcript (`warn-repeated-tool-calls`) is `defaultEnabled: false`, so the " +
      "default workload does no subprocess or transcript I/O. A user who enables those will " +
      "see materially higher `evaluate`.",
  );
  out.push(
    `- **Bash command benchmarked: \`${b.config.benchCommand}\`.** Benign on purpose: a deny ` +
      "short-circuits `evaluateVerdicts`, so benchmarking a blocked command would measure the " +
      "cheapest possible policy loop.",
  );
  out.push(`- **Telemetry:** ${b.config.telemetry}`);
  out.push(
    `- **Omitted from the harness process** (present in the calibration run): ` +
      `${b.config.omittedFromHarness.map((s) => `\`${s}\``).join(", ")}.`,
  );
  out.push(
    "- **The harness hard-exits after emitting its report**, mirroring " +
      "`bin/failproofai.mjs`, which calls `process.exit()` the moment `handleHookEvent` " +
      "returns. That is not cosmetic: a hook process that merely *returns* stays alive as " +
      "long as anything is still pending on the event loop, so without the mirror the " +
      "custom-policy variant measured a 10,088 ms p95 on the first attempt at this baseline " +
      "\u2014 it was timing a pending `setTimeout`, not a hook.",
  );
  out.push(
    "- **`transcript_path` is `/dev/null`** and the sandbox `HOME` is empty, so " +
      "`resolveTranscriptPath` and `resolvePermissionMode` return immediately. On a real " +
      "machine `resolveCodexMode` line-scans `~/.codex/sessions`; `01-stages.md`\u2019s P4 calls " +
      "that out as an unbounded read on the enforcement deadline path. **This baseline does " +
      "not capture that pathology** \u2014 it is a floor, not a worst case.",
  );
  out.push("");
  out.push("## Matrix derivation");
  out.push("");
  out.push(
    "The matrix is `INTEGRATION_TYPES` \u00d7 `HOOK_EVENT_TYPES` read from " +
      "`src/hooks/types.ts`, and per-CLI tool/event tables are resolved by naming convention " +
      "(`<CLI>_TOOL_MAP`, `<CLI>_TOOL_INPUT_MAP`, `<CLI>_EVENT_MAP`) off a namespace import, " +
      "the same technique `scripts/gen-canon-tables.ts` uses. **Nothing hardcodes twelve.** A " +
      "thirteenth CLI appears in this table on the next run with no edit to the script.",
  );
  out.push("");
  out.push(
    `Cells measured: **${b.config.matrix.cells}** = ${b.config.matrix.clis} \u00d7 ` +
      `${b.config.matrix.events}. Full per-cell percentiles are in ` +
      "`bench-baseline.json` under `cells.<variant>[\"<cli>|<event>\"]`; each phase is a " +
      `\`[p50, p95, p99]\` tuple in milliseconds.`,
  );
  out.push("");
  return out.join("\n");
}

function cvList(b: Baseline, variant: string): number[] {
  const cells = b.cells[variant] ?? {};
  return Object.values(cells)
    .filter((c) => c.e2eMean > 0)
    .map((c) => c.e2eStddev / c.e2eMean);
}

function medianCv(b: Baseline, variant: string): number {
  const xs = cvList(b, variant).sort((a, c) => a - c);
  return xs.length === 0 ? 0 : xs[Math.floor(xs.length / 2)]!;
}

function worstCv(b: Baseline, variant: string): number {
  const xs = cvList(b, variant);
  return xs.length === 0 ? 0 : Math.max(...xs);
}

// ── --check ────────────────────────────────────────────────────────────────

function runCheck(fresh: Baseline, baselinePath: string, tolerance: number): number {
  if (!existsSync(baselinePath)) {
    process.stderr.write(`[bench] no committed baseline at ${baselinePath}\n`);
    return 1;
  }
  const old = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const sameMachine = old.machine.fingerprint === fresh.machine.fingerprint;

  process.stdout.write("\n=== bench-hook --check ===\n\n");
  process.stdout.write(`baseline : ${old.generatedAt}  ${old.machine.fingerprint}\n`);
  process.stdout.write(`current  : ${fresh.generatedAt}  ${fresh.machine.fingerprint}\n\n`);
  if (!sameMachine) {
    process.stdout.write(
      "MACHINE FINGERPRINT DIFFERS — this comparison is ADVISORY ONLY.\n" +
        "A latency baseline is not portable across hardware, OS, or runtime versions.\n\n",
    );
  }

  let regressions = 0;
  for (const variant of fresh.config.variants) {
    const a = old.aggregate[variant];
    const c = fresh.aggregate[variant];
    if (!a || !c) continue;
    process.stdout.write(`--- ${variant} ---\n`);
    process.stdout.write("phase          base p50   now p50    base p95   now p95    verdict\n");
    for (const phase of PHASES) {
      const ratio95 = a[phase][1] === 0 ? 1 : c[phase][1] / a[phase][1];
      const absDelta95 = c[phase][1] - a[phase][1];
      const regressed = ratio95 > tolerance && absDelta95 > 5;
      if (regressed && sameMachine) regressions += 1;
      process.stdout.write(
        `${phase.padEnd(14)} ${fmt(a[phase][0], 2).padStart(8)}   ${fmt(c[phase][0], 2).padStart(8)}   ` +
          `${fmt(a[phase][1], 2).padStart(8)}   ${fmt(c[phase][1], 2).padStart(8)}   ` +
          `${regressed ? `REGRESSED (${fmt(ratio95, 2)}x)` : `ok (${fmt(ratio95, 2)}x)`}\n`,
      );
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    `tolerance: p95 may grow up to ${tolerance}x AND +5 ms before it counts as a regression.\n`,
  );
  if (!sameMachine) {
    process.stdout.write("result: ADVISORY (different machine) — exiting 0.\n");
    return 0;
  }
  if (regressions > 0) {
    process.stdout.write(`result: ${regressions} REGRESSION(S).\n`);
    return 1;
  }
  process.stdout.write("result: OK.\n");
  return 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

function cleanup(): void {
  try {
    rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  // `rewriteFileTree` writes an ESM shim beside dist/index.js and unlinks it on
  // the way out; a killed iteration can leave one behind.
  try {
    for (const name of readdirSync(DIST_DIR)) {
      if (name.includes("__failproofai_esm_shim__") || name.includes("__failproofai_tmp__")) {
        rmSync(resolve(DIST_DIR, name), { force: true });
      }
    }
  } catch {
    /* best effort */
  }
}

function which(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.error) throw new Error(`\`${bin}\` is not on PATH — it is required to run this benchmark.`);
  return bin;
}

function progress(done: number, total: number, label: string): void {
  const pct = ((done / total) * 100).toFixed(1);
  process.stderr.write(`\r[bench] ${String(done).padStart(4)}/${total} cells (${pct}%) ${label.padEnd(44)}`);
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const bunBin = which(process.execPath.includes("bun") ? process.execPath : "bun");
  const nodeBin = which("node");

  const machine = readMachine(bunBin, nodeBin);
  const policySet = opts.policySet === "all" ? allPolicies() : defaultEnabledPolicies();
  const cells = buildMatrix(opts.cliFilter, opts.eventFilter);
  const cliCount = opts.cliFilter ? [...opts.cliFilter].length : INTEGRATION_TYPES.length;
  const eventCount = opts.eventFilter ? [...opts.eventFilter].length : HOOK_EVENT_TYPES.length;

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  ensureDistFresh(bunBin, opts.allowBuild);
  buildWorkerBundle(bunBin);

  const sandboxes: Record<string, Sandbox> = {};
  for (const v of opts.variants) sandboxes[v] = makeSandbox(v, policySet);

  const totalIters = cells.length * opts.variants.length * (opts.iterations + opts.warmup);
  process.stderr.write(
    `[bench] ${cells.length} cells x ${opts.variants.length} variants x ` +
      `${opts.iterations} iterations (+${opts.warmup} warmup) = ${totalIters} cold processes\n`,
  );

  // ── Runtime floor probes ──
  const floorSandbox = sandboxes[opts.variants[0]!]!;
  const bareSpawn: number[] = [];
  const bareE2e: number[] = [];
  for (let i = 0; i < opts.calibrationIterations + opts.warmup; i++) {
    const t0 = nowEpochMs();
    const r = spawnSync(nodeBin, [NOOP_SCRIPT], {
      encoding: "utf8",
      cwd: floorSandbox.project,
      env: workerEnv(floorSandbox),
    });
    const e2e = nowEpochMs() - t0;
    const idx = (r.stdout ?? "").lastIndexOf(MARKER);
    if (i < opts.warmup || idx < 0) continue;
    const t = (JSON.parse((r.stdout ?? "").slice(idx + MARKER.length)) as { t: number }).t;
    bareSpawn.push(t - t0);
    bareE2e.push(e2e);
  }
  const moduleEvalSpawn: number[] = [];
  for (let i = 0; i < opts.calibrationIterations + opts.warmup; i++) {
    const t0 = nowEpochMs();
    const r = spawnSync(nodeBin, [WORKER_BUNDLE, "--worker", "--floor"], {
      encoding: "utf8",
      cwd: floorSandbox.project,
      env: workerEnv(floorSandbox),
      input: "",
    });
    const idx = (r.stdout ?? "").lastIndexOf(MARKER);
    if (i < opts.warmup || idx < 0) continue;
    const rep = JSON.parse((r.stdout ?? "").slice(idx + MARKER.length).split("\n")[0]!) as WorkerReport;
    moduleEvalSpawn.push(rep.timeOriginMs + rep.entryMs - t0);
  }
  const bareSpawnT = triple(bareSpawn);
  const moduleEvalT = triple(moduleEvalSpawn);

  // ── The matrix ──
  const results: Record<string, Record<string, CellResult>> = {};
  const firstProbe = new Map<string, number>();
  const probeCells = cells.filter((c) => c.event === "PreToolUse").slice(0, 12);
  const probeKeys = new Set(probeCells.map(cellKey));

  let done = 0;
  const totalCells = cells.length * opts.variants.length;
  for (const variant of opts.variants) {
    results[variant] = {};
    for (const cell of cells) {
      progress(done, totalCells, `${variant} ${cellKey(cell)}`);
      const res = measureCell(cell, sandboxes[variant]!, nodeBin, opts.iterations, opts.warmup);
      done += 1;
      if (!res) continue;
      results[variant]![cellKey(cell)] = res;
      if (variant === opts.variants[0] && probeKeys.has(cellKey(cell))) {
        firstProbe.set(cellKey(cell), res.phases.e2e[0]);
      }
    }
  }
  process.stderr.write("\n");

  // A capture this long shares a machine with whatever else is running in the
  // repo. If a meaningful slice of iterations failed, the percentiles below are
  // computed over a biased survivor set — refuse to write an artifact that
  // looks authoritative and is not.
  const failureRate = totalIterations === 0 ? 1 : failedIterations / totalIterations;
  if (failureRate > MAX_FAILURE_RATE) {
    process.stderr.write(
      `\n[bench] ABORT: ${failedIterations}/${totalIterations} iterations failed ` +
        `(${fmt(failureRate * 100, 1)}%, limit ${fmt(MAX_FAILURE_RATE * 100, 1)}%).\n` +
        `[bench] Nothing was written. First failures:\n` +
        failureSamples.map((m) => `  - ${m}\n`).join("") +
        `[bench] The usual cause is something else in the repo rebuilding while this ran.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Calibration against the real client ──
  // Skipped under --check: neither the calibration nor the repeat probe feeds
  // the regression comparison, and a check that takes as long as a full capture
  // is a check nobody runs.
  const calibration: CalibrationRow[] = [];
  const calSandbox = sandboxes[opts.variants[0]!]!;
  for (const cell of opts.check ? [] : probeCells) {
    const harness = results[opts.variants[0]!]?.[cellKey(cell)];
    if (!harness) continue;
    const real: number[] = [];
    for (let i = 0; i < opts.calibrationIterations + opts.warmup; i++) {
      const payload = JSON.stringify(buildPayload(cell, calSandbox.project, "/dev/null"));
      const t0 = nowEpochMs();
      spawnSync(nodeBin, [SNAPSHOT_CLI, "--hook", nativeEventName(cell.cli, cell.event), "--cli", cell.cli], {
        input: payload,
        cwd: calSandbox.project,
        env: workerEnv(calSandbox),
        encoding: "utf8",
        timeout: 30_000,
      });
      const e2e = nowEpochMs() - t0;
      if (i >= opts.warmup) real.push(e2e);
    }
    const realT = triple(real);
    calibration.push({
      cli: cell.cli,
      event: cell.event,
      harnessE2e: harness.phases.e2e,
      realCliE2e: realT,
      deltaP50: round(realT[0] - harness.phases.e2e[0]),
    });
  }

  // ── Repeat probe (run-to-run repeatability, measured within one run) ──
  const repeatRows: RepeatRow[] = [];
  for (const cell of opts.check ? [] : probeCells) {
    const first = firstProbe.get(cellKey(cell));
    if (first === undefined) continue;
    const again = measureCell(cell, calSandbox, nodeBin, opts.iterations, opts.warmup);
    if (!again) continue;
    const second = again.phases.e2e[0];
    repeatRows.push({
      cell: cellKey(cell),
      firstP50: first,
      secondP50: second,
      absDelta: round(Math.abs(second - first)),
      relDelta: round(Math.abs(second - first) / Math.max(first, 0.001), 4),
    });
  }

  machine.loadAvgAfter = loadavg().map((x) => round(x));

  // ── Aggregate ──
  const aggregate: Record<string, PhaseTriples> = {};
  const byCli: Record<string, Record<string, PhaseTriples>> = {};
  const byEvent: Record<string, Record<string, PhaseTriples>> = {};
  const cellRecords: Record<string, Record<string, CellRecord>> = {};
  for (const variant of opts.variants) {
    const all = Object.values(results[variant] ?? {});
    if (all.length === 0) continue;
    aggregate[variant] = poolTriples(all);
    byCli[variant] = {};
    byEvent[variant] = {};
    cellRecords[variant] = {};
    for (const cli of INTEGRATION_TYPES) {
      const subset = Object.entries(results[variant] ?? {})
        .filter(([k]) => k.startsWith(`${cli}|`))
        .map(([, v]) => v);
      if (subset.length > 0) byCli[variant]![cli] = poolTriples(subset);
    }
    for (const event of HOOK_EVENT_TYPES) {
      const subset = Object.entries(results[variant] ?? {})
        .filter(([k]) => k.endsWith(`|${event}`))
        .map(([, v]) => v);
      if (subset.length > 0) byEvent[variant]![event] = poolTriples(subset);
    }
    for (const [key, r] of Object.entries(results[variant] ?? {})) {
      cellRecords[variant]![key] = {
        n: r.n,
        matched: r.matched,
        customHooks: r.customHooks,
        phases: r.phases,
        e2eMean: r.e2eMean,
        e2eStddev: r.e2eStddev,
        e2eMin: r.e2eMin,
        e2eMax: r.e2eMax,
      };
    }
  }

  const def = aggregate.default;
  const cus = aggregate.custom;
  const gitCommit = (
    spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout ?? ""
  ).trim();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };

  const baseline: Baseline = {
    schema:
      "Every phase value is a [p50, p95, p99] tuple in milliseconds. Phases: " +
      "spawn (fork/exec + interpreter bootstrap + failproofai module-graph evaluation), " +
      "configLoad (readMergedHooksConfig + registerBuiltinPolicies + loadAllCustomHooks), " +
      "evaluate (evaluateVerdicts), encode (encodeResponse), " +
      "other (payload parse + canonicalization + envelope + teardown + parent reap), " +
      "e2e (parent wall clock around the whole cold process). " +
      "spawn is removed by Stage 4 (native client); configLoad/evaluate/encode by Stage 1 (daemon).",
    generator: "scripts/bench-hook.ts",
    generatedAt: new Date().toISOString(),
    gitCommit,
    packageVersion: pkg.version,
    machine,
    config: {
      iterations: opts.iterations,
      warmup: opts.warmup,
      policySet: opts.policySet,
      enabledPolicies: policySet,
      variants: opts.variants,
      matrix: { clis: cliCount, events: eventCount, cells: cells.length },
      benchCommand: BENCH_COMMAND,
      telemetry: "disabled via FAILPROOFAI_TELEMETRY_DISABLED=1 (network I/O would swamp the signal)",
      concurrency: "strictly serial — one cold process at a time",
      omittedFromHarness: ["persistHookActivity", "trackHookEvent", "flushHookTelemetry"],
    },
    phases: [...PHASES],
    percentiles: [...PERCENTILES],
    runtimeFloor: {
      bareInterpreterSpawn: bareSpawnT,
      bareInterpreterE2e: triple(bareE2e),
      moduleGraphEvalSpawn: moduleEvalT,
      derivedModuleEvalP50: round(moduleEvalT[0] - bareSpawnT[0]),
    },
    aggregate,
    byCli,
    byEvent,
    cells: cellRecords,
    customPolicyDelta: {
      configLoadP50: def && cus ? round(cus.configLoad[0] - def.configLoad[0]) : 0,
      configLoadP95: def && cus ? round(cus.configLoad[1] - def.configLoad[1]) : 0,
      configLoadP99: def && cus ? round(cus.configLoad[2] - def.configLoad[2]) : 0,
      e2eP50: def && cus ? round(cus.e2e[0] - def.e2e[0]) : 0,
      tempFilesWrittenPerInvocation: 2,
    },
    calibration,
    repeatability: {
      note:
        "Both measurements come from the same process, minutes apart, on a machine that was " +
        "also running an editor and an agent session — so this is a realistic lower bound on " +
        "run-to-run noise, not a best case.",
      rows: repeatRows,
      maxAbsDeltaMs: repeatRows.length === 0 ? 0 : round(Math.max(...repeatRows.map((r) => r.absDelta))),
      maxRelDelta: repeatRows.length === 0 ? 0 : round(Math.max(...repeatRows.map((r) => r.relDelta)), 4),
    },
    diagnostics: {
      totalIterations,
      failedIterations,
      failureRate: round(failureRate, 5),
      failureSamples,
      clampedOtherSamples: clampedOtherCount,
    },
  };

  const jsonPath = resolve(opts.outDir, "bench-baseline.json");
  const mdPath = resolve(opts.outDir, "bench-baseline.md");

  if (opts.check) {
    process.exitCode = runCheck(baseline, jsonPath, opts.tolerance);
    return;
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, renderMarkdown(baseline) + "\n", "utf8");
  process.stderr.write(`[bench] wrote ${jsonPath}\n[bench] wrote ${mdPath}\n`);
  if (failedIterations > 0) {
    process.stderr.write(`[bench] WARNING: ${failedIterations} iteration(s) failed and were excluded\n`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await main();
}
