/**
 * Close what is still open when the process exits.
 *
 * A run killed mid-flight — every rolling deploy, every `docker stop`, a
 * Kubernetes eviction — used to leave its `agent_start` without an `agent_end`
 * and its `tool_use` without a `tool_result`. The dashboard renders those as
 * running forever and the run is never handed to evaluation. Python gets this
 * for free: its SIGTERM recipe raises `SystemExit`, which unwinds every
 * `with agent(...)` block. JavaScript has no unwinding through a pending
 * `await`, so the event namespace, the scopes and the adapters' trackers
 * register closers here and the writer's `exit` listener runs them before its
 * final synchronous flush.
 *
 * Everything closes most recently opened first, across every owner — the
 * order it would have closed in had it returned.
 *
 * Only on `exit`. A `flushSync()` called while the process carries on closes
 * nothing — the runs it would close are still running.
 */

/** Something still open when the process exits, and how to close it. */
export interface OpenItem {
  /** When it opened, in the event clock's microseconds (`clock.ts`). */
  opened: number;
  close(exitCode: number): void;
}

/** Returns what its owner still has open. Called once, at exit. */
export type ExitCollector = () => OpenItem[];

const collectors = new Set<ExitCollector>();

/**
 * The uncaught exception that is taking the process down, if one is. Without
 * it, a run killed by a crash was closed with "the process exited (code 1)"
 * and the exception itself was nowhere in the trace. Read through
 * `uncaughtExceptionMonitor`, which observes without handling: the process
 * still crashes exactly as it would have.
 */
let fatal: { error: unknown } | null = null;
let monitoring = false;

function monitorFatal(): void {
  if (monitoring) return;
  monitoring = true;
  process.on("uncaughtExceptionMonitor", (error) => {
    fatal ??= { error };
  });
}

/** The uncaught exception the process is exiting on, or undefined. */
export function fatalError(): unknown {
  return fatal?.error;
}

/** @internal For tests. */
export function resetFatal(): void {
  fatal = null;
}

/** Register a collector; returns its unregister function. */
export function onProcessExit(collector: ExitCollector): () => void {
  monitorFatal();
  collectors.add(collector);
  return () => {
    collectors.delete(collector);
  };
}

/**
 * Close everything still open, most recently opened first, across every
 * owner. One ordering, not one per owner: a tool that ran a sub-agent opened
 * before that sub-agent, so the sub-agent — and its model call, opened after
 * it — must close first. Closing all tools before all agents showed a
 * `delegate_writer` tool finishing while the writer it started still ran.
 */
export function runExitClosers(exitCode: number): void {
  const items: OpenItem[] = [];
  for (const collector of collectors) {
    try {
      items.push(...collector());
    } catch {
      // A collector that throws must not cost the others.
    }
  }
  items.sort((a, b) => b.opened - a.opened);
  for (const item of items) {
    try {
      item.close(exitCode);
    } catch {
      // Swallowed: an exception thrown inside `process.on("exit")` prints a
      // stack into the host's stderr and would skip the final flush.
    }
  }
}

/** `: <Class>: <message>` of the fatal exception, for the closing messages. */
export function fatalSuffix(): string {
  if (fatal === null) return "";
  const error = fatal.error;
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? error.name : error.constructor?.name || "Error";
    return ` on an uncaught ${name}: ${error.message}`;
  }
  return ` on an uncaught ${String(error)}`;
}

/** The error an agent is closed with when the process exits under it. */
export class ProcessExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, what: string) {
    super(`the process exited (code ${exitCode})${fatalSuffix()} while ${what} was still running`);
    this.name = "ProcessExit";
    this.exitCode = exitCode;
  }
}
