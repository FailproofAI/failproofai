/**
 * Scopes: `session()`, `agent()`, `toolCall()`.
 *
 * These are the ergonomic surface over `failproofai.event.*`. Each binds run
 * identity onto the `AsyncLocalStorage` in `context.ts` so that everything
 * emitted inside — including code that has never heard of the SDK's identity
 * options — lands on the right session and agent.
 *
 * ## Two forms, and why
 *
 * **Callback (preferred).** `await agent("planner", fn)` runs `fn` inside
 * `AsyncLocalStorage.run()`. Nothing to unwind: the binding exists for exactly
 * the async subtree the callback creates and disappears with it, so the
 * entire class of "a scope was entered here and exited over there" bugs is
 * unreachable. Use this unless you cannot.
 *
 * **`using` (escape hatch).** `using span = agent.open("planner")` binds with
 * `enterWith` and unwinds in `[Symbol.dispose]`. Needed when the work is not a
 * single function — a scope opened in a constructor and closed in a teardown,
 * a block that straddles an existing control structure. It carries the same
 * hazard Python's context managers do: a scope opened in one async context and
 * disposed in another leaves its frame bound where it was set. `context.ts`
 * warns once when it detects that.
 *
 * Both forms emit byte-identical events; the only difference is who unwinds.
 */

import { randomUUID } from "node:crypto";

import * as context from "./context.js";
import type { Identity, Store } from "./context.js";
import { runtime } from "./runtime.js";

// `Symbol.dispose` is only defined from Node 20.5 / V8 11.7. Defining it here
// means `using` works on every runtime this package supports, and assigning it
// when it already exists is a no-op rather than a conflict.
interface SymbolConstructorWithDispose {
  dispose?: symbol;
  asyncDispose?: symbol;
}
const symbolShim = Symbol as unknown as SymbolConstructorWithDispose;
symbolShim.dispose ??= Symbol.for("nodejs.dispose");
symbolShim.asyncDispose ??= Symbol.for("nodejs.asyncDispose");

/**
 * `AUTO` — infer the enclosing agent from the context stack (the default);
 * `null` — force a root span, emitting no `parentId` at all;
 * a string — use this id verbatim.
 *
 * `parentId` has three states and `null` is a meaningful one of them, so the
 * default cannot be `null`.
 */
export const AUTO = Symbol.for("failproofai.AUTO");
export type ParentId = string | null | typeof AUTO;

/**
 * True for a cancellation rather than a failure.
 *
 * A cancellation must not emit an `error` event, or every cancelled run
 * pollutes the Errors surface. JavaScript has no `CancelledError`; the
 * equivalent is the `AbortError` an `AbortSignal` produces, which both
 * `DOMException` and Node's own APIs raise under that name (`ABORT_ERR` is the
 * `code` Node sets on its own variant).
 */
export function isCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return named.name === "AbortError" || named.code === "ABORT_ERR";
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describe(error: unknown): string {
  const text = errorMessage(error);
  const name = errorName(error);
  return text ? `${name}: ${text}` : name;
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? (error.stack ?? undefined) : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Run `body`, then `settle`, preserving whether `body` was sync or async.
 *
 * A scope whose callback is synchronous must stay synchronous: wrapping every
 * body in a promise would make `session(() => 1)` return a `Promise<number>`,
 * which breaks the one case where a caller genuinely cannot await — a
 * constructor, a synchronous framework hook, an `EventEmitter` listener.
 */
function settleWith<T>(
  body: () => T,
  onSuccess: (value: Awaited<T>) => void,
  onFailure: (error: unknown) => void,
): T {
  let result: T;
  try {
    result = body();
  } catch (error) {
    onFailure(error);
    throw error;
  }
  if (isThenable(result)) {
    return (result as PromiseLike<Awaited<T>>).then(
      (value) => {
        onSuccess(value);
        return value;
      },
      (error: unknown) => {
        onFailure(error);
        throw error;
      },
    ) as T;
  }
  onSuccess(result as Awaited<T>);
  return result;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export interface SessionOptions {
  sessionId?: string;
  agentId?: string;
}

/** The handle `session.open()` returns. Disposing it unwinds the binding. */
export class SessionScope {
  readonly id: string;
  private readonly previous: Store;
  private readonly entered: Store;
  private readonly agentId: string | undefined;
  private disposed = false;

  constructor(options: SessionOptions = {}) {
    const store = context.snapshot();
    this.id = options.sessionId ?? store.sessionId ?? randomUUID().replace(/-/g, "");
    let next = context.withSessionBound(store, this.id);
    this.agentId = options.agentId;
    if (options.agentId !== undefined) next = context.withAgentPushed(next, options.agentId);
    this.entered = next;
    this.previous = context.enterWith(next);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Unwind unconditionally: a scope that leaks an agent frame misattributes
    // every later event in the process. When the current store is not the one
    // we entered, something below us bound its own and never unwound, or we are
    // being disposed from a different async context — repair by value rather
    // than stamping the caller's context with a store from somewhere else.
    const now = context.snapshot();
    if (now === this.entered) {
      context.enterWith(this.previous);
      return;
    }
    context.noteCrossContextExit();
    let repaired = now;
    if (this.agentId !== undefined) repaired = context.withAgentDiscarded(repaired, this.agentId);
    context.enterWith({ sessionId: this.previous.sessionId, agentStack: repaired.agentStack });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export interface SessionFn {
  /** Bind a session for the duration of `body`. Emits no events — identity only. */
  <T>(body: (sessionId: string) => T): T;
  <T>(options: SessionOptions, body: (sessionId: string) => T): T;
  /** The `using` form: `using s = failproofai.session.open()`. */
  open(options?: SessionOptions): SessionScope;
}

/**
 * Bind a session id (and optionally an agent id) for the enclosing work.
 *
 *     await failproofai.session(async (sid) => {
 *       failproofai.event.agentStart({ agentId: "main", goal: "..." });
 *     });
 *
 * Emits **no events** — it is identity only. `agent()` is what brackets a run
 * with `agent_start`/`agent_end`.
 *
 * An omitted `sessionId` reuses an already-bound session if there is one, and
 * otherwise generates one. That inheritance is what lets a nested scope stay
 * inside one run instead of splitting it into two sessions.
 */
const sessionImpl = (<T>(
  first: SessionOptions | ((sessionId: string) => T),
  second?: (sessionId: string) => T,
): T => {
  const options = typeof first === "function" ? {} : first;
  const body = typeof first === "function" ? first : second!;
  const store = context.snapshot();
  const id = options.sessionId ?? store.sessionId ?? randomUUID().replace(/-/g, "");
  let next = context.withSessionBound(store, id);
  if (options.agentId !== undefined) next = context.withAgentPushed(next, options.agentId);
  return context.runWith(next, () => body(id));
}) as SessionFn;

sessionImpl.open = (options: SessionOptions = {}): SessionScope => new SessionScope(options);

export const session: SessionFn = sessionImpl;

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

export interface AgentOptions {
  sessionId?: string;
  goal?: string;
  parentId?: ParentId;
  /** The `outcome` on `agent_end` when the block completes normally. */
  outcome?: string;
  summary?: string;
  /** Any other key is attached to `agent_start` only. */
  [field: string]: unknown;
}

function resolveAgentEntry(
  agentId: string,
  options: AgentOptions,
): { sid: string; parent: string | null | undefined; next: Store } {
  const store = context.snapshot();
  const sid = options.sessionId ?? store.sessionId ?? randomUUID().replace(/-/g, "");

  let parent: string | null | undefined;
  if (options.parentId === undefined || options.parentId === AUTO) {
    // Only inherit within the SAME session. An explicit `sessionId` that
    // differs from the ambient one is the documented way to start a NEW run,
    // and the enclosing agent does not exist in it — the span tree is keyed by
    // session, so the child would render as a root with a dangling parent, or
    // get grafted onto whatever agent in its own session happened to share the
    // id. The ordinary long-lived-server shape reaches it directly:
    //
    //     await agent("server", { sessionId: "boot" }, async () => {
    //       for (const rid of requests) {
    //         await agent("handler", { sessionId: rid }, ...);  // parent="server"
    //       }
    //     });
    //
    // A caller who genuinely wants a cross-session link can still pass
    // `parentId` explicitly.
    const currentAgent =
      store.agentStack.length > 0 ? store.agentStack[store.agentStack.length - 1]! : null;
    parent = sid === store.sessionId ? currentAgent : null;
  } else {
    parent = options.parentId;
  }

  const next = context.withAgentPushed(context.withSessionBound(store, sid), agentId);
  return { sid, parent, next };
}

function agentStartFields(options: AgentOptions): Record<string, unknown> {
  const { sessionId, goal, parentId, outcome, summary, ...fields } = options;
  void sessionId;
  void goal;
  void parentId;
  void outcome;
  void summary;
  return fields;
}

function emitAgentEnd(
  sid: string,
  agentId: string,
  options: AgentOptions,
  error: unknown,
  hadError: boolean,
): void {
  let outcome: string;
  if (!hadError) {
    outcome = options.outcome ?? "success";
  } else if (isCancellation(error)) {
    outcome = "cancelled";
  } else {
    outcome = "failed";
    // `error` strictly BEFORE `agent_end`, because the dashboard closes the
    // agent span at `agent_end` and anything after it is attributed to nothing.
    runtime.event.error({
      sessionId: sid,
      agentId,
      errorType: errorName(error),
      message: errorMessage(error),
      traceback: stackOf(error),
    });
  }
  // The literal is `"failed"`, never `"failure"` — only
  // `error|failed|timeout|rejected` count as a failure server-side.
  runtime.event.agentEnd({
    sessionId: sid,
    agentId,
    outcome,
    summary: options.summary,
  });
}

/** The handle `agent.open()` returns. Disposing it emits `agent_end`. */
export class AgentScope {
  readonly agentId: string;
  readonly sessionId: string;
  readonly identity: Identity;
  private readonly options: AgentOptions;
  private readonly previous: Store;
  private readonly entered: Store;
  private disposed = false;
  /** Set by `fail()` so a `using` block can still record a failure. */
  private failure: { error: unknown } | null = null;

  constructor(agentId = "main", options: AgentOptions = {}) {
    this.agentId = agentId;
    this.options = options;
    const { sid, parent, next } = resolveAgentEntry(agentId, options);
    this.sessionId = sid;
    this.entered = next;
    this.previous = context.enterWith(next);
    try {
      runtime.event.agentStart({
        sessionId: sid,
        agentId,
        goal: options.goal,
        parentId: parent,
        ...agentStartFields(options),
      });
    } catch (error) {
      // A rejected `agent_start` (a reserved extra, say) must not leave a
      // half-entered scope behind: the disposer never runs if the constructor
      // throws.
      this.unwind();
      throw error;
    }
    this.identity = context.current();
  }

  /**
   * Record that this span failed. `using` has no exception channel to a
   * disposer, so a caller who catches inside the block tells us here.
   */
  fail(error: unknown): void {
    this.failure = { error };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      emitAgentEnd(
        this.sessionId,
        this.agentId,
        this.options,
        this.failure?.error,
        this.failure !== null,
      );
    } finally {
      // Unwound in a `finally` so the stack is intact even if emission itself
      // blew up. A leaked frame is worse than a lost event.
      this.unwind();
    }
  }

  private unwind(): void {
    const now = context.snapshot();
    if (now === this.entered) {
      context.enterWith(this.previous);
      return;
    }
    context.noteCrossContextExit();
    context.enterWith({
      sessionId: this.previous.sessionId,
      agentStack: context.withAgentDiscarded(now, this.agentId).agentStack,
    });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export interface AgentFn {
  <T>(agentId: string, body: (identity: Identity) => T): T;
  <T>(agentId: string, options: AgentOptions, body: (identity: Identity) => T): T;
  /** The `using` form: `using span = failproofai.agent.open("planner")`. */
  open(agentId?: string, options?: AgentOptions): AgentScope;
}

/**
 * Bracket a run (or a sub-run) with `agent_start` / `agent_end`.
 *
 *     await failproofai.agent("planner", { goal: question }, async () => { ... });
 *
 * Keep `agentId` low-cardinality (a node/role name, never a UUID): it is a
 * `LowCardinality(String)` column and the primary facet across every session.
 *
 * Extra keys are attached to `agent_start` only; `agent_end` carries `outcome`
 * and `summary`.
 *
 * Exit semantics, which are the whole point:
 *
 * | thrown                  | events            | outcome       |
 * |-------------------------|-------------------|---------------|
 * | nothing                 | `agent_end`       | `options.outcome` |
 * | any error               | `error`, then end | `"failed"`    |
 * | an `AbortError`         | `agent_end` only  | `"cancelled"` |
 *
 * The error is always re-thrown.
 */
const agentImpl = (<T>(
  agentId: string,
  second: AgentOptions | ((identity: Identity) => T),
  third?: (identity: Identity) => T,
): T => {
  const options = typeof second === "function" ? {} : second;
  const body = typeof second === "function" ? second : third!;
  const { sid, parent, next } = resolveAgentEntry(agentId, options);

  return context.runWith(next, () => {
    runtime.event.agentStart({
      sessionId: sid,
      agentId,
      goal: options.goal,
      parentId: parent,
      ...agentStartFields(options),
    });
    return settleWith(
      () => body(context.current()),
      () => emitAgentEnd(sid, agentId, options, undefined, false),
      (error) => emitAgentEnd(sid, agentId, options, error, true),
    );
  });
}) as AgentFn;

agentImpl.open = (agentId = "main", options: AgentOptions = {}): AgentScope =>
  new AgentScope(agentId, options);

export const agent: AgentFn = agentImpl;

// ---------------------------------------------------------------------------
// toolCall
// ---------------------------------------------------------------------------

/** The handle a `toolCall` body receives. Set `.output`; read `.id`. */
export class ToolCall {
  readonly id: string;
  /**
   * What the tool produced. When the body returns a value and this was never
   * set, the returned value is recorded instead — so the common
   * `await toolCall("search", { input }, () => search(q))` needs no assignment.
   */
  output: unknown = undefined;
  private assigned = false;

  constructor(toolCallId: string) {
    this.id = toolCallId;
    // A plain field would make "never set" and "set to undefined"
    // indistinguishable, and the difference decides whether the body's return
    // value is used.
    let stored: unknown;
    Object.defineProperty(this, "output", {
      get: () => stored,
      set: (value: unknown) => {
        stored = value;
        this.assigned = true;
      },
      enumerable: true,
      configurable: true,
    });
  }

  /** True once `.output` has been assigned, whatever it was assigned to. */
  get outputAssigned(): boolean {
    return this.assigned;
  }
}

export interface ToolCallOptions {
  toolCallId?: string;
  input?: Record<string, unknown> | null;
  /** Any other key is attached to `tool_use` only. */
  [field: string]: unknown;
}

function toolUseFields(options: ToolCallOptions): Record<string, unknown> {
  const { toolCallId, input, ...fields } = options;
  void toolCallId;
  void input;
  return fields;
}

/** The handle `toolCall.open()` returns. Disposing it emits `tool_result`. */
export class ToolCallScope {
  readonly call: ToolCall;
  private readonly toolName: string;
  private readonly sid: string | null;
  private readonly aid: string;
  private disposed = false;
  private failure: { error: unknown } | null = null;

  constructor(toolName: string, options: ToolCallOptions = {}) {
    this.toolName = toolName;
    // Resolve once, at entry: a tool that opens its own scope inside must not
    // make the closing `tool_result` land on a different agent id.
    this.sid = context.sessionId();
    this.aid = context.agentId();
    this.call = new ToolCall(options.toolCallId ?? randomUUID().replace(/-/g, ""));
    runtime.event.toolUse({
      sessionId: this.sid,
      agentId: this.aid,
      toolName,
      toolCallId: this.call.id,
      input: options.input,
      ...toolUseFields(options),
    });
  }

  fail(error: unknown): void {
    this.failure = { error };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failed = this.failure !== null && !isCancellation(this.failure.error);
    runtime.event.toolResult({
      sessionId: this.sid,
      agentId: this.aid,
      toolName: this.toolName,
      toolCallId: this.call.id,
      output: this.call.output,
      error: failed ? describe(this.failure!.error) : undefined,
    });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export interface ToolCallFn {
  <T>(toolName: string, body: (call: ToolCall) => T): T;
  <T>(toolName: string, options: ToolCallOptions, body: (call: ToolCall) => T): T;
  /** The `using` form: `using t = failproofai.toolCall.open("web_search")`. */
  open(toolName: string, options?: ToolCallOptions): ToolCallScope;
}

/**
 * Bracket a tool invocation with `tool_use` / `tool_result`.
 *
 *     const hits = await failproofai.toolCall("web_search", { input: { q } }, () => search(q));
 *
 * `toolCallId` defaults to a fresh uuid. Identity comes from the enclosing
 * scope; if nothing is bound, the underlying `event.toolUse()` throws the usual
 * `TypeError` naming the fix.
 *
 * The body's resolved value is recorded as `output` unless the handle's
 * `.output` was assigned, in which case that wins.
 *
 * On failure this emits `tool_result({ error: "TypeName: msg" })` and **no
 * `error` event**. A tool failure the agent loop catches is not a run-level
 * error, and one that propagates is reported exactly once, by the enclosing
 * `agent()`. Cancellation closes the leaf with no `error` string at all, for
 * the same reason `agent()` does not mark it failed.
 */
const toolCallImpl = (<T>(
  toolName: string,
  second: ToolCallOptions | ((call: ToolCall) => T),
  third?: (call: ToolCall) => T,
): T => {
  const options = typeof second === "function" ? {} : second;
  const body = typeof second === "function" ? second : third!;

  const sid = context.sessionId();
  const aid = context.agentId();
  const call = new ToolCall(options.toolCallId ?? randomUUID().replace(/-/g, ""));

  runtime.event.toolUse({
    sessionId: sid,
    agentId: aid,
    toolName,
    toolCallId: call.id,
    input: options.input,
    ...toolUseFields(options),
  });

  const finish = (output: unknown, error: unknown, failed: boolean): void => {
    runtime.event.toolResult({
      sessionId: sid,
      agentId: aid,
      toolName,
      toolCallId: call.id,
      output,
      error: failed && !isCancellation(error) ? describe(error) : undefined,
    });
  };

  return settleWith(
    () => body(call),
    (value) => finish(call.outputAssigned ? call.output : value, undefined, false),
    (error) => finish(call.outputAssigned ? call.output : undefined, error, true),
  );
}) as ToolCallFn;

toolCallImpl.open = (toolName: string, options: ToolCallOptions = {}): ToolCallScope =>
  new ToolCallScope(toolName, options);

export const toolCall: ToolCallFn = toolCallImpl;
