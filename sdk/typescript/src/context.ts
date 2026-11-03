/**
 * Ambient run identity, carried on an `AsyncLocalStorage`.
 *
 * Without this the SDK would have no ambient session: every `event.*` call
 * would take `sessionId` and `agentId` as required arguments and nothing would
 * propagate them. Threading both through every function that might emit an
 * event is what makes instrumentation sprawl into a diff nobody wants to
 * review. `session()` / `agent()` bind them instead.
 *
 * ## Why `AsyncLocalStorage` and not a module-level variable
 *
 * An agent process runs many logical runs at once — a server handling
 * concurrent requests, a supervisor fanning out to sub-agents. A plain variable
 * is shared by all of them, so the last writer wins and every event after it is
 * attributed to the wrong run. `AsyncLocalStorage` is Node's equivalent of
 * Python's `contextvars`: the value follows the async call tree through
 * `await`, `.then()`, timers and `EventEmitter` callbacks created inside the
 * scope, and two concurrent branches see two different values.
 *
 * ## Why the stack is a frozen array
 *
 * `agentStack` is replaced, never mutated. A store object is shared BY
 * REFERENCE with every async branch below it, so `push()` in one branch would
 * mutate the value every sibling sees — which is exactly the cross-run event
 * mixing this module exists to prevent, wearing an `AsyncLocalStorage` costume.
 * It passes every single-branch test.
 *
 * There is deliberately no separate `agentId` slot: the top of the stack IS the
 * current agent id, so the two cannot drift apart, and `parentId` is the entry
 * beneath it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { logger } from "./logger.js";

/**
 * The agent id used when events are emitted with a session bound but no agent
 * scope. "main" is the convention the skill and the reference integrations
 * already teach, so an un-scoped event lands somewhere sensible rather than
 * throwing.
 */
export const DEFAULT_AGENT_ID = "main";

/** The run identity in scope. Never null — check `sessionId === null` instead. */
export interface Identity {
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly parentId: string | null;
  readonly depth: number;
}

export interface Store {
  readonly sessionId: string | null;
  readonly agentStack: readonly string[];
}

export const EMPTY_STORE: Store = Object.freeze({
  sessionId: null,
  agentStack: Object.freeze([]),
});

const storage = new AsyncLocalStorage<Store>();

function read(): Store {
  return storage.getStore() ?? EMPTY_STORE;
}

/**
 * The identity bound to the current context.
 *
 * `current().sessionId === null` means nothing is bound — either no scope was
 * entered, or this callback escaped the async context that entered one (see
 * `propagate`).
 */
export function current(): Identity {
  const { sessionId: sid, agentStack: stack } = read();
  return {
    sessionId: sid,
    agentId: stack.length > 0 ? stack[stack.length - 1]! : null,
    parentId: stack.length >= 2 ? stack[stack.length - 2]! : null,
    depth: stack.length,
  };
}

/** The bound session id, or null. Hot path — allocates no Identity. */
export function sessionId(): string | null {
  return read().sessionId;
}

/** The current agent id, falling back to `DEFAULT_AGENT_ID`. */
export function agentId(): string {
  const { agentStack: stack } = read();
  return stack.length > 0 ? stack[stack.length - 1]! : DEFAULT_AGENT_ID;
}

/** The enclosing agent id, or null at depth 0 or 1. */
export function parentAgentId(): string | null {
  const { agentStack: stack } = read();
  return stack.length >= 2 ? stack[stack.length - 2]! : null;
}

export function snapshot(): Store {
  return read();
}

export function withSessionBound(store: Store, sid: string): Store {
  return { sessionId: sid, agentStack: store.agentStack };
}

export function withAgentPushed(store: Store, aid: string): Store {
  return { sessionId: store.sessionId, agentStack: Object.freeze([...store.agentStack, aid]) };
}

/** Run `fn` with `store` bound. The clean form: nothing to unwind, ever. */
export function runWith<T>(store: Store, fn: () => T): T {
  return storage.run(store, fn);
}

/**
 * Bind `store` for the REMAINDER of the current async context and return what
 * was bound before.
 *
 * This is the `using`-statement half of the API, and it is strictly weaker than
 * `runWith`: the binding escapes upward into the caller's context, so it has to
 * be undone by hand. `scopes.ts` does that in a `[Symbol.dispose]`, which the
 * runtime guarantees runs at the end of the block — including on `throw` and
 * `return`.
 *
 * The hazard it cannot fix is a scope entered in one async context and disposed
 * in another: `enterWith` in the disposing context cannot reach the context the
 * value was bound in, so the frame stays bound there. `noteCrossContextExit`
 * below is how that gets reported.
 */
export function enterWith(store: Store): Store {
  const previous = read();
  storage.enterWith(store);
  return previous;
}

/** Deduplicates the cross-context warning — it fires from a scope exit. */
let warnedCrossContext = false;

export function resetCrossContextWarning(): void {
  warnedCrossContext = false;
}

/**
 * Report, once, that a scope could not be unwound where it was entered.
 *
 * WARNING, not debug. The consequence is not cosmetic: the frame the scope
 * pushed stays bound in whatever context it was set in, so identity is wrong
 * for everything that follows there. The caller cannot discover that any other
 * way — there is no exception, and the events look plausible.
 */
export function noteCrossContextExit(): void {
  if (warnedCrossContext) return;
  warnedCrossContext = true;
  logger.warn(
    "a scope was entered in one async context and exited in another, so its identity " +
      "could not be unwound and later events in the entering context may be attributed " +
      "to it. The usual cause is a `using` scope spanning a `yield` in an async " +
      "generator; pass sessionId/agentId explicitly there, or use the callback form " +
      "(`await agent('name', fn)`), which cannot reach this state.",
  );
}

/**
 * Remove ONE frame for `aid` from a stack, innermost first.
 *
 * The fallback for a scope that cannot be unwound by restoring the previous
 * store. Removes a single occurrence rather than every match, because the same
 * agent id may legitimately be on the stack twice (a recursive agent), and
 * dropping both would corrupt the outer one to fix the inner.
 */
export function withAgentDiscarded(store: Store, aid: string): Store {
  const stack = store.agentStack;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i] === aid) {
      return {
        sessionId: store.sessionId,
        agentStack: Object.freeze([...stack.slice(0, i), ...stack.slice(i + 1)]),
      };
    }
  }
  return store;
}

/**
 * Wrap `fn` so it runs with the identity bound *right now*.
 *
 *     queue.push(propagate(work));
 *     emitter.on("done", propagate(onDone));
 *     new Worker(url).on("message", propagate(handle));
 *
 * `AsyncLocalStorage` already follows `await`, `.then()`, `setTimeout` and any
 * callback CREATED inside a scope, so most code needs nothing. This is for the
 * cases where it genuinely cannot: a callback stored during one run and invoked
 * during another (a module-level registry, a connection pool's handler), work
 * handed to a `worker_threads` boundary, or anything re-entered from a native
 * addon that does not carry async context.
 *
 * It snapshots VALUES rather than capturing the store object, so re-entering it
 * twice — a retried job, a handler invoked per message — binds the same
 * identity each time instead of inheriting whatever the previous call left.
 */
export function propagate<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const captured = snapshot();
  return function failproofaiPropagated(this: unknown, ...args: Args): Result {
    return storage.run(captured, () => fn.apply(this, args));
  };
}
