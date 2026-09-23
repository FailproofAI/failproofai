/**
 * LlamaIndex.TS (`llamaindex`, `@llamaindex/core`, `@llamaindex/workflow`).
 *
 * The TypeScript counterpart of the Python SDK's `integrations/llama_index.py`,
 * and it must draw the same tree for the same program:
 *
 * | LlamaIndex.TS                         | FailproofAI                                   |
 * |---------------------------------------|-----------------------------------------------|
 * | `AgentWorkflow` run (`agent()`)       | session + `agent_start`/`agent_end`           |
 * | nested run (inside a tool, a scope)   | nested `agent_start`/`agent_end`              |
 * | `multiAgent()` handoff                | nested agent per agent holding the turn       |
 * | workflow step                         | `hook_triggered`/`hook_completed`, `trigger_event="workflow_step"` |
 * | legacy `LLMAgent` / `AgentRunner` task| `agent_start`/`agent_end` across ALL its steps |
 * | `createWorkflow()` workflow (core ≥1.1)| `agent_start`/`agent_end` (`"Workflow"`), steps as hooks |
 * | LLM chat                              | `model_request`/`model_response` on `request_id` |
 * | tool call                             | `tool_use`/`tool_result`, the model's call id |
 * | retrieval                             | `tool_use`/`tool_result` named after the retriever's class, output summarised |
 * | top-level chat engine / query engine / retriever / `llm.chat()` / tool | its own root run, named after its class |
 *
 * `agent_id` is the agent's `name` (`"Agent"` when unnamed, as in Python), the
 * class name for a multi-agent workflow or a legacy runner — never an id.
 *
 * ## Two extension points, because LlamaIndex.TS has two halves
 *
 * **The callback bus** (`Settings.callbackManager`, from `@llamaindex/core/global`)
 * carries everything below the agent: `llm-start`/`llm-stream`/`llm-end`,
 * `llm-tool-call`/`llm-tool-result`, `retrieve-*`, `query-*`, and the legacy
 * runner's `agent-start`/`agent-end`. Subscribing is the whole integration for
 * that half, and uninstrumenting is unsubscribing.
 *
 * **The workflow runtime** (`@llamaindex/workflow` ≥1.1, on
 * `@llamaindex/workflow-core`) emits NOTHING on that bus: an `agent().run()`
 * has no run boundary and no step events there at all. What it does have is the
 * middleware surface its own first-party middleware is built on — a context's
 * `__internal__call_context` (wraps every step handler invocation; this is how
 * `withTraceEvents` works) and `__internal__call_send_event` (sees every event
 * a step sends; this is how `withState` works). So `AgentWorkflow.prototype.runStream`
 * — which `run()` also goes through — is wrapped to open the run and to attach
 * those two subscriptions to the context it creates. That is a prototype patch,
 * so it records agents built before `instrument()` too.
 *
 * Three smaller hooks fill what neither half says, each on one object and each
 * undone by `uninstrument()`:
 *
 *   * **Invocation boundaries.** A chat engine's `chat()` dispatches nothing of
 *     its own, so its retrieval and its model call used to become two root runs
 *     in two sessions. Every `@wrapEventCaller` method runs as
 *     `storage.run(new EventCaller(...), fn)` on ONE module-private storage in
 *     `@llamaindex/core/global`; an own `run` on that storage (found through the
 *     exported `getEventCaller()`, see `eventCallerStorage`) sees each
 *     invocation start and return. A top-level invocation is then one run named
 *     after its class that ends when it returns, and an invocation that THROWS
 *     is the failure signal `wrapLLMEvent` and the legacy runner lack.
 *   * **Retriever names.** `retrieve-start` carries only the query; the patched
 *     `BaseRetriever.prototype.retrieve` binds the retriever for it.
 *   * **Plain workflows.** workflow-core ≥1.1 runs every step handler as
 *     `AsyncContext.Variable#run(handlerContext, …)`, a class it exports; its
 *     prototype `run` sees every step of every context. See `plainStep` for why
 *     such a run ends when its context goes idle.
 *
 * ## Correlation, which LlamaIndex.TS does not give us
 *
 * The bus events carry an id that pairs start with end and nothing that says
 * which run they belong to. Two signals do, and we use both:
 *
 *   * our own `AsyncLocalStorage` frame, bound around every workflow step we
 *     wrap. The bus dispatches in a `queueMicrotask`, which Node runs in the
 *     dispatcher's async context, so a handler sees the step that caused it;
 *   * LlamaIndex's own `EventCaller` (`event.reason`), set by `@wrapEventCaller`
 *     — on `AgentRunner.chat`, `BaseQueryEngine.query` and every first-party
 *     provider's `chat`. `withEventCaller` binds a FRESH `EventCaller` per
 *     invocation in LlamaIndex's own `AsyncLocalStorage`, chained through
 *     `.parent` to the invocation it ran inside. A legacy task or a query run is
 *     registered under the `EventCaller` of the invocation that opened it, and
 *     an event belongs to it when that exact object is on the event's chain.
 *
 * The invocation, NOT the object that owns it. One query engine (or one
 * `LLMAgent`) built at startup and serving every request is the normal
 * deployment, so the owner is the same object for every concurrent call; keyed
 * by owner, request B's `query-start` found A's run, treated itself as nested
 * and recorded nothing of its own. The `EventCaller` is per call and already
 * flows through the async context, which is why it is used rather than a
 * prototype patch of `query`/`chat`: `@wrapEventCaller` binds the method onto
 * each INSTANCE at construction (`this.query = (...) => withEventCaller(...)`),
 * so a prototype patch would miss every engine built before `instrument()`.
 *
 * Only a bus that carries no `EventCaller` (a build without one; the unit
 * tests' stand-ins) falls back to matching the owner objects in
 * `computedCallers`, and there a run owned by the object STARTING a new run is
 * never taken as its parent: without the chain a concurrent sibling on a shared
 * object is indistinguishable from re-entry, and the sibling is the common case.
 *
 * When both our frame and a caller match, the deeper run wins. When neither
 * does, the call is a root run of its own — the LangChain/Python precedent for a
 * bare model call — and nests under an enclosing `failproofai.session()`/
 * `agent()` scope if there is one.
 *
 * ## Known gaps, each one the framework's and each one documented, not faked
 *
 *   * A model call has no failure signal of its own: `wrapLLMEvent` has no error
 *     path (no `llm-end` when `chat()` throws). A provider whose `chat` is
 *     `@wrapEventCaller` (every first-party one) fails with its invocation, and
 *     inside a workflow the failed step closes it. A STREAM that fails while it
 *     is being read, outside a workflow, has returned already: that leaf stays
 *     open until the reaper (`staleAfter`) or `uninstrument()`.
 *   * A provider error mid-stream inside `agent().run()` escapes LlamaIndex's
 *     workflow runtime as an UNHANDLED rejection and `run()` never settles —
 *     with or without this SDK. The failed step still closes the run, failed.
 *   * `callTool` dispatches no `llm-tool-result` when a tool throws. In a
 *     workflow the runtime's own tool-result event closes it with the error; in
 *     a legacy agent the next model call does, from the tool-result message.
 *   * No embedding events exist on the TS bus, so `embeddings: true` has
 *     nothing to record.
 *   * Streamed calls carry token usage only when the provider sends it:
 *     `@llamaindex/openai` requests it only with
 *     `additionalChatOptions: { stream_options: { include_usage: true } }`.
 *   * A plain `createWorkflow()` workflow is a run only on workflow-core ≥1.1
 *     resolvable from the application (not the floor's `@llama-flow/core`, not
 *     an unhoisted pnpm layout): elsewhere its model calls are loose root runs.
 *     Its run ends when the context goes idle, so a workflow that waits for an
 *     event from outside records each burst as its own run, and it is named
 *     `"Workflow"` — the runtime has no name to give it (wrap it in
 *     `failproofai.agent("name", …)` to name the parent).
 *   * No human-in-the-loop pairs: the TS runtime has no waiting-for-event signal.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { logger } from "../logger.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "llamaindex";
const PACKAGE = "llamaindex";
const CORE_PACKAGE = "@llamaindex/core";
const WORKFLOW_PACKAGE = "@llamaindex/workflow";
const ASYNC_CONTEXT_MODULE = "@llamaindex/workflow-core/async-context";
const INSTALL = "npm install llamaindex";

/**
 * 0.11.4 is a CAPABILITY floor: it is the first `llamaindex` whose agent API
 * (`agent()` / `multiAgent()`) runs on the `@llamaindex/workflow` 1.1 runtime
 * this adapter wraps. 0.9–0.11.3 ship workflow 1.0, a different class-based
 * runtime with none of the surfaces above — their workflow agents would record
 * no run and no steps, only loose model and tool calls.
 */
export const MIN_VERSION = "0.11.4";
export const BELOW_VERSION = "1.0.0";
const WORKFLOW_MIN = "1.1.0";
const WORKFLOW_BELOW = "2.0.0";

const MAX_NODES_IN_SUMMARY = 5;
/**
 * Open runs and leaves are bounded, oldest evicted first: orphans are normal (a
 * stream nobody consumed, a legacy task whose step threw and so never sent
 * `agent-end`) and a long-lived server must not keep every one of them.
 */
const MAX_OPEN = 10_000;

// Token key aliases, widest first. LlamaIndex normalises nothing, so this is
// the union of what the provider packages actually put in `raw` — the Python
// adapter's list, plus the camelCase spellings TS providers use.
const INPUT_TOKEN_KEYS = [
  "prompt_tokens",
  "input_tokens",
  "inputTokens",
  "promptTokens",
  "prompt_token_count",
  "promptTokenCount",
] as const;
const OUTPUT_TOKEN_KEYS = [
  "completion_tokens",
  "output_tokens",
  "outputTokens",
  "completionTokens",
  "candidates_token_count",
  "candidatesTokenCount",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers — no framework import in any of these
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

/** A property read that cannot throw (getters on framework classes can). */
function read(target: unknown, key: string): unknown {
  if (!isObject(target) && typeof target !== "function") return undefined;
  try {
    return (target as Json)[key];
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A correlation id out of a payload field whose type the framework does not
 * promise. An object would render as `[object Object]` and correlate with every
 * other one; a fresh id leaves the pair merely unpaired instead.
 */
function asId(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return randomUUID();
}

function firstInt(source: Json, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

export interface Usage {
  usage?: Json;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Token usage from a `ChatResponse`, streaming or not.
 *
 * Conservative on purpose, like the Python adapter: the token numbers are set
 * ONLY when a key we recognise is present, while the raw usage object always
 * ships as `usage` so a provider that names its counters something new still
 * reports something the server can fall back to.
 *
 * A streamed response is the case that used to lose everything: `wrapLLMEvent`
 * hands `llm-end` a `raw` that is the ARRAY of chunks, and providers put the
 * usage on one chunk — OpenAI on the last, content-less one — so reading
 * `raw.usage` found nothing on every streamed call, which is every
 * `FunctionAgent` call.
 */
export function usageOf(response: unknown): Usage {
  const raw = read(response, "raw");
  const candidates: unknown[] = [];
  const fromChunk = (chunk: unknown): void => {
    const chunkRaw = read(chunk, "raw");
    candidates.push(
      read(chunkRaw, "usage"),
      read(chunkRaw, "usage_metadata"),
      read(chunkRaw, "usageMetadata"),
      read(read(chunk, "options"), "usage"),
    );
  };
  if (Array.isArray(raw)) {
    // Newest chunk first: providers that report running totals end with the final one.
    for (let i = raw.length - 1; i >= 0; i -= 1) fromChunk(raw[i]);
  } else {
    candidates.push(read(raw, "usage"), read(raw, "usage_metadata"), read(raw, "usageMetadata"));
  }
  candidates.push(read(read(read(response, "message"), "options"), "usage"), read(response, "usage"));
  for (const candidate of candidates) {
    if (!isObject(candidate) || Array.isArray(candidate) || Object.keys(candidate).length === 0) continue;
    return {
      usage: candidate,
      inputTokens: firstInt(candidate, INPUT_TOKEN_KEYS),
      outputTokens: firstInt(candidate, OUTPUT_TOKEN_KEYS),
    };
  }
  return {};
}

function stopReasonOf(response: unknown): string | undefined {
  const raw = read(response, "raw");
  const sources = Array.isArray(raw) ? [...raw].reverse().map((chunk) => read(chunk, "raw")) : [raw];
  for (const source of sources) {
    const choice = (read(source, "choices") as unknown[] | undefined)?.[0];
    const value =
      nonEmpty(read(choice, "finish_reason")) ??
      nonEmpty(read(source, "stop_reason")) ??
      nonEmpty(read(source, "finishReason"));
    if (value) return value;
  }
  return undefined;
}

/** A retrieval result small enough to store: count, scores, a prefix of the top few. */
export function summarizeNodes(nodes: unknown): { num_nodes: number; top: Json[] } {
  const items = Array.isArray(nodes) ? nodes : [];
  const top = items.slice(0, MAX_NODES_IN_SUMMARY).map((item) => {
    const node = read(item, "node") ?? item;
    let text: unknown;
    const getContent = read(node, "getContent");
    if (typeof getContent === "function") {
      try {
        text = (getContent as () => unknown).call(node);
      } catch {
        text = undefined;
      }
    }
    text ??= read(node, "text");
    const score = read(item, "score");
    return {
      id: nonEmpty(read(node, "id_")) ?? nonEmpty(read(node, "id")),
      score: typeof score === "number" ? score : undefined,
      text: core.truncate(typeof text === "string" ? text : "", 200),
    };
  });
  return { num_nodes: items.length, top };
}

function messagesOf(messages: unknown): Json[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.map((message) => ({
    role: nonEmpty(read(message, "role")) ?? "user",
    content: read(message, "content"),
  }));
}

/** The text of a query or a `QueryBundle`. */
function queryText(query: unknown): unknown {
  if (typeof query === "string") return query;
  return read(query, "query") ?? read(query, "queryStr") ?? query;
}

/** The text of whatever a run returned — `EngineResponse`, a message, a string. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = read(read(value, "message"), "content") ?? read(value, "response") ?? read(value, "content");
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => read(part, "text")).filter((part) => typeof part === "string");
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name || "Error"}: ${error.message}`;
  return String(error);
}

function className(value: unknown): string | undefined {
  const name = read(read(value, "constructor"), "name");
  return typeof name === "string" && name !== "" && name !== "Object" && name !== "Function"
    ? name
    : undefined;
}

/** `event.reason.computedCallers` — the objects inside whose `@wrapEventCaller` calls this ran. */
function callersOf(event: unknown): unknown[] {
  const callers = read(read(event, "reason"), "computedCallers");
  return Array.isArray(callers) ? callers : [];
}

/**
 * The `EventCaller` chain of an event's `reason`, innermost first — or `null`
 * when the reason is not an `EventCaller` (no `caller` field), in which case
 * only the owner objects in `computedCallers` are known.
 */
function invocationChain(reason: unknown): object[] | null {
  if (!isObject(reason)) return null;
  try {
    if (!("caller" in reason)) return null;
  } catch {
    return null;
  }
  const chain: object[] = [];
  const seen = new Set<unknown>();
  let node: unknown = reason;
  while (isObject(node) && !seen.has(node)) {
    seen.add(node);
    chain.push(node);
    node = read(node, "parent");
  }
  return chain;
}

/** Where an event came from: LlamaIndex's invocation chain, and the owner objects on it. */
interface Origin {
  chain: object[] | null;
  callers: unknown[];
}

function originOf(event: unknown): Origin {
  return { chain: invocationChain(read(event, "reason")), callers: callersOf(event) };
}

/**
 * The model name for a bus event.
 *
 * `llm-start` carries only `{id, messages}`: `wrapLLMEvent` never passes the
 * model. Every first-party provider decorates `chat` with `@wrapEventCaller`
 * too, so the LLM instance itself is the nearest caller, and its
 * `metadata.model` is the name. A legacy runner above it has the LLM as `.llm`.
 */
function modelFromCallers(event: unknown): string | undefined {
  for (const caller of callersOf(event)) {
    const model = nonEmpty(read(read(caller, "metadata"), "model"));
    if (model) return model;
    const viaLlm = nonEmpty(read(read(read(caller, "llm"), "metadata"), "model"));
    if (viaLlm) return viaLlm;
  }
  return undefined;
}

function detail(event: unknown): Json {
  // A `CustomEvent`, so the payload is on `.detail` — with a fallback to the
  // event itself, for a build that dispatched the payload directly.
  const payload = read(event, "detail") ?? event;
  return isObject(payload) ? payload : {};
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** One agent span we opened: a workflow run, a sub-agent, a legacy task, a bare call. */
interface Run {
  key: string;
  agentId: string;
  depth: number;
  /** The run this one is nested in, when it is a multi-agent sub-agent. */
  root: Run | null;
  leaves: Set<string>;
  usedToolIds: Map<string, number>;
  /** Sub-agent currently holding the turn (multi-agent workflows only). */
  sub: Run | null;
  subSeq: number;
  /** The object whose `@wrapEventCaller` calls belong to this run, if any. */
  owner: object | null;
  /** LlamaIndex's `EventCaller` for the ONE invocation that opened this run, if any. */
  caller: object | null;
  /** Workflow step keys linked to this run and not yet ended. */
  steps: Set<string>;
  /** Legacy runs have no end signal until their last step; bare runs end with their leaf. */
  bare: boolean;
  /**
   * Ends when the LlamaIndex invocation in `caller` returns — a chat engine, a
   * bare model call — because nothing on the bus marks its end. (Query and
   * legacy runs have their own end event and take only a FAILURE from there.)
   */
  byInvocation: boolean;
  /** Plain-workflow runs: step handlers still running, and the last step's output text. */
  inFlight: number;
  output?: string;
  /** A run whose end arrived while a streamed leaf was still open. */
  ending: { outcome: string; summary?: string } | null;
  lastContent?: string;
  model?: string;
  ended: boolean;
  /** `performance.now()` of the last event that touched this run; what the reaper reads. */
  lastActivity: number;
  /** Drops this run from whichever index found it (legacy tasks, queries). */
  forget?: () => void;
}

interface Leaf {
  key: string;
  kind: "model" | "tool" | "retrieval";
  run: Run;
  parentKey: string;
  name: string;
  callId: string;
  rawId?: string;
  /** Who opened a tool leaf: the callback bus, or the workflow runtime's own event. */
  source?: "bus" | "workflow";
  started: number;
  model?: string;
  firstChunk?: number;
}

/** What the adapter's `AsyncLocalStorage` carries through a workflow step. */
interface Frame {
  key: string;
  run: Run;
  model?: string;
}

interface Located {
  parentKey: string;
  run: Run;
}

export interface LlamaIndexOptions {
  captureMessages: boolean;
  steps: boolean;
  embeddings: boolean;
  staleAfter: number;
  reaperInterval: number;
  captureLimit?: number;
}

export function parseOptions(options: Record<string, unknown>): LlamaIndexOptions {
  return {
    captureMessages: options.captureMessages !== false,
    steps: options.steps !== false,
    embeddings: options.embeddings === true,
    staleAfter: numberOption(options.staleAfter, 600),
    reaperInterval: numberOption(options.reaperInterval, 30),
    captureLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  };
}

interface Bus {
  on: (event: string, handler: (event: unknown) => void) => unknown;
  off?: (event: string, handler: (event: unknown) => void) => unknown;
}

/** One loaded copy of `@llamaindex/core/global` (or of the umbrella re-exporting it). */
export interface GlobalModule {
  Settings?: { callbackManager?: unknown };
  getEventCaller?: () => unknown;
}

/** One loaded copy of `@llamaindex/core/retriever`. */
export interface RetrieverModule {
  BaseRetriever?: { prototype: object };
}

/** One loaded copy of `@llamaindex/workflow-core/async-context` (workflow-core ≥1.1). */
export interface AsyncContextModule {
  AsyncContext?: { Variable?: { prototype: object } };
}

/** One loaded copy of `@llamaindex/workflow`. */
export interface WorkflowModule {
  AgentWorkflow?: { prototype: object; name?: string };
  stopAgentEvent?: { include: (event: unknown) => boolean };
  agentToolCallEvent?: { include: (event: unknown) => boolean };
  agentToolCallResultEvent?: { include: (event: unknown) => boolean };
}

interface Subscribable {
  subscribe: (callback: (...args: never[]) => unknown) => unknown;
}

interface HandlerContext {
  handler: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

class State {
  readonly options: LlamaIndexOptions;
  readonly tracker: core.RunTracker;
  readonly frames = new AsyncLocalStorage<Frame>();
  private readonly runs = new Map<string, Run>();
  private readonly leaves = new Map<string, Leaf>();
  private readonly owners = new WeakMap<object, Run[]>();
  /** Runs by the `EventCaller` of the invocation that opened them. */
  private readonly invocations = new WeakMap<object, Run>();
  /** Legacy task: first step id -> run. */
  private readonly tasks = new Map<string, Run>();
  /** Root query-engine runs, by `query-start` id. */
  private readonly queries = new Map<string, Run>();
  /** The retriever whose `retrieve()` is running, for the retrieval's name. */
  readonly retrievers = new AsyncLocalStorage<object>();
  /** `EventCaller`s whose invocation we watch start and end (see `invocation`). */
  private readonly observed = new WeakSet<object>();
  /** `EventCaller`s whose invocation has already returned or thrown. */
  private readonly returned = new WeakSet<object>();
  /** Model leaves opened directly inside an invocation (not in a workflow step), by its `EventCaller`. */
  private readonly invocationLeaves = new WeakMap<object, Set<string>>();
  /** Errors a leaf already carries, so the run they end does not report them again. */
  private readonly carried = new WeakSet<object>();
  /** Plain-workflow runs, by the workflow-core root handler context of their context. */
  private readonly plainRuns = new WeakMap<object, Run>();
  /** Step handlers of `AgentWorkflow`s, which are recorded as agent runs instead. */
  private readonly agentHandlers = new WeakSet<object>();
  private readonly globals: GlobalModule[];
  private reaper: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  active = true;

  constructor(options: LlamaIndexOptions, globals: GlobalModule[], frameworkPackage: string) {
    this.options = options;
    this.globals = globals;
    this.tracker = new core.RunTracker(NAME, {
      baseFields: core.frameworkFields(NAME, frameworkPackage),
      fieldLimit: options.captureLimit,
    });
  }

  /** The one gate every payload goes through — `captureMessages: false` drops them all. */
  capture<T>(value: T): T | undefined {
    return this.options.captureMessages ? value : undefined;
  }

  private nextKey(prefix: string): string {
    this.seq += 1;
    return `${prefix}#${this.seq}`;
  }

  // -- where does this event belong -----------------------------------------

  private live(run: Run | undefined | null): Run | null {
    return run && !run.ended ? run : null;
  }

  /** The innermost run opened by an invocation on this chain — exact, per call. */
  private invocationRun(chain: object[]): Run | null {
    for (const node of chain) {
      const run = this.live(this.invocations.get(node));
      if (run) return run;
    }
    return null;
  }

  /**
   * Fallback for a bus without `EventCaller`s: the newest live run of an owner
   * object on the caller list. `starting` is the owner of a run being opened
   * now; its own runs are skipped, because without the chain they are far more
   * likely concurrent siblings on a shared object than this call's parent.
   */
  private ownerRun(callers: unknown[], starting?: unknown): Run | null {
    for (const caller of callers) {
      if (!isObject(caller) || caller === starting) continue;
      const stack = this.owners.get(caller);
      const run = this.live(stack?.[stack.length - 1]);
      if (run) return run;
    }
    return null;
  }

  /**
   * The run an event belongs to: our step frame or LlamaIndex's invocation
   * chain, whichever is deeper. `origin` defaults to the chain bound right now,
   * for callers (a workflow starting) that have no event to read it from.
   * `starting` is the owner of a run about to be opened (see `ownerRun`).
   */
  locate(origin?: Origin, starting?: unknown): Located | null {
    const from = origin ?? this.boundOrigin();
    const frame = this.frames.getStore();
    const fromFrame = frame && this.live(frame.run) ? { parentKey: frame.key, run: frame.run } : null;
    // With an `EventCaller` chain, ONLY the chain decides: a run whose owner is
    // on the caller list but whose invocation is not on the chain belongs to a
    // different call — a concurrent request on a shared engine — never this one.
    const owner = from.chain ? this.invocationRun(from.chain) : this.ownerRun(from.callers, starting);
    const fromOwner = owner ? { parentKey: (owner.sub ?? owner).key, run: owner.sub ?? owner } : null;
    if (fromFrame && fromOwner) return fromOwner.run.depth > fromFrame.run.depth ? fromOwner : fromFrame;
    return fromFrame ?? fromOwner;
  }

  private boundOrigin(): Origin {
    for (const module of this.globals) {
      try {
        const caller = module.getEventCaller?.();
        if (!isObject(caller)) continue;
        const callers = read(caller, "computedCallers");
        return { chain: invocationChain(caller), callers: Array.isArray(callers) ? callers : [] };
      } catch {
        // An older build without `getEventCaller`; the frame is still consulted.
      }
    }
    return { chain: null, callers: [] };
  }

  // -- runs ---------------------------------------------------------------

  openRun(
    prefix: string,
    agentId: string,
    options: {
      parent?: Located | null;
      owner?: object | null;
      caller?: object | null;
      bare?: boolean;
      byInvocation?: boolean;
      goal?: unknown;
      root?: Run | null;
      fields?: Json;
    },
  ): Run {
    while (this.runs.size >= MAX_OPEN) {
      const oldest = this.runs.values().next();
      if (oldest.done) break;
      this.finishRun(oldest.value, "cancelled", undefined, "evicted");
    }
    const key = this.nextKey(prefix);
    const identity = this.tracker.startAgent(key, {
      agentId,
      parentKey: options.parent?.parentKey,
      goal: this.options.captureMessages && typeof options.goal === "string" ? options.goal : undefined,
      ...core.fwFields({ run_id: key, ...(options.fields ?? {}) }),
    });
    const run: Run = {
      key,
      agentId: identity.agentId ?? agentId,
      depth: identity.depth,
      root: options.root ?? null,
      leaves: new Set(),
      usedToolIds: new Map(),
      sub: null,
      subSeq: 0,
      owner: options.owner ?? null,
      caller: options.caller ?? null,
      steps: new Set(),
      bare: options.bare ?? false,
      byInvocation: options.byInvocation ?? false,
      inFlight: 0,
      ending: null,
      ended: false,
      lastActivity: performance.now(),
    };
    this.runs.set(key, run);
    if (run.owner) {
      const stack = this.owners.get(run.owner) ?? [];
      stack.push(run);
      this.owners.set(run.owner, stack);
    }
    if (run.caller) this.invocations.set(run.caller, run);
    return run;
  }

  /**
   * End a run. A success whose streamed model call is still being consumed is
   * DEFERRED until that leaf closes, so the tokens are not lost; anything else
   * force-closes what is open first, because an `agent_end` with an open leaf
   * under it leaves the session `ongoing` forever.
   */
  finishRun(run: Run, outcome: string, summary?: string, reason = "run_ended"): void {
    if (run.ended) return;
    if (run.sub) this.finishRun(run.sub, outcome, undefined, reason);
    if (outcome === "success" && run.leaves.size > 0 && reason === "run_ended") {
      run.ending = { outcome, summary };
      return;
    }
    // Ended BEFORE its leaves are force-closed: closing the last leaf of a bare
    // run would otherwise settle it as a success in the middle of this.
    run.ended = true;
    for (const key of [...run.leaves]) {
      const leaf = this.leaves.get(key);
      if (leaf) this.closeLeaf(leaf, { closedBy: reason });
    }
    this.runs.delete(run.key);
    run.forget?.();
    if (run.owner) {
      const stack = this.owners.get(run.owner);
      const index = stack?.lastIndexOf(run) ?? -1;
      if (stack && index !== -1) stack.splice(index, 1);
      if (stack?.length === 0) this.owners.delete(run.owner);
    }
    if (run.caller && this.invocations.get(run.caller) === run) this.invocations.delete(run.caller);
    if (run.root && run.root.sub === run) run.root.sub = null;
    const text = summary ?? (outcome === "success" ? run.lastContent : undefined);
    this.tracker.endAgent(run.key, {
      outcome,
      summary: this.options.captureMessages || outcome !== "success" ? text : undefined,
      ...core.fwFields({ run_id: run.key }),
    });
    // Every tracker link this run made goes with it — its own and any step
    // still in flight. A leaked link is worse than memory: at the tracker's
    // FIFO cap, the next eviction takes a LIVE run's link and its events drop.
    for (const step of run.steps) this.tracker.unlink(step);
    run.steps.clear();
    this.tracker.unlink(run.key);
  }

  /**
   * A deferred or bare run whose last leaf just closed. A bare run IS its one
   * call, so it ends the way that call did: a failure, a reaped orphan
   * (`cancelled` — we never learned how it ended), or a success.
   */
  private settle(run: Run, outcome: string): void {
    if (run.ended || run.leaves.size > 0) return;
    if (run.ending) this.finishRun(run, run.ending.outcome, run.ending.summary);
    else if (run.bare) this.finishRun(run, outcome, undefined, outcome === "success" ? "run_ended" : "leaf");
  }

  // -- leaves -------------------------------------------------------------

  private openLeaf(leaf: Leaf): void {
    while (this.leaves.size >= MAX_OPEN) {
      const oldest = this.leaves.values().next();
      if (oldest.done) break;
      this.closeLeaf(oldest.value, { closedBy: "evicted" });
    }
    this.leaves.set(leaf.key, leaf);
    leaf.run.leaves.add(leaf.key);
    leaf.run.lastActivity = performance.now();
  }

  closeLeaf(leaf: Leaf, result: { output?: unknown; error?: string; response?: unknown; closedBy?: string }): void {
    if (!this.leaves.delete(leaf.key)) return;
    leaf.run.leaves.delete(leaf.key);
    leaf.run.lastActivity = performance.now();
    const extras = core.fwFields({ run_id: leaf.run.key, closed_by: result.closedBy });
    if (leaf.kind === "model") {
      const response = result.response;
      const usage = usageOf(response);
      const content = read(read(response, "message"), "content");
      if (typeof content === "string" && content !== "") leaf.run.lastContent = content;
      const now = performance.now();
      this.tracker.emit("modelResponse", leaf.key, {
        parentKey: leaf.parentKey,
        model: leaf.model,
        requestId: leaf.callId,
        role: response === undefined ? undefined : "assistant",
        content: this.capture(content),
        stopReason: stopReasonOf(response),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usage: usage.usage,
        error: result.error,
        // Always an int: `modelResponse` does not measure its own duration.
        duration_ms: core.ms(now - leaf.started),
        ...extras,
        ...core.fwFields({
          ttft_ms: leaf.firstChunk === undefined ? undefined : core.ms(leaf.firstChunk - leaf.started),
          chunks: Array.isArray(read(response, "raw")) ? (read(response, "raw") as unknown[]).length : undefined,
        }),
      });
    } else {
      this.tracker.emit("toolResult", leaf.key, {
        parentKey: leaf.parentKey,
        toolName: leaf.name,
        toolCallId: leaf.callId,
        output: result.error === undefined ? this.capture(result.output) : undefined,
        error: result.error,
        ...extras,
      });
    }
    this.tracker.unlink(leaf.key);
    this.settle(leaf.run, result.error !== undefined ? "failed" : result.closedBy ? "cancelled" : "success");
  }

  // -- the bus --------------------------------------------------------------

  /** True when the outermost invocation on the chain is one we can see end. */
  private observedOuter(origin: Origin): boolean {
    const outer = origin.chain?.[origin.chain.length - 1];
    return outer !== undefined && this.observed.has(outer) && !this.returned.has(outer);
  }

  /** Where a bus event goes; opens a root run when it belongs to nothing. */
  private placeOrOpen(event: unknown, prefix: string, agentId: () => string, origin = originOf(event)): Located {
    const located = this.locate(origin);
    if (located) return located;
    const run = this.openRoot(origin, prefix, agentId);
    return { parentKey: run.key, run };
  }

  /**
   * The root run for an event nothing encloses: Python's rule, "any other
   * top-level instrumented call opens the session and becomes its root agent,
   * named after its class".
   *
   * The top-level call is the OUTERMOST invocation on the event's `EventCaller`
   * chain — a `ContextChatEngine.chat`, not the retriever or the model call it
   * made — so everything one chat does lands in one run instead of one session
   * per retrieval and per model call. The run ends when that invocation
   * returns, which only `invocation()` sees; an invocation it did not see start
   * (no hook on this build, or begun before `instrument()`) falls back to a
   * bare run that ends with its one leaf, as every root run used to.
   */
  private openRoot(origin: Origin, prefix: string, agentId: () => string): Run {
    const outer = origin.chain?.[origin.chain.length - 1];
    if (outer && this.observedOuter(origin)) {
      return this.openRun(prefix, className(read(outer, "caller")) ?? agentId(), {
        parent: null,
        caller: outer,
        byInvocation: true,
      });
    }
    return this.openRun(prefix, agentId(), { parent: null, bare: true });
  }

  /**
   * Run one LlamaIndex invocation — the callback `withEventCaller` binds an
   * `EventCaller` around — and observe how it ends. Called from the hook on
   * LlamaIndex's own event-caller storage (`hookInvocations`).
   *
   * A native promise is REPLACED by one that settles identically, never merely
   * observed: attaching a rejection handler to the caller's own promise would
   * mark it handled, and a rejection the application never handled would stop
   * being reported. Anything else is returned untouched and only a synchronous
   * throw is seen.
   */
  invocation(caller: object, fn: () => unknown): unknown {
    this.observed.add(caller);
    let result: unknown;
    try {
      result = fn();
    } catch (error) {
      this.returnedFrom(caller, undefined, error, true);
      throw error;
    }
    if (result instanceof Promise && result.constructor === Promise) {
      return result.then(
        (value: unknown) => {
          this.returnedFrom(caller, value);
          return value;
        },
        (error: unknown) => {
          this.returnedFrom(caller, undefined, error, true);
          throw error;
        },
      );
    }
    if (!(isObject(result) && typeof (result as { then?: unknown }).then === "function")) {
      this.returnedFrom(caller, result);
    }
    return result;
  }

  private returnedFrom(caller: object, value: unknown, error?: unknown, failed = false): void {
    core.callSafely(
      () => {
        if (this.active) this.invocationEnded(caller, value, error, failed);
      },
      [],
      `${NAME}.invocationEnded`,
    );
  }

  /**
   * An invocation returned or threw. A failure is the ONLY failure signal a
   * model call, a query or a legacy task has — `wrapLLMEvent` has no error path
   * and a failed step dispatches no `agent-end` — so it closes what that call
   * left open. A success ends only a run that has no end event of its own.
   */
  private invocationEnded(caller: object, value: unknown, error: unknown, failed: boolean): void {
    this.returned.add(caller);
    const text = failed ? errorText(error) : undefined;
    if (failed) {
      for (const key of this.invocationLeaves.get(caller) ?? []) {
        const leaf = this.leaves.get(key);
        if (!leaf) continue;
        this.closeLeaf(leaf, { error: text });
        if (isObject(error)) this.carried.add(error);
      }
    }
    this.invocationLeaves.delete(caller);
    const run = this.live(this.invocations.get(caller));
    if (!run) return;
    if (failed) {
      for (const key of [...run.leaves]) {
        const leaf = this.leaves.get(key);
        if (!leaf) continue;
        this.closeLeaf(leaf, { error: text });
        if (isObject(error)) this.carried.add(error);
      }
      // One report per failure: a leaf that already carries it is the report.
      if (!(isObject(error) && this.carried.has(error))) this.reportError(run, error);
      this.finishRun(run, "failed", text);
    } else if (run.byInvocation) {
      this.finishRun(run, "success", this.options.captureMessages ? textOf(value) : undefined);
    }
  }

  llmStart(event: unknown): void {
    const payload = detail(event);
    const id = asId(payload.id);
    const frame = this.frames.getStore();
    const origin = originOf(event);
    const place = this.placeOrOpen(event, "llm", () => className(callersOf(event)[0]) ?? "llm", origin);
    this.closeAnsweredTools(place.run, payload.messages);
    const model = modelFromCallers(event) ?? (frame && frame.run === place.run ? frame.model : undefined) ?? place.run.model;
    const leaf: Leaf = {
      key: `llm:${id}`,
      kind: "model",
      run: place.run,
      parentKey: place.parentKey,
      name: model ?? "llm",
      callId: id,
      started: performance.now(),
      model,
    };
    this.openLeaf(leaf);
    // A model call that throws has no `llm-end`; its invocation throwing is the
    // only signal. Inside a workflow step the step's failure already closes it.
    const invocation = origin.chain?.[0];
    if (invocation && !frame) {
      const keys = this.invocationLeaves.get(invocation) ?? new Set<string>();
      keys.add(leaf.key);
      this.invocationLeaves.set(invocation, keys);
    }
    this.tracker.emit("modelRequest", leaf.key, {
      parentKey: leaf.parentKey,
      model,
      requestId: id,
      messages: this.capture(messagesOf(payload.messages)),
      ...core.fwFields({ run_id: place.run.key }),
    });
  }

  llmStream(event: unknown): void {
    const leaf = this.leaves.get(`llm:${asId(detail(event).id)}`);
    if (leaf && leaf.firstChunk === undefined) leaf.firstChunk = performance.now();
  }

  llmEnd(event: unknown): void {
    const payload = detail(event);
    const leaf = this.leaves.get(`llm:${asId(payload.id)}`);
    if (leaf) this.closeLeaf(leaf, { response: payload.response });
  }

  /**
   * Close tool leaves the model has already been shown the result of.
   *
   * `callTool` dispatches no `llm-tool-result` when a tool throws, so without
   * this a failing tool in a legacy agent stays open for the life of the run.
   * The next model call carries the result as a `toolResult` message — with
   * `isError` — which is the framework's own record of how the tool ended.
   */
  private closeAnsweredTools(run: Run, messages: unknown): void {
    if (run.leaves.size === 0 || !Array.isArray(messages)) return;
    const answers = new Map<string, Json>();
    for (const message of messages) {
      const result = read(read(message, "options"), "toolResult");
      const id = nonEmpty(read(result, "id"));
      if (id && isObject(result)) answers.set(id, result);
    }
    for (const key of [...run.leaves]) {
      const leaf = this.leaves.get(key);
      if (!leaf || leaf.kind !== "tool" || !leaf.rawId) continue;
      const answer = answers.get(leaf.rawId);
      if (!answer) continue;
      this.closeLeaf(leaf, answer.isError === true ? { error: cleanToolError(answer.result) } : { output: answer.result });
    }
  }

  private toolCallId(run: Run, rawId: string | undefined): string {
    if (!rawId) return randomUUID();
    const seen = run.usedToolIds.get(rawId) ?? 0;
    run.usedToolIds.set(rawId, seen + 1);
    // A repeat of the same provider id within a run would pair wrongly.
    return seen === 0 ? rawId : `${rawId}#${seen}`;
  }

  toolCall(event: unknown): void {
    const call = read(detail(event), "toolCall");
    const name = nonEmpty(read(call, "name")) ?? "tool";
    const rawId = nonEmpty(read(call, "id"));
    const located = this.locate(originOf(event));
    // Inside a workflow the runtime's own `agentToolCallEvent` opened this call
    // already, synchronously and before the tool ran; this is the same call.
    if (located && this.findTool(rawId, located.run, "workflow")) return;
    const place = located ?? this.placeOrOpen(event, "tool", () => name);
    this.openTool(place, name, rawId, read(call, "input"), "bus");
  }

  private openTool(place: Located, name: string, rawId: string | undefined, input: unknown, source: Leaf["source"]): void {
    const leaf: Leaf = {
      key: this.nextKey("tool"),
      kind: "tool",
      run: place.run,
      parentKey: place.parentKey,
      name,
      callId: this.toolCallId(place.run, rawId),
      rawId,
      source,
      started: performance.now(),
    };
    this.openLeaf(leaf);
    this.tracker.emit("toolUse", leaf.key, {
      parentKey: leaf.parentKey,
      toolName: name,
      toolCallId: leaf.callId,
      input: this.capture(isObject(input) && !Array.isArray(input) ? input : input === undefined ? undefined : { input }),
      ...core.fwFields({ run_id: place.run.key, tool_id: rawId !== leaf.callId ? rawId : undefined }),
    });
  }

  /** The open tool leaf for a provider tool call id, in the run this event belongs to first. */
  private findTool(rawId: string | undefined, run: Run | null, source?: Leaf["source"]): Leaf | undefined {
    if (!rawId) return undefined;
    const search = (keys: Iterable<string>): Leaf | undefined => {
      for (const key of keys) {
        const leaf = this.leaves.get(key);
        if (leaf?.kind === "tool" && leaf.rawId === rawId && (!source || leaf.source === source)) return leaf;
      }
      return undefined;
    };
    if (source) return run ? search(run.leaves) : undefined;
    return (run ? search(run.leaves) : undefined) ?? search(this.leaves.keys());
  }

  toolResult(event: unknown): void {
    const payload = detail(event);
    const leaf = this.findTool(nonEmpty(read(read(payload, "toolCall"), "id")), this.locate(originOf(event))?.run ?? null);
    if (!leaf) return;
    const result = read(payload, "toolResult");
    const failed = read(result, "isError") === true;
    this.closeLeaf(leaf, failed ? { error: cleanToolError(read(result, "output")) } : { output: read(result, "output") });
  }

  retrieveStart(event: unknown): void {
    const payload = detail(event);
    const id = asId(payload.id);
    // The retriever's class, as Python names it (`VectorIndexRetriever`). The
    // event does not carry the retriever; the patched `retrieve()` it was
    // dispatched from does, and the dispatch runs in that call's async context.
    const name = className(this.retrievers.getStore()) ?? "retriever";
    const place = this.placeOrOpen(event, "retrieve", () => name);
    const leaf: Leaf = {
      key: `retrieve:${id}`,
      kind: "retrieval",
      run: place.run,
      parentKey: place.parentKey,
      name,
      callId: id,
      started: performance.now(),
    };
    this.openLeaf(leaf);
    this.tracker.emit("toolUse", leaf.key, {
      parentKey: leaf.parentKey,
      toolName: leaf.name,
      toolCallId: id,
      input: this.capture({ query: queryText(payload.query) }),
      ...core.fwFields({ run_id: place.run.key, kind: "retrieval" }),
    });
  }

  retrieveEnd(event: unknown): void {
    const payload = detail(event);
    const leaf = this.leaves.get(`retrieve:${asId(payload.id)}`);
    if (leaf) this.closeLeaf(leaf, { output: summarizeNodes(payload.nodes) });
  }

  /**
   * A query engine call is a root run when nothing encloses it — Python's
   * top-level `query_engine.query()` — and nothing at all inside a run, where
   * its retrievals and model calls are what is worth seeing.
   */
  queryStart(event: unknown): void {
    const origin = originOf(event);
    const owner = origin.callers[0];
    if (this.locate(origin, owner)) return;
    // Called from inside ANOTHER invocation nothing encloses — a chat engine
    // whose first act is a query: that invocation is the root, and the query
    // is inside it (recording nothing of its own, as inside any run).
    if (origin.chain && origin.chain.length > 1 && this.observedOuter(origin)) {
      this.openRoot(origin, "invocation", () => className(owner) ?? "query_engine");
      return;
    }
    const payload = detail(event);
    const run = this.openRun(`query:${asId(payload.id)}`, className(owner) ?? "query_engine", {
      owner: isObject(owner) ? owner : null,
      caller: origin.chain?.[0] ?? null,
      goal: queryText(payload.query),
    });
    const id = asId(payload.id);
    this.queries.set(id, run);
    run.forget = () => this.queries.delete(id);
  }

  queryEnd(event: unknown): void {
    const payload = detail(event);
    const id = asId(payload.id);
    const run = this.queries.get(id);
    if (!run) return;
    this.finishRun(run, "success", this.options.captureMessages ? textOf(payload.response) : undefined);
  }

  /**
   * Legacy `AgentRunner` (`LLMAgent`, `OpenAIAgent`, `ReActAgent`, …).
   *
   * `agent-start` fires for EVERY step and `agent-end` only after the last one,
   * both carrying the step. Pairing them by step id — what this adapter used to
   * do — opened a span per step and closed one, so every multi-step run left
   * one agent open forever and split into two sessions. A task is identified by
   * its FIRST step instead, reached by walking `prevStep`.
   */
  agentStart(event: unknown): void {
    const step = read(detail(event), "startStep");
    if (!isObject(step)) return;
    const first = firstStep(step);
    const firstId = asId(read(first, "id"));
    const running = this.tasks.get(firstId);
    if (running) {
      running.lastActivity = performance.now();
      return;
    }
    const origin = originOf(event);
    const owner = origin.callers[0];
    let parent = this.locate(origin, owner);
    if (!parent && origin.chain && origin.chain.length > 1 && this.observedOuter(origin)) {
      // A legacy agent called from inside another un-run invocation nests
      // under it, the way a sub-agent nests under a workflow.
      const root = this.openRoot(origin, "invocation", () => "invocation");
      parent = { parentKey: root.key, run: root };
    }
    const run = this.openRun(`task:${firstId}`, className(owner) ?? "AgentRunner", {
      parent,
      owner: isObject(owner) ? owner : null,
      caller: origin.chain?.[0] ?? null,
      goal: textOf((read(read(read(step, "context"), "store"), "messages") as unknown[] | undefined)?.at(-1)),
    });
    run.model = nonEmpty(read(read(read(read(step, "context"), "llm"), "metadata"), "model"));
    this.tasks.set(firstId, run);
    run.forget = () => this.tasks.delete(firstId);
  }

  agentEnd(event: unknown): void {
    const step = read(detail(event), "endStep");
    if (!isObject(step)) return;
    const firstId = asId(read(firstStep(step), "id"));
    const run = this.tasks.get(firstId);
    if (run) this.finishRun(run, "success");
  }

  // -- workflows ------------------------------------------------------------

  /**
   * Open the run for an `AgentWorkflow.runStream()` call and return the hook to
   * attach to the context it is about to create.
   */
  beginWorkflow(
    workflow: Json,
    userInput: unknown,
    module: WorkflowModule,
  ): { run: Run; attach: (context: unknown) => void } {
    // Its steps are recorded through its context (`attachContext`), never
    // again as a plain workflow's.
    for (const handler of handlerNames(workflow).keys()) {
      if (isObject(handler) || typeof handler === "function") this.agentHandlers.add(handler);
    }
    const agents = read(workflow, "agents");
    const size = agents instanceof Map ? agents.size : 1;
    const rootName = nonEmpty(read(workflow, "rootAgentName"));
    const agentId = size <= 1 && rootName ? rootName : (className(workflow) ?? "AgentWorkflow");
    const run = this.openRun("workflow", agentId, {
      parent: this.locate(),
      goal: typeof userInput === "string" ? userInput : textOf(userInput),
      fields: { workflow: className(workflow), agent_name: size <= 1 ? rootName : undefined },
    });
    return {
      run,
      attach: (context: unknown) => {
        this.attachContext(run, workflow, context, module);
      },
    };
  }

  failWorkflow(run: Run | null, error: unknown): void {
    if (!run) return;
    // Nothing below the run saw this failure, so the run reports it — once.
    this.reportError(run, error);
    this.finishRun(run, "failed", errorText(error));
  }

  /**
   * An `error` event, for a failure no leaf or hook already carries. The
   * Python adapter's rule: a second report of one failure double-counts on the
   * session's error total, so only the innermost place that saw it reports it.
   */
  private reportError(run: Run, error: unknown): void {
    this.tracker.emit("error", run.key, {
      errorType: error instanceof Error ? error.name || "Error" : typeof error,
      message: error instanceof Error ? error.message || error.name : String(error),
      traceback: error instanceof Error ? error.stack : undefined,
      ...core.fwFields({ run_id: run.key }),
    });
  }

  private attachContext(run: Run, workflow: Json, context: unknown, module: WorkflowModule): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the subscriber is a named function (its name is its degradation site)
    const state = this;
    const callContext = read(context, "__internal__call_context") as Subscribable | undefined;
    const sendEvent = read(context, "__internal__call_send_event") as Subscribable | undefined;
    if (typeof sendEvent?.subscribe === "function") {
      sendEvent.subscribe(
        core.safe(NAME, function workflowEvent(this: void, sent: unknown): void {
          state.workflowEvent(run, sent, module);
        }),
      );
    }
    if (typeof callContext?.subscribe !== "function") {
      compat.warn(
        "this @llamaindex/workflow context has no __internal__call_context, so workflow steps " +
          "are not recorded (the run, its model calls and its tool calls still are).",
        `${NAME}:call_context`,
      );
      return;
    }
    const names = handlerNames(workflow);
    callContext.subscribe(((handlerContext: HandlerContext, next: (context: HandlerContext) => void) => {
      // `next` MUST be called exactly once whatever happens here: a subscriber
      // that throws before it would silently stop the customer's workflow.
      let wrapped: HandlerContext = handlerContext;
      try {
        const original = handlerContext.handler;
        if (typeof original === "function") {
          const name = names.get(original) ?? nonEmpty(original.name) ?? "step";
          const inputs = handlerContext.inputs;
          const input = Array.isArray(inputs) ? (inputs[0] as unknown) : undefined;
          wrapped = { ...handlerContext, handler: this.wrapStep(run, workflow, name, original, input) };
        }
      } catch (error) {
        core.callSafely(
          () => {
            throw error;
          },
          [],
          `${NAME}.wrapStep`,
        );
      }
      next(wrapped);
    }));
  }

  workflowEvent(run: Run, sent: unknown, module: WorkflowModule): void {
    // A context outlives uninstall(); its subscriptions cannot be removed.
    if (!this.active) return;
    if (module.stopAgentEvent?.include(sent)) {
      const data = read(sent, "data");
      const result = read(data, "result");
      this.finishRun(run, "success", this.options.captureMessages ? (textOf(result) ?? textOf(read(data, "message"))) : undefined);
      return;
    }
    if (module.agentToolCallEvent?.include(sent)) {
      // The runtime announces every tool call before running it — the only
      // signal on releases whose `AgentWorkflow` calls tools directly rather
      // than through `callTool` (workflow 1.1.5 dispatches nothing on the bus).
      const data = read(sent, "data");
      const owner = run.sub ?? run;
      const frame = this.frames.getStore();
      const place = frame && frame.run === owner ? { parentKey: frame.key, run: owner } : { parentKey: owner.key, run: owner };
      const name = nonEmpty(read(data, "toolName")) ?? "tool";
      this.openTool(place, name, nonEmpty(read(data, "toolId")), read(data, "toolKwargs"), "workflow");
      return;
    }
    if (module.agentToolCallResultEvent?.include(sent)) {
      // The runtime's own record of how a tool ended. It is the ONLY signal for
      // a tool that threw: `callTool` dispatches no `llm-tool-result` then.
      const data = read(sent, "data");
      const leaf = this.findTool(nonEmpty(read(data, "toolId")), run.sub ?? run);
      if (!leaf) return;
      const output = read(data, "toolOutput");
      if (read(output, "isError") === true) {
        this.closeLeaf(leaf, { error: cleanToolError(read(output, "result")) });
      } else {
        this.closeLeaf(leaf, { output: read(data, "raw") ?? read(output, "result") });
      }
    }
  }

  private wrapStep(
    run: Run,
    workflow: Json,
    name: string,
    original: (...args: unknown[]) => unknown,
    input: unknown,
  ): (...args: unknown[]) => unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the wrapper needs its own `this`
    const state = this;
    return function failproofaiStep(this: unknown, ...args: unknown[]): unknown {
      if (!state.active) return original.apply(this, args);
      const step = core.callSafely(() => state.stepStart(run, workflow, name, input), [], `${NAME}.stepStart`);
      if (!step) return original.apply(this, args);
      const finish = (value: unknown, error?: unknown): void => {
        core.callSafely(() => {
          state.stepEnd(step, value, error);
        }, [], `${NAME}.stepEnd`);
      };
      let result: unknown;
      try {
        result = state.frames.run(step.frame, () => original.apply(this, args));
      } catch (error) {
        finish(undefined, error);
        throw error;
      }
      if (isObject(result) && typeof (result as { then?: unknown }).then === "function") {
        return (result as unknown as PromiseLike<unknown>).then(
          (value) => {
            finish(value);
            return value;
          },
          (error: unknown) => {
            finish(undefined, error);
            throw error;
          },
        );
      }
      finish(result);
      return result;
    };
  }

  /**
   * One step handler of a plain `createWorkflow()` workflow, seen as
   * workflow-core binds its handler context (`hookAsyncContext`).
   *
   * A plain workflow has no run boundary of its own: the application creates
   * the context, sends it events and stops reading whenever it likes. So the
   * run is the context's BURST of activity — it opens with the first step
   * handler of a context and ends once no step of it is running and none was
   * started by the last one's output (checked a macrotask later, after the
   * runtime has dispatched that output). A workflow that then waits for an
   * event from outside (human-in-the-loop) records the next burst as a new run.
   */
  plainStep(handlerContext: Json, proceed: () => unknown): unknown {
    const original = handlerContext.handler;
    if (typeof original !== "function" || this.agentHandlers.has(original)) return proceed();
    const root = rootContext(handlerContext);
    const inputs = handlerContext.inputs;
    const input = Array.isArray(inputs) ? (inputs[0] as unknown) : undefined;
    let run = this.live(this.plainRuns.get(root));
    if (!run) {
      const data = read(input, "data");
      run = this.openRun("workflow", "Workflow", {
        parent: this.locate(),
        goal: typeof data === "string" ? data : textOf(data),
        fields: { workflow: "Workflow" },
      });
      this.plainRuns.set(root, run);
    }
    const label = eventLabel(input);
    const name = nonEmpty(read(original, "name")) ?? (label ? `handle:${label}` : "step");
    const step = this.stepStart(run, {}, name, input, true);
    if (!step) return proceed();
    const owner = run;
    owner.inFlight += 1;
    let done = false;
    const end = (value: unknown, error?: unknown): void => {
      if (done) return;
      done = true;
      owner.inFlight -= 1;
      core.callSafely(
        () => {
          const data = read(value, "data");
          if (error === undefined && typeof data === "string") owner.output = data;
          this.stepEnd(step, value, error);
          if (owner.inFlight === 0 && !owner.ended) this.whenQuiet(owner);
        },
        [],
        `${NAME}.plainStepEnd`,
      );
    };
    // The handler object is this invocation's own, so its handler is replaced
    // in place — the same thing middleware does — rather than wrapped around.
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the wrapper needs its own `this`
    const state = this;
    handlerContext.handler = function failproofaiStep(this: unknown, ...args: unknown[]): unknown {
      let result: unknown;
      try {
        result = state.frames.run(step.frame, () => (original as (...a: unknown[]) => unknown).apply(this, args));
      } catch (error) {
        end(undefined, error);
        throw error;
      }
      if (isObject(result) && typeof (result as { then?: unknown }).then === "function") {
        return (result as unknown as PromiseLike<unknown>).then(
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
    };
    return proceed();
  }

  /**
   * End a plain-workflow run if it is still idle once the runtime has
   * dispatched the last step's output. Two microtask hops: the step's end runs
   * in a reaction to the handler's promise, the runtime's `sendEvent` in the
   * reaction to the promise returned in its place — queued one hop later, and
   * starting any next handler synchronously. Any later and the run would end
   * after the caller that awaited it (and after an `agent()` scope around it).
   */
  private whenQuiet(run: Run): void {
    queueMicrotask(() => {
      queueMicrotask(() => {
        core.callSafely(
          () => {
            if (this.active && !run.ended && run.inFlight === 0) {
              this.finishRun(run, "success", this.options.captureMessages ? run.output : undefined);
            }
          },
          [],
          `${NAME}.whenQuiet`,
        );
      });
    });
  }

  private stepStart(run: Run, workflow: Json, name: string, event: unknown, plain = false): Step | null {
    if (run.ended) return null;
    const data = read(event, "data");
    // Only an AgentWorkflow's events name the agent holding the turn; a plain
    // workflow's data is the application's own, whatever its field names.
    const agentName = plain
      ? undefined
      : (nonEmpty(read(data, "currentAgentName")) ?? nonEmpty(read(data, "agentName")));
    const owner = plain ? run : this.subAgent(run, agentName);
    run.lastActivity = owner.lastActivity = performance.now();
    const key = this.nextKey(`${run.key}:step`);
    this.tracker.link(key, owner.key);
    owner.steps.add(key);
    const agents = read(workflow, "agents");
    const agent = agents instanceof Map ? agents.get(agentName ?? read(workflow, "rootAgentName")) : undefined;
    const model = nonEmpty(read(read(read(agent, "llm"), "metadata"), "model"));
    if (this.options.steps) {
      this.tracker.emit("hookTriggered", key, {
        parentKey: owner.key,
        hookName: name,
        hookId: key,
        triggerEvent: "workflow_step",
        input: this.capture(eventData(data)),
        ...core.fwFields({ run_id: run.key, step: name, input_event: eventLabel(event), agent_name: agentName }),
      });
    }
    return { key, name, run, owner, frame: { key, run: owner, model } };
  }

  private stepEnd(step: Step, value: unknown, error?: unknown): void {
    step.run.lastActivity = step.owner.lastActivity = performance.now();
    const failed = error !== undefined;
    let reported = false;
    if (failed) {
      // Whatever this step had open failed with it — a model call that threw
      // has no `llm-end` at all.
      for (const key of [...step.owner.leaves]) {
        const leaf = this.leaves.get(key);
        if (leaf && leaf.parentKey === step.key) {
          this.closeLeaf(leaf, { error: errorText(error) });
          reported = true;
        }
      }
    }
    if (this.options.steps) {
      this.tracker.emit("hookCompleted", step.key, {
        parentKey: step.owner.key,
        hookName: step.name,
        hookId: step.key,
        outcome: failed ? "failed" : "success",
        output: failed ? undefined : this.capture(eventData(read(value, "data") ?? value)),
        error: failed ? errorText(error) : undefined,
        ...core.fwFields({ run_id: step.run.key, step: step.name, output_event: eventLabel(value) }),
      });
    }
    // An AgentWorkflow is a single chain of steps: a step that throws ends the
    // run, and the runtime never settles `run()` to tell us so. Under
    // `steps: false` there is no failed hook, so unless a leaf carried it the
    // run reports it — as the Python adapter does.
    if (failed) {
      if (!reported && !this.options.steps) this.reportError(step.owner, error);
      this.finishRun(step.run, "failed", errorText(error));
    }
    // Last: the step's leaves and its hook resolve their session through it.
    step.owner.steps.delete(step.key);
    this.tracker.unlink(step.key);
  }

  /**
   * The nested agent a multi-agent step belongs to, or the run itself.
   *
   * The Python adapter's rule: each distinct agent name opens a nested agent
   * under the workflow and a handoff closes the previous one. The name is
   * sticky — tool steps carry `agentName`, not `currentAgentName`, and a step
   * with neither keeps whichever agent holds the turn.
   */
  private subAgent(run: Run, name: string | undefined): Run {
    if (!name || name === run.agentId || (run.sub && run.sub.agentId === name)) return run.sub ?? run;
    if (run.sub) this.finishRun(run.sub, "success");
    run.subSeq += 1;
    const sub = this.openRun(`${run.key}:sub${run.subSeq}`, name, {
      parent: { parentKey: run.key, run },
      root: run,
      fields: { agent_name: name, workflow: run.agentId },
    });
    run.sub = sub;
    return sub;
  }

  // -- teardown -------------------------------------------------------------

  /**
   * Close what nobody is going to close. Returns how many leaves and runs.
   *
   * Leaves first — a model call that threw has no `llm-end` — then runs that
   * have been silent for `staleAfter`: LlamaIndex.TS never signals a legacy
   * task whose step threw (no `agent-end`) or a `runStream()` nobody drained,
   * and a run left open is a session the dashboard shows as `ongoing` forever.
   * Python reaps only leaves because its span handler sees every drop; here
   * the run-level signal genuinely does not exist.
   */
  sweep(now = performance.now()): number {
    const cutoff = now - this.options.staleAfter * 1000;
    let closed = 0;
    for (const leaf of [...this.leaves.values()]) {
      if (leaf.started > cutoff) continue;
      this.closeLeaf(leaf, { closedBy: "stale" });
      closed += 1;
    }
    for (const run of [...this.runs.values()].reverse()) {
      if (run.ended || run.root !== null || run.leaves.size > 0 || run.lastActivity > cutoff) continue;
      this.finishRun(run, "cancelled", undefined, "stale");
      closed += 1;
    }
    return closed;
  }

  startReaper(): void {
    if (this.options.reaperInterval <= 0 || this.reaper !== null) return;
    this.reaper = setInterval(() => {
      core.callSafely(() => this.sweep(), [], `${NAME}.reaper`);
    }, this.options.reaperInterval * 1000);
    this.reaper.unref();
  }

  /** What is still held, for tests: every per-run table, and the tracker. */
  residue(): { runs: number; leaves: number; tasks: number; queries: number; tracker: core.RunTracker } {
    return {
      runs: this.runs.size,
      leaves: this.leaves.size,
      tasks: this.tasks.size,
      queries: this.queries.size,
      tracker: this.tracker,
    };
  }

  shutdown(): void {
    this.active = false;
    if (this.reaper !== null) clearInterval(this.reaper);
    this.reaper = null;
    // Newest first, so a sub-agent closes before the workflow that opened it.
    for (const run of [...this.runs.values()].reverse()) this.finishRun(run, "cancelled", undefined, "uninstrument");
    this.leaves.clear();
    this.tasks.clear();
    this.queries.clear();
    this.tracker.reset();
  }
}

interface Step {
  key: string;
  name: string;
  run: Run;
  owner: Run;
  frame: Frame;
}

function firstStep(step: Json): Json {
  let current = step;
  const seen = new Set<unknown>();
  for (;;) {
    const previous = read(current, "prevStep");
    if (!isObject(previous) || seen.has(previous)) return current;
    seen.add(previous);
    current = previous;
  }
}

/** A workflow-core handler context's root: one per `createContext()`, so one per context. */
function rootContext(handlerContext: Json): object {
  const root = read(handlerContext, "root");
  if (isObject(root)) return root;
  let current: Json = handlerContext;
  const seen = new Set<unknown>();
  for (;;) {
    const previous = read(current, "prev");
    if (!isObject(previous) || seen.has(previous)) return current;
    seen.add(previous);
    current = previous;
  }
}

/** Step handler functions are instance arrow fields, so they are named by the field. */
function handlerNames(workflow: Json): Map<unknown, string> {
  const names = new Map<unknown, string>();
  try {
    for (const key of Object.keys(workflow)) {
      const value = read(workflow, key);
      if (typeof value === "function") names.set(value, key);
    }
  } catch {
    // A frozen or exotic object; unnamed steps fall back to the function name.
  }
  return names;
}

/** A workflow event's label: workflow-core tags each event with `Symbol.toStringTag`. */
function eventLabel(event: unknown): string | undefined {
  if (!isObject(event)) return undefined;
  try {
    const tag = /^\[object (.+)\]$/.exec(Object.prototype.toString.call(event))?.[1];
    return tag !== undefined && tag !== "Object" && !tag.startsWith("WorkflowEvent") ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** A workflow event's payload, minus the run's whole state object. */
function eventData(data: unknown): unknown {
  if (!isObject(data) || Array.isArray(data)) return data;
  const rest = { ...data };
  delete rest.state;
  return rest;
}

/**
 * `AgentWorkflow` stores a thrown tool as `Error: ${new Error(String(output))}`,
 * where `output` is already `prettifyError`'s rendering — three nested
 * prefixes for one failure. Keep the innermost, as `<name>: <message>`.
 *
 * `prettifyError` has two spellings: `Error: <message>` on older releases and
 * `Error(<name>): <message>` on llamaindex 0.12, which recorded verbatim read
 * "Error: Error(Error): unknown region: latam".
 */
function cleanToolError(result: unknown): string {
  let text = typeof result === "string" ? result : String(result);
  while (/^Error: (\w*Error: |Error\(\w*\): )/.test(text)) text = text.slice("Error: ".length);
  const named = /^Error\((\w*)\): ([\s\S]*)$/.exec(text);
  if (named) text = `${named[1] || "Error"}: ${named[2]}`;
  return text;
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

interface Installed {
  state: State;
  unsubscribe: Array<() => void>;
  patcher: core.Patcher;
}

let installed: Installed | null = null;

const BUS_EVENTS: Array<[string, keyof State]> = [
  ["llm-start", "llmStart"],
  ["llm-stream", "llmStream"],
  ["llm-end", "llmEnd"],
  ["llm-tool-call", "toolCall"],
  ["llm-tool-result", "toolResult"],
  ["retrieve-start", "retrieveStart"],
  ["retrieve-end", "retrieveEnd"],
  ["query-start", "queryStart"],
  ["query-end", "queryEnd"],
  ["agent-start", "agentStart"],
  ["agent-end", "agentEnd"],
];

/**
 * Subscribe to every copy of the bus and patch every copy of `AgentWorkflow`.
 *
 * Separate from `install()` so a test can hand it stand-ins for the framework
 * modules; `install()` is only about FINDING the right copies.
 *
 * THROWS while an earlier attach is still installed, before touching anything.
 * Overwriting it would orphan that install's bus subscriptions and prototype
 * patch — `uninstall()` only reaches the latest — so they would record for the
 * life of the process, every event twice. A throw rather than a no-op because a
 * no-op would hand back a handle for an install that did not happen, with
 * options that were never applied. `instrument()` never reaches this: it skips
 * an adapter that is already active.
 *
 * @internal Not part of the public API.
 */
export function attach(
  rawOptions: Record<string, unknown>,
  modules: {
    globals: GlobalModule[];
    workflows: WorkflowModule[];
    retrievers?: RetrieverModule[];
    asyncContexts?: AsyncContextModule[];
    frameworkPackage?: string;
  },
): { sweep: (now?: number) => number; residue: () => ReturnType<State["residue"]> } {
  if (installed !== null) {
    throw new Error(
      "the llamaindex adapter is already installed; uninstrument(\"llamaindex\") (or " +
        "adapter.uninstall()) before attaching again.",
    );
  }
  const options = parseOptions(rawOptions);
  const state = new State(options, modules.globals, modules.frameworkPackage ?? PACKAGE);
  const current: Installed = { state, unsubscribe: [], patcher: new core.Patcher() };
  installed = current;

  const buses = new Set<Bus>();
  for (const module of modules.globals) {
    const bus = module.Settings?.callbackManager as Bus | undefined;
    if (bus && typeof bus.on === "function") buses.add(bus);
  }
  if (buses.size === 0) {
    throw new Error(
      "Settings.callbackManager is missing or has no `on` — this build of LlamaIndex does not " +
        "expose the callback bus this adapter subscribes to.",
    );
  }
  for (const bus of buses) {
    if (typeof bus.off !== "function") {
      compat.warn(
        "this build of LlamaIndex has no `callbackManager.off`, so uninstrument() cannot detach " +
          "the handlers. They stay subscribed for the life of the process and emit nothing.",
        `${NAME}:off`,
      );
    }
    for (const [event, method] of BUS_EVENTS) {
      // Named per event BEFORE `safe()` reads the name: the name is the
      // degradation site, and one shared site would let a handler that keeps
      // failing on, say, `retrieve-end` switch off `llm-start` with it.
      const named = {
        [method](raw: unknown): void {
          if (!state.active) return;
          (state[method] as (event: unknown) => void).call(state, raw);
        },
      }[method]!;
      const handler = core.safe(NAME, named);
      bus.on(event, handler);
      current.unsubscribe.push(() => {
        bus.off?.(event, handler);
      });
    }
  }
  if (options.embeddings) {
    logger.debug(
      "llamaindex: embeddings=true has nothing to record — LlamaIndex.TS dispatches no embedding events.",
    );
  }

  const storages = new Set<AsyncLocalStorage<unknown>>();
  for (const module of modules.globals) {
    const storage = eventCallerStorage(module);
    if (storage) storages.add(storage);
  }
  for (const storage of storages) hookInvocations(current, storage);
  compat.probe(NAME, "EventCaller storage", () => storages.size > 0 || modules.globals.every((m) => !m.getEventCaller));
  for (const module of modules.retrievers ?? []) {
    patchRetriever(current, module);
  }
  for (const module of modules.workflows) {
    patchWorkflow(current, module);
  }
  for (const module of modules.asyncContexts ?? []) {
    hookAsyncContext(current, module);
  }
  state.startReaper();
  logger.debug(`llamaindex adapter subscribed on ${buses.size} bus(es), ${current.patcher.size} patch(es)`);
  return { sweep: (now?: number) => state.sweep(now), residue: () => state.residue() };
}

/**
 * LlamaIndex's own `AsyncLocalStorage` of `EventCaller`s — module-private in
 * `@llamaindex/core/global`, so found by watching which storage one call of
 * the exported `getEventCaller()` reads. The prototype is swapped back before
 * this returns: the window is one synchronous call, with no other code in it.
 *
 * @internal Exported for the unit tests.
 */
export function eventCallerStorage(module: GlobalModule): AsyncLocalStorage<unknown> | null {
  const getEventCaller = module.getEventCaller;
  if (typeof getEventCaller !== "function") return null;
  const proto = AsyncLocalStorage.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored as the same unbound function
  const original = proto.getStore;
  let found: unknown = null;
  proto.getStore = function getStore(this: AsyncLocalStorage<unknown>): unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- recording WHICH storage is read is the point
    found ??= this;
    return original.call(this);
  };
  try {
    getEventCaller();
  } catch {
    // An exotic build; no storage, so no invocation boundaries.
  } finally {
    proto.getStore = original;
  }
  return found instanceof AsyncLocalStorage ? (found as AsyncLocalStorage<unknown>) : null;
}

/**
 * See every LlamaIndex invocation start and end: `withEventCaller` runs each
 * `@wrapEventCaller` method (a chat engine's `chat`, a query engine's `query`,
 * a provider's `chat`, `AgentRunner.chat`) as `storage.run(new EventCaller(...), fn)`.
 * An own `run` on that ONE storage object wraps `fn`; no other storage in the
 * process is touched, and uninstall restores it.
 *
 * This is the run boundary the callback bus lacks: without it a chat engine
 * has no start or end event at all, so its retrieval and its model call were
 * two unrelated root runs in two sessions.
 */
function hookInvocations(current: Installed, storage: AsyncLocalStorage<unknown>): void {
  const state = current.state;
  // Whatever `run` this storage has now (normally the prototype's), called with the storage as `this`.
  const original = Reflect.get(storage, "run") as (this: unknown, ...args: unknown[]) => unknown;
  const replacement = function run(this: unknown, store: unknown, callback: unknown, ...args: unknown[]): unknown {
    if (!state.active || typeof callback !== "function" || !isObject(store) || !("caller" in store)) {
      return original.call(this, store, callback, ...args);
    }
    const fn = callback as (...a: unknown[]) => unknown;
    return original.call(
      this,
      store,
      function invocation(this: unknown, ...inner: unknown[]): unknown {
        return state.invocation(store, () => fn.apply(this, inner));
      },
      ...args,
    );
  };
  current.patcher.patch(storage, "run", replacement);
}

/**
 * `BaseRetriever.prototype.retrieve` — a plain prototype method, so this also
 * covers retrievers built before `instrument()` — binds the retriever for the
 * `retrieve-start` it dispatches, which carries only the query.
 */
function patchRetriever(current: Installed, module: RetrieverModule): void {
  const proto = module.BaseRetriever?.prototype as Record<string, unknown> | undefined;
  const ok = compat.probe(NAME, "BaseRetriever.retrieve", () => typeof proto?.retrieve === "function");
  if (!ok || !proto) return;
  const original = proto.retrieve as (...args: unknown[]) => unknown;
  const state = current.state;
  const replacement = function retrieve(this: object, ...args: unknown[]): unknown {
    if (!state.active || !isObject(this)) return original.apply(this, args);
    return state.retrievers.run(this, () => original.apply(this, args));
  };
  current.patcher.patch(proto, "retrieve", replacement);
}

/**
 * Plain `createWorkflow()` workflows. workflow-core runs every step handler as
 * `handlerContextAsyncLocalStorage.run(handlerContext, …)`, and from 1.1 that
 * storage is an `AsyncContext.Variable` — a class exported from
 * `@llamaindex/workflow-core/async-context`, so its prototype `run` sees every
 * handler of every context, including workflows built before `instrument()`.
 * (Before 1.1, and on `@llama-flow/core`, it is a closure: nothing to hook.)
 * Only a value shaped like a handler context is acted on; every other use of
 * the class passes straight through.
 */
function hookAsyncContext(current: Installed, module: AsyncContextModule): void {
  const proto = module.AsyncContext?.Variable?.prototype as Record<string, unknown> | undefined;
  if (typeof proto?.run !== "function") {
    logger.debug("llamaindex: this workflow-core has no AsyncContext.Variable; plain workflows are not runs.");
    return;
  }
  const original = proto.run as (value: unknown, fn: () => unknown) => unknown;
  const state = current.state;
  const replacement = function run(this: unknown, value: unknown, fn: () => unknown): unknown {
    if (!state.active || !isHandlerContext(value)) return original.call(this, value, fn);
    let proceeded = false;
    const proceed = (): unknown => {
      proceeded = true;
      return original.call(this, value, fn);
    };
    try {
      return state.plainStep(value, proceed);
    } catch (error) {
      // A failure of ours before the handler ran must not stop the workflow;
      // one from the handler (after `proceed`) is the application's own.
      if (proceeded) throw error;
      core.callSafely(
        () => {
          throw error;
        },
        [],
        `${NAME}.plainStep`,
      );
      return original.call(this, value, fn);
    }
  };
  current.patcher.patch(proto, "run", replacement);
}

/** workflow-core's per-invocation handler context, by shape. */
function isHandlerContext(value: unknown): value is Json {
  return (
    isObject(value) &&
    typeof read(value, "handler") === "function" &&
    Array.isArray(read(value, "inputs")) &&
    read(value, "next") instanceof Set &&
    "prev" in value
  );
}

function patchWorkflow(current: Installed, module: WorkflowModule): void {
  const proto = module.AgentWorkflow?.prototype as Record<string, unknown> | undefined;
  const ok = compat.probe(NAME, "AgentWorkflow.runStream", () => typeof proto?.runStream === "function");
  if (!ok || !proto) return;
  const original = proto.runStream as (...args: unknown[]) => unknown;
  const state = current.state;
  const replacement = function runStream(this: Json, ...args: unknown[]): unknown {
    if (!state.active) return original.apply(this, args);
    const wf = read(this, "workflow") as Json | undefined;
    const createContext = read(wf, "createContext");
    const own = wf ? Object.getOwnPropertyDescriptor(wf, "createContext") : undefined;
    // Without the context there is no end signal, so an opened run would stay
    // open until the reaper: record the calls inside it as loose runs instead.
    const observable = compat.probe(
      NAME,
      "AgentWorkflow.workflow.createContext",
      () => typeof createContext === "function" && own?.writable === true,
    );
    if (!observable) return original.apply(this, args);
    let attach: ((context: unknown) => void) | undefined;
    let run: Run | null = null;
    core.callSafely(
      () => {
        ({ run, attach } = state.beginWorkflow(this, args[0], module));
      },
      [],
      `${NAME}.beginWorkflow`,
    );
    const intercept = attach !== undefined;
    if (intercept) {
      // `runStream` creates the context and sends the start event in one
      // synchronous call, and the first step runs inside that send. So the
      // subscriptions go on the context the moment it exists, for exactly the
      // duration of this call.
      wf!.createContext = function createContextOnce(this: unknown, ...inner: unknown[]): unknown {
        const context = (createContext as (...a: unknown[]) => unknown).apply(this, inner);
        core.callSafely(() => attach!(context), [], `${NAME}.attachContext`);
        return context;
      };
    }
    try {
      return original.apply(this, args);
    } catch (error) {
      core.callSafely(() => state.failWorkflow(run, error), [], `${NAME}.failWorkflow`);
      throw error;
    } finally {
      if (intercept && own) Object.defineProperty(wf!, "createContext", own);
    }
  };
  current.patcher.patch(proto, "runStream", replacement);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

async function loadCopies(specifier: string): Promise<unknown[] | null> {
  try {
    return await compat.requireModuleCopies(specifier, INSTALL);
  } catch {
    return null;
  }
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    compat.checkVersion(NAME, PACKAGE, {
      minimum: MIN_VERSION,
      below: BELOW_VERSION,
      reason: "the first release whose agent() runs on the @llamaindex/workflow 1.1 runtime",
    });

    // `@llamaindex/core/global` is where the bus singleton lives, and it is the
    // one module every LlamaIndex install has — an app on `@llamaindex/core` +
    // `@llamaindex/workflow` alone never installs the umbrella. The umbrella
    // re-exports the same `Settings`, so it is only the fallback for a layout
    // (pnpm, strict) where the app cannot resolve the scoped package itself.
    let globals = (await loadCopies("@llamaindex/core/global")) as GlobalModule[] | null;
    let frameworkPackage = compat.versionString(PACKAGE) !== null ? PACKAGE : CORE_PACKAGE;
    let retrievers = (await loadCopies("@llamaindex/core/retriever")) as RetrieverModule[] | null;
    if (!globals?.some((module) => module.Settings)) {
      globals = (await compat.requireModuleCopies(PACKAGE, INSTALL)) as GlobalModule[];
      frameworkPackage = PACKAGE;
      // The umbrella re-exports `BaseRetriever` from the same copy of core.
      retrievers = globals as RetrieverModule[];
    }

    // The workflow package is optional: a legacy-agent or query-engine app does
    // not have it, and that is not a reason to record nothing.
    let workflows: WorkflowModule[] = [];
    if (compat.versionString(WORKFLOW_PACKAGE) !== null) {
      compat.checkVersion(NAME, WORKFLOW_PACKAGE, {
        minimum: WORKFLOW_MIN,
        below: WORKFLOW_BELOW,
        reason: "1.1 moved agent workflows onto @llamaindex/workflow-core",
      });
      workflows = ((await loadCopies(WORKFLOW_PACKAGE)) ?? []) as WorkflowModule[];
    }
    // Plain workflows: workflow-core ≥1.1 only (see `hookAsyncContext`). Resolved
    // from the application, so a layout that does not hoist it (pnpm) leaves
    // plain workflows unrecorded as runs — their model calls still are.
    const asyncContexts = ((await loadCopies(ASYNC_CONTEXT_MODULE)) ?? []) as AsyncContextModule[];
    attach(options, { globals, workflows, retrievers: retrievers ?? [], asyncContexts, frameworkPackage });
  },

  uninstall(): void {
    const current = installed;
    installed = null;
    if (current === null) return;
    for (const unsubscribe of current.unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Detaching is best-effort; `state.active = false` below is what
        // actually stops events being recorded.
      }
    }
    current.patcher.restoreAll();
    core.callSafely(() => {
      current.state.shutdown();
    }, [], `${NAME}.shutdown`);
  },
};
