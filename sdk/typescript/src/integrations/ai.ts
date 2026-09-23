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
 * | `generateText` / `streamText` / `generateObject` / `streamObject` call — including one made by an agent class (`Experimental_Agent`, `ToolLoopAgent`) | `agent_start` / `agent_end`; `agent_id` = `functionId`, else the operation name (`ai.generateText`) — never a call or span id. An agent class's own `id` is dropped by the SDK before telemetry sees it: set `functionId` in its telemetry settings |
 * | `embed` / `embedMany` with nothing enclosing it           | its own run, like a bare `wrapModel` call: `agent_start`, a model pair per provider call, `agent_end` |
 * | `embed` / `embedMany` inside `failproofai.agent()` or a tool | model pairs of the enclosing agent — no nested agent (it owns no decision loop) |
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
 * **A stream that does not finish ends `cancelled`.** An aborted stream closes
 * its open model call with `stop_reason: "cancelled"` on every major. A stream
 * whose reader goes away — a client disconnecting from a route that returns
 * `toUIMessageStreamResponse()`, a stream nobody reads, a v4–v6 provider
 * stream that breaks mid-way — is never ended by the SDK at all; on v4–v6 the
 * adapter closes it when its root span is garbage-collected (`fw_abandoned`).
 * v7 reports none of these to an integration and hands it nothing to watch,
 * so there the agent stays open (bounded by `MAX_OPEN_CALLS`) unless the call
 * passes an `abortSignal` — the request's own, in a route handler.
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
 * `instrument("ai")` registers the integration on v7's global list, so v7
 * records EVERY call (its telemetry is on by default once an integration is
 * registered). That list is additive and per-call `integrations` replace it,
 * so it takes nothing from anybody else.
 *
 * On v4–v6 `instrument("ai")` records nothing by itself, and says so once. The
 * process-wide hook there is the global OpenTelemetry tracer provider, a
 * single slot that OpenTelemetry refuses to hand over once taken: registering
 * ours would silently refuse the customer's own `NodeSDK.start()` later in
 * startup and route their http/database spans to a tracer that exports
 * nothing. So taking it is opt-in — `instrument("ai", { registerGlobalTracer:
 * true })`, for a process with no OpenTelemetry of its own — and even then
 * only when the slot is still empty. (v4–v6 consult the global tracer only for
 * calls that pass `experimental_telemetry: { isEnabled: true }`; that is the
 * SDK's rule, not ours.) The call-site `telemetry()` and `wrapModel()` are the
 * recommended paths on v4–v6.
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
 * A step's tool calls in the one shape every path emits —
 * `{ toolCallId, toolName, input }` with `input` parsed. The tracer reads them
 * from `ai.response.toolCalls`, which each major spells its own way: v4
 * `{ toolCallType, args: "<json>" }`, v5/v6 `generateText` `{ input: "<json>" }`,
 * v5/v6 `streamText` `{ type: "tool-call", input: {…} }`. Passed through, the
 * same call read three different ways on the dashboard, its input a JSON
 * string inside JSON.
 *
 * @internal Exported for the unit tests.
 */
export function toolCallsOf(value: unknown): Array<Record<string, unknown>> | undefined {
  const parsed = parseMaybeJson(value);
  if (!Array.isArray(parsed)) return undefined;
  const calls = parsed
    .filter((call): call is Record<string, unknown> => typeof call === "object" && call !== null)
    .map(toolCallOf);
  return calls.length > 0 ? calls : undefined;
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

/**
 * The embedding operations. An embedding call owns no decision loop, so it is
 * an agent only when nothing encloses it — a bare `embed()` in an indexing
 * script is its own run, the way a bare `wrapModel` call is. Inside an agent
 * (a `failproofai.agent()` scope, or a tool of a traced operation) it is a
 * model call of THAT agent: a nested `ai.embed` agent per retrieval drowned
 * the real agents in the `agent_id` facet.
 */
const EMBED_OPERATIONS = new Set(["ai.embed", "ai.embedMany"]);

/** Whether an operation starting now has an agent above it to belong to. */
const enclosedByAgent = (parentKey: unknown): boolean =>
  parentKey !== undefined || currentIdentity().agentId !== null;

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

/** A model or tool span still open: what closing it takes, held apart from the span. */
interface OpenLeaf {
  id: string;
  parentId: string | undefined;
  /** Set for a model call (its model id, possibly undefined); unset for a tool. */
  model?: { id: string | undefined };
  tool?: { toolName: string; toolCallId: string };
  started: number;
  closed: boolean;
}

/**
 * What an operation still owes the trace — its `agent_end` and the leaves
 * under it that never closed. Plain data, deliberately holding no span, so a
 * `FinalizationRegistry` can settle it once the root span itself is gone.
 */
interface Ledger {
  id: string;
  operation: string;
  started: number;
  tracker: core.RunTracker;
  /** False for an enclosed embedding operation, which opened no agent. */
  agent: boolean;
  leaves: Map<string, OpenLeaf>;
  done: boolean;
}

/** Close a leaf that will never end by itself, as cancelled. */
function closeLeaf(t: core.RunTracker, leaf: OpenLeaf): void {
  leaf.closed = true;
  if (leaf.model !== undefined) {
    t.emit("modelResponse", leaf.id, {
      parentKey: leaf.parentId,
      model: leaf.model.id,
      stopReason: "cancelled",
      role: "assistant",
      requestId: leaf.id,
      ...core.fwFields({ duration_ms: core.ms(Date.now() - leaf.started) }),
    });
  } else if (leaf.tool !== undefined) {
    t.emit("toolResult", leaf.id, {
      parentKey: leaf.parentId,
      ...leaf.tool,
      error: "cancelled: the operation ended before the tool returned",
    });
  }
  t.unlink(leaf.id);
}

/** Close every leaf still open under an operation; whether there were any. */
function settleLeaves(t: core.RunTracker, ledger: Ledger): boolean {
  const leaves = [...ledger.leaves.values()];
  ledger.leaves.clear();
  for (const leaf of leaves) closeLeaf(t, leaf);
  return leaves.length > 0;
}

/**
 * Operations whose root span was garbage-collected before anything ended it.
 *
 * The SDK ends a stream's root span from its result stream's `flush()`, and a
 * `TransformStream` never flushes when its reader cancels or its source
 * errors. So a client that disconnects from a route returning
 * `toUIMessageStreamResponse()`, a stream nobody reads, and (on v4) a provider
 * stream that breaks mid-way all leave the root span open forever — for the
 * SDK's own OpenTelemetry exporters as much as for this adapter — and the
 * agent reads as still running. Once nothing can reach the root span nothing
 * can end it either, so that is exactly when it is safe to say it never will:
 * the agent ends `cancelled`, marked `fw_abandoned`.
 */
const abandonedOperations =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<Ledger>((ledger) => {
        if (ledger.done) return;
        ledger.done = true;
        const t = tracker;
        // A tracker since replaced (uninstall, reinstall) no longer owns this run.
        if (t === null || t !== ledger.tracker) return;
        core.callSafely(
          () => {
            settleLeaves(t, ledger);
            if (ledger.agent) {
              t.endAgent(ledger.id, {
                outcome: "cancelled",
                ...core.fwFields({
                  operation: ledger.operation,
                  abandoned: true,
                  duration_ms: core.ms(Date.now() - ledger.started),
                }),
              });
            }
            t.unlink(ledger.id);
          },
          [],
          `${NAME}.span.abandoned`,
        );
      })
    : null;

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
  /** An enclosed embedding operation: its model calls belong to the agent above, it is no agent itself. */
  private passThrough = false;
  /**
   * On a root: what the operation still owes. The SDK does not end a model
   * span when a stream is aborted — only the root — so the root closes
   * whatever is left when it ends, and the ledger survives the span for the
   * case where nothing ends the root at all.
   */
  private ledger: Ledger | undefined;
  /** On a model or tool span: its entry in the root's ledger. */
  private leaf: OpenLeaf | undefined;

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
    core.callSafely(() => {
      this.track();
    }, [], `${NAME}.span.track`);
  }

  /** Enter this span in its operation's ledger (or, for a root, open one). */
  private track(): void {
    const t = tracker;
    if (t === null || this.root === undefined) return;
    if (this.root === this) {
      this.ledger = {
        id: this.id,
        operation: this.operation(),
        started: this.started,
        tracker: t,
        agent: !this.passThrough,
        leaves: new Map(),
        done: false,
      };
      abandonedOperations?.register(this, this.ledger, this.ledger);
    } else if (this.isLeaf && this.root.ledger !== undefined) {
      this.leaf = {
        id: this.id,
        parentId: this.parentId,
        ...(this.isModelCall ? { model: { id: this.model() } } : { tool: this.tool() }),
        started: this.started,
        closed: false,
      };
      this.root.ledger.leaves.set(this.id, this.leaf);
    }
  }

  /** A model or tool span: one that opens a request/tool pair it must close. */
  private get isLeaf(): boolean {
    return this.isModelCall || this.operation() === "ai.toolCall";
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
    if (EMBED_OPERATIONS.has(operation) && enclosedByAgent(this.parentId)) {
      this.passThrough = true;
      t.link(this.id, this.parentId);
      return;
    }
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
    if (this.leaf !== undefined) {
      // Closed as cancelled when its operation ended; a late end is not news.
      if (this.leaf.closed) return;
      this.root?.ledger?.leaves.delete(this.id);
    }
    if (this.ledger !== undefined) {
      this.ledger.done = true;
      abandonedOperations?.unregister(this.ledger);
    }
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
      const toolCalls = toolCallsOf(a["ai.response.toolCalls"]);
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
          : (nonEmpty(a["ai.response.text"]) ?? toolCalls ?? parseMaybeJson(nonEmpty(a["ai.response.object"]))),
        role: "assistant",
        requestId: this.id,
        error: failed ? errorText(this.failure) : undefined,
        ...core.fwFields({
          duration_ms: core.ms(Date.now() - this.started),
          tool_calls: failed ? undefined : toolCalls,
          response_id: a["ai.response.id"],
        }),
      });
    } else if (operation === "ai.toolCall") {
      const { toolName, toolCallId } = this.tool();
      t.emit("toolResult", this.id, {
        parentKey: this.parentId,
        toolName,
        toolCallId,
        output: failed ? undefined : parseMaybeJson(a["ai.toolCall.result"] ?? a["ai.toolCall.output"]),
        error: failed ? errorText(this.failure) : undefined,
      });
    } else if (ROOT_OPERATIONS.has(operation)) {
      const cutOff = this.ledger !== undefined && settleLeaves(t, this.ledger);
      // The failure is already on the model_response / tool_result that raised
      // it; a second `error` here would count it twice.
      if (failed && !this.leafFailed) {
        const detail = errorOf(this.failure);
        t.emit("error", this.id, {
          ...(this.passThrough ? { parentKey: this.parentId } : {}),
          errorType: detail.type,
          message: detail.message,
          traceback: detail.stack,
        });
      }
      if (!this.passThrough) {
        // An aborted stream ends its root with a model call still open and no
        // finish reason (v5/v6 end only the root; v4 the same when the
        // provider honours the signal). It did not succeed: it was cancelled.
        const finishReason = stopReasonOf(a["ai.response.finishReason"]);
        const cancelled = cutOff || (operation === "ai.streamText" && finishReason === undefined);
        t.endAgent(this.id, {
          outcome: failed ? "failed" : cancelled ? "cancelled" : "success",
          ...core.fwFields({
            operation,
            duration_ms: core.ms(Date.now() - this.started),
            finish_reason: finishReason,
          }),
        });
      }
    }
    // Every span kind leaves a parent link behind (`emit` with a `parentKey`,
    // `startAgent` under a parent, `link` for any other span). Its last event
    // is out, so forget it: a completed span's link kept forever is a leak,
    // and at the tracker's FIFO cap it evicts a LIVE run's links instead.
    t.unlink(this.id);
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
  pending: Array<{ id: string; started: number; model: string | undefined }>;
  /** Tool keys whose `tool_use` is out and whose `tool_result` is not. */
  tools: Set<string>;
  sequence: number;
  /** A leaf already recorded the failure; the agent's end must not repeat it. */
  leafFailed: boolean;
  /**
   * Whether this call is an agent. An embedding call inside one is not: its
   * model calls are recorded on the enclosing agent and it opens no run.
   */
  agent: boolean;
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
  call.pending.push({ id, started: Date.now(), model: typeof event.modelId === "string" ? event.modelId : undefined });
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
    // An aborted or failed call is closed with no end event: keep the model it started with.
    model: typeof event?.modelId === "string" ? event.modelId : open.model,
    role: "assistant",
    requestId: open.id,
    ...fields,
    ...core.fwFields({
      duration_ms: core.ms(asInt(performance?.responseTimeMs) ?? Date.now() - open.started),
      response_id: event?.responseId,
    }),
  });
  t.unlink(open.id);
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
    // An abort closes the model call it interrupted as cancelled, like the
    // middleware does; "incomplete" is left for an operation that ended with
    // a call the SDK never reported back.
    if (error === undefined) endModel(undefined, call, { stopReason: outcome === "cancelled" ? "cancelled" : "incomplete" });
    else failModel(call, error);
  }
  if (error !== undefined && !call.leafFailed) {
    const detail = errorOf(error);
    t.emit("error", call.key, { errorType: detail.type, message: detail.message, traceback: detail.stack });
  }
  if (call.agent) t.endAgent(call.key, { outcome, ...fields });
  // Forget every link this call left: its own (a nested call's), and any tool
  // the operation abandoned mid-run (an abort, an error).
  t.unlink(call.key);
  for (const key of call.tools) t.unlink(key);
  call.tools.clear();
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
    const parentKey = enclosingCall.getStore();
    const agent = !(EMBED_OPERATIONS.has(operation) && enclosedByAgent(parentKey));
    calls.set(callId, { callId, key, operation, pending: [], tools: new Set(), sequence: 0, leafFailed: false, agent });
    if (!agent) {
      t.link(key, parentKey);
      return;
    }
    t.startAgent(key, {
      agentId: agentName(event.functionId, operation),
      parentKey,
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
    call.tools.add(`${call.key}:${toolCallId}`);
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
    call.tools.delete(`${call.key}:${toolCallId}`);
    t.unlink(`${call.key}:${toolCallId}`);
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
  outcome: string = fields.error === undefined ? "success" : "failed",
): void {
  t.emit("modelResponse", placement.requestId, {
    parentKey: placement.run ?? undefined,
    model: model?.modelId,
    role: "assistant",
    requestId: placement.requestId,
    ...fields,
    ...core.fwFields({ duration_ms: core.ms(Date.now() - started) }),
  });
  t.unlink(placement.requestId);
  if (placement.run !== null) t.endAgent(placement.run, { outcome });
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
 * Observe a model stream so the response event carries what was actually produced.
 *
 * A stream's usage and finish reason only exist in its FINAL part, so emitting
 * at `doStream` return time would record every streaming call with no tokens
 * and no finish reason — the fields the dashboard's cost and failure views are
 * built on. Every chunk passes through untouched, and the model call closes
 * exactly once, however the stream stops:
 *
 * * it finishes — the response carries the text, tool calls, usage and finish
 *   reason read off the parts;
 * * the consumer cancels it (a client that disconnected, a `streamText` that
 *   was aborted) — `stop_reason: "cancelled"` with whatever had arrived, and a
 *   standalone run ends `cancelled`; the cancel is passed on to the provider's
 *   stream so its connection is released;
 * * it errors — `stop_reason: "error"` with the error, and a standalone run
 *   ends `failed`.
 *
 * `pipeThrough(new TransformStream())` saw only the first: a transformer's
 * `flush` never runs on a cancel or an error, so those calls stayed open
 * forever — no `model_response`, and no `agent_end` for a standalone run.
 */
function instrumentStream<R>(
  t: core.RunTracker,
  result: R,
  placement: Placement,
  model: ModelLike | undefined,
  started: number,
): R {
  const value = result as { stream?: ReadableStream<unknown> };
  if (typeof value?.stream?.getReader !== "function" || typeof ReadableStream !== "function") {
    core.callSafely(closeModelCall, [t, placement, model, started, {}], `${NAME}.middleware.stream`);
    return result;
  }

  let text = "";
  let finishReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  let failure: unknown = undefined;
  const toolCalls: Array<Record<string, unknown>> = [];

  const onPart = (chunk: unknown): void => {
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
  };

  const done = (error: unknown, cancelled: boolean): void => {
    const produced = {
      content: text || (toolCalls.length > 0 ? toolCalls : undefined),
      ...core.fwFields({ streaming: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }),
    };
    if (cancelled) {
      closeModelCall(t, placement, model, started, { stopReason: "cancelled", ...usage, ...produced }, "cancelled");
      return;
    }
    // A thrown stream error, else an in-band `error` part.
    const problem = error ?? failure;
    const fields: Record<string, unknown> =
      problem === undefined
        ? { stopReason: finishReason, ...usage, ...produced }
        : { stopReason: "error", error: errorText(problem), ...usage };
    closeModelCall(t, placement, model, started, fields);
  };

  return {
    ...(result as object),
    stream: core.observeStream(value.stream, onPart, done, `${NAME}.middleware.stream`),
  } as R;
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
        "`experimental_telemetry: telemetry()` instead " +
        '(`import { telemetry } from "@failproofai/sdk/ai"`).',
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

/** Whether the "instrument('ai') does not cover v4–v6 by itself" note has been logged. */
let advised = false;

/**
 * Register our tracer as the process-wide OpenTelemetry tracer (ai v4–v6).
 * Only ever on `instrument("ai", { registerGlobalTracer: true })`.
 *
 * Only when no provider is registered yet: taking over a customer's own
 * tracing is the opposite of what an observability library should do to
 * somebody else's observability. `getTracerProvider()` ALWAYS returns the
 * API's proxy, so the question is asked of the proxy's DELEGATE — a no-op
 * provider until somebody registers one.
 *
 * "Not yet" is not "never", which is why this is opt-in: a provider the
 * customer registers AFTER this call is refused by OpenTelemetry ("duplicate
 * registration"), and theirs is the one that exports. Composing instead —
 * handing their provider our spans too — is not possible from here: the
 * registration that would have to be wrapped has not happened yet, and one
 * that already has is held by instrumentations as a cached delegate that a
 * re-registration does not reach.
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

    // v7: harmless on older majors, whose events carry no callId. The global
    // list is additive — v7 dispatches every event to every integration on it,
    // and a per-call `integrations` option replaces the list for that call —
    // so registering ours takes nothing from anybody else's.
    registerIntegration();

    const major = compat.versionTuple(PACKAGE)?.[0];
    if (major !== undefined && major >= 7) return;

    // v4–v6 read spans from the ONE process-wide OpenTelemetry tracer
    // provider, and OpenTelemetry refuses every registration after the first.
    // Taking that slot here would silently refuse the customer's own
    // `NodeSDK.start()` later on, and send their http/database/framework spans
    // to a tracer that exports nothing. So it is opt-in, never the default.
    if (options.registerGlobalTracer !== true) {
      if (options.registerGlobalTracer === undefined && major !== undefined && !advised) {
        advised = true;
        logger.warn(
          `instrument("ai") on ai ${String(major)}.x does not register a global OpenTelemetry ` +
            "tracer — that slot belongs to your own tracing — so by itself it records nothing " +
            "on ai 4–6 (it covers ai 7). Record calls at the call site with " +
            "`experimental_telemetry: telemetry()`, or wrap the model once with " +
            "`await wrapModel(model)` — both `import { telemetry, wrapModel } from " +
            '"@failproofai/sdk/ai"`. If this process runs no OpenTelemetry of its own, ' +
            '`instrument("ai", { registerGlobalTracer: true })` records every call that passes ' +
            "`experimental_telemetry: { isEnabled: true }`. Pass `registerGlobalTracer: false` " +
            "to silence this.",
        );
      }
      return;
    }
    const outcome = registerGlobalTracer();
    if (outcome === "registered" || major === undefined) return;
    compat.warn(
      (outcome === "taken"
        ? "an OpenTelemetry tracer provider is already registered, so the `ai` adapter left it alone. "
        : "`@opentelemetry/api` is not importable, so the `ai` adapter cannot register a global tracer. ") +
        'Add telemetry at the call site (import { telemetry, wrapModel } from "@failproofai/sdk/ai") —\n' +
        "  experimental_telemetry: telemetry()\n" +
        "or wrap the model once —\n" +
        "  const model = await wrapModel(openai('gpt-4o'))",
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
    advised = false;
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
    calls.clear();
  },
};

/**
 * The adapter's bookkeeping, for this package's own unit tests.
 *
 * @internal Not part of the public API.
 */
export const _internals = {
  tracker: (): core.RunTracker | null => tracker,
  openCalls: (): number => calls.size,
};
