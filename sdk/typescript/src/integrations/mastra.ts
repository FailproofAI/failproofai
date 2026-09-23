/**
 * Mastra (`@mastra/core`).
 *
 * ## The mapping
 *
 * Mastra has no Python counterpart, so this is derived from the rule every
 * adapter follows — "a framework construct becomes an agent if and only if it
 * owns an LLM decision loop and has its own goal; everything else with a start
 * and an end becomes the closest kind of leaf" — with CrewAI (agents calling
 * agents) and LlamaIndex (workflow steps) as the analogues:
 *
 * | Mastra | FailproofAI |
 * |---|---|
 * | `Agent.generate()` / `.stream()` (and the legacy / VNext variants) | `agent_start` / `agent_end`, `agent_id` = the agent's `name` (its `id` if unnamed), never a UUID |
 * | a sub-agent another agent delegates to (`agents: {…}`) | nested `agent_start` / `agent_end`, `parent_id` = the caller, inside the caller's `agent-<name>` tool call |
 * | each LLM step of the loop | `model_request` / `model_response`, paired on `request_id`, with the model id, integer tokens, a string `stop_reason` and `duration_ms` |
 * | a tool the model calls | `tool_use` / `tool_result` carrying the MODEL's `toolCallId`, attributed to the agent whose loop called it |
 * | a workflow run (`run.start()`, `.stream()`, `.resume()`) | `agent_start` / `agent_end`, `agent_id` = the workflow id |
 * | a workflow step | `hook_triggered` / `hook_completed`, `trigger_event="workflow_step"` |
 * | Mastra's own machinery — the agentic loop is itself built from internal workflows | nothing |
 *
 * A streamed call finalises when Mastra finishes the stream — which it does as
 * the caller consumes it — not when `stream()` returns: the model events carry
 * the real token counts and stop reason, and `agent_end` is not emitted while
 * the loop is still running. A failure is recorded once, on the event it
 * happened in (the `model_response`, the `tool_result`, the `hook_completed`),
 * and closes the enclosing agent `failed`; there is no separate `error` event
 * for each layer the exception unwound through.
 *
 * ## Why prototype patching, and where
 *
 * Mastra 1.x has a real tracing extension point — an `ObservabilityExporter`
 * receiving `agent_run` / `model_step` / `tool_call` / `workflow_step` spans —
 * but it only exists for agents and workflows registered on a `Mastra` instance
 * configured with `@mastra/observability`. A bare `new Agent(...)` gets a no-op
 * tracer and emits nothing to hook, and that is the most common way Mastra is
 * used outside its dev server. It is also absent from 0.x in this shape. So the
 * adapter patches the few PROTOTYPE methods every run goes through, on both
 * lines alike:
 *
 * * `Agent.prototype.generate` / `.stream` (+ variants) — the agent span.
 * * `Agent.prototype.resolveModelConfig` — every model the agent will call
 *   passes through here, per run. The resolved model is handed back behind a
 *   proxy whose `doGenerate` / `doStream` are observed: that is the AI SDK
 *   `LanguageModel` contract (V1–V3), which Mastra itself calls once per LLM
 *   step, so each step is one pair with the provider's own usage and finish
 *   reason — rather than one collapsed pair read off the final result.
 * * `Agent.prototype.convertTools` — the one step that turns every kind of tool
 *   (assigned, memory, toolset, client, sub-agent, workflow-as-tool) into what
 *   the loop executes. Wrapping its OUTPUT covers tools created before
 *   `instrument()` ran, which patching the `createTool` export never could: an
 *   ES-module namespace is read-only, and a Mastra tool's `execute` lives on
 *   the instance.
 * * `Run.prototype._start` / `_resume` (+ `_restart`, `_timeTravel`) and
 *   `DefaultExecutionEngine.prototype.executeStep` — the workflow span and its
 *   steps. Runs Mastra marks internal (`isInternalWorkflow`, or a
 *   `tracingPolicy.internal` with the WORKFLOW bit) are skipped, which is what
 *   keeps the agentic loop's own `execution-workflow` / `agentic-loop` out.
 *
 * Every copy of `@mastra/core` the application loads is patched — see
 * `compat.requireModuleCopies()`: the ES-module and CommonJS builds are two
 * unrelated sets of classes.
 *
 * ## How events find their agent
 *
 * An adapter-private `AsyncLocalStorage` carries the Mastra run that is
 * executing (`Frame`). It never binds FailproofAI identity — it only answers
 * "which of OUR runs is this?", and every event is still emitted through the
 * `RunTracker` with an explicit parent key. The model proxy and the tool
 * wrappers capture the frame when the run builds them, so an event keeps its
 * agent even when Mastra later executes it from a stream the caller is
 * pulling on a different async path. A tool call runs its body inside a
 * `tool` frame of the calling agent, which is what nests a sub-agent under the
 * agent that delegated to it — and, inside a workflow step, what attributes a
 * tool to the agent that called it rather than to the workflow.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { current as currentIdentity } from "../context.js";
import { agent as agentScope } from "../scopes.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "mastra";
const PACKAGE = "@mastra/core";
const INSTALL = "npm install @mastra/core";

/**
 * The oldest release the patch points above all exist in with this shape:
 * `resolveModelConfig` and `Run._start` both arrived in the 0.20 line, when
 * `generate` / `stream` became the loop that calls a `LanguageModelV2` once per
 * step. Earlier releases route model calls through the AI SDK's own
 * `generateText` and run workflows through a different `Run`, so nothing here
 * would see a model step or a workflow step.
 */
const MINIMUM = "0.20.0";

let tracker: core.RunTracker | null = null;
let patcher: core.Patcher | null = null;

function ensureTracker(options: Record<string, unknown> = {}): core.RunTracker {
  tracker ??= new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGE),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  });
  return tracker;
}

/** The Mastra run currently executing, as far as this adapter is concerned. */
interface Frame {
  /** Our `RunTracker` key for the agent or workflow run. */
  key: string;
  /** The `Agent` or workflow `Run` instance that owns the run. */
  owner: object;
  /** `tool` while a tool the agent called is executing. */
  kind: "agent" | "workflow" | "tool";
}

const frames = new AsyncLocalStorage<Frame>();

/** Mastra workflow run id -> our key, so a step can find its workflow span. */
const workflowRuns = new Map<string, string>();

const WRAPPED = Symbol.for("failproofai.wrapped");

function markWrapped<T extends object>(wrapper: T, original: unknown): T {
  (wrapper as Record<symbol, unknown>)[WRAPPED] = original;
  return wrapper;
}

// ---------------------------------------------------------------------------
// Small readers. Each takes whatever Mastra or a provider handed us and
// returns a value the schema accepts, or undefined — never throws.
// ---------------------------------------------------------------------------

function errorOf(error: unknown): { type: string; message: string } {
  if (error instanceof Error) return { type: error.name || "Error", message: error.message };
  if (typeof error === "object" && error !== null) {
    const value = error as { name?: unknown; message?: unknown };
    if (typeof value.message === "string") {
      return { type: typeof value.name === "string" ? value.name : "Error", message: value.message };
    }
  }
  return { type: typeof error, message: String(error) };
}

const describeError = (error: unknown): string => {
  const detail = errorOf(error);
  return `${detail.type}: ${detail.message}`;
};

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * A token count in any of the provider shapes: a number (V1 `promptTokens`,
 * V2 `inputTokens`) or V3's `{ total, … }` breakdown.
 */
function tokenCount(value: unknown): number | undefined {
  if (typeof value === "object" && value !== null) return asInt((value as { total?: unknown }).total);
  return asInt(value);
}

function usageOf(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (typeof usage !== "object" || usage === null) return {};
  const value = usage as Record<string, unknown>;
  return {
    inputTokens: tokenCount(value.inputTokens ?? value.promptTokens),
    outputTokens: tokenCount(value.outputTokens ?? value.completionTokens),
  };
}

/** V1/V2 finish reasons are strings; V3's are `{ unified, raw }`. */
function finishReasonOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "object" && value !== null) {
    const { unified, raw } = value as { unified?: unknown; raw?: unknown };
    if (typeof unified === "string" && unified) return unified;
    if (typeof raw === "string" && raw) return raw;
  }
  return undefined;
}

function agentLabel(instance: unknown): { label: string; rawId?: string } {
  const value = instance as { name?: unknown; id?: unknown } | undefined;
  const raw = typeof value?.name === "string" && value.name ? value.name : value?.id;
  const label = core.normalizeAgentId(raw, "mastra-agent");
  const rawId = typeof value?.id === "string" && value.id !== label ? value.id : undefined;
  return { label, rawId };
}

/** The run's goal: the prompt, when the caller handed one over as text. */
function goalOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as unknown;
    if (typeof item === "string") return item;
    const message = item as { role?: unknown; content?: unknown } | null;
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  return undefined;
}

/** One `LanguageModel` prompt part, reduced to what a reader needs. */
function partToWire(part: unknown): unknown {
  const value = (part ?? {}) as Record<string, unknown>;
  switch (value.type) {
    case "text":
      return { type: "text", text: value.text };
    case "tool-call":
      return { type: "tool_call", id: value.toolCallId, name: value.toolName, input: value.input ?? value.args };
    case "tool-result":
      return { type: "tool_result", id: value.toolCallId, name: value.toolName, output: value.output ?? value.result };
    default:
      return { type: value.type };
  }
}

function contentToWire(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  if (content.every((part) => (part as { type?: unknown } | null)?.type === "text")) {
    return content.map((part) => (part as { text?: unknown }).text).join("");
  }
  return content.map(partToWire);
}

/**
 * A `LanguageModel` call's prompt as `{messages, system}`.
 *
 * The provider-level prompt is what the model actually receives — the agent's
 * instructions as a system message, memory, the tool results of earlier steps
 * — so it is recorded rather than what the caller passed to `generate()`.
 */
function promptOf(options: unknown): {
  messages?: Array<Record<string, unknown>>;
  system?: unknown;
  tools?: Array<Record<string, unknown>>;
} {
  const value = (options ?? {}) as { prompt?: unknown; tools?: unknown; mode?: { tools?: unknown } };
  const out: ReturnType<typeof promptOf> = {};
  if (Array.isArray(value.prompt)) {
    const system: unknown[] = [];
    const messages: Array<Record<string, unknown>> = [];
    for (const item of value.prompt) {
      const message = (item ?? {}) as { role?: unknown; content?: unknown };
      if (message.role === "system") system.push(message.content);
      else messages.push({ role: message.role, content: contentToWire(message.content) });
    }
    out.messages = messages;
    if (system.length > 0) out.system = system.length === 1 ? system[0] : system;
  }
  const tools = Array.isArray(value.tools) ? value.tools : value.mode?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = tools.map((tool) => {
      const entry = (tool ?? {}) as { name?: unknown; description?: unknown };
      return { name: entry.name, description: entry.description };
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model steps
// ---------------------------------------------------------------------------

interface ModelCall {
  requestId: string;
  runKey: string;
  model?: string;
  started: number;
}

interface ModelOutcome {
  model?: string;
  finishReason?: string;
  usage?: unknown;
  text?: string;
  toolCalls?: Array<Record<string, unknown>>;
  error?: unknown;
}

function modelIdOf(model: object): string | undefined {
  const id = (model as { modelId?: unknown }).modelId;
  return typeof id === "string" && id ? id : undefined;
}

function beginModelCall(runKey: string, model: object, options: unknown): ModelCall {
  const t = ensureTracker();
  const requestId = randomUUID();
  const modelId = modelIdOf(model);
  const provider = (model as { provider?: unknown }).provider;
  t.emit("modelRequest", requestId, {
    parentKey: runKey,
    model: modelId,
    ...promptOf(options),
    requestId,
    ...core.fwFields({ provider: typeof provider === "string" ? provider : undefined }),
  });
  return { requestId, runKey, model: modelId, started: Date.now() };
}

function endModelCall(call: ModelCall, outcome: ModelOutcome): void {
  const usage = usageOf(outcome.usage);
  ensureTracker().emit("modelResponse", call.requestId, {
    parentKey: call.runKey,
    model: outcome.model ?? call.model,
    stopReason: outcome.finishReason ?? (outcome.error !== undefined ? "error" : undefined),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    content: outcome.text ? outcome.text : undefined,
    role: "assistant",
    requestId: call.requestId,
    error: outcome.error === undefined ? undefined : describeError(outcome.error),
    ...core.fwFields({
      duration_ms: core.ms(Date.now() - call.started),
      tool_calls: outcome.toolCalls?.length ? outcome.toolCalls : undefined,
    }),
  });
}

/** What a `doGenerate` result says, in any of the V1–V3 shapes. */
function generateOutcome(result: unknown): ModelOutcome {
  const value = (result ?? {}) as {
    content?: unknown;
    text?: unknown;
    toolCalls?: unknown;
    finishReason?: unknown;
    usage?: unknown;
    response?: { modelId?: unknown };
  };
  let text = typeof value.text === "string" ? value.text : "";
  const toolCalls: Array<Record<string, unknown>> = [];
  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      const entry = (part ?? {}) as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") text += entry.text;
      if (entry.type === "tool-call") {
        toolCalls.push({ id: entry.toolCallId, name: entry.toolName, input: entry.input ?? entry.args });
      }
    }
  }
  if (Array.isArray(value.toolCalls)) {
    for (const call of value.toolCalls) {
      const entry = (call ?? {}) as Record<string, unknown>;
      toolCalls.push({ id: entry.toolCallId, name: entry.toolName, input: entry.args ?? entry.input });
    }
  }
  return {
    model: typeof value.response?.modelId === "string" ? value.response.modelId : undefined,
    finishReason: finishReasonOf(value.finishReason),
    usage: value.usage,
    text,
    toolCalls,
  };
}

/**
 * Fold one `doStream` part into the step's outcome. The stream is the only
 * place a streamed step's usage and finish reason exist, so they are read as
 * they pass rather than from Mastra's aggregate afterwards.
 */
function foldStreamPart(outcome: ModelOutcome, part: unknown): void {
  const value = (part ?? {}) as Record<string, unknown>;
  switch (value.type) {
    case "text-delta": {
      const delta = value.delta ?? value.textDelta;
      if (typeof delta === "string") outcome.text = (outcome.text ?? "") + delta;
      break;
    }
    case "tool-call":
      (outcome.toolCalls ??= []).push({
        id: value.toolCallId,
        name: value.toolName,
        input: value.input ?? value.args,
      });
      break;
    case "response-metadata":
      if (typeof value.modelId === "string" && value.modelId) outcome.model = value.modelId;
      break;
    case "finish":
      outcome.finishReason = finishReasonOf(value.finishReason);
      outcome.usage = value.usage;
      break;
    case "error":
      outcome.error = value.error;
      break;
    default:
      break;
  }
}

/**
 * Pass `source` through untouched, observing each part and calling `done`
 * exactly once — when it ends, errors, or the reader cancels it.
 *
 * A pull-based re-stream rather than `pipeThrough(new TransformStream())`: a
 * transformer has no hook for a consumer that cancels, and a step whose
 * consumer walked away must still close its `model_request`.
 */
function observeStream(
  source: ReadableStream<unknown>,
  onPart: (part: unknown) => void,
  done: (error?: unknown) => void,
): ReadableStream<unknown> {
  const reader = source.getReader();
  let finished = false;
  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    core.callSafely(done, [error], `${NAME}.stream`);
  };
  return new ReadableStream<unknown>({
    async pull(controller) {
      let chunk: { done: boolean; value?: unknown };
      try {
        chunk = await reader.read();
      } catch (error) {
        finish(error);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        finish();
        controller.close();
        return;
      }
      core.callSafely(onPart, [chunk.value], `${NAME}.stream`);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      finish(reason ?? new Error("stream cancelled"));
      return reader.cancel(reason);
    },
  });
}

type ModelMethod = (options: unknown) => PromiseLike<unknown>;

/**
 * One observed `doGenerate` / `doStream` call: a step.
 *
 * The result decides how the step ends, not the method name. A provider's
 * `doGenerate` answers with the finished content, but the model Mastra 0.x
 * resolves is its own V5 wrapper, whose `doGenerate` ALSO answers with a
 * `stream` — reading the result as a finished generation there records a step
 * with no tokens and no stop reason. So a result carrying a readable stream is
 * observed as one, whichever method produced it.
 */
function observedCall(target: object, original: ModelMethod, runKey: string, name: string): ModelMethod {
  const observed = async function (options: unknown): Promise<unknown> {
    const call = core.callSafely(beginModelCall, [runKey, target, options], `${NAME}.model`);
    let result: unknown;
    try {
      result = await original.call(target, options);
    } catch (error) {
      if (call) core.callSafely(endModelCall, [call, { error }], `${NAME}.model`);
      throw error;
    }
    if (!call) return result;
    const stream = (result as { stream?: unknown } | null)?.stream;
    if (typeof (stream as ReadableStream | undefined)?.getReader !== "function") {
      core.callSafely(
        (value: unknown) => endModelCall(call, generateOutcome(value)),
        [result],
        `${NAME}.model`,
      );
      return result;
    }
    const outcome: ModelOutcome = {};
    return {
      ...(result as object),
      stream: observeStream(
        stream as ReadableStream<unknown>,
        (part) => foldStreamPart(outcome, part),
        (error) => endModelCall(call, error === undefined ? outcome : { ...outcome, error: outcome.error ?? error }),
      ),
    };
  };
  Object.defineProperty(observed, "name", { value: name, configurable: true });
  return observed;
}

/**
 * Hand a resolved model back behind a proxy that observes its two call
 * methods and is otherwise the model.
 *
 * Every other method is bound to the real model, and every property read with
 * the real model as receiver: a provider class that keeps state in `#private`
 * fields throws when one of its methods runs with a proxy as `this`.
 */
function observeModel(model: unknown, runKey: string): unknown {
  if (typeof model !== "object" || model === null) return model;
  const target = model;
  const doGenerate = (target as { doGenerate?: unknown }).doGenerate;
  const doStream = (target as { doStream?: unknown }).doStream;
  if (typeof doGenerate !== "function" && typeof doStream !== "function") return model;
  if ((target as Record<symbol, unknown>)[WRAPPED] !== undefined) return model;

  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(object, property) {
      if (property === WRAPPED) return target;
      const value: unknown = Reflect.get(object, property);
      if (typeof value !== "function" || property === "constructor") return value;
      let bound = cache.get(property);
      if (bound === undefined || (bound as { [WRAPPED]?: unknown })[WRAPPED] !== value) {
        const method = value as ModelMethod;
        bound =
          property === "doGenerate" || property === "doStream"
            ? observedCall(object, method, runKey, property)
            : (method as (...args: unknown[]) => unknown).bind(object);
        markWrapped(bound as object, value);
        cache.set(property, bound);
      }
      return bound;
    },
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A tool call that returned a failure instead of throwing it.
 *
 * Mastra 0.x catches a tool's exception and hands the model a `MastraError`
 * (1.x re-throws it); both lines return a `{ error: true, message }` object
 * for input that fails validation. Either way the call failed, and a
 * `tool_result` recording it as output would say otherwise.
 */
function failureOf(value: unknown): unknown {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null) {
    const flagged = value as { error?: unknown; message?: unknown };
    if (flagged.error === true && typeof flagged.message === "string") return flagged;
  }
  return undefined;
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return { input };
}

interface ToolCall {
  key: string;
  toolName: string;
  toolCallId: string;
  parentKey?: string;
  /** Set when the call opened its own root run, which it must close. */
  ownRun?: string;
}

function beginToolCall(
  toolName: string,
  toolCallId: string,
  input: unknown,
  parentKey: string | undefined,
): ToolCall {
  const t = ensureTracker();
  let ownRun: string | undefined;
  if (parentKey === undefined && currentIdentity().sessionId === null) {
    // Nothing is running and no scope is open: a tool called on its own is its
    // own run, exactly as a bare LangChain tool is, rather than an event
    // dropped for want of a session.
    ownRun = randomUUID();
    t.startAgent(ownRun, { agentId: core.normalizeAgentId(toolName, "tool"), ...core.fwFields({ kind: "tool" }) });
    parentKey = ownRun;
  }
  const key = `${parentKey ?? "ambient"}:tool:${toolCallId}:${randomUUID()}`;
  t.emit("toolUse", key, { parentKey, toolName, toolCallId, input: inputRecord(input) });
  return { key, toolName, toolCallId, parentKey, ownRun };
}

function endToolCall(call: ToolCall, output: unknown, error?: unknown): void {
  const t = ensureTracker();
  const failure = error ?? failureOf(output);
  t.emit("toolResult", call.key, {
    parentKey: call.parentKey,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    output: failure === undefined ? output : undefined,
    error: failure === undefined ? undefined : describeError(failure),
  });
  if (call.ownRun !== undefined) {
    t.endAgent(call.ownRun, { outcome: failure === undefined ? "success" : "failed" });
  }
}

/**
 * Run `execute` bracketed by a tool span; the one `try` only re-throws.
 * `frame` is what the tool's own body runs inside, when there is one.
 */
function runTool(
  begin: () => ToolCall | undefined,
  execute: () => unknown,
  frame: Frame | undefined,
): unknown {
  const call = core.callSafely(begin, [], `${NAME}.tool`);
  if (!call) return execute();
  const end = (output: unknown, error?: unknown): void => {
    core.callSafely(endToolCall, [call, output, error], `${NAME}.tool`);
  };
  let result: unknown;
  try {
    result = frame ? frames.run(frame, execute) : execute();
  } catch (error) {
    end(undefined, error);
    throw error;
  }
  if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
    return (result as PromiseLike<unknown>).then(
      (value) => {
        end(value);
        return value;
      },
      (error: unknown) => {
        end(undefined, error);
        throw error;
      },
    );
  }
  end(result);
  return result;
}

/** A copy of `tool` with a new `execute`, keeping its prototype and fields. */
function withExecute<T extends object>(tool: T, execute: unknown): T {
  return Object.assign(Object.create(Object.getPrototypeOf(tool) as object | null) as T, tool, { execute });
}

/**
 * Wrap the tools one agent run is about to execute.
 *
 * These are the loop's converted tools, which all share the AI SDK signature
 * `execute(input, { toolCallId, … })` whatever kind of tool they came from, on
 * both major lines — so the input is the validated arguments and the id is the
 * model's own.
 */
function observeTools(tools: unknown, runKey: string, agent: object): unknown {
  if (typeof tools !== "object" || tools === null) return tools;
  const out: Record<string, unknown> = { ...(tools as Record<string, unknown>) };
  for (const [name, tool] of Object.entries(out)) {
    const execute = (tool as { execute?: unknown } | null)?.execute;
    if (typeof tool !== "object" || tool === null || typeof execute !== "function") continue;
    if ((execute as unknown as Record<symbol, unknown>)[WRAPPED] !== undefined) continue;
    const original = execute as (...args: unknown[]) => unknown;
    const wrapped = function failproofaiToolExecute(this: unknown, ...args: unknown[]): unknown {
      const options = args[1] as { toolCallId?: unknown } | undefined;
      const toolCallId = typeof options?.toolCallId === "string" ? options.toolCallId : randomUUID();
      return runTool(
        () => beginToolCall(name, toolCallId, args[0], runKey),
        () => original.apply(this, args),
        { key: runKey, owner: agent, kind: "tool" },
      );
    };
    out[name] = withExecute(tool, markWrapped(wrapped, original));
  }
  return out;
}

/**
 * The input and call id of a direct `tool.execute(...)` call, in either
 * major's signature: 1.x `execute(input, { agent: { toolCallId } })`, 0.x
 * `execute({ context: input, runtimeContext, … }, { toolCallId })`.
 */
function toolCallArgs(args: unknown[]): { input: unknown; toolCallId?: string } {
  const [first, second] = args as [unknown, Record<string, unknown> | undefined];
  const pick = (...values: unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === "string" && value !== "");
  const legacy =
    typeof first === "object" &&
    first !== null &&
    "context" in first &&
    ("runtimeContext" in first || second === undefined || typeof second.toolCallId === "string");
  if (legacy) {
    const envelope = first as { context?: unknown; toolCallId?: unknown };
    return { input: envelope.context, toolCallId: pick(second?.toolCallId, envelope.toolCallId) };
  }
  const agentContext = second?.agent as { toolCallId?: unknown } | undefined;
  return { input: first, toolCallId: pick(agentContext?.toolCallId, second?.toolCallId) };
}

/**
 * Wrap one Mastra tool's `execute` so a DIRECT call is recorded.
 *
 * A tool an agent executes is already recorded by `instrument()` — including
 * tools built before it ran — so this is for the calls no agent makes: a tool
 * invoked from your own code or a workflow step. Inside a Mastra run or a
 * `failproofai` scope it records under that; with nothing open it records the
 * call as its own run, named after the tool. A wrapped tool handed to an agent
 * is not recorded twice.
 */
export function wrapTool<T extends { id?: string; execute?: (...args: never[]) => unknown }>(
  tool: T,
): T {
  const execute = tool.execute;
  if (typeof execute !== "function" || core.isWrapped(execute)) return tool;
  const toolName = typeof tool.id === "string" && tool.id ? tool.id : "tool";
  const original = execute as unknown as (...args: unknown[]) => unknown;

  const wrapped = function failproofaiToolExecute(this: unknown, ...args: unknown[]): unknown {
    const frame = frames.getStore();
    // The agent's own tool wrapper is already recording this very call.
    if (frame?.kind === "tool") return original.apply(this, args);
    return runTool(
      () => {
        const { input, toolCallId } = toolCallArgs(args);
        return beginToolCall(toolName, toolCallId ?? randomUUID(), input, frame?.key);
      },
      () => original.apply(this, args),
      undefined,
    );
  };
  // A new object rather than a mutation: a Mastra tool may be frozen, and
  // assigning to a frozen object fails silently in sloppy mode. The prototype
  // is kept so it is still a `Tool` to Mastra's own checks.
  return withExecute(tool, markWrapped(wrapped, original));
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

interface AgentRun {
  key: string;
  frame: Frame;
  args: unknown[];
  started: number;
  ended: boolean;
}

function endAgentRun(run: AgentRun, outcome: string): void {
  if (run.ended) return;
  run.ended = true;
  ensureTracker().endAgent(run.key, {
    outcome,
    ...core.fwFields({ duration_ms: core.ms(Date.now() - run.started) }),
  });
}

/** How a finished `generate()` / `onFinish` result ended. */
function outcomeOf(result: unknown): string {
  const value = (result ?? {}) as { error?: unknown; finishReason?: unknown; tripwire?: unknown };
  if (value.tripwire) return "rejected";
  if (value.error || value.finishReason === "error") return "failed";
  return "success";
}

/**
 * Compose our end-of-stream callbacks with the caller's.
 *
 * Mastra calls `onFinish` / `onError` / `onAbort` when the stream actually
 * finishes — as it is consumed — which is the moment the run ends. Reading one
 * of the output's promise getters instead would START consumption: Mastra
 * drains the stream into a buffer the first time one is touched, so observing
 * the run would change what it does.
 */
function withStreamCallbacks(options: unknown, run: AgentRun): Record<string, unknown> {
  const base = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>;
  const chain =
    (name: string, ours: (...args: unknown[]) => void) =>
    (...args: unknown[]): unknown => {
      core.callSafely(ours, args, `${NAME}.${name}`);
      const theirs = base[name];
      return typeof theirs === "function" ? (theirs as (...a: unknown[]) => unknown).apply(base, args) : undefined;
    };
  return {
    ...base,
    onFinish: chain("onFinish", (result) => endAgentRun(run, outcomeOf(result))),
    onError: chain("onError", () => endAgentRun(run, "failed")),
    onAbort: chain("onAbort", () => endAgentRun(run, "cancelled")),
  };
}

function beginAgentRun(agent: object, method: string, args: unknown[], streaming: boolean): AgentRun | undefined {
  const parent = frames.getStore();
  // Re-entry from inside the same run — 0.x's `generate` is `stream` under the
  // hood — is the same agent span, not a nested one.
  if (parent?.kind === "agent" && parent.owner === agent) return undefined;
  const t = ensureTracker();
  const key = randomUUID();
  const { label, rawId } = agentLabel(agent);
  const options = (args[1] ?? {}) as { threadId?: unknown; resourceId?: unknown; memory?: { thread?: unknown; resource?: unknown } };
  t.startAgent(key, {
    agentId: label,
    parentKey: parent?.key,
    goal: goalOf(args[0]),
    ...core.fwFields({
      agent_id: rawId,
      method,
      streaming: streaming || undefined,
      thread_id: typeof options.threadId === "string" ? options.threadId : undefined,
      resource_id: typeof options.resourceId === "string" ? options.resourceId : undefined,
    }),
  });
  const run: AgentRun = {
    key,
    frame: { key, owner: agent, kind: "agent" },
    args,
    started: Date.now(),
    ended: false,
  };
  if (streaming) {
    const next = [...args];
    while (next.length < 2) next.push(undefined);
    next[1] = withStreamCallbacks(args[1], run);
    run.args = next;
  }
  return run;
}

function patchAgentMethod(prototype: object, method: string, streaming: boolean): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.${method}`;

  const wrapper = function failproofaiAgentCall(this: object, ...args: unknown[]): unknown {
    const run = core.callSafely(beginAgentRun, [this, method, args, streaming], site);
    if (!run) return fn.apply(this, args);
    const settle = (value: unknown): void => {
      // A stream ends through its callbacks; `stream()` returning only means
      // the loop has started.
      if (!streaming) core.callSafely(endAgentRun, [run, outcomeOf(value)], site);
    };
    let result: unknown;
    try {
      result = frames.run(run.frame, () => fn.apply(this, run.args));
    } catch (error) {
      core.callSafely(endAgentRun, [run, "failed"], site);
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          settle(value);
          return value;
        },
        (error: unknown) => {
          core.callSafely(endAgentRun, [run, "failed"], site);
          throw error;
        },
      );
    }
    settle(result);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return patcher!.patch(prototype, method, markWrapped(wrapper, original));
}

/**
 * Patch a method that BUILDS something the run will use later, so the result
 * is observed with the run that built it. `observe` sees only calls made by
 * the agent's own run; any other caller gets Mastra's value untouched.
 */
function patchBuilder(
  prototype: object,
  method: string,
  observe: (value: unknown, frame: Frame, agent: object) => unknown,
): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.${method}`;
  const wrapper = function failproofaiBuilder(this: object, ...args: unknown[]): unknown {
    const frame = frames.getStore();
    const result = fn.apply(this, args);
    if (frame?.kind !== "agent" || frame.owner !== this) return result;
    const apply = (value: unknown): unknown => {
      const observed = core.callSafely(observe, [value, frame, this], site);
      return observed === undefined ? value : observed;
    };
    return typeof (result as PromiseLike<unknown> | null)?.then === "function"
      ? (result as PromiseLike<unknown>).then(apply)
      : apply(result);
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return patcher!.patch(prototype, method, markWrapped(wrapper, original));
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

interface WorkflowRunLike {
  workflowId?: unknown;
  runId?: unknown;
  isInternalWorkflow?: unknown;
  tracingPolicy?: { internal?: unknown };
}

/** `InternalSpans.WORKFLOW` — Mastra's own bit for "this workflow is plumbing". */
const INTERNAL_WORKFLOW = 1;

function isInternalRun(run: WorkflowRunLike): boolean {
  if (run.isInternalWorkflow === true) return true;
  const internal = run.tracingPolicy?.internal;
  return typeof internal === "number" && (internal & INTERNAL_WORKFLOW) !== 0;
}

/** A workflow's result status as an `agent_end` outcome. */
function workflowOutcome(status: unknown): string {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "tripwire":
      return "rejected";
    default:
      return typeof status === "string" && status ? status : "success";
  }
}

function patchRunMethod(prototype: object, method: string): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.workflow`;

  const begin = (run: WorkflowRunLike & object): { key: string; frame: Frame; runId?: string; started: number } | undefined => {
    if (isInternalRun(run)) return undefined;
    const parent = frames.getStore();
    if (parent?.kind === "workflow" && parent.owner === run) return undefined;
    const key = randomUUID();
    const runId = typeof run.runId === "string" ? run.runId : undefined;
    ensureTracker().startAgent(key, {
      agentId: core.normalizeAgentId(run.workflowId, "workflow"),
      parentKey: parent?.key,
      ...core.fwFields({ kind: "workflow", workflow_run_id: runId, method: method.replace(/^_/, "") }),
    });
    if (runId !== undefined) workflowRuns.set(runId, key);
    return { key, frame: { key, owner: run, kind: "workflow" }, runId, started: Date.now() };
  };
  const end = (
    span: { key: string; runId?: string; started: number },
    outcome: string,
  ): void => {
    if (span.runId !== undefined && workflowRuns.get(span.runId) === span.key) workflowRuns.delete(span.runId);
    ensureTracker().endAgent(span.key, {
      outcome,
      ...core.fwFields({ duration_ms: core.ms(Date.now() - span.started) }),
    });
  };

  const wrapper = function failproofaiWorkflowRun(this: WorkflowRunLike & object, ...args: unknown[]): unknown {
    const span = core.callSafely(begin, [this], site);
    if (!span) return fn.apply(this, args);
    let result: unknown;
    try {
      result = frames.run(span.frame, () => fn.apply(this, args));
    } catch (error) {
      core.callSafely(end, [span, "failed"], site);
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          core.callSafely(end, [span, workflowOutcome((value as { status?: unknown } | null)?.status)], site);
          return value;
        },
        (error: unknown) => {
          core.callSafely(end, [span, "failed"], site);
          throw error;
        },
      );
    }
    core.callSafely(end, [span, workflowOutcome((result as { status?: unknown } | null)?.status)], site);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return patcher!.patch(prototype, method, markWrapped(wrapper, original));
}

let stepSequence = 0;

interface StepSpan {
  runKey: string;
  hookName: string;
  hookId: string;
}

function beginStep(params: unknown): StepSpan | undefined {
  const value = (params ?? {}) as {
    step?: { id?: unknown };
    runId?: unknown;
    executionContext?: { runId?: unknown };
    prevOutput?: unknown;
  };
  const runId = value.executionContext?.runId ?? value.runId;
  const runKey = typeof runId === "string" ? workflowRuns.get(runId) : undefined;
  const hookName = value.step?.id;
  if (runKey === undefined || typeof hookName !== "string" || !hookName) return undefined;
  stepSequence += 1;
  const hookId = `${runKey}:${hookName}:${stepSequence}`;
  ensureTracker().emit("hookTriggered", runKey, {
    hookName,
    hookId,
    triggerEvent: "workflow_step",
    input: value.prevOutput,
  });
  return { runKey, hookName, hookId };
}

interface StepResult {
  status?: unknown;
  output?: unknown;
  error?: unknown;
}

/**
 * The step result inside what `executeStep` resolved with: `{ result: {…} }`
 * from 0.24 on, the bare `{ status, output, error }` before that.
 */
function stepResultOf(value: unknown): StepResult {
  if (typeof value !== "object" || value === null) return {};
  const wrapped = (value as { result?: unknown }).result;
  if (typeof wrapped === "object" && wrapped !== null && "status" in wrapped) return wrapped;
  return value;
}

/**
 * A failed step does not throw out of `executeStep` — Mastra catches it and
 * resolves with `status: "failed"` — so the failure is read off the result.
 * 0.x hands the error over as a rendered string with its stack attached; only
 * the first line is the error.
 */
function stepOutcome(value: unknown, thrown?: unknown): { outcome: string; output?: unknown; error?: string } {
  const result = stepResultOf(value);
  const error = thrown ?? (result.status === "failed" ? (result.error ?? "step failed") : undefined);
  if (error !== undefined) {
    return { outcome: "failed", error: typeof error === "string" ? error.split("\n")[0] : describeError(error) };
  }
  return {
    outcome: typeof result.status === "string" && result.status ? workflowOutcome(result.status) : "success",
    output: result.output,
  };
}

function endStep(span: StepSpan, value: unknown, thrown?: unknown): void {
  ensureTracker().emit("hookCompleted", span.runKey, {
    hookName: span.hookName,
    hookId: span.hookId,
    ...stepOutcome(value, thrown),
  });
}

function patchExecuteStep(prototype: object): boolean {
  const original = (prototype as Record<string, unknown>).executeStep;
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.step`;
  const wrapper = function failproofaiStep(this: unknown, ...args: unknown[]): unknown {
    const span = core.callSafely(beginStep, [args[0]], site);
    if (!span) return fn.apply(this, args);
    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      core.callSafely(endStep, [span, undefined, error], site);
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          core.callSafely(endStep, [span, value], site);
          return value;
        },
        (error: unknown) => {
          core.callSafely(endStep, [span, undefined, error], site);
          throw error;
        },
      );
    }
    core.callSafely(endStep, [span, result], site);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return patcher!.patch(prototype, "executeStep", markWrapped(wrapper, original));
}

/**
 * Run `body` inside an agent span named for a workflow.
 *
 * Mastra workflow runs are recorded automatically once `instrument("mastra")`
 * has run — the run as an agent, its steps as hooks — so this is not needed
 * for them. It stays for grouping work that is not a Mastra workflow (or runs
 * where the adapter is not installed) under one named span.
 */
export function workflow<T>(workflowName: string, body: () => T): T {
  return agentScope(core.normalizeAgentId(workflowName, "workflow"), { fw_kind: "workflow" }, body);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

type ClassLike = { prototype: object };

const AGENT_METHODS = [
  ["generate", false],
  ["stream", true],
  ["generateVNext", false],
  ["streamVNext", true],
  ["generateLegacy", false],
  ["streamLegacy", true],
] as const;

function installAgent(Agent: ClassLike): number {
  let patched = 0;
  for (const [method, streaming] of AGENT_METHODS) {
    if (patchAgentMethod(Agent.prototype, method, streaming)) patched += 1;
  }
  const proto = Agent.prototype as Record<string, unknown>;
  if (compat.probe(NAME, "Agent.resolveModelConfig", () => typeof proto.resolveModelConfig === "function")) {
    patchBuilder(Agent.prototype, "resolveModelConfig", (model, frame) => observeModel(model, frame.key));
  }
  if (compat.probe(NAME, "Agent.convertTools", () => typeof proto.convertTools === "function")) {
    patchBuilder(Agent.prototype, "convertTools", (tools, frame, agent) => observeTools(tools, frame.key, agent));
  }
  return patched;
}

function installWorkflows(module: unknown): void {
  const { Run, DefaultExecutionEngine } = (module ?? {}) as {
    Run?: ClassLike;
    DefaultExecutionEngine?: ClassLike;
  };
  if (compat.probe(NAME, "workflows Run._start", () => typeof (Run?.prototype as Record<string, unknown> | undefined)?._start === "function")) {
    for (const method of ["_start", "_resume", "_restart", "_timeTravel"]) patchRunMethod(Run!.prototype, method);
  }
  if (
    compat.probe(
      NAME,
      "workflows DefaultExecutionEngine.executeStep",
      () => typeof (DefaultExecutionEngine?.prototype as Record<string, unknown> | undefined)?.executeStep === "function",
    )
  ) {
    patchExecuteStep(DefaultExecutionEngine!.prototype);
  }
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    compat.checkVersion(NAME, PACKAGE, {
      minimum: MINIMUM,
      below: "2.0.0",
      reason: "model steps are observed at resolveModelConfig and workflow runs at Run._start",
    });
    ensureTracker(options);
    patcher = new core.Patcher();

    const agentCopies = await compat.requireModuleCopies("@mastra/core/agent", INSTALL);
    let patched = 0;
    for (const copy of agentCopies) {
      const Agent = (copy as { Agent?: unknown }).Agent;
      if (typeof Agent === "function") patched += installAgent(Agent);
    }
    if (patched === 0) {
      patcher.restoreAll();
      throw new Error(
        "could not patch any Agent generate/stream method — this build of @mastra/core " +
          "exposes none of them under a writable name.",
      );
    }

    // Workflows are optional: an app with no workflows is ordinary, and a
    // workflow module that fails to load must not cost the agent patches above.
    const workflowCopies = await compat
      .requireModuleCopies("@mastra/core/workflows", INSTALL)
      .catch(() => [] as unknown[]);
    for (const copy of workflowCopies) installWorkflows(copy);
  },

  uninstall(): void {
    patcher?.restoreAll();
    patcher = null;
    workflowRuns.clear();
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
  },
};

/**
 * The pure readers above, for this package's own unit tests.
 *
 * @internal Not part of the public API: their shapes follow Mastra's and the
 * providers' internals, and change whenever those do.
 */
export const _internals = {
  usageOf,
  finishReasonOf,
  promptOf,
  generateOutcome,
  foldStreamPart,
  toolCallArgs,
  isInternalRun,
  workflowOutcome,
  stepResultOf,
  stepOutcome,
};
