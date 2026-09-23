/**
 * Close what is still open when the process exits.
 *
 * A run killed mid-flight — every rolling deploy, every `docker stop`, a
 * Kubernetes eviction — used to leave its `agent_start` without an `agent_end`
 * and its `tool_use` without a `tool_result`. The dashboard renders those as
 * running forever and the run is never handed to evaluation. Python gets this
 * for free: its SIGTERM recipe raises `SystemExit`, which unwinds every
 * `with agent(...)` block. JavaScript has no unwinding through a pending
 * `await`, so the scopes and the adapters' trackers register a closer here and
 * the writer's `exit` listener runs them before its final synchronous flush.
 *
 * Only on `exit`. A `flushSync()` called while the process carries on closes
 * nothing — the runs it would close are still running.
 *
 * Closers run newest first, so an inner agent ends before the one that
 * contains it, as it would have had it returned. A closer that throws is
 * skipped rather than allowed to cost the flush that follows.
 */

export type ExitCloser = (exitCode: number) => void;

const closers = new Set<ExitCloser>();

/** Register a closer; returns its unregister function. */
export function onProcessExit(closer: ExitCloser): () => void {
  closers.add(closer);
  return () => {
    closers.delete(closer);
  };
}

/** Run every registered closer, newest first. Called from the writer's `exit` hook. */
export function runExitClosers(exitCode: number): void {
  for (const closer of [...closers].reverse()) {
    try {
      closer(exitCode);
    } catch {
      // Swallowed: an exception thrown inside `process.on("exit")` prints a
      // stack into the host's stderr and would skip the flush of everything
      // the other closers just queued.
    }
  }
}

/** The error an agent or tool is closed with when the process exits under it. */
export class ProcessExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, what: string) {
    super(`the process exited (code ${exitCode}) while ${what} was still running`);
    this.name = "ProcessExit";
    this.exitCode = exitCode;
  }
}
