import * as context from "./context.js";
import { logger } from "./logger.js";
import {
  agentEndEvent,
  agentPauseEvent,
  agentResumeEvent,
  agentStartEvent,
  errorEvent,
  hookCompletedEvent,
  hookTriggeredEvent,
  humanInputEvent,
  humanInterruptEvent,
  humanPauseEvent,
  humanWaitEvent,
  modelRequestEvent,
  modelResponseEvent,
  toolResultEvent,
  toolUseEvent,
} from "./schema.js";
import type { EventWriter } from "./writer.js";
import { formatMicros, nowMicros } from "./clock.js";

/**
 * `sessionId` and `agentId` are named options on every method, so a caller
 * cannot pass them as extras. `timestamp` and `type` are not, so they would
 * land in the extras and are caught here — and `environment` with them, since
 * an extra of that name would overwrite the one the schema sets.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "timestamp",
  "session_id",
  "agent_id",
  "type",
  "environment",
]);

/**
 * Payload keys ingest lifts out of the JSON blob into unsigned 32-bit columns
 * via `pu32()`. Everything else is stored as-is and can be any shape, but these
 * three are read with a typed accessor that returns null on a mismatch — and a
 * null there is written as NULL under a 200 OK. Nothing is logged, nothing is
 * rejected, and the row still arrives, so the only symptom is a column that is
 * empty for some events and not others.
 *
 * `durationMs` is refused outright on the four events that MEASURE it. These
 * checks cover the other way in: any of the three passed as a custom field on
 * an event that does not name it, plus `modelResponse`'s own two options, which
 * are the ones a caller is most likely to fill straight from a provider's usage
 * object.
 */
const PROMOTED_NUMERIC: ReadonlySet<string> = new Set([
  "duration_ms",
  "input_tokens",
  "output_tokens",
]);

/**
 * Payload keys ingest lifts into an INDEXED STRING column via `ps()`, which
 * reads JSON strings and stores NULL for anything else — the same
 * silent-at-200 failure `PROMOTED_NUMERIC` guards. `undefined` is the realistic
 * way in: `toolName: tool?.name` is ordinary code, and it produces a row that
 * is invisible to every tool-name filter and whose `tool_result` never pairs.
 */
const PROMOTED_STRING: ReadonlySet<string> = new Set([
  "tool_name",
  "tool_call_id",
  "hook_name",
  "hook_id",
  "input_id",
  "pause_id",
  "error_type",
  "model",
]);

const U32_MAX = 2 ** 32 - 1;

/** A value for an error message, without rendering an object as `[object Object]`. */
function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

/**
 * Reject anything `pu32()` would silently turn into NULL.
 *
 * Rejecting rather than coercing, and at the boundary rather than in the
 * writer, for the same reason `validatedInterval` does: this is the last point
 * where the caller still has a stack trace pointing at their own call. A
 * non-integer is a mistake worth hearing about — the server drops it whole
 * rather than rounding it — and rounding it here would hide that from the one
 * person who could fix the source of it.
 */
export function validatePromotedNumeric(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(
      `${name} must be an integer (the server reads it as an unsigned 32-bit integer and ` +
        `stores NULL for anything else), got ${typeof value}: ${describe(value)}`,
    );
  }
  if (value < 0 || value > U32_MAX) {
    throw new RangeError(
      `${name} must be between 0 and ${U32_MAX} (an unsigned 32-bit integer), got ${value}`,
    );
  }
}

/**
 * Reject anything `ps()` would silently turn into NULL.
 *
 * Same reasoning and the same boundary. The schema copies the identity block
 * verbatim, so an absent value here would reach the wire as an explicit JSON
 * `null`, the row would be accepted at 200 OK, and the column would be empty
 * for some events and not others with nothing logged anywhere.
 *
 * Extras no longer reach this holding a nullish value: `validateFields` drops
 * the key and warns, so an optional column the caller simply does not have
 * costs a log line rather than the whole event. The throw below stays as the
 * backstop for the declared options.
 */
export function validatePromotedString(name: string, value: unknown): void {
  if (value === undefined || value === null) {
    throw new TypeError(
      `${name} must be a string (the server lifts it into an indexed column and stores NULL ` +
        `for anything else, so the event would be accepted at 200 OK and be invisible to ` +
        `every filter on ${name}), got ${value === null ? "null" : "undefined"}`,
    );
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `${name} must be a string (the server lifts it into an indexed column and stores NULL ` +
        `for anything else), got ${typeof value}`,
    );
  }
}

/**
 * Reject an id the server will skip, at the point the caller can see it.
 *
 * `session_id` and `agent_id` are on every one of the 15 event types and are
 * what everything downstream groups by. Ingest requires each to be a JSON
 * string: hand it anything else and the row is SKIPPED — and the response is
 * `200 OK` with `{"accepted": 0, "skipped": 1}`, so nothing upstream learns.
 * The SDK reports success, the collector deletes the batch, and the event is
 * gone. Verified against the live server for number, null and object.
 *
 * Empty and whitespace-only are refused as well, and those the server DOES
 * accept. That is the worse outcome of the two: every event lands, grouped
 * under one blank id, so the data looks present and is silently merged.
 */
function validateIdentity(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(
      `${name} must be a string — the server skips any event whose ${name} is not a JSON ` +
        `string, and answers 200 as though it stored it. Got ${value === null ? "null" : typeof value}`,
    );
  }
  if (value.trim() === "") {
    throw new Error(
      `${name} must not be empty — the server accepts it, so every event sent this way is ` +
        "silently grouped under one blank id.",
    );
  }
}

/**
 * Fill an omitted `sessionId`/`agentId` from the ambient scope, then validate.
 *
 * ORDER MATTERS. The validation runs on the RESOLVED value, not the argument.
 * Validating first would reject every ambient call; resolving without
 * validating would put the silent-skip back: ingest drops an event whose
 * `session_id` is not a JSON string and answers `200 OK` with
 * `{"accepted":0,"skipped":1}`, so a run with nothing bound would vanish rather
 * than fail.
 *
 * Called AFTER `validateFields`, deliberately. A reserved extra is a fault in
 * the call itself and reads identically from anywhere, so reporting it first
 * gives a stable, reproducible message; the identity error depends on where the
 * call was made from, and is the less useful of the two to hear when both are
 * true.
 *
 * `agentId` falls back to `DEFAULT_AGENT_ID` rather than throwing — an event
 * emitted inside `session()` with no `agent()` around it lands somewhere
 * sensible. `sessionId` has no such default: inventing one would scatter a run
 * across as many sessions as it has emit sites.
 */
function resolveIdentity(
  sessionId: string | null | undefined,
  agentId: string | null | undefined,
): [string, string] {
  let sid: string | null | undefined = sessionId;
  let aid: string | null | undefined = agentId;
  if (sid === undefined || sid === null) sid = context.sessionId();
  if (aid === undefined || aid === null) aid = context.agentId();

  if (sid === undefined || sid === null) {
    throw new TypeError(
      "sessionId is required and nothing is bound. Pass sessionId, or wrap the call in " +
        "`await failproofai.session(fn)` / `await failproofai.agent('name', fn)`. A callback " +
        "stored in one run and invoked from another does not inherit the ambient scope — " +
        "hand it over with `failproofai.propagate(fn)`.",
    );
  }
  validateIdentity("sessionId", sid);
  validateIdentity("agentId", aid);
  return [sid, aid];
}

/**
 * Whole milliseconds between a paired start and end, or undefined.
 *
 * `pu32()` reads `duration_ms` as an unsigned 32-bit integer and stores NULL
 * for anything outside it, at `200 OK`, so an out-of-range duration is not an
 * error anywhere: the row lands with an empty column and nothing says why.
 *
 * Two ways to leave the range, both reachable without anything being wrong with
 * the caller:
 *
 * * **over.** 2**32 ms is ~49.7 days. A `humanWait` answered after a long
 *   weekend, or an `agentPause` resumed a month later, is an ordinary lifetime
 *   for these pairs, not an abuse of them.
 * * **under.** These are wall-clock readings, so an NTP step backwards between
 *   start and end yields a NEGATIVE interval, and a negative into an unsigned
 *   column is the same silent NULL.
 *
 * Omitted rather than clamped. A clamped 49.7 days is indistinguishable from a
 * measurement, and the whole reason `duration_ms` is computed here instead of
 * accepted from the caller is that a reported duration is unfalsifiable. An
 * absent field is at least honest, and the timestamps are still on both events
 * for anyone who wants to do the subtraction themselves.
 */
function measuredDurationMs(start: number | undefined, end: number): number | undefined {
  if (start === undefined) return undefined;
  const ms = Math.round((end - start) / 1000);
  if (ms < 0 || ms > U32_MAX) {
    logger.warn(
      `omitted duration_ms=${ms}: outside the unsigned 32-bit range the server stores it in ` +
        `(0..${U32_MAX}). The event is unaffected.`,
    );
    return undefined;
  }
  return ms;
}

/**
 * Hard cap on the correlation map. Orphaned starts (a `toolUse` with no
 * `toolResult`, a `humanWait` the user never answers) would otherwise grow it
 * unbounded in a long-running process. At the cap the oldest entry is evicted —
 * a `Map` preserves insertion order.
 */
const PENDING_CAP = 10_000;

/**
 * Every pairing is keyed by what it pairs and by the SESSION it belongs to —
 * and deliberately NOT by the agent.
 *
 * The rule: include what makes the id unique, exclude what can legitimately
 * change between the start event and the end event.
 *
 * * KIND belongs in the key. Tool pairs keyed on the bare `toolCallId` and hook
 *   pairs on the bare `hookId` would share one flat keyspace, so a caller whose
 *   tool call and hook happened to share an id — not exotic, both are
 *   frequently the harness's own step id — would get a `hook_completed` that
 *   consumed the `tool_use` timestamp, and then a `tool_result` with no
 *   duration at all.
 *
 * * SESSION belongs in the key. This map lives on one process-wide namespace,
 *   so two sessions in one process — a supervisor running agents concurrently,
 *   the ordinary multi-agent shape — would collide on any shared step id.
 *
 * * AGENT DOES NOT. This is the tempting third component and it is wrong. Once
 *   a framework runs tools inside sub-agents, a `tool_use` opened under
 *   `planner` and closed under `worker` is routine — LangGraph does it — and an
 *   agent-scoped key makes those pairs miss entirely, silently dropping
 *   `duration_ms` for exactly the nested runs that most need it. A session
 *   cannot change under a pair; an agent can.
 *
 * These are correlation keys only; they are never emitted and never leave the
 * process, so the shape changes no wire format.
 */
const toolKey = (sessionId: string, toolCallId: string): string =>
  `tool:${sessionId}:${toolCallId}`;
const hookKey = (sessionId: string, hookId: string): string => `hook:${sessionId}:${hookId}`;
const pauseKey = (sessionId: string, pauseId: string): string => `pause:${sessionId}:${pauseId}`;
const humanKey = (sessionId: string, inputId: string): string => `human:${sessionId}:${inputId}`;

export interface BaseEventOptions {
  sessionId?: string | null;
  agentId?: string | null;
  /**
   * Any other key is a custom payload field, merged verbatim onto the event —
   * the direct analogue of Python's `**fields`. Namespace anything
   * framework-specific `fw_*`; a name that collides with a declared field is
   * refused.
   */
  [field: string]: unknown;
}

export interface ToolUseOptions extends BaseEventOptions {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown> | null;
}

export interface ToolResultOptions extends BaseEventOptions {
  toolName: string;
  toolCallId: string;
  output?: unknown;
  error?: string | null;
}

export interface ModelRequestOptions extends BaseEventOptions {
  model?: string | null;
  messages?: Array<Record<string, unknown>> | null;
  system?: unknown;
  tools?: Array<Record<string, unknown>> | null;
  requestId?: string | null;
}

export interface ModelResponseOptions extends BaseEventOptions {
  model?: string | null;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  content?: unknown;
  role?: string | null;
  requestId?: string | null;
}

export interface AgentStartOptions extends BaseEventOptions {
  goal?: string | null;
  parentId?: string | null;
}

export interface AgentEndOptions extends BaseEventOptions {
  outcome?: string | null;
  summary?: string | null;
}

export interface AgentPauseOptions extends BaseEventOptions {
  pauseId: string;
  reason?: string | null;
  userId?: string | null;
}

export interface AgentResumeOptions extends BaseEventOptions {
  pauseId: string;
  reason?: string | null;
  userId?: string | null;
}

export interface HookTriggeredOptions extends BaseEventOptions {
  hookName: string;
  hookId: string;
  triggerEvent?: string | null;
  input?: unknown;
}

export interface HookCompletedOptions extends BaseEventOptions {
  hookName: string;
  hookId: string;
  outcome?: string | null;
  output?: unknown;
  error?: string | null;
}

export interface ErrorOptions extends BaseEventOptions {
  errorType: string;
  message: string;
  traceback?: string | null;
}

export interface HumanWaitOptions extends BaseEventOptions {
  inputId: string;
  prompt?: string | null;
  options?: string[] | null;
  reason?: string | null;
}

export interface HumanInputOptions extends BaseEventOptions {
  inputId: string;
  response?: string | null;
}

export interface HumanPauseOptions extends BaseEventOptions {
  reason?: string | null;
  userId?: string | null;
}

export interface HumanInterruptOptions extends BaseEventOptions {
  reason?: string | null;
  userId?: string | null;
  atStep?: string | null;
}

type Extras = Record<string, unknown>;

export class EventNamespace {
  private readonly writer: EventWriter;
  private readonly pending = new Map<string, number>();

  constructor(writer: EventWriter) {
    this.writer = writer;
  }

  private trackPending(key: string, ts: number): void {
    // No lock and no tolerance for a concurrent evictor, unlike the Python SDK:
    // JavaScript runs this on one thread, so `size` / `keys().next()` / `delete`
    // cannot interleave with another emit. The cap is exact here rather than
    // approximate.
    if (this.pending.size >= PENDING_CAP) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(key, ts);
  }

  private takePending(key: string): number | undefined {
    const value = this.pending.get(key);
    if (value !== undefined) this.pending.delete(key);
    return value;
  }

  private validateFields(fields: Extras): void {
    const bad = Object.keys(fields).filter((key) => RESERVED.has(key));
    if (bad.length > 0) {
      throw new Error(
        `Reserved field names cannot be used as custom fields: ${JSON.stringify(bad.sort())}`,
      );
    }
    // The schema merges extras verbatim, so a promoted key left nullish would
    // reach the wire as an explicit JSON null — accepted at 200 OK, stored as
    // NULL, invisible to every filter on that column. For a promoted column "no
    // value" has to mean "no key", so drop it here, the one place holding the
    // caller's own object. Warned rather than silent: passing a nullish value
    // is still a mistake worth hearing about, it just must not cost the event.
    for (const name of Object.keys(fields)) {
      if (!PROMOTED_NUMERIC.has(name) && !PROMOTED_STRING.has(name)) continue;
      if (fields[name] === undefined || fields[name] === null) {
        logger.warn(
          `${name} was passed as ${fields[name] === null ? "null" : "undefined"} and has been ` +
            "omitted from the event; pass a value, or omit the key entirely to silence this.",
        );
        delete fields[name];
      }
    }
    for (const name of Object.keys(fields)) {
      if (PROMOTED_NUMERIC.has(name)) validatePromotedNumeric(name, fields[name]);
      if (PROMOTED_STRING.has(name)) validatePromotedString(name, fields[name]);
    }
  }

  private refuseDuration(fields: Extras): void {
    if ("duration_ms" in fields || "durationMs" in fields) {
      throw new Error(
        "duration_ms is auto-computed by the SDK and cannot be passed by the caller",
      );
    }
  }

  /** Epoch microseconds, strictly increasing in the process — see `clock.ts`. */
  private now(): number {
    return nowMicros();
  }

  /**
   * `2026-09-23T12:34:56.123004Z` — six fractional digits, matching the Python
   * SDK's `%f` and the format the ingest endpoint parses. The last three are an
   * ordering sequence inside the millisecond, not a measurement (`clock.ts`).
   */
  private fmtTs(micros: number): string {
    return formatMicros(micros);
  }

  toolUse(options: ToolUseOptions): void {
    const { sessionId, agentId, toolName, toolCallId, input, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    this.trackPending(toolKey(sid, toolCallId), ts);
    this.writer.submit(
      toolUseEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        toolName,
        toolCallId,
        input,
        extraFields: fields,
      }),
    );
  }

  toolResult(options: ToolResultOptions): void {
    const { sessionId, agentId, toolName, toolCallId, output, error, ...fields } = options;
    this.refuseDuration(fields);
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    const durationMs = measuredDurationMs(this.takePending(toolKey(sid, toolCallId)), ts);
    this.writer.submit(
      toolResultEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        toolName,
        toolCallId,
        output,
        error,
        durationMs,
        extraFields: fields,
      }),
    );
  }

  modelRequest(options: ModelRequestOptions = {}): void {
    const { sessionId, agentId, model, messages, system, tools, requestId, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      modelRequestEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        model,
        messages,
        system,
        tools,
        requestId,
        extraFields: fields,
      }),
    );
  }

  modelResponse(options: ModelResponseOptions = {}): void {
    const {
      sessionId,
      agentId,
      model,
      stopReason,
      inputTokens,
      outputTokens,
      content,
      role,
      requestId,
      ...fields
    } = options;
    // Named options, so they never reach `validateFields`. They are also the
    // likeliest of the three to arrive wrong: a caller reading them off a
    // provider's usage object gets whatever that object holds.
    validatePromotedNumeric("inputTokens", inputTokens);
    validatePromotedNumeric("outputTokens", outputTokens);
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      modelResponseEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        model,
        stopReason,
        inputTokens,
        outputTokens,
        content,
        role,
        requestId,
        extraFields: fields,
      }),
    );
  }

  agentStart(options: AgentStartOptions = {}): void {
    const { sessionId, agentId, goal, parentId, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      agentStartEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        goal,
        parentId,
        extraFields: fields,
      }),
    );
  }

  agentEnd(options: AgentEndOptions = {}): void {
    const { sessionId, agentId, outcome, summary, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      agentEndEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        outcome,
        summary,
        extraFields: fields,
      }),
    );
  }

  agentPause(options: AgentPauseOptions): void {
    const { sessionId, agentId, pauseId, reason, userId, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    this.trackPending(pauseKey(sid, pauseId), ts);
    this.writer.submit(
      agentPauseEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        pauseId,
        reason,
        userId,
        extraFields: fields,
      }),
    );
  }

  agentResume(options: AgentResumeOptions): void {
    const { sessionId, agentId, pauseId, reason, userId, ...fields } = options;
    this.refuseDuration(fields);
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    const durationMs = measuredDurationMs(this.takePending(pauseKey(sid, pauseId)), ts);
    this.writer.submit(
      agentResumeEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        pauseId,
        durationMs,
        reason,
        userId,
        extraFields: fields,
      }),
    );
  }

  hookTriggered(options: HookTriggeredOptions): void {
    const { sessionId, agentId, hookName, hookId, triggerEvent, input, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    this.trackPending(hookKey(sid, hookId), ts);
    this.writer.submit(
      hookTriggeredEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        hookName,
        hookId,
        triggerEvent,
        input,
        extraFields: fields,
      }),
    );
  }

  hookCompleted(options: HookCompletedOptions): void {
    const { sessionId, agentId, hookName, hookId, outcome, output, error, ...fields } = options;
    this.refuseDuration(fields);
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    const durationMs = measuredDurationMs(this.takePending(hookKey(sid, hookId)), ts);
    this.writer.submit(
      hookCompletedEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        hookName,
        hookId,
        outcome,
        output,
        error,
        durationMs,
        extraFields: fields,
      }),
    );
  }

  error(options: ErrorOptions): void {
    const { sessionId, agentId, errorType, message, traceback, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      errorEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        errorType,
        message,
        traceback,
        extraFields: fields,
      }),
    );
  }

  humanWait(opts: HumanWaitOptions): void {
    const { sessionId, agentId, inputId, prompt, options, reason, ...fields } = opts;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    this.trackPending(humanKey(sid, inputId), ts);
    this.writer.submit(
      humanWaitEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        inputId,
        prompt,
        options,
        reason,
        extraFields: fields,
      }),
    );
  }

  humanInput(options: HumanInputOptions): void {
    const { sessionId, agentId, inputId, response, ...fields } = options;
    this.refuseDuration(fields);
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    const ts = this.now();
    const durationMs = measuredDurationMs(this.takePending(humanKey(sid, inputId)), ts);
    this.writer.submit(
      humanInputEvent({
        timestamp: this.fmtTs(ts),
        sessionId: sid,
        agentId: aid,
        inputId,
        response,
        durationMs,
        extraFields: fields,
      }),
    );
  }

  humanPause(options: HumanPauseOptions = {}): void {
    const { sessionId, agentId, reason, userId, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      humanPauseEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        reason,
        userId,
        extraFields: fields,
      }),
    );
  }

  humanInterrupt(options: HumanInterruptOptions = {}): void {
    const { sessionId, agentId, reason, userId, atStep, ...fields } = options;
    this.validateFields(fields);
    const [sid, aid] = resolveIdentity(sessionId, agentId);
    this.writer.submit(
      humanInterruptEvent({
        timestamp: this.fmtTs(this.now()),
        sessionId: sid,
        agentId: aid,
        reason,
        userId,
        atStep,
        extraFields: fields,
      }),
    );
  }
}

export { RESERVED, PROMOTED_NUMERIC, PROMOTED_STRING, U32_MAX, PENDING_CAP };
