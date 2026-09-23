/**
 * LangChain.js and LangGraph.js.
 *
 * The TypeScript twin of the Python SDK's `integrations/langchain.py`, and it
 * is held to that adapter's output: both SDKs write into one pipe and the
 * dashboard cannot tell which language wrote an event, so for the same program
 * they must draw the same tree. Every mapping decision below is Python's, and
 * where JavaScript forced a different mechanism the comment says why. Verified
 * against `@langchain/core` 0.3.80 + `@langchain/langgraph` 0.4.10 and
 * `@langchain/core` 1.2.12 + `@langchain/langgraph` 1.4.17 — the two fixtures
 * under `integration/fixtures/langchain-*`, which run this file from the packed
 * tarball as both ES module and CommonJS.
 *
 * ## The mapping
 *
 *     LangChain / LangGraph        FailproofAI
 *     ---------------------------  ------------------------------------------
 *     root run (no parent)         agent_start / agent_end
 *     LangGraph node               hook_triggered / hook_completed,
 *                                  trigger_event="graph_node"
 *     compiled subgraph            nested agent_start ("root/node")
 *     tool run                     tool_use / tool_result (the MODEL's id)
 *     retriever run                tool_use / tool_result (summarised)
 *     chat model / LLM run         model_request / model_response
 *     interrupt()                  human_wait + agent_pause
 *     Command({ resume })          agent_resume + human_input
 *     intermediate chains          nothing (see `includeChains`)
 *
 * **A LangGraph node is a hook, not a nested agent.** `agent_id` is a
 * `LowCardinality(String)` column and the primary facet on every dashboard
 * surface, and a session is labelled with the first `agent_id` it saw — so
 * promoting `retrieve`, `grade_documents` and `should_continue` to agents would
 * drown the facet and name the session after whichever node ran first. Hook
 * spans draw identically on the timeline, and `/hooks` becomes a per-node
 * latency page for free. (The first release of this adapter made every node an
 * agent, which is exactly the trace this paragraph exists to prevent.)
 *
 * ## Where it attaches
 *
 * `CallbackManager.configure` and `CallbackManager._configureSync` — the two
 * functions every runnable calls to build the manager for an invocation, and
 * the one LangGraph's Pregel loop calls for the graph itself. Patching them
 * attaches the handler to every `invoke`/`stream`/`batch` in the process
 * without the caller passing `callbacks:` anywhere. LangChain.js has no
 * supported global-handler registry (Python has `register_configure_hook`), so
 * this is the only placement that works without editing call sites. Both are
 * patched on EVERY loaded copy of `@langchain/core` — see
 * `compat.requireModuleCopies` for why there can be two — and on every copy
 * nested under a dependency that pinned its own (see `nestedManagers`).
 *
 * `langchainHandler()` is the patch-free path: the same handler, passed
 * explicitly. It works with or without `instrument()`, and the two together do
 * not double-record, because attaching is idempotent on a marker the handler
 * carries rather than on object identity.
 *
 * ## Why the handler is awaited
 *
 * `awaitHandlers: true` is not optional, for the same reason Python sets
 * `run_inline = True`. Without it LangChain queues every callback on a
 * background promise queue: callbacks land after the call that caused them
 * returned, possibly after the process flushed its spool, and — the part that
 * is not recoverable — in whatever async context the queue happens to run in,
 * so an enclosing `failproofai.agent()` scope is invisible to them and a graph
 * that should nest under it becomes a second, unrelated session. Every
 * callback here is synchronous bookkeeping plus an in-memory `submit`, so
 * awaiting it costs nothing measurable.
 *
 * ## Control flow is not failure
 *
 * LangGraph reports an `interrupt()` through the same `handleChainError` as a
 * genuine failure — the node run "errors" with a `GraphInterrupt`. Reporting it
 * would paint a red error plus `agent_end(outcome="failed")` on every human
 * approval. Anything LangGraph marks `is_bubble_up` (`GraphInterrupt`,
 * `NodeInterrupt`, `ParentCommand`, `GraphDrained`), or whose name says it is
 * one, is treated as control flow and emits the human-in-the-loop pairs
 * instead.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { sessionId as ambientSessionId } from "../context.js";
import { logger } from "../logger.js";
import { isCancellation as isScopeCancellation } from "../scopes.js";
import {
  entryIsCommonJs,
  importModule,
  isRequired,
  nestedCopies,
  nodeRequire,
  resolveExportsAt,
  resolveFrom,
} from "../node-require.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "langchain";
const PACKAGE = "@langchain/core";
const GRAPH_PACKAGE = "@langchain/langgraph";

/**
 * The documented per-call session key — the same string the Python SDK reads,
 * so one config object means the same thing to both:
 *
 *     graph.invoke(input, { metadata: { failproofai_sdk_session_id: requestId } })
 */
export const SESSION_METADATA_KEY = "failproofai_sdk_session_id";

/**
 * Checked in order after the explicit key. `thread_id` is last because a thread
 * is a *conversation*: two turns on one thread are two runs, and a caller who
 * wants them merged says so with one of the earlier keys.
 */
const SESSION_METADATA_FALLBACKS = ["session_id", "conversation_id", "thread_id"] as const;

/**
 * LangSmith's convention for "machinery, not user-visible work". Demoted rather
 * than dropped: never a span, but kept in the parent chain so its children
 * still find the agent above them.
 */
const HIDDEN_TAG = "langsmith:hidden";

/**
 * A run of one of these types is a leaf — a model call, a tool call, a
 * retrieval — and is never a LangGraph node's own run: whatever is handed to
 * `addNode`, the node's own run is a chain run and the thing passed runs as its
 * child.
 */
const LEAF_RUN_TYPES: ReadonlySet<string> = new Set(["llm", "chat_model", "tool", "retriever"]);

/** LangChain tags every step of a `RunnableSequence` `seq:step:N`; a node is `graph:step:N`. */
const INNER_STEP_TAG = "seq:step:";

/**
 * Name-based fallback for `is_bubble_up`. Getting this wrong is expensive and
 * silent — a red error on every human approval — so it is worth a second check.
 */
const CONTROL_FLOW_NAMES: ReadonlySet<string> = new Set([
  "GraphBubbleUp",
  "GraphInterrupt",
  "NodeInterrupt",
  "ParentCommand",
  "GraphDrained",
]);

/**
 * JavaScript's own cancellation: an `AbortSignal` firing inside a run, which is
 * how a stream whose consumer went away and a request whose client
 * disconnected both end. The analogue of Python's `GeneratorExit` /
 * `CancelledError`, and for the same reason: a stopped stream is not a crashed
 * one, and must not flip a healthy session to failed.
 */
const CANCELLATION_NAMES: ReadonlySet<string> = new Set(["AbortError"]);

/**
 * LangGraph.js (>= 1.x) routes interrupt/resume lifecycle events to any handler
 * carrying this marker — its `GraphCallbackHandler.isInstance` is a duck-typed
 * check on exactly this registered symbol. Setting it on a plain object means
 * the handler gets `handleInterrupt`/`handleResume` without this module ever
 * importing LangGraph. On 0.x the symbol means nothing and the exception-path
 * fallback produces the same pairs.
 */
const GRAPH_CALLBACK_HANDLER = Symbol.for("langgraph.graph_callback_handler");

/**
 * Marks our handler, so "is it already attached?" is answered by what the
 * handler IS rather than which object it is. Identity is not enough: a manager
 * built from `callbacks: [langchainHandler()]` and then passed through the
 * patched `configure` would otherwise carry it once per path.
 */
const HANDLER_MARK = Symbol.for("failproofai.langchain.handler");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Everything `instrument("langchain", ...)` and `langchainHandler()` accept. */
export interface LangChainOptions {
  /** Pin every run to this session id (step 1 of the resolution order). */
  sessionId?: string;
  /** Drop prompts, messages and outputs; keep structure, durations and tokens. */
  captureContent?: boolean;
  /** Record these intermediate chains, by run name, as `trigger_event="pipeline"` hooks. */
  includeChains?: string | Iterable<string>;
  /** LangGraph interrupt/resume lifecycle callbacks (LangGraph.js >= 1). Default on. */
  graphCallbacks?: boolean;
  /** Per-value truncation ceiling. Default: the core field limit. */
  captureLimit?: number | string;
}

interface Options {
  sessionId: string | null;
  includeChains: ReadonlySet<string>;
  captureContent: boolean;
  graphCallbacks: boolean;
  captureLimit: number;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "sessionId",
  "includeChains",
  "captureContent",
  "graphCallbacks",
  "captureLimit",
]);

function defaultOptions(): Options {
  return {
    sessionId: null,
    includeChains: new Set(),
    captureContent: true,
    graphCallbacks: true,
    captureLimit: core.FIELD_LIMIT,
  };
}

/**
 * Validate `captureLimit`, falling back rather than throwing.
 *
 * `instrument()` with no name installs every detected adapter with the same
 * options object, so a value meant for — or mistyped for — another framework
 * must never take this one down. `Infinity`, the obvious spelling of "capture
 * everything", is not an integer and falls back too (it is what broke the
 * Python adapter's startup under strict mode).
 */
export function captureLimitOf(value: unknown): number {
  if (value === undefined || value === null) return core.FIELD_LIMIT;
  const limit = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    logger.warn(`langchain captureLimit=${display(value)} is not an integer; using ${core.FIELD_LIMIT}`);
    return core.FIELD_LIMIT;
  }
  if (limit < 1) {
    logger.warn(`langchain captureLimit=${limit} must be >= 1; using ${core.FIELD_LIMIT}`);
    return core.FIELD_LIMIT;
  }
  return limit;
}

/** `LangChainOptions` (or the shared `instrument()` bag) -> the validated `Options`. */
export function readOptions(options: Record<string, unknown> = {}): Options {
  const unknown = Object.keys(options).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    // Not fatal: a bare `instrument()` hands every adapter the same options,
    // so one meant for another framework legitimately arrives here.
    logger.debug(`langchain adapter ignoring options ${JSON.stringify(unknown.sort())}`);
  }
  const include = options.includeChains;
  let chains: string[] = [];
  if (typeof include === "string") chains = [include];
  else if (include !== null && typeof include === "object" && Symbol.iterator in include) {
    chains = [...(include as Iterable<unknown>)].map(String);
  }
  const sid = options.sessionId;
  return {
    sessionId: sid === undefined || sid === null || sid === "" ? null : display(sid),
    includeChains: new Set(chains),
    captureContent: options.captureContent === undefined ? true : Boolean(options.captureContent),
    graphCallbacks: options.graphCallbacks === undefined ? true : Boolean(options.graphCallbacks),
    captureLimit: captureLimitOf(options.captureLimit),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * One FailproofAI session, which may outlive a single `.invoke()`.
 *
 * It has to: a human-in-the-loop graph runs `invoke()`, interrupts, and is
 * resumed by a *second* `invoke()` minutes later. Both are the same session and
 * the same root agent, and the agent stays open across the gap so that
 * `agent_pause` -> `agent_resume` measures the wait.
 */
interface Session {
  sessionId: string;
  agentKey: string;
  agentId: string;
  /** pause id -> the prompt it asked, for `human_input.fw_prompt`. */
  openPauses: Map<string, string | undefined>;
  reportedError: boolean;
  /** When its root ended with a pause still open; null while running. */
  pausedAt: number | null;
}

/**
 * Bookkeeping for a resume whose pause was opened in ANOTHER process. Set on
 * the ROOT run only, and only when this process has no open pause of its own to
 * close. See `closeRemotePause`.
 */
interface RemoteResume {
  value: unknown;
  /** level key (checkpoint-ns prefix) -> the `langgraph_step` of the first node seen there. */
  levels: Map<string, unknown>;
  /** The deepest level LangGraph said is resuming (`handleResume`, LangGraph.js >= 1). */
  deepest: string | null;
  done: Set<string>;
}

type RunType = "chain" | "llm" | "chat_model" | "tool" | "retriever";
type Kind = "" | "root" | "node" | "tool" | "retriever" | "model" | "chain" | "subgraph";

/** What we need about a LangChain run after its start callback returns. */
interface RunInfo {
  id: string;
  parent: string | null;
  name: string;
  runType: RunType;
  started: number;
  hidden: boolean;
  kind: Kind;
  /** Set only on a ROOT run that is itself a leaf — a bare `model.invoke()`, a standalone tool. */
  leafKind: "" | "model" | "tool" | "retriever";
  root: string | null;
  session: Session | null;
  node: string | null;
  toolCallId: string | null;
  model: string | null;
  ttftMs: number | null;
  chunks: number;
  remote: RemoteResume | null;
  tags: string[];
  meta: Record<string, unknown>;
  /** Chain inputs, kept for `goal` and for recovering a tool call's id on core 0.3. */
  inputs: unknown;
  /** Tool-call ids already handed to a child tool run (0.3 id recovery). */
  claimed: Set<string> | null;
  /** ROOT only: bumped by every callback under this root (see `reapIfAbandoned`). */
  activity: number;
}

interface StartArgs {
  id: string;
  parent: string | null;
  name: string;
  runType: RunType;
  tags: string[];
  meta: Record<string, unknown>;
  inputs: unknown;
  /** The chat model's messages, still as `BaseMessage` objects. */
  messages?: unknown[];
  invocationParams?: Record<string, unknown>;
  toolCallId?: string;
}

interface EndArgs {
  outputs?: unknown;
  error?: unknown;
  response?: unknown;
}

const MAX_RUNS = 10_000;
const MAX_SESSIONS = 1_000;

/**
 * How long this process keeps a run that paused on a human.
 *
 * An interrupted graph deliberately leaves its agent open so the resume can
 * continue it — but the resume usually lands on ANOTHER worker, which already
 * handles it (`closeRemotePause`), and then this process would hold the agent
 * forever: a slot in the tracker that live runs need, plus a linear cost on
 * every lookup that scanned open agents. After this long it is forgotten
 * without emitting anything. A resume that does arrive here later takes the
 * same path a cross-worker resume does, so nothing is lost but the in-process
 * shortcut.
 */
export const PAUSED_SESSION_TTL_MS = 15 * 60_000;

/**
 * All cross-callback state, module level on purpose: one handler object serves
 * every callback manager in the process, and a start and its end are separate
 * calls on possibly different async branches.
 */
class State {
  /**
   * The kill switch `uninstrument()` flips. Restoring `configure` stops new
   * managers getting the handler, but a handler object somebody already holds
   * (from `langchainHandler()`) or a manager already built would keep
   * recording; this makes every entry point a no-op instead.
   */
  enabled = false;
  installed = false;
  options: Options = defaultOptions();
  tracker: core.RunTracker = State.newTracker(core.FIELD_LIMIT);
  runs = new Map<string, RunInfo>();
  sessions = new Map<string, Session>();

  static newTracker(limit: number): core.RunTracker {
    return new core.RunTracker(NAME, { baseFields: baseFields(), fieldLimit: limit });
  }

  configure(options: Options): void {
    this.options = options;
    this.tracker = State.newTracker(options.captureLimit);
    this.runs.clear();
    this.sessions.clear();
  }

  reset(): void {
    this.tracker.reset();
    this.runs.clear();
    this.sessions.clear();
  }

  /**
   * FIFO; a `Map` keeps insertion order. Orphaned entries are normal — a
   * cancelled stream, a crashed node, a framework that skipped an end callback
   * — and unbounded, each table is a memory leak in a long-lived server.
   */
  evict(): void {
    while (this.runs.size >= MAX_RUNS) {
      const oldest = this.runs.keys().next();
      if (oldest.done) break;
      this.runs.delete(oldest.value);
      this.tracker.unlink(oldest.value);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.dropSession(oldest.value);
    }
  }

  /**
   * Forget sessions paused longer than `PAUSED_SESSION_TTL_MS`.
   *
   * Paused sessions are the only ones that outlive their root, and a `Map`
   * keeps insertion order, so a sweep from the front stops at the first one
   * that is either not paused or not yet stale.
   */
  sweepPaused(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.pausedAt === null) continue;
      if (now - session.pausedAt <= PAUSED_SESSION_TTL_MS) break;
      this.dropSession(id);
    }
  }

  /** Remove a session; a paused one's agent is forgotten, never closed. */
  dropSession(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session !== undefined && session.pausedAt !== null) this.tracker.forget(session.agentKey);
  }
}

function baseFields(): Record<string, unknown> {
  const fields = core.frameworkFields(NAME, PACKAGE);
  const graphVersion = compat.versionString(GRAPH_PACKAGE);
  if (graphVersion) fields.fw_langgraph_version = graphVersion;
  return fields;
}

const state = new State();
let patcher: core.Patcher | null = null;

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;

function isPlainObject(value: unknown): value is Loose {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `runName` first, then the serialized `name`, then the last `id` segment (the class name). */
function runNameOf(serialized: unknown, runName: unknown, fallback: string): string {
  if (typeof runName === "string" && runName) return runName;
  const value = serialized as { name?: unknown; id?: unknown } | undefined;
  if (typeof value?.name === "string" && value.name) return value.name;
  const id = value?.id;
  if (Array.isArray(id) && id.length > 0) {
    const last = id[id.length - 1] as unknown;
    if (typeof last === "string" && last) return last;
  }
  return fallback;
}

/** A LangChain message's type (`human`, `ai`, `tool`, `system`), or null for anything else. */
function messageType(value: unknown): string | null {
  if (!isObject(value)) return null;
  for (const method of ["getType", "_getType"]) {
    const fn: unknown = value[method];
    if (typeof fn === "function") {
      try {
        const type = (fn as () => unknown).call(value);
        if (typeof type === "string" && type) return type;
      } catch {
        // A message whose type getter throws is still not worth failing over.
      }
    }
  }
  return null;
}

/**
 * The payload view of a LangChain value: messages as `{type, content, ...}`,
 * anything else `Serializable` as its constructor kwargs.
 *
 * `truncate()` would otherwise reach these through `toJSON()`, which LangChain
 * defines as its SERIALISATION envelope — `{lc: 1, type: "constructor", id:
 * [...], kwargs}` — so every graph-state payload would render as class paths
 * with the content buried one level down. The Python adapter gets the
 * equivalent of this view from pydantic's `model_dump`.
 */
function plain(value: unknown, depth = 0): unknown {
  if (!isObject(value) || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
  const type = messageType(value);
  if (type !== null) {
    const out: Loose = { type, content: plain(value.content, depth + 1) };
    for (const key of ["name", "id", "tool_call_id", "status"]) {
      if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
    }
    for (const key of ["tool_calls", "usage_metadata"]) {
      const field = value[key];
      if (field !== undefined && field !== null && !(Array.isArray(field) && field.length === 0)) {
        out[key] = plain(field, depth + 1);
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: Loose = {};
    for (const [key, item] of Object.entries(value)) out[key] = plain(item, depth + 1);
    return out;
  }
  const kwargs = (value as Loose).lc_kwargs;
  if (isObject(kwargs)) return plain(kwargs, depth + 1);
  // A LangGraph `Command` / `Send` — what every `createAgent` model node
  // returns. Not `Serializable`, so `truncate()` would dump it through its own
  // `toJSON()` and every message inside through LangChain's envelope. Take the
  // dump here instead and give its contents the same payload view.
  const dump = (value as { toJSON?: unknown }).toJSON;
  if (typeof dump === "function") {
    try {
      const dumped: unknown = (dump as () => unknown).call(value);
      if (isPlainObject(dumped) && dumped.lc === undefined) return plain(dumped, depth + 1);
    } catch {
      // A throwing `toJSON` is the value's problem; `truncate` renders it.
    }
  }
  return value;
}

const limit = (): number => state.options.captureLimit;

/** Payload discipline for the big three: inputs, outputs, graph state. */
function shrink(value: unknown): unknown {
  if (!state.options.captureContent || value === undefined) return undefined;
  return core.truncate(plain(value), limit());
}

function tagsOf(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function metaOf(metadata: unknown): Record<string, unknown> {
  return isObject(metadata) ? { ...metadata } : {};
}

/**
 * The LangGraph node name iff this run is the node's OWN run.
 *
 * Every inner runnable inherits `langgraph_node` from the node that contains
 * it, so the metadata alone matches the node, the chat model inside it, the
 * tool it called and each conditional-edge function. Only the node's own run
 * is NAMED after the node — but the name is the user's to choose on both
 * sides, and the Python adapter verified three collisions that each deleted
 * the most valuable event in the trace: a node named after its tool swallowed
 * the tool pair, a node named after its model swallowed the model pair, and an
 * inner runnable carrying the node's name doubled the node's visits. So the run
 * must also be SHAPED like a node's own run: a non-leaf run type, and not an
 * inner step of a `RunnableSequence`. Both are exclusions, so if LangGraph ever
 * stops emitting `seq:step:` tags this degrades to a duplicate span rather than
 * to no spans.
 */
export function nodeOf(
  run: { name: string; runType: string; tags: readonly string[] },
  meta: Record<string, unknown>,
): string | null {
  const node = meta.langgraph_node;
  if (typeof node !== "string" || !node || node !== run.name) return null;
  if (LEAF_RUN_TYPES.has(run.runType)) return null;
  if (run.tags.some((tag) => tag.startsWith(INNER_STEP_TAG))) return null;
  return node;
}

/**
 * `langgraph_checkpoint_ns` split into its `name:uuid` segments. One segment
 * for a top-level node, `child:uuid|inner:uuid` inside a compiled subgraph: the
 * number beyond the first is the nesting depth, and the leading segments name
 * the subgraphs — which is how nested agents get their ids without recognising
 * a compiled graph from a callback.
 */
function nsParts(meta: Record<string, unknown>): string[] {
  const ns = meta.langgraph_checkpoint_ns;
  return typeof ns === "string" && ns ? ns.split("|") : [];
}

function errorName(error: unknown): string {
  if (isObject(error)) {
    if (typeof error.name === "string" && error.name) return error.name;
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctor === "string" && ctor) return ctor;
  }
  return "Error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

/** Names on the error AND its class chain — a subclass keeps its parent's meaning. */
function errorNames(error: unknown): string[] {
  const names = [errorName(error)];
  let proto: unknown = isObject(error) ? Object.getPrototypeOf(error) : null;
  while (isObject(proto)) {
    const ctor = (proto as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctor === "string") names.push(ctor);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

export function isControlFlow(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (error.is_bubble_up === true) return true;
  return errorNames(error).some((name) => CONTROL_FLOW_NAMES.has(name));
}

export function isCancellation(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (isScopeCancellation(error)) return true;
  if (errorNames(error).some((name) => CANCELLATION_NAMES.has(name))) return true;
  // LangChain's own abort sentinels, bare `Error`s identified only by their
  // text: core's `raceWithSignal` rejects with "Aborted" when the signal
  // carries no reason of its own, and LangGraph.js 0.x fails the graph's root
  // run with "Abort".
  return (
    error instanceof Error &&
    error.name === "Error" &&
    (error.message === "Aborted" || error.message === "Abort")
  );
}

function outcomeOf(error: unknown): string {
  if (error === undefined || error === null) return "success";
  if (isControlFlow(error)) return "paused";
  // Before `failed`, or an abandoned stream reads as a crash.
  if (isCancellation(error)) return "cancelled";
  return "failed";
}

/**
 * The error as one short line — `"Error: model exploded"` — never the stack.
 * The stack belongs on an `error` event's `traceback`; inline in
 * `tool_result.error` it is unreadable.
 */
function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null || isControlFlow(error)) return undefined;
  return core.truncate(`${errorName(error)}: ${errorMessage(error)}`, limit()) as string;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Pick the session id for a root run, first that produces a value wins:
 *
 *   1. `instrument("langchain", { sessionId })`;
 *   2. `metadata.failproofai_sdk_session_id` on the call — the documented
 *      per-call key, the one to use in a web service;
 *   3. an enclosing `failproofai.session()` / `failproofai.agent()` scope, so a
 *      hand-written outer bracket and the adapter produce ONE session;
 *   4. `metadata.session_id | conversation_id | thread_id`;
 *   5. the root run id.
 *
 * Never synthesised from scratch: a made-up id splits one run into many
 * sessions, a silent wrong answer rather than a loud one.
 */
function resolveSessionId(id: string, meta: Record<string, unknown>): string {
  if (state.options.sessionId) return state.options.sessionId;
  const explicit = meta[SESSION_METADATA_KEY];
  if (explicit !== undefined && explicit !== null && explicit !== "") return display(explicit);
  const ambient = ambientSessionId();
  if (ambient) return ambient;
  for (const key of SESSION_METADATA_FALLBACKS) {
    const value = meta[key];
    if (value !== undefined && value !== null && value !== "") return display(value);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

function emit(method: core.EventMethod, info: RunInfo, fields: Record<string, unknown>): void {
  state.tracker.emit(method, info.id, { parentKey: info.parent, ...fields });
}

function emitOnAgent(session: Session, method: core.EventMethod, fields: Record<string, unknown>): void {
  state.tracker.emit(method, session.agentKey, fields);
}

/**
 * The `fw_*` extras every event from this adapter carries. Namespaced as a
 * SAFETY rule: the schema merges extras last, so an extra called `tool_name`
 * or `outcome` would silently overwrite the declared field.
 */
function fwCommon(info: RunInfo): Record<string, unknown> {
  const meta = info.meta;
  return core.fwFields({
    run_id: info.id,
    parent_run_id: info.parent ?? undefined,
    node: info.node ?? meta.langgraph_node,
    step: meta.langgraph_step,
    checkpoint_ns: meta.langgraph_checkpoint_ns,
    thread_id: meta.thread_id,
    tags: info.tags.length > 0 ? info.tags : undefined,
    hidden: info.hidden ? true : undefined,
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function onStart(args: StartArgs): void {
  if (!state.enabled) return;
  state.evict();
  if (args.parent === null) state.sweepPaused(Date.now());
  const info: RunInfo = {
    id: args.id,
    parent: args.parent,
    name: args.name,
    runType: args.runType,
    started: Date.now(),
    hidden: args.tags.includes(HIDDEN_TAG),
    kind: "",
    leafKind: "",
    root: null,
    session: null,
    node: null,
    toolCallId: null,
    model: null,
    ttftMs: null,
    chunks: 0,
    remote: null,
    tags: args.tags,
    meta: args.meta,
    inputs: args.runType === "chain" ? args.inputs : undefined,
    claimed: null,
    activity: 0,
  };
  state.runs.set(info.id, info);
  // Every run is linked, span or not: a tool three runnables deep still finds
  // the agent above it by walking the chain, and an intermediate chain that
  // emits nothing would otherwise break the walk.
  state.tracker.link(info.id, info.parent);

  if (info.parent === null) {
    startRoot(info, args);
    return;
  }

  const holder = state.runs.get(info.parent);
  if (holder === undefined) warnOrphan(info);
  info.root = holder?.root ?? null;
  info.session = holder?.session ?? null;
  touch(info.root);

  const node = nodeOf(info, info.meta);
  if (node !== null) {
    info.kind = "node";
    info.node = node;
    startNode(info, args);
    return;
  }
  if (info.runType === "llm" || info.runType === "chat_model") {
    info.kind = "model";
    startModel(info, args);
    return;
  }
  if (info.runType === "tool") {
    info.kind = "tool";
    startTool(info, args);
    return;
  }
  if (info.runType === "retriever") {
    info.kind = "retriever";
    startRetriever(info, args);
    return;
  }
  // Everything else — RunnableSequence, prompt templates, output parsers,
  // conditional-edge functions, a compiled subgraph's own run. Linked above and
  // otherwise invisible unless explicitly allowlisted.
  if (info.name && state.options.includeChains.has(info.name) && !info.hidden) {
    info.kind = "chain";
    emit("hookTriggered", info, {
      hookName: info.name,
      hookId: info.id,
      triggerEvent: "pipeline",
      input: shrink(args.inputs),
      ...fwCommon(info),
    });
  }
}

/**
 * A run whose parent this adapter never saw start. The usual cause is an
 * `instrument()` that was not awaited: the graph's root run began before the
 * callback was installed, so its children arrive with a parent nobody knows
 * and a node or a model call ends up as the session's agent — a wrong trace,
 * with nothing said. Warned once per process; the trace itself cannot be
 * repaired after the fact.
 */
let warnedOrphan = false;

function warnOrphan(info: RunInfo): void {
  if (warnedOrphan || info.hidden) return;
  warnedOrphan = true;
  logger.warn(
    `a LangChain run (${JSON.stringify(info.name)}) started under a parent run the langchain ` +
      "adapter never saw, so its trace is missing the root. Most often `instrument()` was not " +
      "awaited before the run began — `await failproofai.instrument()` at startup, before the " +
      "first invoke/stream.",
  );
}

/** @internal Re-arm the once-per-process orphan warning, for tests. */
export function resetOrphanWarning(): void {
  warnedOrphan = false;
}

/**
 * The root run becomes the session's agent — and its FIRST event. A session is
 * labelled by the first `agent_id` it saw, and the dashboard parents every leaf
 * to the open agent with the same `agent_id`, synthesising a never-ending root
 * span when there is none — so this must never be skipped or preceded.
 */
function startRoot(info: RunInfo, args: StartArgs): void {
  info.kind = "root";
  info.root = info.id;
  const sessionId = resolveSessionId(info.id, info.meta);

  const existing = state.sessions.get(sessionId);
  if (
    existing !== undefined &&
    existing.openPauses.size > 0 &&
    state.tracker.isOpen(existing.agentKey) &&
    isContinuation(args.inputs, info.meta)
  ) {
    // A resume: the previous `.invoke()` interrupted, we deliberately left its
    // agent open, and this continues it. Both halves of the test are needed.
    // "The session's agent is still open" is also true of two roots that merely
    // OVERLAP under one session id — `.batch()`, two requests on one
    // conversation id — and reading those as a resume folds one root into the
    // other and drops its events. And an open pause bounds the window without
    // closing it: any other run on the same session id while a human thinks —
    // a different graph, a background summariser — would be recorded as the
    // human's answer. LangGraph only continues an interrupted thread through a
    // `Command` or a `null` input, so that is what is required.
    info.session = existing;
    state.tracker.link(info.id, existing.agentKey);
    resume(existing, args.inputs);
    return;
  }

  const identity = state.tracker.startAgent(info.id, {
    agentId: core.normalizeAgentId(info.name, "agent"),
    sessionId,
    goal: goalOf(args),
    ...fwCommon(info),
  });
  const session: Session = {
    sessionId: identity.sessionId ?? sessionId,
    agentKey: info.id,
    agentId: identity.agentId ?? "agent",
    openPauses: new Map(),
    reportedError: false,
    pausedAt: null,
  };
  info.session = session;
  state.sessions.set(session.sessionId, session);

  // A resume, but nothing in THIS process is paused — so the pause was opened
  // by another process. That is the ordinary deployment shape (one worker
  // serves the interrupt, whichever worker picks up the approval resumes
  // against the shared checkpointer), and without this its human_wait and
  // agent_pause stay open forever. See `closeRemotePause`.
  const answer = resumeValue(args.inputs);
  if (answer !== undefined && answer !== null) {
    info.remote = { value: answer, levels: new Map(), deepest: null, done: new Set() };
  }

  // A root run that is ITSELF a leaf is recorded as one too. A bare
  // `model.invoke()` handled only as a root produced agent_start/agent_end and
  // nothing else — no model name, no tokens, no latency — while the trace
  // still looked populated. The agent span stays; the leaf pair lands inside.
  if (info.runType === "llm" || info.runType === "chat_model") {
    info.leafKind = "model";
    startModel(info, args);
  } else if (info.runType === "tool") {
    info.leafKind = "tool";
    startTool(info, args);
  } else if (info.runType === "retriever") {
    info.leafKind = "retriever";
    startRetriever(info, args);
  }
}

function goalOf(args: StartArgs): string | undefined {
  if (!state.options.captureContent) return undefined;
  // A chat model's input is a list of message BATCHES; its goal is the last
  // message of the last one, exactly as a graph's is the last of its state.
  const batches = args.messages;
  const lastBatch = Array.isArray(batches) && Array.isArray(batches[batches.length - 1])
    ? (batches[batches.length - 1] as unknown[])
    : batches;
  const inputs = args.runType === "chat_model" ? { messages: lastBatch } : args.inputs;
  if (inputs === undefined || inputs === null) return undefined;
  if (isObject(inputs) && Array.isArray(inputs.messages) && inputs.messages.length > 0) {
    const last = inputs.messages[inputs.messages.length - 1] as unknown;
    const content = isObject(last) ? last.content : undefined;
    if (typeof content === "string" && content) return core.truncate(content, 512) as string;
  }
  if (typeof inputs === "string") return core.truncate(inputs, 512) as string;
  try {
    return core.truncate(JSON.stringify(plain(inputs)), 512) as string;
  } catch {
    return undefined;
  }
}

/**
 * A LangGraph node -> `hook_triggered`. Also where a compiled SUBGRAPH becomes
 * a nested agent: a node whose checkpoint namespace is more than one segment
 * deep runs inside one, and its parent run IS the subgraph's own run. Deriving
 * it here nests to any depth without recognising a compiled graph.
 */
function startNode(info: RunInfo, args: StartArgs): void {
  const parts = nsParts(info.meta);
  if (parts.length > 1 && info.parent !== null) ensureSubgraphAgent(info, parts.slice(0, -1));

  const remote = remoteOf(info);
  if (remote !== null) {
    // First node seen at a level wins: LangGraph re-runs the interrupted tasks
    // in the level's first superstep and nothing else, so anything at a later
    // step is ordinary downstream work.
    const level = parts.slice(0, -1).join("|");
    if (!remote.levels.has(level)) remote.levels.set(level, info.meta.langgraph_step);
  }

  if (info.hidden) return;
  emit("hookTriggered", info, {
    hookName: info.node,
    hookId: info.id,
    triggerEvent: "graph_node",
    input: shrink(args.inputs),
    ...fwCommon(info),
  });
}

function ensureSubgraphAgent(info: RunInfo, prefix: string[]): void {
  const key = info.parent;
  if (key === null || state.tracker.isOpen(key)) return;
  const holder = state.runs.get(key);
  const session = info.session;
  if (holder === undefined || session === null) return;
  const names = prefix.filter(Boolean).map((part) => part.split(":")[0]!);
  state.tracker.startAgent(key, {
    agentId: [session.agentId, ...names].join("/"),
    parentKey: holder.parent,
    sessionId: session.sessionId,
    ...core.fwFields({ run_id: key, subgraph: names[names.length - 1], kind: "subgraph" }),
  });
  holder.kind = "subgraph";
  holder.session = session;
}

function startTool(info: RunInfo, args: StartArgs): void {
  // The MODEL's tool-call id when there is one, so a tool_use joins to the
  // `tool_calls[]` entry that asked for it and to the provider's own logs.
  info.toolCallId = args.toolCallId ?? recoverToolCallId(info, args.inputs) ?? info.id;
  if (info.hidden) return;
  emit("toolUse", info, {
    toolName: info.name || "tool",
    toolCallId: info.toolCallId,
    input: state.options.captureContent ? toolInput(args.inputs) : undefined,
    ...fwCommon(info),
  });
}

/** `handleToolStart` hands over a string; the tool's arguments are JSON inside it. */
function toolInput(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) return undefined;
  if (isPlainObject(input)) return core.truncate(plain(input), limit()) as Record<string, unknown>;
  return { input: core.truncate(plain(input), limit()) };
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const text = input.trim();
  if (!text.startsWith("{")) return input;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return input;
  }
}

/** Order-insensitive JSON, for comparing a tool call's `args` with the tool's parsed input. */
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (isPlainObject(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  try {
    return JSON.stringify(sort(value)) ?? "";
  } catch {
    return "";
  }
}

/**
 * The model's tool-call id, on a core that does not pass one.
 *
 * `@langchain/core` 1.x hands `handleToolStart` the id as its eighth argument;
 * 0.3 does not, and neither does it put it anywhere a callback can read at
 * start. Without it every `tool_use` on 0.3 carried the tool's RUN id, which
 * joins to nothing: not the assistant message's `tool_calls[]`, not the
 * provider's logs.
 *
 * It is recoverable, exactly, in the case that matters — a tool run under a
 * `ToolNode` or any runnable fed the conversation. The nearest ancestor whose
 * input carries messages holds the assistant message that asked for this call,
 * and its `tool_calls[]` entry names the tool and carries the same arguments
 * the tool was invoked with. Each id is claimed once per ancestor, so two calls
 * to one tool with identical arguments still get two different ids. When there
 * is no such ancestor, or no entry matches, the run id stands, as before.
 */
function recoverToolCallId(info: RunInfo, input: unknown): string | null {
  const args = canonical(parseToolInput(input));
  let key = info.parent;
  const seen = new Set<string>();
  while (key !== null && !seen.has(key)) {
    seen.add(key);
    const holder = state.runs.get(key);
    if (holder === undefined) return null;
    const inputs = holder.inputs;
    const messages = Array.isArray(inputs) ? inputs : isObject(inputs) ? inputs.messages : undefined;
    if (Array.isArray(messages)) {
      holder.claimed ??= new Set();
      const claimed = holder.claimed;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const calls = (messages[i] as { tool_calls?: unknown } | undefined)?.tool_calls;
        if (!Array.isArray(calls) || calls.length === 0) continue;
        const open = (calls as Array<{ id?: unknown; name?: unknown; args?: unknown }>).filter(
          (call) => typeof call.id === "string" && call.name === info.name && !claimed.has(call.id),
        );
        const match = open.find((call) => canonical(call.args) === args) ?? (open.length === 1 ? open[0] : undefined);
        if (match === undefined) return null;
        claimed.add(match.id as string);
        return match.id as string;
      }
      return null;
    }
    key = holder.parent;
  }
  return null;
}

function startRetriever(info: RunInfo, args: StartArgs): void {
  info.toolCallId = info.id;
  if (info.hidden) return;
  emit("toolUse", info, {
    toolName: `retriever:${info.name || "retriever"}`,
    toolCallId: info.toolCallId,
    input: state.options.captureContent ? { query: core.truncate(args.inputs, limit()) } : undefined,
    ...fwCommon(info),
  });
}

function startModel(info: RunInfo, args: StartArgs): void {
  info.model = modelNameOf(info, args.invocationParams);
  if (info.hidden) return;
  const messages =
    args.runType === "chat_model"
      ? normalizeMessages(args.messages)
      : promptsAsMessages((args.inputs as { prompts?: unknown } | undefined)?.prompts);
  emit("modelRequest", info, {
    // The correlation id the dashboard pairs a request with its response on.
    requestId: info.id,
    model: info.model,
    messages: state.options.captureContent ? messages : undefined,
    tools: toolsOf(args.invocationParams),
    ...fwCommon(info),
  });
}

/**
 * `ls_model_name` first — the LangSmith standard key a real provider
 * integration sets — then the invocation params, then the model's own name.
 * The fallbacks are load-bearing: fakes and some community integrations set no
 * `ls_model_name` at all.
 */
function modelNameOf(info: RunInfo, params: Record<string, unknown> | undefined): string {
  const name = info.meta.ls_model_name;
  if (typeof name === "string" && name) return name;
  for (const key of ["model_name", "model", "modelName", "model_id", "deployment_name"]) {
    const value = params?.[key];
    if (typeof value === "string" && value) return value;
  }
  return info.name || "unknown";
}

function toolsOf(params: Record<string, unknown> | undefined): Array<Record<string, unknown>> | undefined {
  const tools = params?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return core.truncate(tools, limit()) as Array<Record<string, unknown>>;
}

const ROLES: Record<string, string> = { human: "user", ai: "assistant", system: "system", tool: "tool" };

/**
 * Chat messages as `{role, content, tool_calls?}`, from the LAST batch. They
 * arrive as real `BaseMessage` objects here, which is the one place their
 * roles are still intact.
 */
export function normalizeMessages(batches: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(batches) || batches.length === 0) return undefined;
  const last = batches[batches.length - 1] as unknown;
  const batch = Array.isArray(last) ? last : batches;
  return batch.map((message: unknown) => {
    const kind = messageType(message) ?? (isObject(message) && typeof message.role === "string" ? message.role : "");
    const value = isObject(message) ? message : {};
    const entry: Record<string, unknown> = {
      role: ROLES[kind] ?? (kind || "user"),
      content: core.truncate(plain(value.content ?? ""), limit()),
    };
    if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
      entry.tool_calls = core.truncate(plain(value.tool_calls), limit());
    }
    return entry;
  });
}

function promptsAsMessages(prompts: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(prompts)) return undefined;
  return prompts.map((prompt: unknown) => ({ role: "user", content: core.truncate(prompt, limit()) }));
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

function onEnd(id: string, end: EndArgs): void {
  const info = state.runs.get(id);
  if (info === undefined) return;
  const error = end.error;
  touch(info.root);

  if (info.kind === "root") {
    // Close the leaf pair first when the root was also a leaf: the dashboard
    // closes the agent span at `agent_end`, so a `model_response` after it is
    // attributed to nothing.
    if (info.leafKind) {
      endLeaf(info.leafKind, info, end);
      // ...and that leaf OWNS the failure, exactly as a nested one does.
      // Without this a failing top-level `tool.invoke()` counted twice: once as
      // `tool_result.error` and again as a standalone `error` event.
      if (info.session !== null && error !== undefined && error !== null && !isControlFlow(error)) {
        info.session.reportedError = true;
      }
    }
    endRoot(info, error);
    return;
  }

  state.runs.delete(id);

  if (info.kind === "subgraph" || state.tracker.isOpen(id)) {
    state.tracker.endAgent(id, { outcome: outcomeOf(error), summary: errorText(error) });
  }
  // `owned` records whether a SPAN was actually emitted for this run, which is
  // what decides `reportedError` below.
  let owned = false;
  if (info.kind === "node" || info.kind === "chain") {
    endHook(info, end);
    owned = !info.hidden;
  } else if (info.kind === "tool" || info.kind === "retriever" || info.kind === "model") {
    endLeaf(info.kind, info, end);
    owned = !info.hidden;
  }

  if (info.kind === "node") {
    // Strictly BEFORE the suspend below: a node that answers one interrupt and
    // raises the next must close the old pause before opening the new one.
    closeRemotePause(info);
  }

  // The exception-path HITL: every LangGraph interrupt surfaces here, as the
  // node's `handleChainError`. Outside the span handling on purpose, so it
  // still fires for a hidden node and for a subgraph that bubbled the
  // interrupt up. `suspend` dedups on the interrupt id, so this and
  // `handleInterrupt` cannot double-emit.
  const interrupts = interruptsOf(error);
  if (interrupts.length > 0 && info.session !== null) suspend(info.session, interrupts);

  if (owned && error !== undefined && error !== null && !isControlFlow(error) && info.session !== null) {
    // Only when a span reported it. The failures nobody owned — a
    // RunnableSequence step, an output parser, a hidden run — must still reach
    // the root's one standalone `error` event; the ones a span DID report must
    // not be counted twice.
    info.session.reportedError = true;
  }

  if (isCancellation(error) && info.root !== null) reapIfAbandoned(info.root);
  // Last, after every event above has resolved through it. See `RunTracker.unlink`.
  state.tracker.unlink(id);
}

function touch(rootId: string | null): void {
  const root = rootId !== null ? state.runs.get(rootId) : undefined;
  if (root !== undefined) root.activity += 1;
}

/** How long an aborted root may stay silent before it is closed for LangGraph. */
export const ABANDONED_ROOT_GRACE_MS = 3_000;

/**
 * Close a root that was aborted and will never be told so.
 *
 * An `AbortSignal` firing inside `graph.invoke()` on LangGraph.js 1.x ends the
 * node's run with an `AbortError` and then abandons the graph's OWN run: the
 * invoke races the signal and returns, the stream generator is never resumed,
 * and no `handleChainEnd` or `handleChainError` ever arrives for the root
 * (VERIFIED on 1.4.17; 0.4.10 does report it, as `Error("Abort")`). Without
 * this the session reads as running forever — the JavaScript face of the
 * `GeneratorExit` case the Python adapter closes as `cancelled`.
 *
 * It cannot be closed at the node's error: a node's own `AbortError` — its
 * fetch timed out — can be retried, and the graph carries on. So the root is
 * closed only if, a grace period later, it is still open, nothing under it is
 * still running, and NOTHING under it has happened since: any retry, any new
 * node, any end callback bumps `activity` and the reap stands down. The timer
 * is `unref`'d, so it never holds a process open; a script that exits first
 * leaves the root open exactly as a crash would.
 */
function reapIfAbandoned(rootId: string): void {
  const root = state.runs.get(rootId);
  if (root === undefined) return;
  const seen = root.activity;
  const timer = setTimeout(() => {
    core.callSafely(
      () => {
        if (!state.enabled || state.runs.get(rootId) !== root || root.activity !== seen) return;
        for (const info of state.runs.values()) if (info.root === rootId && info.id !== rootId) return;
        const abort = new Error("the run was aborted and LangGraph never closed it");
        abort.name = "AbortError";
        endRoot(root, abort);
      },
      [],
      `${NAME}.reapIfAbandoned`,
    );
  }, ABANDONED_ROOT_GRACE_MS);
  timer.unref?.();
}

function endLeaf(kind: "tool" | "retriever" | "model", info: RunInfo, end: EndArgs): void {
  if (info.hidden) return;
  if (kind === "tool") endTool(info, end);
  else if (kind === "retriever") endRetriever(info, end);
  else endModel(info, end);
}

function endHook(info: RunInfo, end: EndArgs): void {
  if (info.hidden) return;
  emit("hookCompleted", info, {
    hookName: info.node ?? info.name,
    hookId: info.id,
    // "paused" for an interrupt: the node did not fail, it stopped to ask a
    // human. "failed", never "failure" — the server counts only
    // error|failed|timeout|rejected.
    outcome: outcomeOf(end.error),
    output: shrink(end.outputs),
    error: errorText(end.error),
    ...fwCommon(info),
  });
}

/**
 * The tool's actual result, plus an error when it failed quietly.
 *
 * A tool invoked with a `ToolCall` — what every tool loop does — returns a
 * `ToolMessage`, not a string, and rendering that object is not the result.
 * `status: "error"` is the second half: a tool whose exception the framework
 * turned into a message for the model has no error anywhere else, so without
 * this the failure had no representation at all.
 */
export function toolOutput(output: unknown): { output: unknown; failed?: string } {
  if (messageType(output) !== "tool") return { output };
  const message = output as { content?: unknown; status?: unknown };
  if (message.status === "error") {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return { output: message.content, failed: core.truncate(text, limit()) as string };
  }
  return { output: message.content };
}

function endTool(info: RunInfo, end: EndArgs): void {
  const { output, failed } = toolOutput(end.outputs);
  emit("toolResult", info, {
    toolName: info.name || "tool",
    toolCallId: info.toolCallId ?? info.id,
    output: shrink(output),
    error: errorText(end.error) ?? failed,
    ...fwCommon(info),
  });
}

function endRetriever(info: RunInfo, end: EndArgs): void {
  emit("toolResult", info, {
    toolName: `retriever:${info.name || "retriever"}`,
    toolCallId: info.toolCallId ?? info.id,
    output: summarizeDocuments(end.outputs),
    error: errorText(end.error),
    ...fwCommon(info),
  });
}

/**
 * `{n, sources}` — never the document text. Twenty 4 KB chunks per retrieval
 * would put 80 KB of prose into one event on every hop of every RAG loop. The
 * count is structure and survives `captureContent: false`; the sources do not,
 * because a source is a document path and on regulated data that path is
 * content.
 */
export function summarizeDocuments(documents: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(documents)) return undefined;
  if (!state.options.captureContent) return { n: documents.length };
  const sources = documents.slice(0, 10).map((doc: unknown, index) => {
    const meta = isObject(doc) && isObject(doc.metadata) ? doc.metadata : {};
    const source = meta.source ?? meta.id ?? meta.file_path;
    return core.truncate(source ? display(source) : `doc[${index}]`, 256);
  });
  return { n: documents.length, sources };
}

function endModel(info: RunInfo, end: EndArgs): void {
  const usage = usageOf(end.response);
  const completion = completionOf(end.response);
  const extras: Record<string, unknown> = { ...fwCommon(info) };
  if (info.chunks > 0) {
    Object.assign(extras, core.fwFields({ streamed: true, chunks: info.chunks, ttft_ms: info.ttftMs ?? 0 }));
  }
  emit("modelResponse", info, {
    requestId: info.id,
    model: info.model,
    stopReason: end.error !== undefined && end.error !== null ? "error" : completion.stopReason,
    content: state.options.captureContent ? completion.content : undefined,
    role: completion.role,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    // Shipped as an object as well: both server-side summaries fall back to
    // `payload.usage` for tokens.
    usage,
    error: errorText(end.error),
    // ALWAYS set, always an integer. The dashboard prefers the closing event's
    // duration, which is what keeps model durations honest when concurrent
    // calls pair up by arrival, and a float would NULL the u32 column.
    duration_ms: core.ms(Date.now() - info.started),
    ...extras,
  });
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: unknown;
  output_token_details?: unknown;
}

const asInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

function firstGeneration(response: unknown): Loose | undefined {
  const generations = (response as { generations?: unknown } | undefined)?.generations;
  if (!Array.isArray(generations) || generations.length === 0) return undefined;
  const first = generations[0] as unknown;
  const generation = Array.isArray(first) ? (first[0] as unknown) : first;
  return isObject(generation) ? generation : undefined;
}

/**
 * Token counts from wherever this provider put them.
 *
 * `usage_metadata` on the generated message is primary — LangChain's standard
 * shape and the only one carrying cache/reasoning detail. The fallbacks are
 * `llmOutput`: `tokenUsage` / `estimatedTokenUsage` (camelCase, the JS OpenAI
 * integration) and `token_usage` / `usage` (snake_case). Reading one place only
 * is how an adapter ends up with an empty token column for half the providers,
 * at 200 OK, with nothing logged.
 */
export function usageOf(response: unknown): Usage | undefined {
  const message = firstGeneration(response)?.message;
  const data = isObject(message) ? message.usage_metadata : undefined;
  if (isObject(data) && Object.keys(data).length > 0) {
    const usage: Usage = {
      input_tokens: asInt(data.input_tokens),
      output_tokens: asInt(data.output_tokens),
      total_tokens: asInt(data.total_tokens),
    };
    for (const key of ["input_token_details", "output_token_details"] as const) {
      if (isObject(data[key]) && Object.keys(data[key]).length > 0) usage[key] = { ...data[key] };
    }
    return compact(usage);
  }
  const output = (response as { llmOutput?: unknown } | undefined)?.llmOutput;
  if (!isObject(output)) return undefined;
  for (const raw of [output.tokenUsage, output.estimatedTokenUsage, output.token_usage, output.usage]) {
    if (!isObject(raw)) continue;
    const usage: Usage = {
      input_tokens: asInt(raw.promptTokens ?? raw.prompt_tokens ?? raw.input_tokens),
      output_tokens: asInt(raw.completionTokens ?? raw.completion_tokens ?? raw.output_tokens),
      total_tokens: asInt(raw.totalTokens ?? raw.total_tokens),
    };
    if (usage.input_tokens === undefined && usage.output_tokens === undefined) continue;
    usage.total_tokens ??= (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    return compact(usage);
  }
  return undefined;
}

function compact(usage: Usage): Usage | undefined {
  const out = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as Usage;
  return Object.keys(out).length > 0 ? out : undefined;
}

function completionOf(response: unknown): { content?: unknown; role?: string; stopReason?: string } {
  const generation = firstGeneration(response);
  if (generation === undefined) return {};
  const message = isObject(generation.message) ? generation.message : undefined;
  const content = message?.content ?? generation.text;
  let stopReason: string | undefined;
  for (const source of [generation.generationInfo, message?.response_metadata]) {
    if (!isObject(source)) continue;
    for (const key of ["finish_reason", "stop_reason", "finishReason", "stopReason"]) {
      const value = source[key];
      if (typeof value === "string" && value) {
        stopReason = value;
        break;
      }
    }
    if (stopReason !== undefined) break;
  }
  return {
    content: core.truncate(plain(content), limit()),
    role: message !== undefined ? "assistant" : undefined,
    stopReason,
  };
}

function endRoot(info: RunInfo, error: unknown): void {
  const session = info.session;
  state.runs.delete(info.id);
  closeOpenLeaves(info.id);
  // A resumed root is linked to the session's agent rather than being one, so
  // `endAgent` below would not clear its link.
  state.tracker.unlink(info.id);
  if (session === null) return;

  if (session.openPauses.size > 0) {
    // Interrupted, waiting on a human. Deliberately no `agent_end`: closing the
    // agent force-closes the open pause, zeroing the one interval that
    // measures how long the human took. The resuming `.invoke()` closes it —
    // here, or on another worker, in which case this process forgets it after
    // `PAUSED_SESSION_TTL_MS` (see `State.sweepPaused`).
    session.pausedAt = Date.now();
    return;
  }

  const cancelled = isCancellation(error);
  const failed = error !== undefined && error !== null && !isControlFlow(error) && !cancelled;

  if (failed && !session.reportedError) {
    // Nothing below reported this failure, so nobody owns it — a standalone
    // `error` is the only way it reaches the Errors surface. Strictly before
    // `agent_end`, which closes the span it would be attributed to.
    emitOnAgent(session, "error", {
      errorType: errorName(error),
      // The bare message: the server renders `<error_type>: <message>`, and the
      // prefixed form would read "Error: Error: ...".
      message: core.truncate(errorMessage(error), limit()) || errorName(error),
      traceback: error instanceof Error && error.stack ? core.truncate(error.stack, core.FIELD_LIMIT) : undefined,
      ...fwCommon(info),
    });
  }

  state.tracker.endAgent(session.agentKey, {
    outcome: cancelled ? "cancelled" : failed ? "failed" : "success",
    summary: failed ? errorText(error) : undefined,
    ...fwCommon(info),
  });
  if (state.sessions.get(session.sessionId) === session) state.sessions.delete(session.sessionId);
}

/**
 * Close every leaf still open under this root. `agent_end` force-closes open
 * pauses but not tools, models or hooks, so a run that dies mid-tool — a hard
 * cancellation, a killed stream, a framework that skipped an end callback —
 * would otherwise leave the session `ongoing` forever.
 */
function closeOpenLeaves(rootId: string): void {
  const stale = [...state.runs.values()].filter((info) => info.root === rootId && info.id !== rootId);
  for (const info of stale.reverse()) {
    state.runs.delete(info.id);
    if (info.hidden || !info.kind) {
      state.tracker.unlink(info.id);
      continue;
    }
    const marker = core.fwFields({ incomplete: true });
    core.callSafely(
      () => {
        if (info.kind === "tool" || info.kind === "retriever") {
          emit("toolResult", info, {
            toolName: info.kind === "retriever" ? `retriever:${info.name || "retriever"}` : info.name || "tool",
            toolCallId: info.toolCallId ?? info.id,
            ...marker,
          });
        } else if (info.kind === "node" || info.kind === "chain") {
          emit("hookCompleted", info, {
            hookName: info.node ?? info.name,
            hookId: info.id,
            outcome: "cancelled",
            ...marker,
          });
        } else if (info.kind === "model") {
          emit("modelResponse", info, {
            requestId: info.id,
            model: info.model,
            stopReason: "incomplete",
            duration_ms: core.ms(Date.now() - info.started),
            ...marker,
          });
        } else if (info.kind === "subgraph") {
          state.tracker.endAgent(info.id, { outcome: "cancelled", ...marker });
        }
      },
      [],
      `${NAME}.closeOpenLeaves`,
    );
    state.tracker.unlink(info.id);
  }
}

// ---------------------------------------------------------------------------
// Human in the loop
// ---------------------------------------------------------------------------

interface InterruptLike {
  id?: unknown;
  value?: unknown;
}

/**
 * The interrupts a `GraphInterrupt` carries. `ParentCommand` and
 * `GraphDrained` are bubble-ups too but carry a command / a reason, which is
 * what the `value` check keeps out.
 */
function interruptsOf(error: unknown): InterruptLike[] {
  if (!isControlFlow(error)) return [];
  const interrupts = (error as { interrupts?: unknown }).interrupts;
  if (!Array.isArray(interrupts)) return [];
  return interrupts.filter((item): item is InterruptLike => isObject(item) && "value" in item);
}

/**
 * `human_wait` + `agent_pause`, one pair per interrupt, in that order. Both are
 * required: only `agent_pause` -> `agent_resume` feeds the session's paused
 * time, and only `human_wait` -> `human_input` carries the prompt and the
 * answer.
 */
function suspend(session: Session, interrupts: readonly InterruptLike[]): void {
  interrupts.forEach((interrupt, index) => {
    const pauseId =
      typeof interrupt.id === "string" && interrupt.id ? interrupt.id : `${session.agentKey}:${index}`;
    if (session.openPauses.has(pauseId)) return;
    const { prompt, options } = promptOf(interrupt.value);
    session.openPauses.set(pauseId, prompt);
    // `captureContent: false` covers these: in a real HITL graph the interrupt
    // payload IS the record being approved, and the answer is a human's free
    // text — the two most sensitive strings in the run.
    const capture = state.options.captureContent;
    emitOnAgent(session, "humanWait", {
      inputId: pauseId,
      prompt: capture ? prompt : undefined,
      options: capture ? options : undefined,
      reason: "langgraph_interrupt",
      ...core.fwFields({ interrupt_id: pauseId, kind: "interrupt" }),
    });
    emitOnAgent(session, "agentPause", {
      pauseId,
      reason: "langgraph_interrupt",
      ...core.fwFields({ interrupt_id: pauseId }),
    });
  });
}

/** A value as text: strings as-is, everything else as JSON of its payload view. */
function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  try {
    return JSON.stringify(plain(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

export function promptOf(value: unknown): { prompt?: string; options?: string[] } {
  if (value === undefined || value === null) return {};
  if (isPlainObject(value)) {
    const prompt = value.prompt ?? value.question ?? value.message;
    const options = Array.isArray(value.options) ? value.options.map((option: unknown) => display(option)) : undefined;
    const text = prompt !== undefined && prompt !== null ? display(prompt) : display(value);
    return { prompt: core.truncate(text, limit()) as string, options };
  }
  return { prompt: core.truncate(display(value), limit()) as string };
}

/** `agent_resume` + `human_input`, in that order, one pair per open pause. */
function resume(session: Session, inputs: unknown): void {
  session.pausedAt = null;
  if (session.openPauses.size === 0) return;
  const answers = resumeValue(inputs);
  const capture = state.options.captureContent;
  for (const [pauseId, prompt] of [...session.openPauses]) {
    session.openPauses.delete(pauseId);
    emitOnAgent(session, "agentResume", {
      pauseId,
      reason: "langgraph_resume",
      ...core.fwFields({ interrupt_id: pauseId }),
    });
    emitOnAgent(session, "humanInput", {
      inputId: pauseId,
      response: capture ? answerFor(answers, pauseId) : undefined,
      ...core.fwFields({ interrupt_id: pauseId, prompt: capture ? prompt : undefined }),
    });
  }
}

const MISSING = Symbol("missing");

function isCommand(value: unknown): value is { resume?: unknown } {
  if (!isObject(value)) return false;
  if (value.lg_name === "Command") return true;
  // Duck-typed fallback for a moved or renamed `Command`.
  return "resume" in value && "goto" in value;
}

/**
 * What `.invoke()` was called with, when it was NOT fresh state.
 *
 * LangGraph.js hands the root's `handleChainStart` a `Command` itself (it is an
 * object, so `_coerceToDict` passes it through), and wraps anything that is not
 * an object under a single `input` key — `{input: null}` for
 * `invoke(null, config)`. Fresh state arrives as the state object. So a
 * `Command`, or an `input` key, is what separates "steering an existing
 * checkpointed run" from "starting a new one".
 */
function steeringValue(inputs: unknown): unknown {
  if (isCommand(inputs)) return inputs;
  if (isPlainObject(inputs) && "input" in inputs) return inputs.input;
  return MISSING;
}

/** Is this run a LangGraph invocation at all? A resume always is. */
function isGraphRun(meta: Record<string, unknown>): boolean {
  return (
    "langgraph_checkpoint_ns" in meta ||
    "checkpoint_ns" in meta ||
    "thread_id" in meta ||
    "langgraph_step" in meta
  );
}

/**
 * True when this root run continues an interrupted thread: a `Command`, or a
 * `null` input to a graph. A bare `null` alone is not enough — any runnable
 * invoked with no argument produces the same `{input: null}` shape, and
 * reading an unrelated heartbeat as the human's answer would fabricate an
 * approval nobody gave.
 */
function isContinuation(inputs: unknown, meta: Record<string, unknown>): boolean {
  const value = steeringValue(inputs);
  if (value === MISSING) return false;
  if (value === undefined || value === null) return isGraphRun(meta);
  return isCommand(value);
}

/** The value handed to `Command({ resume })`, read off the root run's input. */
function resumeValue(inputs: unknown): unknown {
  const value = steeringValue(inputs);
  return value !== MISSING && isCommand(value) ? value.resume : undefined;
}

function answerFor(answers: unknown, pauseId: string): string | undefined {
  if (answers === undefined || answers === null) return undefined;
  if (isPlainObject(answers) && pauseId in answers) {
    return core.truncate(display(answers[pauseId]), limit()) as string;
  }
  return core.truncate(display(answers), limit()) as string;
}

// ---------------------------------------------------------------------------
// Human in the loop, resumed by a DIFFERENT PROCESS
// ---------------------------------------------------------------------------
//
// Everything above keys the pause on the interrupt object this process saw,
// which assumes the process that paused is the one that resumes. Real HITL is
// not shaped like that: one worker serves the interrupt, a human answers later,
// and any worker may pick the approval up. The resuming process has no session
// and no open pauses, so nothing correlated and the pause stayed open forever.
//
// It is recoverable, exactly, because an interrupt's id is not random:
// LangGraph.js's `interrupt()` sets it to `XXH3(checkpoint_ns)` — a pure
// function of the interrupted task's namespace, which is
// `metadata.langgraph_checkpoint_ns` on the node's run and identical across the
// two invocations. So the resuming process can rebuild the id the pausing
// process used with no shared state.
//
// Which node re-ran BECAUSE it was interrupted: only the first superstep of a
// level re-runs interrupted tasks, and the deepest resuming level is the graph
// that actually paused — which excludes a subgraph's HOST node, a normal node
// one level up. LangGraph.js >= 1 names that level in `handleResume`; on 0.x,
// where there is no such event, the same answer is read off the runs
// themselves: decided at node END, a host node has always seen its subgraph's
// deeper nodes by then.

type Hash = (input: string) => string;
let xxh3: Hash | null | undefined;

/**
 * LangGraph's own XXH3, loaded from the installed package on first use.
 *
 * Not an export — LangGraph keeps it internal — so this reads the file beside
 * its `package.json`. That is the price of an id that matches the one
 * `interrupt()` produced byte for byte; a reimplementation would have to match
 * too, and would not be told when LangGraph changed. A missing or changed file
 * disables ONLY the cross-process resume: the probe below checks the function
 * still returns the 32-hex-digit shape `interrupt()` stamps.
 */
function interruptHash(): Hash | null {
  if (xxh3 !== undefined) return xxh3;
  xxh3 = null;
  const manifest = resolveFrom(`${GRAPH_PACKAGE}/package.json`);
  if (manifest === null) return xxh3;
  compat.probe(NAME, "langgraph interrupt ids", () => {
    const module = nodeRequire(join(manifest, "..", "dist", "hash.cjs")) as { XXH3?: unknown };
    const fn = module.XXH3;
    if (typeof fn !== "function") return false;
    const sample = String((fn as (text: string) => unknown)("failproofai"));
    if (!/^[0-9a-f]{32}$/.test(sample)) return false;
    xxh3 = (text: string) => String((fn as (value: string) => unknown)(text));
    return true;
  });
  return xxh3;
}

/** The id LangGraph's `interrupt()` gave a task with this checkpoint namespace. */
export function interruptIdOf(ns: string): string | null {
  if (!ns) return null;
  const hash = interruptHash();
  if (hash === null) return null;
  try {
    return hash(ns);
  } catch {
    return null;
  }
}

function remoteOf(info: RunInfo): RemoteResume | null {
  return info.root !== null ? (state.runs.get(info.root)?.remote ?? null) : null;
}

/** `agent_resume` + `human_input` for a pause this process never opened. */
function closeRemotePause(info: RunInfo): void {
  const remote = remoteOf(info);
  const session = info.session;
  if (remote === null || session === null) return;
  const parts = nsParts(info.meta);
  const level = parts.slice(0, -1).join("|");
  if (remote.deepest !== null) {
    if (level !== remote.deepest) return;
  } else {
    // No lifecycle event named the resuming level (LangGraph.js 0.x). A level
    // strictly deeper than this one has run, so this node is a subgraph's host,
    // not the task that paused.
    const depth = parts.length - 1;
    for (const seen of remote.levels.keys()) {
      if ((seen ? seen.split("|").length : 0) > depth) return;
    }
  }
  if (info.meta.langgraph_step !== remote.levels.get(level)) return;
  const ns = info.meta.langgraph_checkpoint_ns;
  const pauseId = typeof ns === "string" ? interruptIdOf(ns) : null;
  if (pauseId === null || remote.done.has(pauseId)) return;
  remote.done.add(pauseId);
  const marker = core.fwFields({ interrupt_id: pauseId, resumed_elsewhere: true });
  emitOnAgent(session, "agentResume", { pauseId, reason: "langgraph_resume", ...marker });
  emitOnAgent(session, "humanInput", {
    inputId: pauseId,
    response: state.options.captureContent ? answerFor(remote.value, pauseId) : undefined,
    ...marker,
  });
}

/** LangGraph.js >= 1 lifecycle: an interrupt, delivered with the root's run id. */
function onInterrupt(event: unknown): void {
  if (!state.enabled || !isObject(event)) return;
  const info = typeof event.runId === "string" ? state.runs.get(event.runId) : undefined;
  if (info?.session == null) return;
  const interrupts = Array.isArray(event.interrupts) ? event.interrupts : [];
  suspend(
    info.session,
    interrupts.filter((item): item is InterruptLike => isObject(item) && "value" in item),
  );
}

/**
 * LangGraph.js >= 1 lifecycle: a Pregel level is resuming. Normally a no-op for
 * the in-process case — the resuming root already closed the pause at start —
 * and load-bearing for the cross-process one, because it names the level that
 * is resuming, once per level, deepest last.
 */
function onResume(event: unknown): void {
  if (!state.enabled || !isObject(event)) return;
  const info = typeof event.runId === "string" ? state.runs.get(event.runId) : undefined;
  if (info === undefined) return;
  const remote = remoteOf(info);
  if (remote !== null) {
    const ns = Array.isArray(event.checkpointNs) ? event.checkpointNs.map(String) : [];
    const level = ns.join("|");
    if (remote.deepest === null || ns.length >= (remote.deepest ? remote.deepest.split("|").length : 0)) {
      remote.deepest = level;
    }
  }
  if (info.session !== null) resume(info.session, undefined);
}

function onToken(id: string): void {
  const info = state.runs.get(id);
  if (info === undefined) return;
  // Folded into the closing `model_response`, NEVER an event: a 500-token
  // response would otherwise be 500 stored rows.
  info.chunks += 1;
  info.ttftMs ??= core.ms(Date.now() - info.started);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

type Handler = Record<string | symbol, unknown>;

function nullable(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The one handler. A plain object in LangChain's `BaseCallbackHandler` shape
 * rather than a subclass, so this module never imports LangChain — the class
 * would have to come from the application's copy, of which there can be two.
 *
 * Every method is a thin argument-order adapter onto `onStart`/`onEnd`, wrapped
 * in `core.safe`. The argument order is the one `CallbackManager` DISPATCHES
 * with, which is not always the order its own `.d.ts` declares (1.x's
 * `handleChainStart` declaration puts `runType` fourth; the call site passes
 * `parentRunId` fourth, as 0.3 did).
 */
function buildHandler(): Handler {
  const wrap = <Args extends unknown[]>(fn: (...args: Args) => void): ((...args: Args) => void) =>
    core.safe(NAME, fn);

  return {
    name: "failproofai",
    [HANDLER_MARK]: true,
    // See the module comment: without this LangChain backgrounds every
    // callback, out of our async context and possibly past the final flush.
    awaitHandlers: true,
    ignoreLLM: false,
    ignoreChain: false,
    ignoreAgent: false,
    ignoreRetriever: false,
    // Python's adapter records no custom events; neither does this one.
    ignoreCustomEvent: true,
    // Normally false so an adapter bug can never take down the graph. Under
    // FAILPROOFAI_SDK_STRICT it follows strict mode — otherwise LangChain's own
    // handler firewall swallows the re-raise and the escape hatch does nothing.
    get raiseError(): boolean {
      return core.strict();
    },
    get [GRAPH_CALLBACK_HANDLER](): boolean {
      return state.options.graphCallbacks;
    },

    handleChainStart: wrap(function handleChainStart(
      serialized: unknown,
      inputs: unknown,
      runId: string,
      parentRunId?: string,
      tags?: unknown,
      metadata?: unknown,
      _runType?: unknown,
      runName?: unknown,
    ) {
      onStart({
        id: runId,
        parent: nullable(parentRunId),
        name: runNameOf(serialized, runName, "chain"),
        runType: "chain",
        tags: tagsOf(tags),
        meta: metaOf(metadata),
        inputs,
      });
    }),
    handleChainEnd: wrap(function handleChainEnd(outputs: unknown, runId: string) {
      onEnd(runId, { outputs });
    }),
    handleChainError: wrap(function handleChainError(error: unknown, runId: string) {
      onEnd(runId, { error: error ?? new Error("chain failed") });
    }),

    handleLLMStart: wrap(function handleLLMStart(
      serialized: unknown,
      prompts: unknown,
      runId: string,
      parentRunId?: string,
      extraParams?: unknown,
      tags?: unknown,
      metadata?: unknown,
      runName?: unknown,
    ) {
      onStart({
        id: runId,
        parent: nullable(parentRunId),
        name: runNameOf(serialized, runName, "llm"),
        runType: "llm",
        tags: tagsOf(tags),
        meta: metaOf(metadata),
        inputs: { prompts },
        invocationParams: (extraParams as { invocation_params?: Record<string, unknown> } | undefined)
          ?.invocation_params,
      });
    }),
    handleChatModelStart: wrap(function handleChatModelStart(
      serialized: unknown,
      messages: unknown,
      runId: string,
      parentRunId?: string,
      extraParams?: unknown,
      tags?: unknown,
      metadata?: unknown,
      runName?: unknown,
    ) {
      onStart({
        id: runId,
        parent: nullable(parentRunId),
        name: runNameOf(serialized, runName, "chat_model"),
        runType: "chat_model",
        tags: tagsOf(tags),
        meta: metaOf(metadata),
        inputs: messages,
        messages: Array.isArray(messages) ? messages : undefined,
        invocationParams: (extraParams as { invocation_params?: Record<string, unknown> } | undefined)
          ?.invocation_params,
      });
    }),
    handleLLMNewToken: wrap(function handleLLMNewToken(_token: unknown, _idx: unknown, runId: string) {
      if (state.enabled) onToken(runId);
    }),
    handleLLMEnd: wrap(function handleLLMEnd(output: unknown, runId: string) {
      onEnd(runId, { response: output });
    }),
    handleLLMError: wrap(function handleLLMError(error: unknown, runId: string) {
      onEnd(runId, { error: error ?? new Error("model call failed") });
    }),

    handleToolStart: wrap(function handleToolStart(
      serialized: unknown,
      input: unknown,
      runId: string,
      parentRunId?: string,
      tags?: unknown,
      metadata?: unknown,
      runName?: unknown,
      toolCallId?: unknown,
    ) {
      onStart({
        id: runId,
        parent: nullable(parentRunId),
        name: runNameOf(serialized, runName, "tool"),
        runType: "tool",
        tags: tagsOf(tags),
        meta: metaOf(metadata),
        inputs: parseToolInput(input),
        toolCallId: nullable(toolCallId) ?? undefined,
      });
    }),
    handleToolEnd: wrap(function handleToolEnd(output: unknown, runId: string) {
      onEnd(runId, { outputs: output });
    }),
    handleToolError: wrap(function handleToolError(error: unknown, runId: string) {
      onEnd(runId, { error: error ?? new Error("tool failed") });
    }),

    handleRetrieverStart: wrap(function handleRetrieverStart(
      serialized: unknown,
      query: unknown,
      runId: string,
      parentRunId?: string,
      tags?: unknown,
      metadata?: unknown,
      name?: unknown,
    ) {
      onStart({
        id: runId,
        parent: nullable(parentRunId),
        name: runNameOf(serialized, name, "retriever"),
        runType: "retriever",
        tags: tagsOf(tags),
        meta: metaOf(metadata),
        inputs: query,
      });
    }),
    handleRetrieverEnd: wrap(function handleRetrieverEnd(documents: unknown, runId: string) {
      onEnd(runId, { outputs: documents });
    }),
    handleRetrieverError: wrap(function handleRetrieverError(error: unknown, runId: string) {
      onEnd(runId, { error: error ?? new Error("retriever failed") });
    }),

    handleInterrupt: wrap(function handleInterrupt(event: unknown) {
      onInterrupt(event);
    }),
    handleResume: wrap(function handleResume(event: unknown) {
      onResume(event);
    }),
  };
}

let handler: Handler | null = null;

function theHandler(): Handler {
  handler ??= buildHandler();
  return handler;
}

interface CallbackManagerLike {
  handlers?: unknown[];
  addHandler?: (handler: unknown, inherit?: boolean) => void;
}

interface CallbackManagerCtor {
  new (): CallbackManagerLike;
  configure?: (...args: unknown[]) => unknown;
  _configureSync?: (...args: unknown[]) => unknown;
}

function isOurs(value: unknown): boolean {
  return isObject(value) && (value as Record<symbol, unknown>)[HANDLER_MARK] === true;
}

/**
 * Attach our handler to a manager `configure` just built — unless one is
 * already there. LangChain calls `configure` for every invocation and a child
 * manager inherits its parent's handlers, so a blind `addHandler` would emit
 * every event once per attachment.
 */
function attach(manager: unknown): unknown {
  const value = manager as CallbackManagerLike | undefined | null;
  if (!value || typeof value.addHandler !== "function") return manager;
  if (!state.enabled) return manager;
  if (Array.isArray(value.handlers) && value.handlers.some(isOurs)) {
    return manager;
  }
  value.addHandler(theHandler(), true);
  return manager;
}

/**
 * `configure`'s first argument — the inheritable handlers — with ours added.
 * An array (or nothing) gets the handler appended; a `CallbackManager` is left
 * alone and the manager `configure` derives from it is handled by `attach`.
 */
function withHandler(inheritable: unknown): unknown {
  if (inheritable === undefined || inheritable === null) return [theHandler()];
  if (Array.isArray(inheritable)) {
    return inheritable.some(isOurs) ? inheritable : [...(inheritable as unknown[]), theHandler()];
  }
  return inheritable;
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/** Close every span still open at teardown, leaves before agents. */
function closeEverything(): void {
  const roots = new Set<string>();
  for (const info of state.runs.values()) if (info.root !== null) roots.add(info.root);
  for (const root of roots) closeOpenLeaves(root);
  state.tracker.closeOpenAgents("cancelled");
}

/**
 * The `CallbackManager` of every OTHER installed copy of `@langchain/core` —
 * the ones nested under a dependency that pinned its own version.
 *
 * That layout is ordinary: a provider or community package declaring
 * `@langchain/core` as a hard dependency on a range the application's copy does
 * not satisfy gets its own copy at `node_modules/<pkg>/node_modules/
 * @langchain/core`, and everything it exports — its chat model, its tools, its
 * retrievers — is built on that copy. Resolution from the application can never
 * reach it. A run such a class starts INSIDE one of the application's runs was
 * always recorded: the child is handed the parent's manager, handler included.
 * But one it starts as a ROOT — `providerModel.invoke()`, a provider's tool or
 * retriever called directly — went through the nested copy's own, unpatched
 * `configure`, and was recorded nowhere, silently, while `instrument()`
 * reported success (VERIFIED: `integration/fixtures/langchain-dup-core`).
 *
 * LangChain offers no cross-copy hook to use instead. Its one registration
 * point, `registerConfigureHook`, keys its list on a module-private
 * `Symbol("lc:configure_hooks")` — each copy reads only its own — and stores
 * it in the current async context, not globally. So the copies are found on
 * disk (`nestedCopies`) and loaded the way the application will load them: the
 * build its module system reaches, plus the CommonJS build if something has
 * already `require`d it — `requireModuleCopies`' rule, for the same reasons. A
 * copy outside the declared range is left alone rather than patched blind.
 *
 * The one arrangement this cannot see is the one `requireModuleCopies` cannot:
 * an ES-module application whose CommonJS-only dependency `require`s its nested
 * copy AFTER `instrument()`. `langchainHandler()` covers it.
 */
async function nestedManagers(): Promise<CallbackManagerCtor[]> {
  const found: CallbackManagerCtor[] = [];
  for (const root of nestedCopies(PACKAGE)) {
    await core.callSafely(
      async () => {
        const version = (nodeRequire(join(root, "package.json")) as { version?: unknown }).version;
        const parts = compat.parseVersion(typeof version === "string" ? version : "");
        if (parts.length === 0 || (parts[0] ?? 0) >= 2 || ((parts[0] ?? 0) === 0 && (parts[1] ?? 0) < 3)) {
          logger.debug(`langchain adapter leaving ${root} (${String(version)}) alone: outside >=0.3.0 <2.0.0`);
          return;
        }
        const cjs = resolveExportsAt(root, "./callbacks/manager", "require");
        const esm = resolveExportsAt(root, "./callbacks/manager", "import");
        const modules: unknown[] = [];
        if (esm === null || entryIsCommonJs()) {
          if (cjs !== null) modules.push(nodeRequire(cjs));
        } else {
          modules.push(await importModule(pathToFileURL(esm).href));
          if (cjs !== null && cjs !== esm && isRequired(cjs)) modules.push(nodeRequire(cjs));
        }
        for (const module of modules) {
          const CallbackManager = (module as { CallbackManager?: unknown }).CallbackManager;
          if (typeof CallbackManager === "function") found.push(CallbackManager as CallbackManagerCtor);
        }
      },
      [],
      `${NAME}.nestedManagers`,
    );
  }
  return found;
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    // Every loaded copy: the ES-module and CommonJS builds of @langchain/core
    // are two different CallbackManager classes. See `requireModuleCopies`.
    const primary = (
      (await compat.requireModuleCopies(
        "@langchain/core/callbacks/manager",
        "npm install @langchain/core",
      )) as Array<{ CallbackManager?: CallbackManagerCtor }>
    ).map((module) => module.CallbackManager);
    if (primary.some((CallbackManager) => typeof CallbackManager !== "function")) {
      throw new Error("@langchain/core/callbacks/manager does not export CallbackManager");
    }
    // ...and every copy nested under a dependency. See `nestedManagers`.
    const managers = [...new Set([...primary, ...(await nestedManagers())])] as CallbackManagerCtor[];

    compat.checkVersion(NAME, PACKAGE, {
      minimum: "0.3.0",
      below: "2.0.0",
      reason: "the callback argument order and run metadata below are the 0.3+ shape",
    });
    // LangGraph is optional — plain LangChain is instrumented without it — so
    // only an INSTALLED LangGraph outside the range warns.
    compat.checkVersion(NAME, GRAPH_PACKAGE, {
      minimum: "0.4.0",
      below: "2.0.0",
      reason: "the node metadata and interrupt shape below are LangGraph.js 0.4+",
    });

    state.configure(readOptions(options));
    state.enabled = true;
    state.installed = true;
    patcher = new core.Patcher();

    // Both entry points, and at least one must take. A version that routed
    // through the other would install cleanly and record nothing — the single
    // most expensive failure an adapter can have, because everything looks fine.
    let patched = 0;
    for (const CallbackManager of managers) {
      for (const method of ["configure", "_configureSync"] as const) {
        const original = CallbackManager[method];
        if (typeof original !== "function") continue;
        if (
          !compat.probe(NAME, `CallbackManager.${method}`, () =>
            Object.getOwnPropertyDescriptor(CallbackManager, method)?.writable !== false,
          )
        ) {
          continue;
        }
        const replacement = function failproofaiConfigure(this: unknown, ...args: unknown[]): unknown {
          // Our handler goes IN, as one of the inheritable handlers, rather
          // than onto whatever comes out. `configure` returns undefined when
          // there are no handlers at all — the ordinary case for an un-traced
          // process, exactly the process we are here to trace — and it only
          // applies the call's tags and metadata to a manager it builds. The
          // first release attached to a bare `new CallbackManager()` in that
          // case, which carried the handler and none of the metadata: every
          // `thread_id` and `failproofai_sdk_session_id` was silently dropped,
          // so neither could ever choose the session.
          if (state.enabled) args[0] = withHandler(args[0]);
          const built = original.apply(this, args);
          if (typeof (built as PromiseLike<unknown> | undefined)?.then === "function") {
            return (built as PromiseLike<unknown>).then(attach);
          }
          return attach(built);
        };
        if (patcher.patch(CallbackManager, method, replacement)) patched += 1;
      }
    }

    if (patched === 0) {
      throw new Error(
        "could not patch CallbackManager.configure — this build of @langchain/core exposes " +
          "neither a writable `configure` nor `_configureSync`. Pass the handler explicitly " +
          "instead: `chain.invoke(input, { callbacks: [langchainHandler()] })`.",
      );
    }
    logger.debug(`langchain adapter attached to ${patched} callback-manager entry point(s)`);
  },

  uninstall(): void {
    // The switch goes FIRST: teardown below emits through the tracker directly,
    // and nothing may re-enter `onStart` while it does.
    state.enabled = false;
    state.installed = false;
    patcher?.restoreAll();
    patcher = null;
    closeEverything();
    state.reset();
    state.options = defaultOptions();
  },
};

let warnedOptions = false;

/**
 * The raw handler, for passing explicitly instead of — or as well as —
 * `instrument()`:
 *
 *     import { langchainHandler } from "@failproofai/sdk/langchain";
 *     await graph.invoke(input, { callbacks: [langchainHandler()] });
 *
 * Works without `instrument()`: the patch-free path, and the documented
 * fallback for a bundled application where the `@langchain/core` in
 * `node_modules` is not the copy that runs. Takes the same options as
 * `instrument("langchain", options)`; while `instrument()` is active its
 * options govern, and passing different ones here warns once.
 *
 * Using it alongside `instrument()` does not double-record: the patched
 * `configure` sees the handler is already on the manager and adds nothing.
 * `uninstrument()` disables it too, until it is asked for again.
 */
/** @internal Table sizes, for the tests that prove a finished request leaves nothing behind. */
export function _stats(): { runs: number; sessions: number; tracker: { runs: number; links: number } } {
  return { runs: state.runs.size, sessions: state.sessions.size, tracker: state.tracker.stats() };
}

export function langchainHandler(options?: LangChainOptions): Record<string, unknown> {
  if (state.installed) {
    if (options !== undefined && !warnedOptions) {
      warnedOptions = true;
      logger.warn(
        "langchainHandler() options are ignored while instrument('langchain') is active; " +
          "the options passed to instrument() govern.",
      );
    }
  } else if (!state.enabled) {
    state.configure(readOptions((options ?? {}) as Record<string, unknown>));
    state.enabled = true;
  } else if (options !== undefined) {
    // Already recording through an earlier call: new options, same runs.
    state.options = readOptions(options as Record<string, unknown>);
  }
  return theHandler();
}
