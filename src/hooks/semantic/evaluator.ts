/**
 * The semantic evaluator: one tool call in, one allow / deny / instruct out,
 * decided by a single Jev request carrying every applicable policy.
 *
 * It never throws and it never guesses. Anything that stops it from getting a
 * complete, valid answer — no transport, timeout, HTTP error, malformed body, a
 * different model than the one pinned, an abort — comes back as `degraded`,
 * and the two-tier combine then keeps the regex result for that call exactly
 * as it is today. A semantic outage is a return to the old engine, not an
 * open door.
 *
 * The caller always supplies the transport: in the product that is the
 * customer's own BYOK config (`transportForConfig` behind `throttleTransport`,
 * see `jev-review.ts`). There is deliberately no fallback that goes looking
 * for credentials on disk — a machine without a `jev.json` must never reach
 * Jev at all.
 *
 * Every evaluation, degraded ones included, is written to
 * `~/.failproofai/state/semantic/verdicts.jsonl` with the per-question
 * probabilities, so any verdict can be re-derived later with `decide()`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { semanticDir } from "../fp-home";
import { DEFAULT_JEV_MODEL, MAX_REQUEST_CHARS, compileRequest, selectPolicies, type CompiledRequest } from "./compile";
import { DEFAULT_THRESHOLDS, decide, decideV1, type DecideV1Options, type Thresholds } from "./decide";
import { buildEnvelope, redactSecrets, type Envelope } from "./envelope";
import { computeFacts, scanCommand } from "./facts";
import { cleanUserSaid } from "./intent";
import { JevError, readAnswers, type JevTransport } from "./jev-client";
import type { JevProviderKind } from "./jev-config";
import { SEMANTIC_POLICIES } from "./policies";
import type { Facts, IntentMode, SemanticInput, SemanticPolicy, SemanticVerdict } from "./types";

/** p95 measured independently at 710–740 ms; past this, the regex engine decides. */
export const DEFAULT_JEV_TIMEOUT_MS = 1_500;

export interface SemanticOptions {
  /** How to reach Jev. Required for a request to be made; absent → `degraded("no-transport")`. */
  transport?: JevTransport;
  /** Which provider `transport` reaches, for the outcome and the verdict log. */
  via?: JevProviderKind;
  timeoutMs?: number;
  /**
   * Aborts the request from outside — the two-tier handler does this the
   * moment a hard regex deny makes Jev's answer irrelevant. An abort comes
   * back as `degraded("aborted")`, never as a timeout.
   */
  signal?: AbortSignal;
  model?: string;
  policies?: ReadonlyArray<SemanticPolicy>;
  thresholds?: Thresholds;
  /** How "did the human ask for this?" is asked; see {@link IntentMode}. Defaults to v0. */
  intent?: IntentMode;
  /** v1 only: decision options (thresholds, ablations). */
  v1?: DecideV1Options;
  /** v1 only: send `agent_last_message`. Defaults to true; false is an ablation. */
  includeAgentLastMessage?: boolean;
  /** v1 only: strip harness-written text from `user_said`. Defaults to true; false is an ablation. */
  cleanHarnessText?: boolean;
}

export interface PreparedCall {
  facts: Facts;
  selected: SemanticPolicy[];
  envelope: Envelope;
  compiled: CompiledRequest;
  intent: IntentMode;
  /** The human turns actually judged against (cleaned in v1). */
  userSaid: string[];
  /** The agent message actually sent (v1), or null. */
  agentLastMessage: string | null;
  /**
   * Jev is judging less than the whole picture: the envelope cut something
   * (`envelope.truncated`), OR a human message or agent message it carries was
   * already cut before it got here (see `contextCutUpstream`). This, not
   * `envelope.truncated`, is the outcome's `truncated`.
   */
  truncated: boolean;
}

/**
 * The mark a head-and-tail cap leaves where it cut: `capHeadTail`
 * (`envelope.ts`) writes it, and so does the intent store when it caps a
 * stored prompt or agent message (T4's `intent.ts` uses the same marker).
 */
const OMISSION_MARK = /\n…\[\d+ characters omitted\]…\n/;

/**
 * Whether a human message or the agent message in the envelope was cut
 * BEFORE the envelope saw it. The intent store caps what it keeps to fit
 * inside the envelope's own limit, marker included, precisely so the envelope
 * does not cut it a second time — which also means the envelope cannot tell
 * it was cut, and `envelope.truncated` stays false. §4 falls back on a
 * truncated envelope whatever was cut (a clear resting on half of what the
 * human typed is not a clear), so the mark itself is what counts. Only what
 * is actually sent is looked at: `user_said` (cleaned, the last few) and
 * `agent_last_message`.
 */
function contextCutUpstream(state: Record<string, unknown>): boolean {
  const said = Array.isArray(state.user_said) ? state.user_said : [];
  return [...said, state.agent_last_message].some((m) => typeof m === "string" && OMISSION_MARK.test(m));
}

export type SemanticOutcome =
  | {
      status: "ok";
      verdict: SemanticVerdict;
      answers: Record<string, number>;
      latencyMs: number;
      inputTokens: number | null;
      questionCount: number;
      truncated: boolean;
      redactions: number;
      model: string;
      /** False when the provider did not say which Jev version answered. */
      modelVerified: boolean;
      /** Which route answered; `none` when no policy applied and nothing was sent. */
      via: JevProviderKind | "none";
    }
  | {
      status: "degraded";
      reason: string;
      latencyMs: number;
      questionCount: number;
      truncated: boolean;
    };

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Everything that happens locally before the network: facts, policy selection, envelope, request. */
export function prepareSemantic(input: SemanticInput, opts: SemanticOptions = {}): PreparedCall {
  const command = input.toolInput.command;
  const scanned = typeof command === "string" ? scanCommand(command) : null;
  const facts = computeFacts(input.toolName, input.toolInput, input.cwd ?? null, input.permissionMode ?? null, scanned);
  const selected = selectPolicies(opts.policies ?? SEMANTIC_POLICIES, facts);
  const intent = opts.intent ?? "v0";
  const userSaid = intent === "v1" && opts.cleanHarnessText !== false ? cleanUserSaid(input.userSaid) : input.userSaid;
  const agentLastMessage =
    intent === "v1" && opts.includeAgentLastMessage !== false && typeof input.agentLastMessage === "string"
      ? input.agentLastMessage
      : null;
  const envelope = buildEnvelope(input.toolInput, userSaid, facts, scanned, { agentLastMessage });
  const model = opts.model ?? (process.env.FAILPROOFAI_JEV_MODEL || DEFAULT_JEV_MODEL);
  const compiled = compileRequest(selected, envelope.state, userSaid, model, intent);
  const truncated = envelope.truncated || contextCutUpstream(envelope.state);
  return { facts, selected, envelope, compiled, intent, userSaid, agentLastMessage, truncated };
}

export async function evaluateSemantic(input: SemanticInput, opts: SemanticOptions = {}): Promise<SemanticOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let prepared: PreparedCall;
  try {
    prepared = prepareSemantic(input, opts);
  } catch (err) {
    return { status: "degraded", reason: `prepare: ${err instanceof Error ? err.message : String(err)}`, latencyMs: elapsed(), questionCount: 0, truncated: false };
  }
  const { selected, envelope, compiled, truncated } = prepared;
  const questionCount = Object.keys(compiled.request.questions).length;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const judge = (answers: Record<string, number>): SemanticVerdict =>
    prepared.intent === "v1"
      ? decideV1(selected, answers, input.toolInput, prepared.userSaid, prepared.agentLastMessage, opts.v1)
      : decide(selected, answers, input.toolInput, prepared.userSaid, thresholds);

  // Nothing applies (an inert tool, or every precondition false): the answer
  // is allow and no request is made.
  if (questionCount === 0) {
    return {
      status: "ok",
      verdict: judge({}),
      answers: {},
      latencyMs: elapsed(),
      inputTokens: null,
      questionCount: 0,
      truncated,
      redactions: envelope.redactions,
      model: compiled.request.model,
      modelVerified: true,
      via: "none",
    };
  }

  const degraded = (reason: string): SemanticOutcome => ({
    status: "degraded",
    reason,
    latencyMs: elapsed(),
    questionCount,
    truncated,
  });

  if (JSON.stringify(compiled.request).length > MAX_REQUEST_CHARS) return degraded("request-too-large");

  const transport = opts.transport;
  if (!transport) return degraded("no-transport");
  const via: JevProviderKind = opts.via ?? "custom";
  if (opts.signal?.aborted) return degraded("aborted");

  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? envNumber("FAILPROOFAI_JEV_TIMEOUT_MS", DEFAULT_JEV_TIMEOUT_MS));
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const response = await transport(compiled.request, signal);
    const answers = readAnswers(compiled.request, response);
    return {
      status: "ok",
      verdict: judge(answers),
      answers,
      latencyMs: elapsed(),
      inputTokens: typeof response.usage?.input_tokens === "number" ? response.usage.input_tokens : null,
      questionCount,
      truncated,
      redactions: envelope.redactions,
      model: response.model,
      modelVerified: response.modelUnverified !== true,
      via,
    };
  } catch (err) {
    // Checked first: a transport that surfaces the abort as its own timeout
    // error must still read as the caller's abort, not as Jev being slow.
    if (opts.signal?.aborted) return degraded("aborted");
    if (err instanceof JevError) return degraded(err.code);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return degraded("timeout");
    return degraded(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Verdict log ──────────────────────────────────────────────────────────────

const VERDICT_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const verdictLogFile = (): string => resolve(semanticDir(), "verdicts.jsonl");

function inputPreview(toolInput: Record<string, unknown>): string {
  const primary =
    ["command", "file_path", "path", "url", "query", "pattern"].map((k) => toolInput[k]).find((v) => typeof v === "string") ??
    JSON.stringify(toolInput);
  return redactSecrets(String(primary).slice(0, 240)).text;
}

export interface VerdictLogMeta {
  sessionId?: string;
  cli?: string;
  eventType: string;
  /**
   * What the handler did with the outcome: combined it with the regex results
   * (`two-tier`), logged it while enforcing the regex result (`shadow`), or
   * kept the regex result because Jev was unavailable or the envelope it
   * judged was truncated (`legacy-fallback`).
   */
  applied: "two-tier" | "shadow" | "legacy-fallback";
}

export function verdictLogRow(input: SemanticInput, outcome: SemanticOutcome, meta: VerdictLogMeta): Record<string, unknown> {
  const base = {
    ts: Date.now(),
    sessionId: meta.sessionId ?? null,
    cli: meta.cli ?? null,
    eventType: meta.eventType,
    tool: input.toolName,
    inputDigest: createHash("sha256").update(JSON.stringify(input.toolInput)).digest("hex").slice(0, 16),
    inputPreview: inputPreview(input.toolInput),
    userSaidCount: input.userSaid.length,
    applied: meta.applied,
    latencyMs: outcome.latencyMs,
    questionCount: outcome.questionCount,
    truncated: outcome.truncated,
  };
  if (outcome.status === "degraded") return { ...base, status: "degraded", reason: outcome.reason };
  return {
    ...base,
    status: "ok",
    model: outcome.model,
    decision: outcome.verdict.decision,
    reason: outcome.verdict.reason,
    outcomes: outcome.verdict.outcomes.filter((o) => o.verdict !== "none"),
    answers: outcome.answers,
    inputTokens: outcome.inputTokens,
    redactions: outcome.redactions,
    via: outcome.via,
    modelVerified: outcome.modelVerified,
  };
}

/** Append one row. Never throws: a full disk must not change a verdict. */
export function appendVerdictLog(row: Record<string, unknown>): void {
  try {
    const file = verdictLogFile();
    mkdirSync(semanticDir(), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > VERDICT_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No file yet.
    }
    appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {
    // Logging is best-effort by design.
  }
}
