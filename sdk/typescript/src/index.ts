/**
 * Telemetry for AI agents: emit events, spool them, let the daemon ship them.
 *
 * Three surfaces, in the order most people meet them:
 *
 * * **Scopes** — `session()`, `agent()`, `toolCall()`. They bind run identity
 *   and, for the latter two, bracket a run with its own events. Callback form
 *   by default; a `using`-compatible `.open()` for the cases a callback cannot
 *   express.
 * * **Adapters** — `instrument()`. Wires LangChain/LangGraph, the Vercel AI
 *   SDK, Mastra and LlamaIndex.TS to the scopes above.
 * * **`event.*`** — the 15 event methods, for anything the adapters do not
 *   cover.
 *
 * `sessionId` and `agentId` are optional on every event method: omitted, they
 * resolve from the enclosing scope. Nothing bound and nothing passed is an
 * error, never a silent drop — ingest skips an event with no session and
 * answers 200.
 *
 * ## Shutdown
 *
 * Buffered events are flushed on `process.on("exit")` automatically. A process
 * that is killed by a signal never reaches that, and Node's default for SIGTERM
 * is to terminate without running exit handlers — so a containerised agent
 * loses whatever the last interval had not yet written. Installing a signal
 * handler from a library would change the process's behaviour (a listener
 * suppresses Node's default termination), so this package will not do it for
 * you. Two lines, at your own startup:
 *
 *     for (const signal of ["SIGINT", "SIGTERM"] as const) {
 *       process.once(signal, () => { failproofai.flushSync(); process.exit(0); });
 *     }
 */

import { setEnvironment, rejectComma } from "./environment.js";
import type { EventNamespace } from "./events.js";
import { setBaseDir } from "./resolver.js";
import { runtime } from "./runtime.js";
import { VERSION } from "./version.js";
import { flushAllNow, flushAllSync, validatedInterval } from "./writer.js";

export { VERSION as version };

export { current, propagate, DEFAULT_AGENT_ID } from "./context.js";
export type { Identity } from "./context.js";

export { session, agent, toolCall, AUTO, ToolCall } from "./scopes.js";
export type {
  AgentOptions,
  AgentScope,
  ParentId,
  SessionOptions,
  SessionScope,
  ToolCallOptions,
  ToolCallScope,
} from "./scopes.js";

export type {
  AgentEndOptions,
  AgentPauseOptions,
  AgentResumeOptions,
  AgentStartOptions,
  ErrorOptions,
  HookCompletedOptions,
  HookTriggeredOptions,
  HumanInputOptions,
  HumanInterruptOptions,
  HumanPauseOptions,
  HumanWaitOptions,
  ModelRequestOptions,
  ModelResponseOptions,
  ToolResultOptions,
  ToolUseOptions,
} from "./events.js";

export { setLogger, setLogLevel } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";

export {
  available as availableFrameworks,
  activeFrameworks,
  instrument,
  uninstrument,
} from "./integrations/index.js";
export type { FrameworkName, InstrumentOptions } from "./integrations/index.js";

export interface ConfigureOptions {
  /**
   * Override the spool root. Omitted, it resolves to
   * `~/.failproofai/custom-agents` (honouring `$FAILPROOFAI_HOME`, which moves
   * the umbrella but cannot take the spool outside it — the `custom-agents`
   * segment is always appended).
   *
   * This is the ONLY way to spool anywhere else. No environment variable
   * redirects it, because a redirect with no confirmation and no error means
   * batches land in a directory nothing reads, and an unread spool is
   * indistinguishable from an idle one.
   */
  baseDir?: string | null;
  /** Seconds between flush cycles. Default 0.5 (500 ms). */
  flushInterval?: number;
  /**
   * Deployment environment label (e.g. "production", "staging"). Can also be
   * set with `AGENTEYE_ENVIRONMENT`. Defaults to "dev" when neither is set.
   */
  environment?: string | null;
}

/**
 * Configure the SDK. Call once at startup, before any `event.*` call.
 *
 * Throws if `flushInterval` is not a finite number greater than zero, or if
 * `environment` contains a comma.
 *
 * BOTH validations run before ANY of it is applied, so a rejected call leaves
 * the SDK exactly as it was rather than with a new `baseDir` and the old
 * interval. Applying as we went meant
 * `configure({ baseDir, environment: "prod,eu" })` threw having already moved
 * the spool — precisely the half-applied state a caller who wraps startup in a
 * `try/catch` (a reasonable thing to do for a telemetry library that must not
 * crash the agent) was left shipping from.
 */
export function configure(options: ConfigureOptions = {}): void {
  const flushInterval = validatedInterval(options.flushInterval ?? 0.5);
  if (options.environment) rejectComma(options.environment, "configure({ environment })");
  setBaseDir(options.baseDir ?? null);
  runtime.writer.setFlushInterval(flushInterval);
  setEnvironment(options.environment ?? null);
}

/**
 * The 15 event methods.
 *
 * A forwarding view of the process-wide namespace rather than a direct
 * reference, so a test can replace `runtime.event` with a recording namespace
 * and every call site — including the adapters and the scopes — picks it up.
 */
export const event: EventNamespace = new Proxy(Object.create(null) as EventNamespace, {
  get(_target, property) {
    const value = (runtime.event as unknown as Record<PropertyKey, unknown>)[property];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(runtime.event)
      : value;
  },
  has(_target, property) {
    return property in (runtime.event as unknown as object);
  },
});

/**
 * Write everything buffered, now.
 *
 * Awaitable, so a short-lived script or a serverless handler can guarantee its
 * events reached disk before returning — the interval alone does not, and a
 * function that returns immediately after its last event routinely exits before
 * the next cycle.
 */
export async function flush(): Promise<void> {
  await flushAllNow();
}

/**
 * The synchronous flush, for a signal handler or an `exit` listener, where
 * awaiting is not possible. Blocks; use `flush()` anywhere else.
 */
export function flushSync(): void {
  flushAllSync();
}

// The per-framework call-site helpers live on subpaths rather than here:
//
//     import { telemetry, wrapModel } from "@failproofai/sdk/ai";
//     import { wrapTool, workflow }    from "@failproofai/sdk/mastra";
//     import { langchainHandler }      from "@failproofai/sdk/langchain";
//     import { Evaluator }             from "@failproofai/sdk/evaluator";
//
// Re-exporting them here would make `import "@failproofai/sdk"` evaluate every
// adapter module in the package — cheap, since none of them imports its
// framework at module scope, but it is exactly the creep that ends with the
// root import pulling in half the ecosystem. A subpath costs one line at the
// call site and keeps that impossible.
