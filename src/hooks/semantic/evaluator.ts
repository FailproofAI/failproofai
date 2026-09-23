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
import { MAX_USER_MESSAGE_CHARS, buildEnvelope, redactSecrets, type Envelope } from "./envelope";
import { computeFacts, scanCommand } from "./facts";
import { cleanUserSaid } from "./intent";
import { JevError, readAnswers, type JevTransport } from "./jev-client";
import type { JevProviderKind } from "./jev-config";
import { SEMANTIC_POLICIES } from "./policies";
import type { Facts, IntentMode, SemanticInput, SemanticPolicy, SemanticVerdict } from "./types";

/**
 * How long a Jev call may take before the regex engine decides alone.
 *
 * 3000 ms, from 1,449 answered Cloudflare calls over five separate sessions:
 * 1,187 labelled-corpus and 202 intent-set replays through the real handler,
 * plus 60 live calls measured for this decision. Pooled p50 508 ms, p90
 * 1425 ms, p95 1692 ms, p99 2370 ms, max 3624 ms. Latency does not track
 * request size or question count (p50 is flat from 2 to 24 questions), so the
 * tail is provider-side jitter, not something a caller can shrink.
 *
 * The old 1500 ms came from a sandbox reading of p95 210 ms that no longer
 * reproduces — today's p50 alone is ~500 ms. At 1500 ms, 8.4% of answered
 * calls pooled, and 43% of the cold-process calls in the worst session, were
 * aborted and quietly downgraded to the regex verdict: the timeout was a
 * routine event rather than a failure, and on a fresh install Jev was
 * effectively off. At 3000 ms it is 0.28% — about 1 call in 360 — and no
 * measured session is above 1.0%.
 *
 * THE TRADEOFF. This runs inside a PreToolUse hook, so the budget is a direct
 * tax on every tool call — but only on the calls the provider does not answer
 * in time. The typical cost is the p50 (~500 ms) and does not move with the
 * budget; what doubles is the worst case, 1.5 s to 3.0 s per tool call. There
 * is no circuit breaker, so a provider that accepts a connection and then
 * stalls charges the full budget on every call until the user lowers
 * `timeoutMs` or removes the config. We take that ceiling because the failure
 * it replaces is worse and invisible: a budget under the provider's real
 * latency does not just slow the hook down, it silently returns the weaker
 * regex verdict for roughly 1 call in 12 and lets the same event be enforced
 * two different ways on two runs.
 *
 * 3000 ms is where the tail flattens: 2500 → 3000 recovers 9 calls per 1,449,
 * 3000 → 4000 only 4 more. Past it the budget buys almost nothing and the
 * worst case keeps growing.
 *
 * NO SEPARATE COLD-START BUDGET, deliberately. Measured in pairs — call 1
 * against call 2 in the same fresh process, same second, n=30 — the cold
 * connection setup costs a median of +180 ms (mean +266 ms). That is an order
 * of magnitude below the provider jitter both share (warm p50 617 ms to p95
 * 1964 ms), so a cold-only budget would be tuning the small term. It would
 * also not reach the path that needs it: without the daemon each hook is its
 * own process, so every call is a cold call and a first-call exemption is
 * just this default under another name, while with the daemon the worker
 * lives for hours and the exemption would buy one verdict per worker. And a
 * second budget is a second way for one event to be enforced two ways
 * depending on how old the process happens to be.
 *
 * Per-machine override: `timeoutMs` in the Jev config file, or
 * `FAILPROOFAI_JEV_TIMEOUT_MS`. Bounds: `MIN_JEV_TIMEOUT_MS` /
 * `MAX_JEV_TIMEOUT_MS` (100 ms – 10 s).
 */
export const DEFAULT_JEV_TIMEOUT_MS = 3_000;

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
   * The human turns the envelope CARRIES — `envelope.evidence`, which is the
   * window Jev was shown with its text uncut. See {@link Envelope.evidence}
   * for why it is neither the full list handed in nor the capped strings.
   */
  userSaid: string[];
  /** The agent message the envelope carries (v1), or null. Same rule. */
  agentLastMessage: string | null;
  /**
   * Something did not fit: the envelope cut it (`envelope.truncated`), or a
   * human or agent message it carries had already been cut before it got here
   * (`opts.contextTruncated`, or failing that `intentStoreCut`).
   *
   * Informational. It is recorded, and it changes no verdict — a prompt or a
   * pasted stack trace over the per-message cap is ordinary work. The flag
   * that does change something is {@link requestCut}.
   */
  truncated: boolean;
  /**
   * Part of what the CALL DOES was not shown to Jev (`envelope.requestCut`):
   * the tool input did not fit `MAX_AGENT_REQUEST_CHARS`, a redaction
   * swallowed a span of it that could have been executable, or a computed fact
   * about it was dropped.
   *
   * Jev is still asked with whatever fitted and its deny or instruct still
   * counts; what it may not do is CLEAR a reviewable policy. See
   * `envelope.ts`'s header and `combine.ts`.
   *
   * A cut the intent store made is NOT one of these: what it cuts is what the
   * human typed, not the call.
   */
  requestCut: boolean;
  /**
   * The compiled request does not fit `MAX_REQUEST_CHARS`.
   *
   * The state is bounded by `MAX_STATE_CHARS` however the call was shaped, so
   * this is reachable only if OUR OWN question set overruns the budget — a
   * policy-set problem, not something a caller can provoke. It is NOT a
   * refusal and not a degrade: the request is still sent (the provider's own
   * error is the honest answer if it really is too big), and it counts as a
   * cut, so nothing can be cleared on it. Pinned by
   * `__tests__/hooks/semantic/envelope-budget.test.ts`.
   */
  oversized: boolean;
  /**
   * A human turn in the window arrived already cut (T4's store caps what it
   * keeps). Read ONLY by the deciders' local target check, which it makes
   * inconclusive rather than negative. See {@link humanTurnCut}.
   */
  userSaidCut: boolean;
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
 * `envelope.truncated` stays false.
 *
 * What it feeds is `truncated`, which is RECORDED and changes no verdict. It
 * used to withdraw every clear, and that made the length of the human's own
 * prompt the difference between an allow and a deny on identical work: a
 * pasted spec or stack trace over 1,200 characters is routine, and the store
 * keeps a capped prompt for hours, so the clearing half of the tier stayed off
 * for the rest of the session.
 *
 * The mark alone is NOT the test, and that is what the length is for.
 * `agent_last_message` is written by the agent, which repeats text from files,
 * web pages and command output that a third party controls, so a message that
 * merely quotes the mark — an excerpt of one of our own capped prompts, say —
 * should not read as a cut. A message the store actually cut also FILLS the
 * cap; a quoted mark in ordinary prose does not. Only what is actually sent is
 * looked at: `user_said` (cleaned, the last few) and `agent_last_message`.
 */
function storeCut(message: unknown): boolean {
  return typeof message === "string" && message.length >= MAX_USER_MESSAGE_CHARS - STORE_CUT_SLACK && OMISSION_MARK.test(message);
}

function intentStoreCut(state: Record<string, unknown>): boolean {
  const said = Array.isArray(state.user_said) ? state.user_said : [];
  return [...said, state.agent_last_message].some(storeCut);
}

/**
 * The same guess, over the HUMAN channel only — and it feeds something that
 * does change a verdict, so the narrowing is the point.
 *
 * `decide` / `decideV1` run one check of their own that the model does not:
 * when a call names an identifiable target, one of those targets has to appear
 * in what the human typed before an `op-requested` answer may clear the
 * policy. Run over a prompt the store CUT, that check reads a head and a tail
 * and calls a target named in the middle absent — so a 12,000-character prompt
 * asking for exactly this file came out `instruct` + every clear withdrawn,
 * where the same sentence on its own came out `allow`. The length of the
 * human's own paste decided the verdict, which is what the design forbids.
 *
 * So a cut prompt makes that local check INCONCLUSIVE rather than negative:
 * the same answer the deciders already give when a call names no identifiable
 * target at all, where the model's own `op_requested` / `scope` answers carry
 * the override. It can only ever restore a clear a short prompt would have
 * had; it never adds one where the human's words are whole.
 *
 * The AGENT's message is deliberately NOT in here, and `opts.contextTruncated`
 * deliberately not consulted: the agent writes its own channel and chooses its
 * own length, so letting a cut there relax a local check would hand it the
 * switch. The human's turns are read from a channel the agent cannot write.
 */
function humanTurnCut(turns: ReadonlyArray<string>): boolean {
  return turns.some(storeCut);
}

export type SemanticOutcome =
  | {
      status: "ok";
      verdict: SemanticVerdict;
      answers: Record<string, number>;
      latencyMs: number;
      inputTokens: number | null;
      questionCount: number;
      /** Something did not fit. Recorded; changes no verdict. See {@link PreparedCall.truncated}. */
      truncated: boolean;
      /** Part of what the call DOES was not shown to Jev, so it may clear nothing. */
      requestCut: boolean;
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
      requestCut: boolean;
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
  const cleaned = intent === "v1" && opts.cleanHarnessText !== false ? cleanUserSaid(input.userSaid) : input.userSaid;
  const agentLastMessage =
    intent === "v1" && opts.includeAgentLastMessage !== false && typeof input.agentLastMessage === "string"
      ? input.agentLastMessage
      : null;
  const model = opts.model ?? (process.env.FAILPROOFAI_JEV_MODEL || DEFAULT_JEV_MODEL);

  // One build, no "try again smaller": `buildEnvelope` spends a fixed budget
  // (`MAX_STATE_CHARS`) as it goes, so the state's size is a function of the
  // caps and never of what the agent sent. A call cannot come out too big.
  const envelope = buildEnvelope(input.toolInput, cleaned, facts, scanned, { agentLastMessage });
  const compiled = compileRequest(selected, envelope.state, envelope.evidence.userSaid, model, intent);

  // Nothing is sent when no question applies, so an inert call is not measured.
  // This is also the one place the budget is CHECKED rather than asserted: the
  // accounting in `envelope.ts` is supposed to make it impossible to exceed,
  // and a claim like that belongs in the code that can still notice it is
  // wrong. Being wrong costs the call its clears; it never costs it a verdict.
  const chars = Object.keys(compiled.request.questions).length > 0 ? JSON.stringify(compiled.request).length : 0;
  const oversized = chars > MAX_REQUEST_CHARS;

  const truncated = envelope.truncated || (opts.contextTruncated ?? intentStoreCut(envelope.state));
  return {
    facts,
    selected,
    envelope,
    compiled,
    intent,
    userSaid: envelope.evidence.userSaid,
    agentLastMessage: envelope.evidence.agentLastMessage,
    truncated: truncated || oversized,
    requestCut: envelope.requestCut || oversized,
    oversized,
    userSaidCut: humanTurnCut(envelope.evidence.userSaid),
  };
}

export async function evaluateSemantic(input: SemanticInput, opts: SemanticOptions = {}): Promise<SemanticOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let prepared: PreparedCall;
  try {
    prepared = prepareSemantic(input, opts);
  } catch (err) {
    // `buildEnvelope` never throws, whatever the caller's input looks like —
    // that is rule 4 there, because a `prepare:` degrade is a verdict thrown
    // away on the shape of the tool input. This stays as a floor under the
    // code around it (`scanCommand`, `computeFacts`, the policy set), never as
    // the plan for an exotic payload.
    return {
      status: "degraded",
      reason: `prepare: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: elapsed(),
      questionCount: 0,
      truncated: false,
      requestCut: false,
    };
  }
  const { selected, envelope, compiled, truncated, requestCut } = prepared;
  const questionCount = Object.keys(compiled.request.questions).length;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const judge = (answers: Record<string, number>): SemanticVerdict =>
    prepared.intent === "v1"
      ? decideV1(selected, answers, input.toolInput, prepared.userSaid, prepared.agentLastMessage, {
          ...opts.v1,
          userSaidCut: prepared.userSaidCut,
        })
      : decide(selected, answers, input.toolInput, prepared.userSaid, thresholds, prepared.userSaidCut);

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
      requestCut,
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
    requestCut,
  });

  // Size is NOT a reason to refuse to ask. An oversized or truncated call used
  // to come back `degraded("request-too-large")`, which `toReview` maps to a
  // `fallback` — Jev's verdict discarded, the regex tier's floor (allow, in
  // the case this tier exists for) applied. That made "make the request big"
  // an off switch, and the size that triggered it was reachable from ordinary
  // work. So the request goes out with whatever fitted: what did not fit is
  // already recorded as `requestCut`, which stops any clear, and a request the
  // provider genuinely cannot accept degrades on its own error, honestly.
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
      requestCut,
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

/**
 * `JSON.stringify` on a caller-shaped value, which can throw: a bigint, a
 * cycle, a getter that raises, or nesting deep enough for a RangeError. The
 * verdict log runs INSIDE the promise chain that produces the review, so a
 * throw here would turn an answered call into `kind: "fallback"` — Jev's
 * verdict discarded because of the shape of the tool input, which is the
 * padding attack in one more spelling. Logging is best-effort; a verdict is not.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserialisable>";
  }
}

function inputPreview(toolInput: Record<string, unknown>): string {
  const primary =
    ["command", "file_path", "path", "url", "query", "pattern"].map((k) => toolInput[k]).find((v) => typeof v === "string") ??
    safeStringify(toolInput);
  // The narrow rules only (`blunt` is opt-in, and this is not the envelope).
  // This preview goes to `~/.failproofai/semantic/verdicts.jsonl` on this
  // machine and nowhere else — it is what an operator reads to see what the
  // agent tried. With the blunt rules on, every command that merely NAMED a
  // credential came back cut off at the name: `bun test -t "sends
  // authorization: Bearer when configured"` logged as `… authorization:
  // <redacted:authorization header>`. A secret that is actually in the command
  // is still removed by the shared floor, the vendor prefixes and the
  // secret-named assignment and flag rules.
  return redactSecrets(String(primary).slice(0, 240), { blunt: false }).text;
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
    inputDigest: createHash("sha256").update(safeStringify(input.toolInput)).digest("hex").slice(0, 16),
    inputPreview: inputPreview(input.toolInput),
    userSaidCount: input.userSaid.length,
    applied: meta.applied,
    latencyMs: outcome.latencyMs,
    questionCount: outcome.questionCount,
    truncated: outcome.truncated,
    requestCut: outcome.requestCut,
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
