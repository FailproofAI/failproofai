/**
 * The Vercel AI SDK (`ai`).
 *
 * ## Why this adapter does not monkey-patch
 *
 * Every other adapter here replaces a method on a class prototype or a static.
 * The AI SDK's surface is module-level functions — `generateText`, `streamText`
 * — exported from an ES module, and ES module namespace objects are immutable
 * by specification. There is no supported place to stand. So this adapter uses
 * the two extension points the SDK itself documents, and both are real APIs
 * rather than a patch that a minor release can silently break:
 *
 * * **`telemetry()`** — the SDK's own `experimental_telemetry` hook. It emits a
 *   span per operation (`ai.generateText`, `ai.generateText.doGenerate`,
 *   `ai.toolCall`, …), and this module implements just enough of the
 *   OpenTelemetry `Tracer` interface to translate those into events. This is
 *   the complete integration: agent span, model request/response with token
 *   counts, and every tool call.
 *
 * * **`middleware()` / `wrapModel()`** — a `LanguageModelV2Middleware`, for a
 *   caller who does not want to pass `experimental_telemetry` at every call
 *   site. It sees model calls only; tool calls happen above the model layer
 *   and are invisible to it.
 *
 * Using both is fine and does not double-record: the middleware notices that a
 * tracer span is already open around it and defers.
 *
 * `instrument("ai")` cannot install either of these into someone else's call
 * sites, so it registers the tracer as the process-wide OpenTelemetry tracer
 * when `@opentelemetry/api` is present — the one placement that needs no code
 * change — and otherwise warns with the two-line fix. It never claims to have
 * instrumented something it has not.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { logger } from "../logger.js";
import { tryRequire } from "../node-require.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "ai";
const PACKAGE = "ai";

let tracker: core.RunTracker | null = null;
let patcher: core.Patcher | null = null;

/**
 * Set while a tracer span for an AI SDK operation is open, so `middleware()`
 * knows the tracer is already recording this call and stays quiet. Using
 * `AsyncLocalStorage` rather than a counter because several operations can be
 * in flight at once and a counter cannot tell which call it belongs to.
 */
const insideTracer = new AsyncLocalStorage<true>();

function ensureTracker(options: Record<string, unknown> = {}): core.RunTracker {
  tracker ??= new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGE),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  });
  return tracker;
}

function asInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
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

function errorOf(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message, stack: error.stack };
  }
  return { type: typeof error, message: String(error) };
}

// ---------------------------------------------------------------------------
// The tracer
// ---------------------------------------------------------------------------

type Attributes = Record<string, unknown>;

/** The operations the SDK opens a ROOT span for. Each becomes an agent span. */
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

class FailproofSpan {
  readonly attributes: Attributes = {};
  private spanName: string;
  private readonly id: string;
  private readonly parentId: string | undefined;
  private readonly started = Date.now();
  private ended = false;
  private failure: unknown = undefined;
  private recording = true;

  constructor(spanName: string, parentId: string | undefined, attributes: Attributes = {}) {
    this.spanName = spanName;
    spanCounter += 1;
    this.id = `ai-${String(spanCounter)}-${randomUUID().slice(0, 8)}`;
    this.parentId = parentId;
    Object.assign(this.attributes, attributes);
    this.open();
  }

  get spanId(): string {
    return this.id;
  }

  private operation(): string {
    const id = this.attributes["ai.operationId"];
    return typeof id === "string" ? id : this.spanName;
  }

  private open(): void {
    const t = tracker;
    if (t === null) return;
    const operation = this.operation();
    if (ROOT_OPERATIONS.has(operation)) {
      t.startAgent(this.id, {
        agentId: (this.attributes["ai.telemetry.functionId"] as string | undefined) ?? operation,
        parentKey: this.parentId,
        ...core.fwFields({ operation, span: this.spanName }),
      });
    } else {
      t.link(this.id, this.parentId);
    }
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

  setStatus(status: { code?: number; message?: string }): this {
    // OpenTelemetry's SpanStatusCode.ERROR is 2.
    if (status?.code === 2 && this.failure === undefined) {
      this.failure = new Error(status.message ?? "span reported an error status");
    }
    return this;
  }

  recordException(error: unknown): this {
    this.failure = error;
    return this;
  }

  updateName(name: string): this {
    this.spanName = name;
    return this;
  }

  isRecording(): boolean {
    return this.recording && !this.ended;
  }

  spanContext(): { traceId: string; spanId: string; traceFlags: number } {
    return { traceId: this.id.padEnd(32, "0").slice(0, 32), spanId: this.id.slice(0, 16), traceFlags: 1 };
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.recording = false;
    const t = tracker;
    if (t === null) return;
    core.callSafely(() => {
      this.emit(t);
    }, [], `${NAME}.span.end`);
  }

  private emit(t: core.RunTracker): void {
    const a = this.attributes;
    const operation = this.operation();
    const failed = this.failure !== undefined;

    if (MODEL_OPERATIONS.has(operation)) {
      this.emitModel(t, failed);
      return;
    }
    if (operation === "ai.toolCall") {
      this.emitToolCall(t, failed);
      return;
    }
    if (ROOT_OPERATIONS.has(operation)) {
      if (failed) {
        const detail = errorOf(this.failure);
        t.emit("error", this.id, {
          errorType: detail.type,
          message: detail.message,
          traceback: detail.stack,
        });
      }
      t.endAgent(this.id, {
        outcome: failed ? "failed" : "success",
        ...core.fwFields({
          operation,
          duration_ms: core.ms(Date.now() - this.started),
          response_text: a["ai.response.text"],
          finish_reason: a["ai.response.finishReason"],
        }),
      });
    }
  }

  private emitModel(t: core.RunTracker, failed: boolean): void {
    const a = this.attributes;
    const model =
      (a["ai.model.id"] as string | undefined) ??
      (a["gen_ai.request.model"] as string | undefined) ??
      (a["ai.response.model"] as string | undefined);
    const messages = parseMaybeJson(a["ai.prompt.messages"] ?? a["ai.prompt"]);
    const tools = Array.isArray(a["ai.prompt.tools"])
      ? (a["ai.prompt.tools"] as unknown[]).map(parseMaybeJson)
      : undefined;

    t.emit("modelRequest", `${this.id}:req`, {
      parentKey: this.parentId ?? this.id,
      model,
      messages: Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : undefined,
      tools: tools as Array<Record<string, unknown>> | undefined,
      requestId: this.id,
      ...core.fwFields({
        provider: a["ai.model.provider"] ?? a["gen_ai.system"],
        operation: this.operation(),
        prompt: Array.isArray(messages) ? undefined : messages,
      }),
    });

    if (failed) {
      const detail = errorOf(this.failure);
      t.emit("error", `${this.id}:req`, {
        parentKey: this.parentId ?? this.id,
        errorType: detail.type,
        message: detail.message,
        traceback: detail.stack,
        ...core.fwFields({ stage: "model", request_id: this.id }),
      });
      return;
    }

    const toolCalls = parseMaybeJson(a["ai.response.toolCalls"]);
    t.emit("modelResponse", `${this.id}:req`, {
      parentKey: this.parentId ?? this.id,
      model: (a["ai.response.model"]) ?? model,
      stopReason:
        (a["ai.response.finishReason"]) ??
        (a["gen_ai.response.finish_reasons"]),
      inputTokens: asInt(a["ai.usage.inputTokens"] ?? a["ai.usage.promptTokens"]),
      outputTokens: asInt(a["ai.usage.outputTokens"] ?? a["ai.usage.completionTokens"]),
      content: a["ai.response.text"] ?? a["ai.response.object"] ?? toolCalls,
      role: "assistant",
      requestId: this.id,
      ...core.fwFields({
        duration_ms: core.ms(Date.now() - this.started),
        tool_calls: toolCalls,
        response_id: a["ai.response.id"],
      }),
    });
  }

  private emitToolCall(t: core.RunTracker, failed: boolean): void {
    const a = this.attributes;
    const toolName = (a["ai.toolCall.name"] as string | undefined) ?? "tool";
    const toolCallId = (a["ai.toolCall.id"] as string | undefined) ?? this.id;
    const input = parseMaybeJson(a["ai.toolCall.args"] ?? a["ai.toolCall.input"]);

    t.emit("toolUse", this.id, {
      parentKey: this.parentId,
      toolName,
      toolCallId,
      input: (input) ?? undefined,
    });
    const detail = failed ? errorOf(this.failure) : null;
    t.emit("toolResult", this.id, {
      parentKey: this.parentId,
      toolName,
      toolCallId,
      output: failed ? undefined : parseMaybeJson(a["ai.toolCall.result"] ?? a["ai.toolCall.output"]),
      error: detail ? `${detail.type}: ${detail.message}` : undefined,
    });
  }
}

const activeSpan = new AsyncLocalStorage<FailproofSpan>();

type SpanCallback<T> = (span: FailproofSpan) => T;

/**
 * Just enough of OpenTelemetry's `Tracer` for the AI SDK.
 *
 * The SDK only ever calls `startActiveSpan` (with three or four arguments) and
 * `startSpan`, and on the span only `setAttribute(s)`, `addEvent`, `setStatus`,
 * `recordException` and `end`. Implementing that subset is what lets this work
 * with no OpenTelemetry dependency at all — which matters, because the whole
 * package is zero-dependency and `@opentelemetry/api` is not a small ask to put
 * in somebody's agent process.
 */
class FailproofTracer {
  startSpan(name: string, options?: { attributes?: Attributes }): FailproofSpan {
    return new FailproofSpan(name, activeSpan.getStore()?.spanId, options?.attributes ?? {});
  }

  startActiveSpan<T>(name: string, ...rest: unknown[]): T {
    const callback = rest[rest.length - 1] as SpanCallback<T>;
    const options = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as {
      attributes?: Attributes;
    };
    const span = new FailproofSpan(name, activeSpan.getStore()?.spanId, options.attributes ?? {});

    const run = (): T => {
      let result: T;
      try {
        result = callback(span);
      } catch (error) {
        span.recordException(error);
        span.end();
        throw error;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        typeof (result as unknown as PromiseLike<unknown>).then === "function"
      ) {
        return (result as unknown as PromiseLike<unknown>).then(
          (value) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            span.recordException(error);
            span.end();
            throw error;
          },
        ) as T;
      }
      span.end();
      return result;
    };

    return activeSpan.run(span, () => insideTracer.run(true, run));
  }
}

/**
 * The value to hand the SDK's `experimental_telemetry` option:
 *
 *     const { text } = await generateText({
 *       model,
 *       prompt,
 *       experimental_telemetry: failproofai.ai.telemetry(),
 *     });
 *
 * `functionId` names the agent span; without one it is named after the
 * operation (`ai.generateText`). Keep it low-cardinality — it lands in
 * `agent_id`, which is the primary dashboard facet.
 */
export function telemetry(
  options: { functionId?: string; metadata?: Record<string, unknown> } = {},
): { isEnabled: true; functionId?: string; metadata?: Record<string, unknown>; tracer: FailproofTracer } {
  ensureTracker();
  return {
    isEnabled: true,
    ...(options.functionId === undefined ? {} : { functionId: options.functionId }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    tracer: new FailproofTracer(),
  };
}

/** The bare tracer, for `experimental_telemetry: { isEnabled: true, tracer }`. */
export function tracer(): FailproofTracer {
  ensureTracker();
  return new FailproofTracer();
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

interface ModelLike {
  modelId?: string;
  provider?: string;
}

function usageOf(result: unknown): { inputTokens?: number; outputTokens?: number } {
  const usage = (result as { usage?: Record<string, unknown> })?.usage;
  if (!usage) return {};
  return {
    inputTokens: asInt(usage.inputTokens ?? usage.promptTokens),
    outputTokens: asInt(usage.outputTokens ?? usage.completionTokens),
  };
}

function contentOf(result: unknown): unknown {
  const value = result as { content?: unknown; text?: unknown };
  return value.content ?? value.text;
}

/**
 * A `LanguageModelV2Middleware` that records `model_request` / `model_response`.
 *
 *     const model = wrapLanguageModel({
 *       model: openai("gpt-4o"),
 *       middleware: failproofai.ai.middleware(),
 *     });
 *
 * Defers when a tracer span is already open around the call, so combining this
 * with `telemetry()` records each model call once rather than twice.
 */
export function middleware(options: Record<string, unknown> = {}): Record<string, unknown> {
  const t = ensureTracker(options);

  const record = async (
    params: Record<string, unknown>,
    model: ModelLike | undefined,
    run: () => Promise<unknown>,
    streaming: boolean,
  ): Promise<unknown> => {
    if (insideTracer.getStore()) return run();

    const requestId = randomUUID();
    const started = Date.now();
    const prompt = params.prompt;
    core.callSafely(
      () => {
        t.emit("modelRequest", requestId, {
          model: model?.modelId,
          messages: Array.isArray(prompt) ? (prompt as Array<Record<string, unknown>>) : undefined,
          tools: Array.isArray(params.tools) ? (params.tools as Array<Record<string, unknown>>) : undefined,
          requestId,
          ...core.fwFields({ provider: model?.provider, streaming: streaming || undefined }),
        });
      },
      [],
      `${NAME}.middleware.request`,
    );

    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      const detail = errorOf(error);
      core.callSafely(
        () => {
          t.emit("error", requestId, {
            errorType: detail.type,
            message: detail.message,
            traceback: detail.stack,
            ...core.fwFields({ stage: "model", request_id: requestId }),
          });
        },
        [],
        `${NAME}.middleware.error`,
      );
      throw error;
    }

    if (streaming) return instrumentStream(t, result, requestId, model, started);

    const usage = usageOf(result);
    core.callSafely(
      () => {
        t.emit("modelResponse", requestId, {
          model: model?.modelId,
          stopReason: (result as { finishReason?: string }).finishReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          content: contentOf(result),
          role: "assistant",
          requestId,
          ...core.fwFields({ duration_ms: core.ms(Date.now() - started) }),
        });
      },
      [],
      `${NAME}.middleware.response`,
    );
    return result;
  };

  return {
    // v2 middleware names. `specificationVersion` is what `wrapLanguageModel`
    // checks; declaring it stops a v2-only host rejecting the object outright.
    specificationVersion: "v2",
    wrapGenerate: async ({
      doGenerate,
      params,
      model,
    }: {
      doGenerate: () => Promise<unknown>;
      params: Record<string, unknown>;
      model?: ModelLike;
    }) => record(params, model, doGenerate, false),
    wrapStream: async ({
      doStream,
      params,
      model,
    }: {
      doStream: () => Promise<unknown>;
      params: Record<string, unknown>;
      model?: ModelLike;
    }) => record(params, model, doStream, true),
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
function instrumentStream(
  t: core.RunTracker,
  result: unknown,
  requestId: string,
  model: ModelLike | undefined,
  started: number,
): unknown {
  const value = result as { stream?: ReadableStream<unknown> };
  if (!value?.stream || typeof TransformStream !== "function") return result;

  let text = "";
  let finishReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  const toolCalls: unknown[] = [];

  const transform = new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      try {
        const part = chunk as { type?: string; delta?: unknown; text?: unknown } & Record<string, unknown>;
        if (part.type === "text-delta" || part.type === "text") {
          const delta = typeof part.delta === "string" ? part.delta : part.text;
          if (typeof delta === "string") text += delta;
        } else if (part.type === "tool-call") {
          toolCalls.push(part);
        } else if (part.type === "finish") {
          finishReason = typeof part.finishReason === "string" ? part.finishReason : undefined;
          usage = usageOf(part);
        }
      } catch {
        // A malformed part must not break the caller's stream.
      }
      controller.enqueue(chunk);
    },
    flush() {
      core.callSafely(
        () => {
          t.emit("modelResponse", requestId, {
            model: model?.modelId,
            stopReason: finishReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            content: text || undefined,
            role: "assistant",
            requestId,
            ...core.fwFields({
              duration_ms: core.ms(Date.now() - started),
              streaming: true,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            }),
          });
        },
        [],
        `${NAME}.middleware.stream`,
      );
    },
  });

  return { ...(result as object), stream: value.stream.pipeThrough(transform) };
}

/**
 * Wrap a model so every call through it is recorded.
 *
 *     const model = failproofai.ai.wrapModel(openai("gpt-4o"));
 *
 * Uses the SDK's own `wrapLanguageModel` when it can be imported, so the
 * returned value is exactly what the SDK expects.
 */
export async function wrapModel<T>(model: T, options: Record<string, unknown> = {}): Promise<T> {
  const sdk = (await compat.requireModule("ai", "npm install ai")) as {
    wrapLanguageModel?: (arg: { model: T; middleware: unknown }) => T;
  };
  if (typeof sdk.wrapLanguageModel !== "function") {
    throw new Error(
      "this version of `ai` does not export wrapLanguageModel; pass " +
        "`experimental_telemetry: failproofai.ai.telemetry()` instead.",
    );
  }
  return sdk.wrapLanguageModel({ model, middleware: middleware(options) });
}

/**
 * Wrap one tool's `execute` so its call and result are recorded.
 *
 * Only needed when you are NOT using `telemetry()` — the SDK opens an
 * `ai.toolCall` span for every tool it runs, which the tracer already turns
 * into a `tool_use`/`tool_result` pair.
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
        const detail = errorOf(error);
        t.emit("toolResult", ctx, {
          toolName,
          toolCallId: String(ctx),
          error: `${detail.type}: ${detail.message}`,
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

export const adapter: Adapter = {
  name: NAME,

  install(options: Record<string, unknown> = {}): void {
    compat.checkVersion(NAME, PACKAGE, {
      minimum: "4.0.0",
      below: "7.0.0",
      reason: "the middleware and telemetry attribute names below are the v4/v5 shape",
    });
    ensureTracker(options);
    patcher = new core.Patcher();

    // The only placement that reaches call sites we do not control. When
    // `@opentelemetry/api` is present, the AI SDK resolves its tracer from the
    // global provider whenever `experimental_telemetry.isEnabled` is set
    // without an explicit `tracer`, so registering ours there instruments those
    // calls with no code change.
    const registered = registerGlobalTracer();
    if (!registered) {
      logger.warn(
        "the `ai` adapter cannot attach itself to call sites: the AI SDK exports ES module " +
          "functions, which cannot be patched. Add telemetry at the call site —\n" +
          "  experimental_telemetry: failproofai.ai.telemetry()\n" +
          "or wrap the model once —\n" +
          "  const model = await failproofai.ai.wrapModel(openai('gpt-4o'))",
      );
    }
  },

  uninstall(): void {
    patcher?.restoreAll();
    patcher = null;
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
  },
};

/**
 * Register our tracer as the process-wide OpenTelemetry tracer.
 *
 * Deliberately narrow: it only registers when `@opentelemetry/api` is ALREADY
 * installed and no provider has been registered yet. Overwriting an existing
 * provider would silently take over a customer's own tracing — the opposite of
 * what an observability library should do to somebody else's observability.
 */
function registerGlobalTracer(): boolean {
  // A synchronous require so `install()` stays synchronous, and `tryRequire`
  // because the package being absent is the ordinary case, not an error.
  const api = tryRequire<{
    trace?: {
      setGlobalTracerProvider?: (provider: unknown) => boolean;
      getTracerProvider?: () => unknown;
    };
  }>("@opentelemetry/api");
  if (api === null) return false;
  const setProvider = api.trace?.setGlobalTracerProvider;
  if (typeof setProvider !== "function") return false;

  const existing = api.trace?.getTracerProvider?.();
  const existingName = existing?.constructor?.name ?? "";
  if (existing && existingName !== "NoopTracerProvider" && existingName !== "ProxyTracerProvider") {
    logger.warn(
      "an OpenTelemetry tracer provider is already registered, so the `ai` adapter left it " +
        "alone. Pass `experimental_telemetry: failproofai.ai.telemetry()` at the call site " +
        "to record AI SDK calls alongside your existing tracing.",
    );
    return false;
  }

  const shared = new FailproofTracer();
  return setProvider({
    getTracer: () => shared,
  });
}
