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
import {
  DEFAULT_ENVELOPE_LIMITS,
  MAX_USER_MESSAGE_CHARS,
  buildEnvelope,
  redactSecrets,
  type Envelope,
  type EnvelopeLimits,
} from "./envelope";
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
  /**
   * The human turns or the agent message handed in were already cut before
   * they got here — the intent store caps what it keeps, and caps it to fit
   * inside the envelope's own limit, so the envelope cannot see that cut
   * (see {@link intentStoreCut}).
   *
   * This is metadata from the store, deliberately out of band: the messages
   * themselves are agent-authored (and repeat file and tool-output text a
   * third party controls), so a cut read out of their text would be an off
   * switch for the semantic tier that a repo file could pull. A store that
   * reports it here is believed exactly; `undefined` (a store that does not)
   * leaves `intentStoreCut`'s narrower guess.
   */
  contextTruncated?: boolean;
}

export interface PreparedCall {
  facts: Facts;
  selected: SemanticPolicy[];
  envelope: Envelope;
  compiled: CompiledRequest;
  intent: IntentMode;
  /**
   * The human turns Jev was actually shown — read back out of the envelope,
   * NOT the list handed in.
   *
   * `decide` / `decideV1` do not only read Jev's answers: `targetNamedByUser`
   * is a LOCAL check, run here, and an `op-requested` override needs it to
   * hold before a fired policy becomes `overridden` — which `toReview` reports
   * as a clear. Taking that check off the full list while the envelope sent
   * only `slice(-MAX_USER_MESSAGES)` let a turn Jev never saw supply the
   * consent: a deny flipped to allow on evidence nothing judged, and
   * `truncated` stayed false, so the combine's one gate never saw it either.
   *
   * Reading it back from `envelope.state` closes that by construction — every
   * cap the envelope applies now applies to the local check too, including any
   * cap added later — and makes the clearing half rest on exactly the evidence
   * that was put to Jev, which is what `combine.ts` claims of a clear.
   */
  userSaid: string[];
  /** The agent message actually sent (v1), or null. Read back the same way. */
  agentLastMessage: string | null;
  /**
   * Jev is judging less than the whole picture: the envelope cut something
   * (`envelope.truncated`), the request had to be rebuilt smaller to fit
   * `MAX_REQUEST_CHARS`, OR a human message or agent message it carries was
   * already cut before it got here (`opts.contextTruncated`, or failing that
   * `intentStoreCut`). This, not `envelope.truncated`, is the outcome's
   * `truncated`.
   */
  truncated: boolean;
  /**
   * Even the smallest envelope did not fit `MAX_REQUEST_CHARS`, so nothing can
   * be sent. Only reachable when the QUESTIONS alone overrun the budget —
   * their text is ours, not the caller's — because every part of the state is
   * capped. `evaluateSemantic` degrades on it.
   */
  oversized: boolean;
}

/**
 * The mark a head-and-tail cap leaves where it cut: `capHeadTail`
 * (`envelope.ts`) writes it, and so does the intent store when it caps a
 * stored prompt or agent message (T4's `intent.ts` uses the same marker).
 */
const OMISSION_MARK = /\n…\[\d+ characters omitted\]…\n/;

/**
 * How far below the envelope's own per-message cap a message the intent store
 * cut can land. The store fits what it keeps INSIDE that cap, the mark
 * included (T4's `capWithin`), so what it stores ends within about one mark's
 * length of the cap; this is comfortably longer than the longest mark.
 */
const STORE_CUT_SLACK = 64;

/**
 * A guess — used only when the caller does not say
 * ({@link SemanticOptions.contextTruncated}) — at whether a human message or
 * the agent message in the envelope was cut BEFORE the envelope saw it. The
 * intent store caps what it keeps to fit inside the envelope's own limit,
 * marker included, precisely so the envelope does not cut it a second time —
 * which also means the envelope cannot tell it was cut, and
 * `envelope.truncated` stays false. §4 falls back on a truncated envelope
 * whatever was cut: a clear resting on half of what the human typed is not a
 * clear.
 *
 * The mark alone is NOT the test, and this is the whole point of the length.
 * `agent_last_message` is written by the agent, which repeats text from files,
 * web pages and command output that a third party controls, so a message that
 * merely quotes the mark — an excerpt of one of our own capped prompts, say —
 * would otherwise force this call onto the regex-only path and throw Jev's
 * verdict away, from nothing but repo content. A message the store actually
 * cut also FILLS the cap; a quoted mark in ordinary prose does not. Only what
 * is actually sent is looked at: `user_said` (cleaned, the last few) and
 * `agent_last_message`.
 */
function intentStoreCut(state: Record<string, unknown>): boolean {
  const said = Array.isArray(state.user_said) ? state.user_said : [];
  return [...said, state.agent_last_message].some(
    (m) => typeof m === "string" && m.length >= MAX_USER_MESSAGE_CHARS - STORE_CUT_SLACK && OMISSION_MARK.test(m),
  );
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

/**
 * Progressively smaller envelopes, tried in order when the compiled request
 * does not fit `MAX_REQUEST_CHARS`.
 *
 * An oversized request used to be `degraded("request-too-large")`, and a
 * degraded call is `kind: "fallback"` — no verdict, the regex result stands.
 * That made SIZE the last working spelling of the padding attack the
 * truncation rule was written to stop: one ignored extra key (a 70,000-char
 * `file_path` beside the command, which no policy reads) or enough nesting
 * (24 × 24 × 1,500 characters of `tool_input`, every individual string within
 * its cap) pushed a request past the budget, and Jev's deny went with it.
 *
 * Shrinking instead keeps the call on the rule this module already has: the
 * rebuild sets `truncated`, so Jev clears nothing — but Jev still answers, and
 * its own deny still reaches `combineTwoTier`. The head-and-tail cap means the
 * dangerous suffix survives every step.
 *
 * The tightest step bounds the state at roughly 4 × 4 × 200 characters of
 * input, 4 paths and 3 × 300 characters of human text — a few kB beside ~13 kB
 * of questions, against a 120,000-character budget.
 */
const SHRINK_STEPS: ReadonlyArray<EnvelopeLimits> = [
  { stringChars: 600, messageChars: 600, keys: 8 },
  { stringChars: 200, messageChars: 300, keys: 4 },
];

/**
 * What the envelope actually carries, read back out of it — the only evidence
 * a local check in `decide` / `decideV1` may look at. See
 * {@link PreparedCall.userSaid}.
 */
function evidenceSent(envelope: Envelope): { userSaid: string[]; agentLastMessage: string | null } {
  const said = envelope.state.user_said;
  const agent = envelope.state.agent_last_message;
  return {
    userSaid: Array.isArray(said) ? said.filter((m): m is string => typeof m === "string") : [],
    agentLastMessage: typeof agent === "string" ? agent : null,
  };
}

/** Everything that happens locally before the network: facts, policy selection, envelope, request. */
export function prepareSemantic(input: SemanticInput, opts: SemanticOptions = {}): PreparedCall {
  const command = input.toolInput.command;
  const scanned = typeof command === "string" ? scanCommand(command) : null;
  const facts = computeFacts(input.toolName, input.toolInput, input.cwd ?? null, input.permissionMode ?? null, scanned);
  const selected = selectPolicies(opts.policies ?? SEMANTIC_POLICIES, facts);
  const intent = opts.intent ?? "v0";
  const cleaned = intent === "v1" && opts.cleanHarnessText !== false ? cleanUserSaid(input.userSaid) : input.userSaid;
  const agentLastMessage =
    intent === "v1" && opts.includeAgentLastMessage !== false && typeof input.agentLastMessage === "string"
      ? input.agentLastMessage
      : null;
  const model = opts.model ?? (process.env.FAILPROOFAI_JEV_MODEL || DEFAULT_JEV_MODEL);

  const build = (limits: EnvelopeLimits) => {
    const envelope = buildEnvelope(input.toolInput, cleaned, facts, scanned, { agentLastMessage, limits });
    const sent = evidenceSent(envelope);
    const compiled = compileRequest(selected, envelope.state, sent.userSaid, model, intent);
    return { envelope, sent, compiled };
  };

  let built = build(DEFAULT_ENVELOPE_LIMITS);
  let shrunk = false;
  let chars = 0;
  // Nothing is sent when no question applies, so an oversized inert call is
  // neither measured (the measurement is a full serialisation of whatever the
  // agent sent) nor rebuilt.
  if (Object.keys(built.compiled.request.questions).length > 0) {
    chars = JSON.stringify(built.compiled.request).length;
    for (const limits of SHRINK_STEPS) {
      if (chars <= MAX_REQUEST_CHARS) break;
      built = build(limits);
      shrunk = true;
      chars = JSON.stringify(built.compiled.request).length;
    }
  }

  const { envelope, sent, compiled } = built;
  // `shrunk` sits ahead of the store's word on purpose: a rebuild is a cut
  // this module made and can see, so `contextTruncated: false` cannot talk it
  // away the way it can talk away the mark-and-cap guess.
  const truncated = envelope.truncated || shrunk || (opts.contextTruncated ?? intentStoreCut(envelope.state));
  return {
    facts,
    selected,
    envelope,
    compiled,
    intent,
    userSaid: sent.userSaid,
    agentLastMessage: sent.agentLastMessage,
    truncated,
    oversized: chars > MAX_REQUEST_CHARS,
  };
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

  // Only when even the smallest envelope did not fit — `prepareSemantic`
  // rebuilds an oversized call instead of abandoning it, so this is no longer
  // reachable by padding the call (see `SHRINK_STEPS`).
  if (prepared.oversized) return degraded("request-too-large");

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
   * kept the regex result because Jev never answered (`legacy-fallback`).
   *
   * A TRUNCATED call is `two-tier`, not `legacy-fallback`: its clears were
   * withdrawn, but Jev's own verdict still joined the most-severe rule (see
   * `combine.ts`). `truncated` on the same row is what says the clearing half
   * was off for it; the activity row records `jev-fallback` / `truncated`.
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
