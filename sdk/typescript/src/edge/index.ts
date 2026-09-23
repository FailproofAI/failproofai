/**
 * `@failproofai/sdk` for runtimes with no filesystem: the Edge runtime (Next.js
 * `export const runtime = "edge"`, Vercel Edge Functions), Cloudflare Workers,
 * and browser bundles. Selected by the package's `exports` conditions
 * (`edge-light`, `workerd`, `worker`, `browser`), so an application's own
 * `import "@failproofai/sdk"` lands here without a code change.
 *
 * ## Why a separate build
 *
 * The real entry statically imports `node:fs`, `node:os`, `node:module` and
 * `node:crypto`. An ES module cannot catch a failed static import, so in the
 * Edge runtime the IMPORT itself failed — and because Next evaluates a route
 * module while building, `next build` failed ("Native module not found:
 * node:fs"), taking the whole application down over a telemetry import.
 *
 * ## What it does instead
 *
 * The same public surface, recording nothing: scopes run their bodies and
 * return their values, `event.*` accepts and drops, `flush()` resolves,
 * `instrument()` returns `[]`. The first use logs ONE line to stderr saying
 * so. These runtimes are not a deployment target — the SDK ships beside the
 * `failproofaid` daemon on a machine with a filesystem — so this build exists
 * only so that a shared module importing the SDK cannot break an Edge route.
 *
 * Type declarations stay the real ones (the `types` condition), so code that
 * compiles against Node compiles here too.
 */

import type { Identity } from "../context.js";
import type { EventNamespace } from "../events.js";
import type {
  AgentFn,
  AgentOptions,
  SessionFn,
  SessionOptions,
  ToolCallFn,
  ToolCallOptions,
} from "../scopes.js";
import { VERSION } from "../version.js";
import { notice } from "./notice.js";

export { VERSION as version };

export const DEFAULT_AGENT_ID = "main";
/** The same registered symbol as the Node build's, so comparisons still hold. */
export const AUTO: unique symbol = Symbol.for("failproofai.AUTO") as never;

// `Symbol.dispose` is not in every Edge runtime. A missing one must not become
// the property key "undefined".
const DISPOSE: symbol =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("nodejs.dispose");

let counter = 0;
function newId(): string {
  try {
    const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
    if (typeof uuid === "string") return uuid.replace(/-/g, "");
  } catch {
    /* fall through */
  }
  counter += 1;
  return `edge${Date.now().toString(16)}${counter.toString(16)}`;
}

const identityOf = (sessionId: string | null, agentId: string | null): Identity =>
  Object.freeze({ sessionId, agentId, parentId: null, depth: agentId === null ? 0 : 1 });

export function current(): Identity {
  return identityOf(null, null);
}

export function propagate<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return fn;
}

/** The handle a `toolCall` body receives. Set `.output`; read `.id`. */
export class ToolCall {
  readonly id: string;
  output: unknown = undefined;
  private assigned = false;

  constructor(toolCallId: string) {
    this.id = toolCallId;
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

  get outputAssigned(): boolean {
    return this.assigned;
  }
}

class Handle {
  dispose(): void {}
  fail(): void {}
  [DISPOSE](): void {}
}

class SessionHandle extends Handle {
  constructor(readonly id: string) {
    super();
  }
}

class AgentHandle extends Handle {
  readonly identity: Identity;
  constructor(
    readonly agentId: string,
    readonly sessionId: string,
  ) {
    super();
    this.identity = identityOf(sessionId, agentId);
  }
}

class ToolCallHandle extends Handle {
  constructor(readonly call: ToolCall) {
    super();
  }
}

type Body<A, T> = (arg: A) => T;

function split<O, A, T>(optionsOrBody: O | Body<A, T> | undefined, body: Body<A, T> | undefined) {
  return typeof optionsOrBody === "function"
    ? { options: {} as O, body: optionsOrBody as Body<A, T> }
    : { options: (optionsOrBody ?? {}) as O, body: body! };
}

function sessionImpl<T>(optionsOrBody: SessionOptions | Body<string, T>, maybeBody?: Body<string, T>): T {
  notice();
  const { options, body } = split(optionsOrBody, maybeBody);
  return body(options.sessionId ?? newId());
}
sessionImpl.open = (options: SessionOptions = {}) => {
  notice();
  return new SessionHandle(options.sessionId ?? newId());
};

function agentImpl<T>(
  agentId: string,
  optionsOrBody: AgentOptions | Body<Identity, T>,
  maybeBody?: Body<Identity, T>,
): T {
  notice();
  const { options, body } = split(optionsOrBody, maybeBody);
  return body(identityOf(options.sessionId ?? null, agentId));
}
agentImpl.open = (agentId = DEFAULT_AGENT_ID, options: AgentOptions = {}) => {
  notice();
  return new AgentHandle(agentId, options.sessionId ?? newId());
};

function toolCallImpl<T>(
  toolName: string,
  optionsOrBody: ToolCallOptions | Body<ToolCall, T>,
  maybeBody?: Body<ToolCall, T>,
): T {
  notice();
  void toolName;
  const { options, body } = split(optionsOrBody, maybeBody);
  return body(new ToolCall(options.toolCallId ?? newId()));
}
toolCallImpl.open = (toolName: string, options: ToolCallOptions = {}) => {
  void toolName;
  notice();
  return new ToolCallHandle(new ToolCall(options.toolCallId ?? newId()));
};

export const session = sessionImpl as unknown as SessionFn;
export const agent = agentImpl as unknown as AgentFn;
export const toolCall = toolCallImpl as unknown as ToolCallFn;

const EVENT_METHODS = [
  "toolUse",
  "toolResult",
  "modelRequest",
  "modelResponse",
  "agentStart",
  "agentEnd",
  "agentPause",
  "agentResume",
  "hookTriggered",
  "hookCompleted",
  "error",
  "humanWait",
  "humanInput",
  "humanPause",
  "humanInterrupt",
] as const;

/** The 15 event methods, each accepting its options and recording nothing. */
export const event: EventNamespace = Object.freeze(
  Object.fromEntries(EVENT_METHODS.map((name) => [name, () => notice()])),
) as unknown as EventNamespace;

export function configure(): void {
  notice();
}

export function flush(): Promise<void> {
  notice();
  return Promise.resolve();
}

export function flushSync(): void {
  notice();
}

export function setLogger(): void {}
export function setLogLevel(): void {}

export function instrument(): Promise<never[]> {
  notice();
  return Promise.resolve([]);
}

export function uninstrument(): never[] {
  return [];
}

export function availableFrameworks(): never[] {
  return [];
}

export function activeFrameworks(): never[] {
  return [];
}
