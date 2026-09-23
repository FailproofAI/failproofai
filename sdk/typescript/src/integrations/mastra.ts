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
 * | a workflow step (incl. every branch taken, parallel step and loop iteration) | `hook_triggered` / `hook_completed`, `trigger_event="workflow_step"` |
 * | a nested workflow, or an agent used as a step | a nested agent under the workflow, inside that step's hook |
 * | a step's `suspend()` … `run.resume({ step, resumeData })` | `human_wait` + `agent_pause` … `agent_resume` + `human_input` on the SAME workflow span, which stays open while suspended; ids `<runId>:<step path>` |
 * | `agent.network()` | ONE agent (`fw_method="network"`); the router Mastra builds per decision (`routing-agent`) is that agent's own model steps, and the agent it delegates to is nested under it |
 * | a run an input or output processor blocks (`abort()` / tripwire) | `agent_end` `outcome="rejected"` |
 * | Mastra's own machinery — the agentic loop and a network are built from internal workflows | nothing |
 *
 * **Sessions.** A root run (nothing enclosing it, no `failproofai.session()` /
 * `agent()` scope) takes the conversation id Mastra gives it, the rule every
 * adapter follows ("a conversation spanning runs is one session where the
 * framework provides a conversation id"): an agent run's memory thread
 * (`memory: { thread }`, 0.x `threadId`), so every turn of a thread is one
 * session; a workflow run's run id, so a suspended run and its resume — in
 * this process or another — are one session. Otherwise the session is new.
 * An enclosing scope always wins, and a nested run is in its parent's.
 *
 * A streamed call finalises when Mastra finishes the stream — which it does as
 * the caller consumes it — not when `stream()` returns: the model events carry
 * the real token counts and stop reason, and `agent_end` is not emitted while
 * the loop is still running. A failure is recorded once, on the event it
 * happened in (the `model_response`, the `tool_result`, the `hook_completed`),
 * and closes the enclosing agent `failed`; there is no separate `error` event
 * for each layer the exception unwound through.
 *
 * Token counts are the provider's own, read off each step. A STREAMED step
 * from an OpenAI-compatible endpoint carries none unless the request asked for
 * them (`stream_options.include_usage`), and the model Mastra's router builds
 * for a `{ id, url }` / custom provider does not ask — Mastra itself then
 * reports zero usage — so such a step is recorded without tokens. Nothing a
 * call passes turns it on (`providerOptions` cannot: the provider overwrites
 * `stream_options`); a model built with usage on — `@ai-sdk/openai`, or
 * `createOpenAICompatible({ includeUsage: true })` — is recorded with them.
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
 * * `Agent.prototype.generate` / `.stream` (+ variants) and `.network` — the
 *   agent span.
 * * `Agent.prototype.__runInputProcessors` — where an input processor's
 *   `abort()` lands. A blocked `stream()` calls none of its callbacks, so this
 *   is what ends it (1.x also exposes the stream's finish; 0.x does not).
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

/*
 * ## Lifetime
 *
 * `instrument()` hands Mastra objects that outlive it: a model behind a proxy,
 * tools behind wrappers, a stream the caller is still reading. Restoring the
 * prototypes does not reach any of them, so every recording path checks that
 * the tracker it began on is still LIVE (`live()`), and nothing recreates a
 * tracker behind `uninstrument()`'s back:
 *
 * * `tracker` exists exactly while `enabled` — created by `install()`, dropped
 *   by `uninstall()`. A proxy, wrapper, span or frame remembers the tracker it
 *   was built under; once that tracker is gone it is a pass-through for good,
 *   even after a later `instrument()` creates a new one.
 * * `uninstall()` turns `enabled` off FIRST, then closes what is still open —
 *   model steps, tool calls, workflow steps (marked `fw_incomplete`), then
 *   agents `cancelled` — so the trace ends where the recording did instead of
 *   leaving spans `ongoing` forever.
 * * Open spans are tracked only so teardown can close them. Every end path
 *   removes its own entry; a stream nobody ever consumes has no end path, so
 *   the registries are bounded like the tracker's own run table.
 * * `wrapTool()` works without `instrument()` — it is the call-site helper for
 *   bundled applications — so a call with no live installation records on a
 *   `standalone` tracker, which is self-contained (its run opens and closes in
 *   the one call) and never touched by `uninstall()`.
 */

let enabled = false;
let tracker: core.RunTracker | null = null;
let standalone: core.RunTracker | null = null;
let patcher: core.Patcher | null = null;

function newTracker(options: Record<string, unknown> = {}): core.RunTracker {
  return new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGE),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  });
}

/** May something begun on `t` still record? */
function live(t: core.RunTracker | null | undefined): t is core.RunTracker {
  return t !== null && t !== undefined && ((enabled && t === tracker) || t === standalone);
}

/** Same bound as `RunTracker`'s own run table. */
const MAX_OPEN = 10_000;

/** A span that is open until it is `closed`, on the tracker it began on. */
interface Span {
  tracker: core.RunTracker;
  closed: boolean;
}

/** Open spans, oldest first, forgetting the oldest past `MAX_OPEN`. */
class OpenSpans<T extends Span> {
  private readonly items = new Set<T>();

  add(item: T): void {
    while (this.items.size >= MAX_OPEN) {
      const oldest = this.items.values().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
    this.items.add(item);
  }

  /** End `item`: true when it was still open on a live tracker. */
  close(item: T): boolean {
    this.items.delete(item);
    if (item.closed) return false;
    item.closed = true;
    return live(item.tracker);
  }

  /** Remove and return everything still open, newest first. */
  drain(): T[] {
    const all = [...this.items].reverse().filter((item) => !item.closed);
    this.items.clear();
    for (const item of all) item.closed = true;
    return all;
  }

  get size(): number {
    return this.items.size;
  }
}

/** The Mastra run currently executing, as far as this adapter is concerned. */
interface Frame {
  /** The tracker the run was begun on; a frame from a dead one records nothing. */
  tracker: core.RunTracker;
  /** Our `RunTracker` key for the agent or workflow run. */
  key: string;
  /** The `Agent` or workflow `Run` instance that owns the run. */
  owner: object;
  /** `tool` while a tool the agent called is executing. */
  kind: "agent" | "workflow" | "tool";
  /** Set on the frame of an `agent.network()` run, whose router it absorbs. */
  network?: boolean;
  /** Ends the agent run this frame is, for an end no Mastra callback reports. */
  close?: (outcome: string) => void;
}

const frames = new AsyncLocalStorage<Frame>();

/** Mastra workflow run id -> our key, so a step can find its workflow span. */
const workflowRuns = new Map<string, string>();

const WRAPPED = Symbol.for("failproofai.wrapped");

/**
 * Our own model proxies and agent-tool wrappers, to what they wrap. A reused
 * agent can hand a later run the proxy or tool an earlier run built; that one
 * is bound to the earlier run (or a dead installation), so it is unwrapped and
 * observed afresh rather than skipped as "already wrapped".
 */
const modelProxies = new WeakMap<object, object>();
const toolWrappers = new WeakMap<object, (...args: unknown[]) => unknown>();

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

interface ModelCall extends Span {
  requestId: string;
  runKey: string;
  model?: string;
  started: number;
}

const openModels = new OpenSpans<ModelCall>();

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

function beginModelCall(frame: Frame, model: object, options: unknown): ModelCall | undefined {
  const t = frame.tracker;
  if (!live(t)) return undefined;
  const runKey = frame.key;
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
  const call: ModelCall = { tracker: t, closed: false, requestId, runKey, model: modelId, started: Date.now() };
  openModels.add(call);
  return call;
}

function endModelCall(call: ModelCall, outcome: ModelOutcome): void {
  // Already closed — by teardown, when its installation is gone.
  if (!openModels.close(call)) return;
  const usage = usageOf(outcome.usage);
  call.tracker.emit("modelResponse", call.requestId, {
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
function observedCall(target: object, original: ModelMethod, frame: Frame, name: string): ModelMethod {
  const observed = async function (options: unknown): Promise<unknown> {
    // Built under an installation that is gone: the model, untouched.
    if (!live(frame.tracker)) return original.call(target, options);
    const call = core.callSafely(beginModelCall, [frame, target, options], `${NAME}.model`);
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
      // Pull-based, so a consumer that cancels still closes the step (see
      // core.observeStream). A cancel ends it with the cancel reason as its error.
      stream: core.observeStream(
        stream as ReadableStream<unknown>,
        (part) => foldStreamPart(outcome, part),
        (error) => endModelCall(call, error === undefined ? outcome : { ...outcome, error: outcome.error ?? error }),
        `${NAME}.stream`,
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
function observeModel(model: unknown, frame: Frame): unknown {
  if (typeof model !== "object" || model === null) return model;
  // One of ours from an earlier run: observe the model it wraps, for THIS run.
  const target = modelProxies.get(model) ?? model;
  const doGenerate = (target as { doGenerate?: unknown }).doGenerate;
  const doStream = (target as { doStream?: unknown }).doStream;
  if (typeof doGenerate !== "function" && typeof doStream !== "function") return model;
  if ((target as Record<symbol, unknown>)[WRAPPED] !== undefined) return model;

  const cache = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(target, {
    get(object, property) {
      if (property === WRAPPED) return target;
      const value: unknown = Reflect.get(object, property);
      if (typeof value !== "function" || property === "constructor") return value;
      let bound = cache.get(property);
      if (bound === undefined || (bound as { [WRAPPED]?: unknown })[WRAPPED] !== value) {
        const method = value as ModelMethod;
        bound =
          property === "doGenerate" || property === "doStream"
            ? observedCall(object, method, frame, property)
            : (method as (...args: unknown[]) => unknown).bind(object);
        markWrapped(bound as object, value);
        cache.set(property, bound);
      }
      return bound;
    },
  });
  modelProxies.set(proxy, target);
  return proxy;
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

interface ToolCall extends Span {
  key: string;
  toolName: string;
  toolCallId: string;
  parentKey?: string;
  /** Set when the call opened its own root run, which it must close. */
  ownRun?: string;
}

const openTools = new OpenSpans<ToolCall>();

function beginToolCall(
  t: core.RunTracker,
  toolName: string,
  toolCallId: string,
  input: unknown,
  parentKey: string | undefined,
): ToolCall | undefined {
  if (!live(t)) return undefined;
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
  const call: ToolCall = { tracker: t, closed: false, key, toolName, toolCallId, parentKey, ownRun };
  openTools.add(call);
  return call;
}

function endToolCall(call: ToolCall, output: unknown, error?: unknown): void {
  // Already closed — by teardown, when its installation is gone.
  if (!openTools.close(call)) return;
  const t = call.tracker;
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
function observeTools(tools: unknown, runFrame: Frame, agent: object): unknown {
  if (typeof tools !== "object" || tools === null) return tools;
  const out: Record<string, unknown> = { ...(tools as Record<string, unknown>) };
  const frame: Frame = { tracker: runFrame.tracker, key: runFrame.key, owner: agent, kind: "tool" };
  for (const [name, tool] of Object.entries(out)) {
    const execute = (tool as { execute?: unknown } | null)?.execute;
    if (typeof tool !== "object" || tool === null || typeof execute !== "function") continue;
    // One of ours from an earlier run: wrap what it wraps, for THIS run.
    const ours = toolWrappers.get(execute);
    if (ours === undefined && (execute as unknown as Record<symbol, unknown>)[WRAPPED] !== undefined) continue;
    const original = ours ?? (execute as (...args: unknown[]) => unknown);
    const wrapped = function failproofaiToolExecute(this: unknown, ...args: unknown[]): unknown {
      // Built under an installation that is gone: the tool, untouched.
      if (!live(frame.tracker)) return original.apply(this, args);
      const options = args[1] as { toolCallId?: unknown } | undefined;
      const toolCallId = typeof options?.toolCallId === "string" ? options.toolCallId : randomUUID();
      return runTool(
        () => beginToolCall(frame.tracker, name, toolCallId, args[0], frame.key),
        () => original.apply(this, args),
        frame,
      );
    };
    toolWrappers.set(wrapped, original);
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
    // The agent's own tool wrapper is already recording this very call; and
    // inside a run whose installation is gone, nothing records.
    if (frame?.kind === "tool" || (frame !== undefined && !live(frame.tracker))) {
      return original.apply(this, args);
    }
    return runTool(
      () => {
        const { input, toolCallId } = toolCallArgs(args);
        const t = frame?.tracker ?? (enabled && tracker !== null ? tracker : (standalone ??= newTracker()));
        return beginToolCall(t, toolName, toolCallId ?? randomUUID(), input, frame?.key);
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

/**
 * How an agent method is called: `generate` resolves with the finished run,
 * `stream` resolves as soon as the loop starts and finishes as the caller
 * consumes it, and `network` resolves with a stream that runs on its own.
 */
type AgentCallMode = "generate" | "stream" | "network";

interface AgentRun {
  tracker: core.RunTracker;
  key: string;
  frame: Frame;
  args: unknown[];
  started: number;
  ended: boolean;
  /**
   * Set when this call is recorded as part of an enclosing span rather than as
   * a span of its own — a network's router — so it never emits `agent_end`.
   */
  borrowed?: boolean;
}

function endAgentRun(run: AgentRun, outcome: string): void {
  if (run.ended) return;
  run.ended = true;
  if (run.borrowed) return;
  // Closed `cancelled` already, by the teardown that made it not live.
  if (!live(run.tracker)) return;
  run.tracker.endAgent(run.key, {
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

/**
 * Close a streamed run that no callback will close.
 *
 * A stream a processor blocks — an input processor's `abort()`, or one on the
 * output stream — ends with a `tripwire` chunk and calls none of `onFinish` /
 * `onError` / `onAbort` (1.x and 0.x alike), so without this its agent stayed
 * open forever. The output's `_waitUntilFinished()` settles when the stream
 * does, without starting consumption the way its promise getters would; a run
 * the callbacks already closed makes this a no-op.
 */
function closeWhenFinished(run: AgentRun, output: unknown): void {
  const wait = (output as { _waitUntilFinished?: unknown } | null)?._waitUntilFinished;
  if (typeof wait !== "function") return;
  const waiting = (wait as () => unknown).call(output);
  const finish = (): void => {
    endAgentRun(run, (output as { tripwire?: unknown }).tripwire ? "rejected" : "success");
  };
  Promise.resolve(waiting).then(
    () => core.callSafely(finish, [], `${NAME}.stream`),
    () => undefined,
  );
}

/**
 * Close a network run when its stream does.
 *
 * `network()` resolves with a stream that runs by itself — its workflow starts
 * as the stream is constructed and does not wait on the reader — and whose
 * `status` getter settles once it has finished, without consuming anything.
 */
function closeNetworkWhenFinished(run: AgentRun, stream: unknown): void {
  const status = (stream as { status?: unknown } | null)?.status;
  if (typeof (status as PromiseLike<unknown> | undefined)?.then !== "function") {
    endAgentRun(run, "success");
    return;
  }
  const site = `${NAME}.network`;
  Promise.resolve(status).then(
    (value) => core.callSafely(endAgentRun, [run, workflowOutcome(value)], site),
    () => core.callSafely(endAgentRun, [run, "failed"], site),
  );
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The conversation a call belongs to: its memory thread and resource, in the
 * 1.x shape (`memory: { thread, resource }`, the thread a string or `{ id }`)
 * or 0.x's older top-level `threadId` / `resourceId`.
 */
function conversationOf(options: unknown): { thread?: string; resource?: string } {
  const value = (typeof options === "object" && options !== null ? options : {}) as {
    threadId?: unknown;
    resourceId?: unknown;
    memory?: unknown;
  };
  const memory = (typeof value.memory === "object" && value.memory !== null ? value.memory : {}) as {
    thread?: unknown;
    resource?: unknown;
  };
  const threadObject = (typeof memory.thread === "object" && memory.thread !== null ? memory.thread : {}) as {
    id?: unknown;
  };
  return {
    thread: nonEmpty(memory.thread) ?? nonEmpty(threadObject.id) ?? nonEmpty(value.threadId),
    resource: nonEmpty(memory.resource) ?? nonEmpty(value.resourceId),
  };
}

/**
 * The agent an `agent.network()` builds for itself to route with.
 *
 * Every routing decision and completion check of a network is a fresh
 * `routing-agent` running on the network agent's own model. It IS the
 * network's decision loop, so its model calls are recorded as the network
 * agent's own steps rather than as one more agent per decision.
 */
function isRoutingAgent(agent: object): boolean {
  const { id, name } = agent as { id?: unknown; name?: unknown };
  return id === "routing-agent" || name === "routing-agent";
}

/**
 * Whether a run is a root nothing has put in a session yet — then the
 * conversation id the framework gives it is its session. An enclosing
 * `failproofai.session()` / `agent()` scope always wins.
 */
function isUnscopedRoot(parent: Frame | undefined): boolean {
  return parent === undefined && currentIdentity().sessionId === null;
}

function beginAgentRun(agent: object, method: string, args: unknown[], mode: AgentCallMode): AgentRun | undefined {
  const t = tracker;
  if (!enabled || t === null) return undefined;
  const parent = frames.getStore();
  // Inside a run whose installation is gone: that whole tree is unrecorded.
  if (parent !== undefined && !live(parent.tracker)) return undefined;
  // Re-entry from inside the same run — 0.x's `generate` is `stream` under the
  // hood — is the same agent span, not a nested one.
  if (parent?.kind === "agent" && parent.owner === agent) return undefined;
  if (parent?.network === true && isRoutingAgent(agent)) {
    // The network's own router: recorded on the network's span, not its own.
    return {
      tracker: t,
      key: parent.key,
      frame: { tracker: t, key: parent.key, owner: agent, kind: "agent" },
      args,
      started: Date.now(),
      ended: false,
      borrowed: true,
    };
  }
  const key = randomUUID();
  const { label, rawId } = agentLabel(agent);
  const { thread, resource } = conversationOf(args[1]);
  t.startAgent(key, {
    agentId: label,
    parentKey: parent?.key,
    // A memory thread is a conversation that spans runs: the session, for a
    // run nothing else has put in one.
    sessionId: isUnscopedRoot(parent) ? thread : undefined,
    goal: goalOf(args[0]),
    ...core.fwFields({
      agent_id: rawId,
      method,
      streaming: mode === "stream" || undefined,
      thread_id: thread,
      resource_id: resource,
    }),
  });
  const run: AgentRun = {
    tracker: t,
    key,
    frame: { tracker: t, key, owner: agent, kind: "agent", network: mode === "network" || undefined },
    args,
    started: Date.now(),
    ended: false,
  };
  run.frame.close = (outcome: string): void => endAgentRun(run, outcome);
  if (mode === "stream") {
    const next = [...args];
    while (next.length < 2) next.push(undefined);
    next[1] = withStreamCallbacks(args[1], run);
    run.args = next;
  }
  return run;
}

function patchAgentMethod(prototype: object, method: string, mode: AgentCallMode): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.${method}`;

  const wrapper = function failproofaiAgentCall(this: object, ...args: unknown[]): unknown {
    const run = core.callSafely(beginAgentRun, [this, method, args, mode], site);
    if (!run) return fn.apply(this, args);
    const settle = (value: unknown): void => {
      if (run.borrowed) return;
      // A stream ends through its callbacks — `stream()` returning only means
      // the loop has started — or, when none will fire, as it finishes.
      if (mode === "stream") core.callSafely(closeWhenFinished, [run, value], site);
      else if (mode === "network") core.callSafely(closeNetworkWhenFinished, [run, value], site);
      else core.callSafely(endAgentRun, [run, outcomeOf(value)], site);
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
 * End a run the moment an input processor blocks its prompt.
 *
 * `__runInputProcessors` is where every input processor's `abort()` lands, and
 * its result says so (`tripwire` in 1.x, `tripwireTriggered` in 0.x). A
 * blocked `generate()` resolves with the tripwire and ends there anyway, but a
 * blocked `stream()` calls none of its callbacks — and 0.x's output offers no
 * other end signal — so without this its agent stayed open for good. Nothing
 * the run would have done follows a blocked prompt, so it ends here.
 */
function patchInputProcessors(prototype: object): void {
  const method = "__runInputProcessors";
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.inputProcessors`;
  const blocked = (value: unknown): boolean => {
    const result = (value ?? {}) as { tripwire?: unknown; tripwireTriggered?: unknown };
    return result.tripwireTriggered === true || (result.tripwire !== undefined && result.tripwire !== null && result.tripwire !== false);
  };
  const wrapper = function failproofaiInputProcessors(this: object, ...args: unknown[]): unknown {
    const frame = frames.getStore();
    const result = fn.apply(this, args);
    const close = frame?.kind === "agent" && frame.owner === this ? frame.close : undefined;
    if (close === undefined) return result;
    const check = (value: unknown): void => {
      if (blocked(value)) close("rejected");
    };
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      return (result as PromiseLike<unknown>).then((value) => {
        core.callSafely(check, [value], site);
        return value;
      });
    }
    core.callSafely(check, [result], site);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  patcher!.patch(prototype, method, markWrapped(wrapper, original));
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
    if (frame?.kind !== "agent" || frame.owner !== this || !live(frame.tracker)) return result;
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

interface WorkflowSpan {
  tracker: core.RunTracker;
  key: string;
  frame: Frame;
  runId?: string;
  started: number;
}

/**
 * The workflows `agent.network()` is built from. 1.x marks them internal
 * (`tracingPolicy.internal`); 0.x marks them nothing, so inside a network run
 * they are recognised by id — anywhere else a workflow of that name is the
 * user's and recorded as usual.
 */
const NETWORK_WORKFLOWS: ReadonlySet<unknown> = new Set([
  "agent-loop-main-workflow",
  "Agent-Network-Outer-Workflow",
  "iteration-with-validation",
]);

// ---------------------------------------------------------------------------
// Suspend / resume (human in the loop)
// ---------------------------------------------------------------------------

/**
 * A workflow run that suspended and waits to be resumed.
 *
 * A suspended run deliberately keeps its agent open, as a LangGraph interrupt
 * does: closing it would close the pause with it, zeroing the one interval
 * that measures how long the human took. The resume continues the SAME span.
 * A resume that lands in another process — the ordinary deployment shape, one
 * worker suspends and whichever picks up the approval resumes from storage —
 * finds nothing here, starts a new span in the same session (a root workflow's
 * session is its run id) and closes the pause by its deterministic id.
 */
interface PausedRun {
  tracker: core.RunTracker;
  key: string;
  started: number;
  /** Open pause id -> the step path it waits on. */
  pauses: Map<string, string>;
}

/** Mastra workflow run id -> its paused span. */
const pausedRuns = new Map<string, PausedRun>();

function rememberPaused(runId: string, paused: PausedRun): void {
  pausedRuns.delete(runId);
  while (pausedRuns.size >= MAX_OPEN) {
    const oldest = pausedRuns.entries().next();
    if (oldest.done) break;
    pausedRuns.delete(oldest.value[0]);
    // Never closed from here: the resume may still come, in any process.
    oldest.value[1].tracker.forget(oldest.value[1].key);
  }
  pausedRuns.set(runId, paused);
}

/** A suspend payload or resume answer as the text a human read or wrote. */
function humanText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const { prompt, question, message } = value as Record<string, unknown>;
    const text = prompt ?? question ?? message;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** The steps a `suspended` result waits on: their path, and what each asked. */
function suspendedStepsOf(result: unknown): Array<{ path: string; payload: unknown }> {
  const value = (result ?? {}) as {
    suspended?: unknown;
    steps?: Record<string, { status?: unknown; suspendPayload?: unknown } | undefined>;
    suspendPayload?: Record<string, unknown>;
  };
  const payloadOf = (id: string): unknown => value.steps?.[id]?.suspendPayload ?? value.suspendPayload?.[id];
  const out: Array<{ path: string; payload: unknown }> = [];
  if (Array.isArray(value.suspended)) {
    for (const entry of value.suspended) {
      const ids = (Array.isArray(entry) ? entry : [entry]).filter(
        (id): id is string => typeof id === "string" && id !== "",
      );
      if (ids.length > 0) out.push({ path: ids.join("."), payload: payloadOf(ids[0]!) });
    }
  }
  if (out.length === 0 && typeof value.steps === "object" && value.steps !== null) {
    for (const [id, step] of Object.entries(value.steps)) {
      if (step?.status === "suspended") out.push({ path: id, payload: step.suspendPayload });
    }
  }
  return out;
}

/**
 * The step a `run.resume({ step, resumeData })` resumes, as a path: a step id,
 * a `Step`, or an array of either for a step inside a nested workflow.
 */
function resumeTargetOf(params: unknown): { path?: string; answer: unknown } {
  const value = (params ?? {}) as { step?: unknown; resumeData?: unknown };
  const ids = (Array.isArray(value.step) ? value.step : [value.step])
    .map((step: unknown) => (typeof step === "string" ? step : (step as { id?: unknown } | null)?.id))
    .filter((id): id is string => typeof id === "string" && id !== "");
  return { path: ids.length > 0 ? ids.join(".") : undefined, answer: value.resumeData };
}

const pauseIdOf = (runId: string, path: string): string => `${runId}:${path}`;

/** `human_wait` + `agent_pause` for each step newly suspended, in that order. */
function suspendRun(span: WorkflowSpan, runId: string, result: unknown): void {
  const existing = pausedRuns.get(runId);
  const paused: PausedRun =
    existing !== undefined && existing.key === span.key
      ? existing
      : { tracker: span.tracker, key: span.key, started: span.started, pauses: new Map() };
  for (const { path, payload } of suspendedStepsOf(result)) {
    const pauseId = pauseIdOf(runId, path);
    if (paused.pauses.has(pauseId)) continue;
    paused.pauses.set(pauseId, path);
    const marker = core.fwFields({ step_id: path, workflow_run_id: runId });
    span.tracker.emit("humanWait", span.key, {
      inputId: pauseId,
      prompt: humanText(payload),
      reason: "mastra_suspend",
      ...marker,
    });
    span.tracker.emit("agentPause", span.key, { pauseId, reason: "mastra_suspend", ...marker });
  }
  rememberPaused(runId, paused);
}

/**
 * `agent_resume` + `human_input` for the pauses a resume answers: the step it
 * names (and anything nested under it), or every open pause when it names
 * none. With no pause open in this process, the one the named step must have
 * opened elsewhere — the same id, since it is derived from the run and step.
 */
function resumeRun(span: WorkflowSpan, runId: string, params: unknown, paused: PausedRun | undefined): void {
  const { path, answer } = resumeTargetOf(params);
  const response = humanText(answer);
  const emit = (pauseId: string, stepPath: string, elsewhere: boolean): void => {
    const marker = core.fwFields({
      step_id: stepPath,
      workflow_run_id: runId,
      resumed_elsewhere: elsewhere || undefined,
    });
    span.tracker.emit("agentResume", span.key, { pauseId, reason: "mastra_resume", ...marker });
    span.tracker.emit("humanInput", span.key, { inputId: pauseId, response, ...marker });
  };
  if (paused === undefined) {
    if (path !== undefined) emit(pauseIdOf(runId, path), path, true);
    return;
  }
  for (const [pauseId, stepPath] of [...paused.pauses]) {
    if (path !== undefined && stepPath !== path && !stepPath.startsWith(`${path}.`)) continue;
    paused.pauses.delete(pauseId);
    emit(pauseId, stepPath, false);
  }
}

function patchRunMethod(prototype: object, method: string): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function" || core.isWrapped(original)) return false;
  const fn = original as (...args: unknown[]) => unknown;
  const site = `${NAME}.workflow`;
  const resuming = method === "_resume";

  const begin = (run: WorkflowRunLike & object, args: unknown[]): WorkflowSpan | undefined => {
    const t = tracker;
    if (!enabled || t === null || isInternalRun(run)) return undefined;
    const parent = frames.getStore();
    if (parent !== undefined && !live(parent.tracker)) return undefined;
    if (parent?.kind === "workflow" && parent.owner === run) return undefined;
    // A network's own machinery (0.x marks it nothing): its agents land on
    // the network's span.
    if (parent?.network === true && NETWORK_WORKFLOWS.has(run.workflowId)) return undefined;
    const runId = typeof run.runId === "string" ? run.runId : undefined;

    const paused = resuming && runId !== undefined ? pausedRuns.get(runId) : undefined;
    if (paused !== undefined && paused.tracker === t && t.isOpen(paused.key)) {
      // Resuming a run this process suspended: the same span, continued.
      const span: WorkflowSpan = {
        tracker: t,
        key: paused.key,
        frame: { tracker: t, key: paused.key, owner: run, kind: "workflow" },
        runId,
        started: paused.started,
      };
      workflowRuns.set(runId!, paused.key);
      resumeRun(span, runId!, args[0], paused);
      return span;
    }

    const key = randomUUID();
    t.startAgent(key, {
      agentId: core.normalizeAgentId(run.workflowId, "workflow"),
      parentKey: parent?.key,
      // A root run's session is its run id — the one thing its resume, in
      // this process or another, is sure to share with it.
      sessionId: isUnscopedRoot(parent) ? runId : undefined,
      ...core.fwFields({ kind: "workflow", workflow_run_id: runId, method: method.replace(/^_/, "") }),
    });
    const span: WorkflowSpan = {
      tracker: t,
      key,
      frame: { tracker: t, key, owner: run, kind: "workflow" },
      runId,
      started: Date.now(),
    };
    if (runId !== undefined) {
      workflowRuns.set(runId, key);
      if (resuming) resumeRun(span, runId, args[0], undefined);
    }
    return span;
  };
  const end = (span: WorkflowSpan, value: unknown, failed = false): void => {
    if (span.runId !== undefined && workflowRuns.get(span.runId) === span.key) workflowRuns.delete(span.runId);
    // Closed `cancelled` already, by the teardown that made it not live.
    if (!live(span.tracker)) return;
    const status = failed ? "failed" : (value as { status?: unknown } | null)?.status;
    if (status === "suspended" && span.runId !== undefined) {
      suspendRun(span, span.runId, value);
      return;
    }
    if (span.runId !== undefined && pausedRuns.get(span.runId)?.key === span.key) pausedRuns.delete(span.runId);
    span.tracker.endAgent(span.key, {
      outcome: workflowOutcome(status),
      ...core.fwFields({ duration_ms: core.ms(Date.now() - span.started) }),
    });
  };

  const wrapper = function failproofaiWorkflowRun(this: WorkflowRunLike & object, ...args: unknown[]): unknown {
    const span = core.callSafely(begin, [this, args], site);
    if (!span) return fn.apply(this, args);
    let result: unknown;
    try {
      result = frames.run(span.frame, () => fn.apply(this, args));
    } catch (error) {
      core.callSafely(end, [span, undefined, true], site);
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then === "function") {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          core.callSafely(end, [span, value], site);
          return value;
        },
        (error: unknown) => {
          core.callSafely(end, [span, undefined, true], site);
          throw error;
        },
      );
    }
    core.callSafely(end, [span, result], site);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return patcher!.patch(prototype, method, markWrapped(wrapper, original));
}

let stepSequence = 0;

interface StepSpan extends Span {
  runKey: string;
  hookName: string;
  hookId: string;
}

const openSteps = new OpenSpans<StepSpan>();

function beginStep(params: unknown): StepSpan | undefined {
  const t = tracker;
  if (!enabled || t === null) return undefined;
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
  // Only a step of the recorded run ITSELF. An agent that runs inside it
  // executes its own loop as internal workflows, and one called with the
  // run's id — as 0.x's network calls its sub-agents — hands those internal
  // steps the same run id; they execute in the agent's frame, not the run's.
  const frame = frames.getStore();
  if (frame?.kind !== "workflow" || frame.key !== runKey) return undefined;
  stepSequence += 1;
  const hookId = `${runKey}:${hookName}:${stepSequence}`;
  t.emit("hookTriggered", runKey, {
    hookName,
    hookId,
    triggerEvent: "workflow_step",
    input: value.prevOutput,
  });
  const span: StepSpan = { tracker: t, closed: false, runKey, hookName, hookId };
  openSteps.add(span);
  return span;
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
  // Already closed — by teardown, when its installation is gone.
  if (!openSteps.close(span)) return;
  span.tracker.emit("hookCompleted", span.runKey, {
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
  ["generate", "generate"],
  ["stream", "stream"],
  ["generateVNext", "generate"],
  ["streamVNext", "stream"],
  ["generateLegacy", "generate"],
  ["streamLegacy", "stream"],
  ["network", "network"],
] as const;

function installAgent(Agent: ClassLike): number {
  let patched = 0;
  for (const [method, mode] of AGENT_METHODS) {
    if (patchAgentMethod(Agent.prototype, method, mode)) patched += 1;
  }
  const proto = Agent.prototype as Record<string, unknown>;
  if (compat.probe(NAME, "Agent.resolveModelConfig", () => typeof proto.resolveModelConfig === "function")) {
    patchBuilder(Agent.prototype, "resolveModelConfig", (model, frame) => observeModel(model, frame));
  }
  if (compat.probe(NAME, "Agent.convertTools", () => typeof proto.convertTools === "function")) {
    patchBuilder(Agent.prototype, "convertTools", (tools, frame, agent) => observeTools(tools, frame, agent));
  }
  // Optional, and silent when absent: without it a blocked stream is closed
  // by its finish (1.x) or at teardown (0.x), rather than never recorded.
  patchInputProcessors(Agent.prototype);
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
    const agentCopies = await compat.requireModuleCopies("@mastra/core/agent", INSTALL);
    // Workflows are optional: an app with no workflows is ordinary, and a
    // workflow module that fails to load must not cost the agent patches below.
    const workflowCopies = await compat
      .requireModuleCopies("@mastra/core/workflows", INSTALL)
      .catch(() => [] as unknown[]);

    // A fresh tracker per installation, never one left over: whatever an
    // earlier installation built stays bound to ITS tracker, which is dead.
    teardown();
    tracker = newTracker(options);
    patcher = new core.Patcher();

    let patched = 0;
    for (const copy of agentCopies) {
      const Agent = (copy as { Agent?: unknown }).Agent;
      if (typeof Agent === "function") patched += installAgent(Agent);
    }
    if (patched === 0) {
      teardown();
      throw new Error(
        "could not patch any Agent generate/stream method — this build of @mastra/core " +
          "exposes none of them under a writable name.",
      );
    }
    for (const copy of workflowCopies) installWorkflows(copy);
    enabled = true;
  },

  uninstall(): void {
    teardown();
  },
};

/**
 * Stop recording and close what is still open, on the tracker it opened on.
 * The switch goes FIRST: nothing may begin a span while the rest are closed.
 */
function teardown(): void {
  enabled = false;
  patcher?.restoreAll();
  patcher = null;
  workflowRuns.clear();
  pausedRuns.clear();
  const t = tracker;
  tracker = null;
  const models = openModels.drain();
  const tools = openTools.drain();
  const steps = openSteps.drain();
  if (t === null) return;
  const site = `${NAME}.uninstall`;
  const incomplete = core.fwFields({ incomplete: true });
  // Innermost first — a step's model calls and tools before the step — and
  // every leaf before the agents that own it.
  for (const call of models) {
    if (call.tracker !== t) continue;
    core.callSafely(
      () =>
        t.emit("modelResponse", call.requestId, {
          parentKey: call.runKey,
          model: call.model,
          stopReason: "incomplete", // the LangChain adapter's word for a model call cut off mid-flight
          requestId: call.requestId,
          ...core.fwFields({ duration_ms: core.ms(Date.now() - call.started), incomplete: true }),
        }),
      [],
      site,
    );
  }
  for (const call of tools) {
    if (call.tracker !== t) continue;
    core.callSafely(
      () =>
        t.emit("toolResult", call.key, {
          parentKey: call.parentKey,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          ...incomplete,
        }),
      [],
      site,
    );
  }
  for (const span of steps) {
    if (span.tracker !== t) continue;
    core.callSafely(
      () =>
        t.emit("hookCompleted", span.runKey, {
          hookName: span.hookName,
          hookId: span.hookId,
          outcome: "cancelled",
          ...incomplete,
        }),
      [],
      site,
    );
  }
  core.callSafely(() => t.closeOpenAgents("cancelled"), [], site);
  t.reset();
}

/**
 * The pure readers above and two lifecycle probes, for this package's own
 * unit tests.
 *
 * @internal Not part of the public API — `stripInternal` drops it from the
 * published declarations: their shapes follow Mastra's and the providers' internals, and
 * change whenever those do. Nothing exported references it.
 */
export const _internals = {
  /** Whether an installation is live. */
  isEnabled: (): boolean => enabled,
  /** How many suspended workflow runs are waiting on a resume. */
  pausedRuns: (): number => pausedRuns.size,
  /** How many spans of each kind are open, for the bookkeeping tests. */
  openSpans: (): Record<string, number> => ({
    models: openModels.size,
    tools: openTools.size,
    steps: openSteps.size,
    workflowRuns: workflowRuns.size,
    agents: tracker?.openAgents().length ?? 0,
  }),
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
  conversationOf,
  isRoutingAgent,
  suspendedStepsOf,
  resumeTargetOf,
  humanText,
};
