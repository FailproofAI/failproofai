/**
 * The Vercel AI SDK (`ai`), majors 4 through 7.
 *
 * ## The mapping
 *
 * Python's rule (`sdk/python/skill/references/frameworks.md`): a construct is
 * an agent if and only if it owns an LLM decision loop and has its own goal.
 * In the AI SDK that is exactly one thing — a top-level operation.
 *
 * | AI SDK                                                   | FailproofAI                                   |
 * |----------------------------------------------------------|-----------------------------------------------|
 * | `generateText` / `streamText` / `generateObject` / `streamObject` / `embed` / `embedMany` call | `agent_start` / `agent_end`; `agent_id` = `functionId`, else the operation name (`ai.generateText`) — never a call or span id |
 * | a model step (one provider call; a tool loop makes several) | `model_request` / `model_response`, paired on `request_id` |
 * | a tool execution                                         | `tool_use` / `tool_result`, with the MODEL's own `toolCallId` |
 * | an operation inside `failproofai.agent()` / a tool       | nested: `parent_id` = the enclosing agent     |
 * | a bare `wrapModel` call with no enclosing agent           | its own run: `agent_start` named after the model, the model pair, `agent_end` |
 *
 * `model_response` always carries integer `input_tokens` / `output_tokens`, a
 * STRING `stop_reason`, the model id and an integer `duration_ms`. Every major
 * spells those differently — v4 `promptTokens`, v5 `inputTokens: 11`, v6+
 * `inputTokens: { total: 11 }`; a finish reason is `"stop"` up to v5 and
 * `{ unified: "stop", raw }` from v6 — and every spelling is read here.
 *
 * **A failure is recorded once, where it happened.** A model that throws closes
 * its `model_response` with `error` and `stop_reason: "error"`; a tool that
 * throws closes its `tool_result` with `error`. The enclosing agent then ends
 * `failed` WITHOUT a separate `error` event — one is emitted only when the
 * failure happened at the operation itself (schema validation, say) and no
 * leaf carried it. v5+ hands a tool failure back to the model as a tool-error
 * result and the loop carries on, so there the agent ends `success`: it
 * recovered. v4 throws it out of `generateText`, so there it ends `failed`.
 *
 * ## Where it attaches
 *
 * The AI SDK's surface is module-level functions exported from an ES module,
 * whose namespace is immutable by specification — there is nothing to patch.
 * So this adapter uses the extension points the SDK itself documents:
 *
 * * **v4–v6: an OpenTelemetry `Tracer`.** The SDK opens a span per operation
 *   (`ai.generateText`), per model step (`ai.generateText.doGenerate`) and per
 *   tool (`ai.toolCall`) on whatever tracer `experimental_telemetry.tracer`
 *   names, else on the global one. `FailproofTracer` implements just enough of
 *   the OTel `Tracer` interface to translate those spans — structurally, with
 *   no dependency on `@opentelemetry/api`.
 * * **v7: a `Telemetry` integration.** v7 removed the `tracer` option and the
 *   OpenTelemetry dependency and replaced them with lifecycle callbacks
 *   (`onStart`, `onLanguageModelCallStart`/`End`, `onToolExecutionStart`/`End`,
 *   `onEnd`, `onError`, …) passed per call in `telemetry.integrations` or
 *   registered process-wide on `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`
 *   (which is all `registerTelemetry()` does). `integration` below is one.
 *
 * `telemetry()` returns BOTH — `{ isEnabled, functionId, tracer, integrations }`
 * — so one call site works on every major: v4–v6 read `tracer`, v7 reads
 * `integrations`. v6 also knows `integrations` (an earlier, smaller interface),
 * but its events carry no `callId`, and the integration ignores any event
 * without one, so v6 is recorded by the tracer alone and never twice.
 *
 * `instrument("ai")` registers both process-wide: the integration on the
 * global list (v7 then records EVERY call — its telemetry is on by default
 * once an integration is registered) and, for v4–v6, the tracer as the global
 * OpenTelemetry tracer provider — but only when none is registered yet, so it
 * never takes over a customer's own tracing. v4–v6 only consult the global
 * tracer for calls that pass `experimental_telemetry: { isEnabled: true }`;
 * that is the SDK's rule, not ours.
 *
 * * **`middleware()` / `wrapModel()`** see model calls only — tools run above
 *   the model layer. Combined with `telemetry()` or `instrument()` they defer,
 *   so each call is recorded once: the tracer marks a model span's callback,
 *   and the integration its `executeLanguageModelCall`, with an
 *   `AsyncLocalStorage` flag the middleware checks.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { current as currentIdentity } from "../context.js";
import { logger } from "../logger.js";
import { resolveEsm, resolveFrom, tryRequire } from "../node-require.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "ai";
const PACKAGE = "ai";

let tracker: core.RunTracker | null = null;

/**
 * Set while the tracer or the integration is recording a MODEL call, so
 * `middleware()` knows this call is already covered and stays quiet. Scoped to
 * the model call, not the whole operation: a wrapped model called from inside
 * a tool is a different call and must still be recorded.
 */
const recordingModelCall = new AsyncLocalStorage<true>();

function ensureTracker(options: Record<string, unknown> = {}): core.RunTracker {
  tracker ??= new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGE),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  });
  return tracker;
}

// ---------------------------------------------------------------------------
// Reading every major's spelling
// ---------------------------------------------------------------------------

function asInt(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** `11` (v5, v7's normalised usage) or `{ total: 11, … }` (v6+ provider usage). */
function tokenCount(value: unknown): number | undefined {
  if (typeof value === "object" && value !== null) return asInt((value as { total?: unknown }).total);
  return asInt(value);
}

/** Input/output tokens from any major's usage object. */
export function usageTokens(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (typeof usage !== "object" || usage === null) return {};
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: tokenCount(u.inputTokens ?? u.promptTokens ?? u.tokens),
    outputTokens: tokenCount(u.outputTokens ?? u.completionTokens),
  };
}

/**
 * A finish reason as a string. v6 made it `{ unified, raw }`; the column is a
 * string, and an object there is unfilterable.
 */
export function stopReasonOf(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) return stopReasonOf(value[0]);
  if (typeof value === "object" && value !== null) {
    const v = value as { unified?: unknown; type?: unknown; raw?: unknown };
    return stopReasonOf(v.unified ?? v.type ?? v.raw);
  }
  return undefined;
}

/** Attribute values arrive as JSON strings; a non-JSON string is itself. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/** `""` is not content: a tool-call step has empty text and a real answer elsewhere. */
function nonEmpty(value: unknown): unknown {
  if (value === "" || value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

function toolCallOf(part: Record<string, unknown>): Record<string, unknown> {
  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: parseMaybeJson(part.input ?? part.args),
  };
}

/**
 * What the model said: its text, or — for a step that only called tools — the
 * calls. Reads v4's `{ text, toolCalls }` and v5+'s `content: [parts]`.
 */
export function responseContent(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as { content?: unknown; text?: unknown; toolCalls?: unknown };
  if (Array.isArray(r.content)) {
    const parts = r.content as Array<Record<string, unknown>>;
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    if (text) return text;
    const calls = parts.filter((p) => p.type === "tool-call").map(toolCallOf);
    return calls.length > 0 ? calls : undefined;
  }
  const text = nonEmpty(r.text);
  if (text !== undefined) return text;
  if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
    return (r.toolCalls as Array<Record<string, unknown>>).map(toolCallOf);
  }
  return undefined;
}

function errorOf(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message, stack: error.stack };
  }
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    const e = error as { name?: unknown; message: string; stack?: unknown };
    return {
      type: typeof e.name === "string" && e.name ? e.name : "Error",
      message: e.message,
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  return { type: typeof error, message: String(error) };
}

const errorText = (error: unknown): string => {
  const detail = errorOf(error);
  return `${detail.type}: ${detail.message}`;
};

/** An operation's default agent name — stable, low-cardinality, never an id. */
function agentName(functionId: unknown, operation: unknown): string {
  if (typeof functionId === "string" && functionId) return functionId;
  return typeof operation === "string" && operation ? operation : "ai";
}

// ---------------------------------------------------------------------------
// v4–v6: the tracer
// ---------------------------------------------------------------------------

type Attributes = Record<string, unknown>;

/**
 * An OpenTelemetry attribute value. Spelled out rather than imported so the
 * public types check against `ai`'s own `TelemetrySettings.metadata` without
 * this package depending on `@opentelemetry/api`.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

/** The operations the SDK opens a ROOT span for. Each becomes an agent. */
const ROOT_OPERATIONS = new Set([
  "ai.generateText",
  "ai.streamText",
  "ai.generateObject",
  "ai.streamObject",
  "ai.embed",
  "ai.embedMany",
]);

/** The operations that ARE the model call. Each becomes a request/response pair. */
const MODEL_OPERATIONS = new Set([
  "ai.generateText.doGenerate",
  "ai.streamText.doStream",
  "ai.generateObject.doGenerate",
  "ai.streamObject.doStream",
  "ai.embed.doEmbed",
  "ai.embedMany.doEmbed",
]);

let spanCounter = 0;

/**
 * One OpenTelemetry span, translated as it opens and as it ends.
 *
 * The START events are emitted when the span OPENS, not when it ends: the SDK
 * sets a model span's prompt and a tool span's arguments as start attributes,
 * and in a stream the tool a model asked for runs while the model's span is
 * still open — emitting the request at end time put it after the tool it
 * caused.
 */
export class FailproofSpan {
  readonly attributes: Attributes = {};
  /** The ROOT span of this operation, where "a leaf already reported the failure" is kept. */
  readonly root: FailproofSpan | undefined;
  private spanName: string;
  private readonly id: string;
  private readonly parentId: string | undefined;
  private readonly started = Date.now();
  private ended = false;
  private failure: unknown = undefined;
  private leafFailed = false;

  constructor(spanName: string, parent: FailproofSpan | undefined, attributes: Attributes = {}) {
    this.spanName = spanName;
    spanCounter += 1;
    this.id = `ai-${String(spanCounter)}-${randomUUID().slice(0, 8)}`;
    this.parentId = parent?.spanId;
    Object.assign(this.attributes, attributes);
    this.root = ROOT_OPERATIONS.has(this.operation()) && !parent?.root ? this : parent?.root;
    core.callSafely(() => {
      this.open();
    }, [], `${NAME}.span.start`);
  }

  get spanId(): string {
    return this.id;
  }

  /** Whether this span is the model call itself. */
  get isModelCall(): boolean {
    return MODEL_OPERATIONS.has(this.operation());
  }

  private operation(): string {
    const id = this.attributes["ai.operationId"];
    return typeof id === "string" ? id : this.spanName;
  }

  private open(): void {
    const t = tracker;
    if (t === null) return;
    const a = this.attributes;
    const operation = this.operation();
    if (ROOT_OPERATIONS.has(operation)) {
      t.startAgent(this.id, {
        agentId: agentName(a["ai.telemetry.functionId"], operation),
        parentKey: this.parentId,
        ...core.fwFields({ operation }),
      });
      return;
    }
    if (MODEL_OPERATIONS.has(operation)) {
      const messages = parseMaybeJson(a["ai.prompt.messages"] ?? a["ai.prompt"]);
      const tools = Array.isArray(a["ai.prompt.tools"])
        ? (a["ai.prompt.tools"] as unknown[]).map(parseMaybeJson)
        : undefined;
      t.emit("modelRequest", this.id, {
        parentKey: this.parentId,
        model: this.model(),
        messages: Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : undefined,
        tools: tools as Array<Record<string, unknown>> | undefined,
        requestId: this.id,
        ...core.fwFields({
          provider: a["ai.model.provider"] ?? a["gen_ai.system"],
          operation,
          prompt: Array.isArray(messages) ? undefined : messages,
        }),
      });
    } else if (operation === "ai.toolCall") {
      const { toolName, toolCallId } = this.tool();
      t.emit("toolUse", this.id, {
        parentKey: this.parentId,
        toolName,
        toolCallId,
        input: parseMaybeJson(a["ai.toolCall.args"] ?? a["ai.toolCall.input"]) ?? undefined,
      });
    } else {
      // Any other span still has to lead its children to the agent above it.
      t.link(this.id, this.parentId);
    }
  }

  private model(): string | undefined {
    const a = this.attributes;
    const id = a["ai.model.id"] ?? a["gen_ai.request.model"] ?? a["ai.response.model"];
    return typeof id === "string" ? id : undefined;
  }

  private tool(): { toolName: string; toolCallId: string } {
    const a = this.attributes;
    return {
      toolName: typeof a["ai.toolCall.name"] === "string" ? a["ai.toolCall.name"] : "tool",
      toolCallId: typeof a["ai.toolCall.id"] === "string" ? a["ai.toolCall.id"] : this.id,
    };
  }

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(): this {
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: { code?: number; message?: string }): this {
    // OpenTelemetry's SpanStatusCode.ERROR is 2.
    if (status?.code === 2 && this.failure === undefined) {
      this.failure = new Error(status.message ?? "span reported an error status");
    }
    return this;
  }

  recordException(error: unknown): void {
    this.failure = error;
  }

  updateName(name: string): this {
    this.spanName = name;
    return this;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  spanContext(): { traceId: string; spanId: string; traceFlags: number } {
    return { traceId: this.id.padEnd(32, "0").slice(0, 32), spanId: this.id.slice(0, 16), traceFlags: 1 };
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const t = tracker;
    if (t === null) return;
    core.callSafely(() => {
      this.emitEnd(t);
    }, [], `${NAME}.span.end`);
  }

  private emitEnd(t: core.RunTracker): void {
    const a = this.attributes;
    const operation = this.operation();
    const failed = this.failure !== undefined;
    if (failed && this.root && this.root !== this) this.root.leafFailed = true;

    if (MODEL_OPERATIONS.has(operation)) {
      const toolCalls = parseMaybeJson(a["ai.response.toolCalls"]);
      t.emit("modelResponse", this.id, {
        parentKey: this.parentId,
        model: (typeof a["ai.response.model"] === "string" ? a["ai.response.model"] : undefined) ?? this.model(),
        stopReason: failed
          ? "error"
          : stopReasonOf(a["ai.response.finishReason"] ?? a["gen_ai.response.finish_reasons"]),
        inputTokens: asInt(
          a["ai.usage.inputTokens"] ?? a["ai.usage.promptTokens"] ?? a["ai.usage.tokens"] ?? a["gen_ai.usage.input_tokens"],
        ),
        outputTokens: asInt(
          a["ai.usage.outputTokens"] ?? a["ai.usage.completionTokens"] ?? a["gen_ai.usage.output_tokens"],
        ),
        content: failed
          ? undefined
          : (nonEmpty(a["ai.response.text"]) ?? nonEmpty(toolCalls) ?? parseMaybeJson(nonEmpty(a["ai.response.object"]))),
        role: "assistant",
        requestId: this.id,
        error: failed ? errorText(this.failure) : undefined,
        ...core.fwFields({
          duration_ms: core.ms(Date.now() - this.started),
          tool_calls: failed ? undefined : nonEmpty(toolCalls),
          response_id: a["ai.response.id"],
        }),
      });
      return;
    }
    if (operation === "ai.toolCall") {
      const { toolName, toolCallId } = this.tool();
      t.emit("toolResult", this.id, {
        parentKey: this.parentId,
        toolName,
        toolCallId,
        output: failed ? undefined : parseMaybeJson(a["ai.toolCall.result"] ?? a["ai.toolCall.output"]),
        error: failed ? errorText(this.failure) : undefined,
      });
      return;
    }
    if (ROOT_OPERATIONS.has(operation)) {
      // The failure is already on the model_response / tool_result that raised
      // it; a second `error` here would count it twice.
      if (failed && !this.leafFailed) {
        const detail = errorOf(this.failure);
        t.emit("error", this.id, { errorType: detail.type, message: detail.message, traceback: detail.stack });
      }
      t.endAgent(this.id, {
        outcome: failed ? "failed" : "success",
        ...core.fwFields({
          operation,
          duration_ms: core.ms(Date.now() - this.started),
          finish_reason: stopReasonOf(a["ai.response.finishReason"]),
        }),
      });
    }
  }
}

const activeSpan = new AsyncLocalStorage<FailproofSpan>();

type SpanCallback = (span: FailproofSpan) => unknown;
interface SpanOptions {
  attributes?: Attributes;
}

/**
 * Just enough of OpenTelemetry's `Tracer` for the AI SDK — structurally
 * assignable to it, which is what lets `experimental_telemetry.tracer` accept
 * it with no OpenTelemetry dependency in this package.
 *
 * `startActiveSpan` NEVER ends the span. That is OpenTelemetry's contract, and
 * the SDK relies on it: its stream spans are opened with `endWhenDone: false`
 * and ended by the SDK itself when the stream finishes. Ending on the
 * callback's promise closed a `streamText` span the moment the stream object
 * was returned, before a single token — and dropped half the events.
 */
export class FailproofTracer {
  startSpan(name: string, options?: SpanOptions): FailproofSpan {
    return new FailproofSpan(name, activeSpan.getStore(), options?.attributes ?? {});
  }

  startActiveSpan<F extends SpanCallback>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends SpanCallback>(name: string, options: SpanOptions, fn: F): ReturnType<F>;
  startActiveSpan<F extends SpanCallback>(name: string, options: SpanOptions, context: unknown, fn: F): ReturnType<F>;
  startActiveSpan(name: string, ...rest: unknown[]): unknown {
    const callback = rest[rest.length - 1] as SpanCallback;
    const options = (rest.length > 1 && typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as SpanOptions;
    const span = new FailproofSpan(name, activeSpan.getStore(), options.attributes ?? {});
    const run = (): unknown => callback(span);
    return activeSpan.run(span, () => (span.isModelCall ? recordingModelCall.run(true, run) : run()));
  }
}

/** What `telemetry()` returns: every major's telemetry settings at once. */
export interface AiTelemetry {
  isEnabled: true;
  functionId?: string;
  metadata?: Record<string, AttributeValue>;
  /** Read by ai v4–v6. */
  tracer: FailproofTracer;
  /** Read by ai v7. */
  integrations: AiTelemetryIntegration[];
}

/**
 * The value to hand the SDK's telemetry option, on any major:
 *
 *     const { text } = await generateText({
 *       model,
 *       prompt,
 *       experimental_telemetry: telemetry({ functionId: "answer-question" }),
 *     });
 *
 * `functionId` names the agent; without one it is named after the operation
 * (`ai.generateText`). Keep it low-cardinality — it lands in `agent_id`, the
 * primary dashboard facet.
 */
export function telemetry(
  options: { functionId?: string; metadata?: Record<string, AttributeValue> } = {},
): AiTelemetry {
  ensureTracker();
  return {
    isEnabled: true,
    ...(options.functionId === undefined ? {} : { functionId: options.functionId }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    tracer: new FailproofTracer(),
    integrations: [integration],
  };
}

/** The bare tracer, for `experimental_telemetry: { isEnabled: true, tracer }` (ai v4–v6). */
export function tracer(): FailproofTracer {
  ensureTracker();
  return new FailproofTracer();
}

// ---------------------------------------------------------------------------
// v7: the Telemetry integration
// ---------------------------------------------------------------------------

/**
 * The subset of ai v7's `Telemetry` interface this adapter implements.
 *
 * Parameters are `unknown` so the object is assignable to v7's `Telemetry` and
 * v6's `TelemetryIntegration` alike without naming either; every field is read
 * defensively below.
 */
export interface AiTelemetryIntegration {
  onStart: (event: unknown) => void;
  onLanguageModelCallStart: (event: unknown) => void;
  onLanguageModelCallEnd: (event: unknown) => void;
  onObjectStepStart: (event: unknown) => void;
  onObjectStepEnd: (event: unknown) => void;
  onEmbedStart: (event: unknown) => void;
  onEmbedEnd: (event: unknown) => void;
  onToolExecutionStart: (event: unknown) => void;
  onToolExecutionEnd: (event: unknown) => void;
  onEnd: (event: unknown) => void;
  onAbort: (event: unknown) => void;
  onError: (event: unknown) => void;
  executeLanguageModelCall: <T>(options: { execute: () => PromiseLike<T>; callId?: string }) => Promise<T>;
  executeTool: <T>(options: { execute: () => PromiseLike<T>; callId?: string }) => Promise<T>;
}

interface Call {
  callId: string;
  key: string;
  operation: string;
  /** Model calls started and not yet ended, oldest first — one at a time in practice. */
  pending: Array<{ id: string; started: number }>;
  sequence: number;
  /** A leaf already recorded the failure; the agent's end must not repeat it. */
  leafFailed: boolean;
}

const MAX_OPEN_CALLS = 10_000;
const calls = new Map<string, Call>();

/**
 * The agent a tool's `execute` runs under, so an operation started INSIDE a
 * tool — a sub-agent — nests under the operation that called the tool. v7
 * calls `executeTool` around exactly that function, which is the one place an
 * `AsyncLocalStorage` scope covers the nested call and nothing else.
 */
const enclosingCall = new AsyncLocalStorage<string>();

type Event7 = Record<string, unknown>;

/** v7 events carry `callId`; v6's do not, and are recorded by the tracer instead. */
function callOf(event: unknown): Call | undefined {
  const id = (event as Event7 | undefined)?.callId;
  return typeof id === "string" ? calls.get(id) : undefined;
}

function startModel(event: Event7, fields: Record<string, unknown>): void {
  const t = tracker;
  const call = callOf(event);
  if (t === null || call === undefined) return;
  call.sequence += 1;
  const id = `${call.key}:m${String(call.sequence)}`;
  call.pending.push({ id, started: Date.now() });
  t.emit("modelRequest", id, {
    parentKey: call.key,
    model: typeof event.modelId === "string" ? event.modelId : undefined,
    requestId: id,
    ...fields,
    ...core.fwFields({ provider: event.provider, operation: call.operation }),
  });
}

function endModel(event: Event7 | undefined, call: Call, fields: Record<string, unknown>): void {
  const t = tracker;
  const open = call.pending.shift();
  if (t === null || open === undefined) return;
  const performance = event?.performance as { responseTimeMs?: unknown } | undefined;
  t.emit("modelResponse", open.id, {
    parentKey: call.key,
    model: typeof event?.modelId === "string" ? event.modelId : undefined,
    role: "assistant",
    requestId: open.id,
    ...fields,
    ...core.fwFields({
      duration_ms: core.ms(asInt(performance?.responseTimeMs) ?? Date.now() - open.started),
      response_id: event?.responseId,
    }),
  });
}

/** Close the oldest open model call as failed. */
function failModel(call: Call, error: unknown): void {
  if (call.pending.length === 0) return;
  call.leafFailed = true;
  endModel(undefined, call, { stopReason: "error", error: errorText(error) });
}

function finishCall(call: Call, outcome: string, error?: unknown, fields: Record<string, unknown> = {}): void {
  const t = tracker;
  calls.delete(call.callId);
  if (t === null) return;
  while (call.pending.length > 0) {
    if (error === undefined) endModel(undefined, call, { stopReason: "incomplete" });
    else failModel(call, error);
  }
  if (error !== undefined && !call.leafFailed) {
    const detail = errorOf(error);
    t.emit("error", call.key, { errorType: detail.type, message: detail.message, traceback: detail.stack });
  }
  t.endAgent(call.key, { outcome, ...fields });
}

const safe = (site: string, fn: (event: Event7) => void) => (event: unknown): void => {
  if (typeof event !== "object" || event === null) return;
  core.callSafely(fn, [event], `${NAME}.${site}`);
};

/**
 * One shared, stateless-per-call object: per-call state is keyed by v7's
 * `callId`, so the same instance serves every call, the per-call
 * `integrations` list and the global one.
 */
export const integration: AiTelemetryIntegration = {
  onStart: safe("onStart", (event: Event7) => {
    const callId = event?.callId;
    if (typeof callId !== "string" || calls.has(callId)) return;
    // The integration is exported, so it can be registered by hand
    // (`registerTelemetry(integration)`) without telemetry() or instrument().
    const t = ensureTracker();
    while (calls.size >= MAX_OPEN_CALLS) {
      const oldest = calls.keys().next();
      if (oldest.done) break;
      calls.delete(oldest.value);
    }
    const operation = typeof event.operationId === "string" ? event.operationId : "ai";
    const key = `ai7:${callId}`;
    calls.set(callId, { callId, key, operation, pending: [], sequence: 0, leafFailed: false });
    t.startAgent(key, {
      agentId: agentName(event.functionId, operation),
      parentKey: enclosingCall.getStore(),
      ...core.fwFields({ operation, call_id: callId }),
    });
  }),

  onLanguageModelCallStart: safe("onLanguageModelCallStart", (event: Event7) => {
    startModel(event, {
      messages: Array.isArray(event.messages) ? (event.messages as Array<Record<string, unknown>>) : undefined,
      system: event.system,
      tools: Array.isArray(event.tools) ? (event.tools as Array<Record<string, unknown>>) : undefined,
    });
  }),

  onLanguageModelCallEnd: safe("onLanguageModelCallEnd", (event: Event7) => {
    const call = callOf(event);
    if (call === undefined) return;
    const content = responseContent(event);
    endModel(event, call, {
      stopReason: stopReasonOf(event.finishReason),
      ...usageTokens(event.usage),
      content,
      ...core.fwFields({ tool_calls: Array.isArray(content) ? content : undefined }),
    });
  }),

  onObjectStepStart: safe("onObjectStepStart", (event: Event7) => {
    startModel(event, {
      messages: Array.isArray(event.promptMessages) ? (event.promptMessages as Array<Record<string, unknown>>) : undefined,
    });
  }),

  onObjectStepEnd: safe("onObjectStepEnd", (event: Event7) => {
    const call = callOf(event);
    if (call === undefined) return;
    endModel(event, call, {
      stopReason: stopReasonOf(event.finishReason),
      ...usageTokens(event.usage),
      content: parseMaybeJson(nonEmpty(event.objectText)),
    });
  }),

  onEmbedStart: safe("onEmbedStart", (event: Event7) => {
    startModel(event, { ...core.fwFields({ values: Array.isArray(event.values) ? event.values.length : undefined }) });
  }),

  onEmbedEnd: safe("onEmbedEnd", (event: Event7) => {
    const call = callOf(event);
    if (call === undefined) return;
    endModel(event, call, { ...usageTokens(event.usage) });
  }),

  onToolExecutionStart: safe("onToolExecutionStart", (event: Event7) => {
    const t = tracker;
    const call = callOf(event);
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    if (t === null || call === undefined || !toolCall) return;
    const toolCallId = String(toolCall.toolCallId);
    t.emit("toolUse", `${call.key}:${toolCallId}`, {
      parentKey: call.key,
      toolName: typeof toolCall.toolName === "string" ? toolCall.toolName : "tool",
      toolCallId,
      input: parseMaybeJson(toolCall.input ?? toolCall.args) ?? undefined,
    });
  }),

  onToolExecutionEnd: safe("onToolExecutionEnd", (event: Event7) => {
    const t = tracker;
    const call = callOf(event);
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    if (t === null || call === undefined || !toolCall) return;
    const toolCallId = String(toolCall.toolCallId);
    const output = event.toolOutput as { type?: unknown; output?: unknown; error?: unknown } | undefined;
    const failed = output?.type === "tool-error";
    if (failed) call.leafFailed = true;
    t.emit("toolResult", `${call.key}:${toolCallId}`, {
      parentKey: call.key,
      toolName: typeof toolCall.toolName === "string" ? toolCall.toolName : "tool",
      toolCallId,
      output: failed ? undefined : output?.output,
      error: failed ? errorText(output?.error) : undefined,
    });
  }),

  onEnd: safe("onEnd", (event: Event7) => {
    const call = callOf(event);
    if (call === undefined) return;
    // streamObject reports a schema failure here rather than throwing.
    const failure = event.error;
    finishCall(call, failure === undefined ? "success" : "failed", failure, {
      ...core.fwFields({ operation: call.operation, finish_reason: stopReasonOf(event.finishReason) }),
    });
  }),

  onAbort: safe("onAbort", (event: Event7) => {
    const call = callOf(event);
    if (call !== undefined) finishCall(call, "cancelled");
  }),

  onError: safe("onError", (event: Event7) => {
    const call = callOf(event);
    if (call === undefined) return;
    failModel(call, event.error);
    finishCall(call, "failed", event.error, { ...core.fwFields({ operation: call.operation }) });
  }),

  async executeLanguageModelCall<T>(options: { execute: () => PromiseLike<T>; callId?: string }): Promise<T> {
    try {
      return await recordingModelCall.run(true, () => options.execute());
    } catch (error) {
      // A provider call that throws never reaches `onLanguageModelCallEnd`,
      // and a retried one starts again: close THIS attempt here, as failed.
      const call = callOf(options);
      if (call !== undefined) core.callSafely(failModel, [call, error], `${NAME}.executeLanguageModelCall`);
      throw error;
    }
  },

  async executeTool<T>(options: { execute: () => PromiseLike<T>; callId?: string }): Promise<T> {
    const key = callOf(options)?.key;
    return key === undefined ? await options.execute() : await enclosingCall.run(key, () => options.execute());
  },
};

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

interface ModelLike {
  modelId?: string;
  provider?: string;
}

/**
 * A language-model middleware, typed structurally so it is assignable to
 * `LanguageModelV1Middleware` (ai 4), `V2` (ai 5), `V3` (ai 6) and v7's
 * `LanguageModelMiddleware` without naming any of them. The result type is a
 * type parameter: whatever the model's `doGenerate` resolves to is what comes
 * back.
 */
export interface AiMiddleware {
  /**
   * ai 6 requires the literal `"v3"`; ai 4, 5 and 7 do not look at it. The
   * wrapping behaviour is identical across the four specifications.
   */
  readonly specificationVersion: "v3";
  wrapGenerate<R>(options: { doGenerate: () => PromiseLike<R>; params: unknown; model?: unknown }): Promise<R>;
  wrapStream<R>(options: { doStream: () => PromiseLike<R>; params: unknown; model?: unknown }): Promise<R>;
}

/** Where a middleware-observed call's events go: an enclosing agent, or a run of its own. */
interface Placement {
  requestId: string;
  run: string | null;
}

/**
 * Open the model call. With an enclosing `failproofai.agent()` the call is one
 * step of that agent; without one it is its own run — `agent_start` named after
 * the model — the same answer the LangChain adapter gives a bare chat-model
 * call. Dropping it (no session) or pinning it to a phantom `main` agent with
 * no `agent_start` were the two previous answers, and both lost it.
 */
function openModelCall(t: core.RunTracker, params: Record<string, unknown>, model: ModelLike | undefined, streaming: boolean): Placement {
  const requestId = randomUUID();
  let run: string | null = null;
  if (currentIdentity().agentId === null) {
    run = `ai-model:${requestId}`;
    t.startAgent(run, {
      agentId: typeof model?.modelId === "string" && model.modelId ? model.modelId : "model",
      ...core.fwFields({ provider: model?.provider }),
    });
  }
  const prompt = params.prompt;
  t.emit("modelRequest", requestId, {
    parentKey: run ?? undefined,
    model: model?.modelId,
    messages: Array.isArray(prompt) ? (prompt as Array<Record<string, unknown>>) : undefined,
    tools: Array.isArray(params.tools) ? (params.tools as Array<Record<string, unknown>>) : undefined,
    requestId,
    ...core.fwFields({ provider: model?.provider, streaming: streaming || undefined }),
  });
  return { requestId, run };
}

function closeModelCall(
  t: core.RunTracker,
  placement: Placement,
  model: ModelLike | undefined,
  started: number,
  fields: Record<string, unknown>,
): void {
  const failed = fields.error !== undefined;
  t.emit("modelResponse", placement.requestId, {
    parentKey: placement.run ?? undefined,
    model: model?.modelId,
    role: "assistant",
    requestId: placement.requestId,
    ...fields,
    ...core.fwFields({ duration_ms: core.ms(Date.now() - started) }),
  });
  if (placement.run !== null) t.endAgent(placement.run, { outcome: failed ? "failed" : "success" });
}

/**
 * A language-model middleware that records `model_request` / `model_response`.
 *
 *     const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: middleware() });
 *
 * Defers when `telemetry()` / `instrument()` is already recording the call, so
 * combining them records each model call once.
 */
export function middleware(options: Record<string, unknown> = {}): AiMiddleware {
  const t = ensureTracker(options);

  const record = async <R>(
    params: unknown,
    rawModel: unknown,
    run: () => PromiseLike<R>,
    streaming: boolean,
  ): Promise<R> => {
    if (recordingModelCall.getStore()) return await run();
    const model = (typeof rawModel === "object" && rawModel !== null ? rawModel : undefined) as ModelLike | undefined;
    const started = Date.now();
    const placement = core.callSafely(
      openModelCall,
      [t, (params ?? {}) as Record<string, unknown>, model, streaming],
      `${NAME}.middleware.request`,
    );
    if (placement === undefined) return await run();

    let result: R;
    try {
      result = await run();
    } catch (error) {
      core.callSafely(
        closeModelCall,
        [t, placement, model, started, { stopReason: "error", error: errorText(error) }],
        `${NAME}.middleware.error`,
      );
      throw error;
    }

    if (streaming) return instrumentStream(t, result, placement, model, started);
    core.callSafely(
      closeModelCall,
      [
        t,
        placement,
        model,
        started,
        {
          stopReason: stopReasonOf((result as { finishReason?: unknown }).finishReason),
          ...usageTokens((result as { usage?: unknown }).usage),
          content: responseContent(result),
        },
      ],
      `${NAME}.middleware.response`,
    );
    return result;
  };

  return {
    specificationVersion: "v3",
    wrapGenerate: ({ doGenerate, params, model }) => record(params, model, doGenerate, false),
    wrapStream: ({ doStream, params, model }) => record(params, model, doStream, true),
  };
}

/**
 * Tee a model stream so the response event carries what was actually produced.
 *
 * A stream's usage and finish reason only exist in its FINAL part, so emitting
 * at `doStream` return time would record every streaming call with no tokens
 * and no finish reason — the fields the dashboard's cost and failure views are
 * built on. The transform passes every chunk through untouched and emits once,
 * when the stream closes.
 */
function instrumentStream<R>(
  t: core.RunTracker,
  result: R,
  placement: Placement,
  model: ModelLike | undefined,
  started: number,
): R {
  const value = result as { stream?: ReadableStream<unknown> };
  if (!value?.stream || typeof TransformStream !== "function") {
    core.callSafely(closeModelCall, [t, placement, model, started, {}], `${NAME}.middleware.stream`);
    return result;
  }

  let text = "";
  let finishReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let failure: unknown = undefined;
  const toolCalls: Array<Record<string, unknown>> = [];

  const transform = new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      try {
        const part = chunk as Record<string, unknown>;
        if (part.type === "text-delta" || part.type === "text") {
          // v5+ `delta`, v4 `textDelta`.
          const delta = part.delta ?? part.textDelta ?? part.text;
          if (typeof delta === "string") text += delta;
        } else if (part.type === "tool-call") {
          toolCalls.push(toolCallOf(part));
        } else if (part.type === "finish") {
          finishReason = stopReasonOf(part.finishReason);
          usage = usageTokens(part.usage);
        } else if (part.type === "error") {
          failure = part.error;
        }
      } catch {
        // A malformed part must not break the caller's stream.
      }
      controller.enqueue(chunk);
    },
    flush() {
      const fields: Record<string, unknown> =
        failure === undefined
          ? {
              stopReason: finishReason,
              ...usage,
              content: text || (toolCalls.length > 0 ? toolCalls : undefined),
              ...core.fwFields({ streaming: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }),
            }
          : { stopReason: "error", error: errorText(failure), ...usage };
      core.callSafely(closeModelCall, [t, placement, model, started, fields], `${NAME}.middleware.stream`);
    },
  });

  return { ...(result as object), stream: value.stream.pipeThrough(transform) } as R;
}

/**
 * Wrap a model so every call through it is recorded.
 *
 *     const model = await wrapModel(openai("gpt-4o"));
 *
 * Uses the SDK's own `wrapLanguageModel`, so the returned value is exactly
 * what the SDK expects.
 */
export async function wrapModel<T>(model: T, options: Record<string, unknown> = {}): Promise<T> {
  const sdk = (await compat.requireModule("ai", "npm install ai")) as {
    wrapLanguageModel?: (arg: { model: T; middleware: unknown }) => T;
    experimental_wrapLanguageModel?: (arg: { model: T; middleware: unknown }) => T;
  };
  const wrap = sdk.wrapLanguageModel ?? sdk.experimental_wrapLanguageModel;
  if (typeof wrap !== "function") {
    throw new Error(
      "this version of `ai` does not export wrapLanguageModel; pass " +
        "`experimental_telemetry: failproofai.ai.telemetry()` instead.",
    );
  }
  return wrap({ model, middleware: middleware(options) });
}

/**
 * Wrap one tool's `execute` so its call and result are recorded.
 *
 * Only needed when you are NOT using `telemetry()` — the SDK reports every
 * tool it runs, which already becomes a `tool_use`/`tool_result` pair.
 */
export function wrapTool<T extends { execute?: (...args: never[]) => unknown }>(
  toolName: string,
  tool: T,
): T {
  const execute = tool.execute;
  if (typeof execute !== "function") return tool;
  const t = ensureTracker();

  const wrapped = core.wrapCallable(
    execute,
    {
      before: (input: unknown, meta: unknown) => {
        const toolCallId =
          (meta as { toolCallId?: string } | undefined)?.toolCallId ?? randomUUID();
        t.emit("toolUse", toolCallId, {
          toolName,
          toolCallId,
          input: (input) ?? undefined,
        });
        return toolCallId;
      },
      after: (ctx, output) => {
        t.emit("toolResult", ctx, { toolName, toolCallId: String(ctx), output });
      },
      onError: (ctx, error) => {
        t.emit("toolResult", ctx, {
          toolName,
          toolCallId: String(ctx),
          error: errorText(error),
        });
      },
    },
    NAME,
  );
  return { ...tool, execute: wrapped };
}

/** `wrapTool` across a `{ name: tool }` record, as `generateText({ tools })` takes. */
export function wrapTools<T extends Record<string, { execute?: (...args: never[]) => unknown }>>(
  tools: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) out[name] = wrapTool(name, tool);
  return out as T;
}

// ---------------------------------------------------------------------------
// instrument("ai")
// ---------------------------------------------------------------------------

/** The global v7 reads; `registerTelemetry()` only ever pushes onto it. */
const GLOBAL_INTEGRATIONS = "AI_SDK_TELEMETRY_INTEGRATIONS";

function globalIntegrations(): unknown[] | undefined {
  const value = (globalThis as Record<string, unknown>)[GLOBAL_INTEGRATIONS];
  return Array.isArray(value) ? value : undefined;
}

function registerIntegration(): void {
  const list = globalIntegrations();
  if (list === undefined) {
    (globalThis as Record<string, unknown>)[GLOBAL_INTEGRATIONS] = [integration];
  } else if (!list.includes(integration)) {
    list.push(integration);
  }
}

function unregisterIntegration(): void {
  const list = globalIntegrations();
  if (list === undefined) return;
  const index = list.indexOf(integration);
  if (index !== -1) list.splice(index, 1);
}

interface OtelApi {
  trace: {
    setGlobalTracerProvider(provider: unknown): boolean;
    getTracerProvider(): unknown;
    disable(): void;
  };
  ProxyTracerProvider?: new () => { getDelegate(): unknown };
}

const provider = { getTracer: (): FailproofTracer => sharedTracer };
const sharedTracer = new FailproofTracer();
let registeredWith: OtelApi | null = null;

/**
 * `@opentelemetry/api` as the AI SDK sees it: resolved from `ai`'s own
 * location first — under pnpm the application cannot see a transitive
 * dependency, and the global registry is shared between copies anyway — then
 * from the application.
 */
function loadOtel(): OtelApi | null {
  for (const anchor of [resolveFrom(PACKAGE), resolveEsm(PACKAGE)]) {
    if (anchor === null) continue;
    try {
      return createRequire(anchor)("@opentelemetry/api") as OtelApi;
    } catch {
      // Not beside `ai` (v7 dropped the dependency); try the next anchor.
    }
  }
  return tryRequire<OtelApi>("@opentelemetry/api");
}

/**
 * Register our tracer as the process-wide OpenTelemetry tracer (ai v4–v6).
 *
 * Only when no provider is registered yet: taking over a customer's own
 * tracing is the opposite of what an observability library should do to
 * somebody else's observability. `getTracerProvider()` ALWAYS returns the
 * API's proxy, so the question is asked of the proxy's DELEGATE — a no-op
 * provider until somebody registers one.
 */
function registerGlobalTracer(): "registered" | "absent" | "taken" {
  const api = loadOtel();
  if (api === null || typeof api.trace?.setGlobalTracerProvider !== "function") return "absent";
  const current = api.trace.getTracerProvider() as { getDelegate?: () => unknown } | undefined;
  const delegate = typeof current?.getDelegate === "function" ? current.getDelegate() : current;
  if (delegate === provider) {
    registeredWith = api;
    return "registered";
  }
  const noop = api.ProxyTracerProvider ? (new api.ProxyTracerProvider().getDelegate() as object) : undefined;
  if (noop !== undefined && (delegate as object | undefined)?.constructor !== noop.constructor) return "taken";
  if (!api.trace.setGlobalTracerProvider(provider)) return "taken";
  registeredWith = api;
  return "registered";
}

export const adapter: Adapter = {
  name: NAME,

  install(options: Record<string, unknown> = {}): void {
    compat.checkVersion(NAME, PACKAGE, {
      minimum: "4.0.0",
      below: "8.0.0",
      reason: "the tracer spans, telemetry integration and middleware below are the v4–v7 shapes",
    });
    ensureTracker(options);

    // v7: harmless on older majors, whose events carry no callId.
    registerIntegration();

    const major = compat.versionTuple(PACKAGE)?.[0];
    if (major !== undefined && major >= 7) return;
    const outcome = registerGlobalTracer();
    if (outcome === "registered" || major === undefined) return;
    compat.warn(
      (outcome === "taken"
        ? "an OpenTelemetry tracer provider is already registered, so the `ai` adapter left it alone. "
        : "`@opentelemetry/api` is not importable, so the `ai` adapter cannot register a global tracer. ") +
        "Add telemetry at the call site —\n" +
        "  experimental_telemetry: failproofai.ai.telemetry()\n" +
        "or wrap the model once —\n" +
        "  const model = await failproofai.ai.wrapModel(openai('gpt-4o'))",
      `${NAME}:global-tracer`,
    );
  },

  uninstall(): void {
    unregisterIntegration();
    if (registeredWith !== null) {
      try {
        registeredWith.trace.disable();
      } catch (error) {
        logger.debug(`could not unregister the OpenTelemetry tracer provider: ${String(error)}`);
      }
      registeredWith = null;
    }
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
    calls.clear();
  },
};
