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
 * Two phases, in order: `leaves` (open tool calls, hooks and model calls), then
 * `agents` — so every leaf ends before the agent that contains it, whichever
 * module registered first. Within a phase, newest first.
 *
 * Only on `exit`. A `flushSync()` called while the process carries on closes
 * nothing — the runs it would close are still running.
 */

export type ExitCloser = (exitCode: number) => void;
export type ExitPhase = "leaves" | "agents";

const closers: Record<ExitPhase, Set<ExitCloser>> = { leaves: new Set(), agents: new Set() };

/** Register a closer; returns its unregister function. */
export function onProcessExit(closer: ExitCloser, phase: ExitPhase = "agents"): () => void {
  closers[phase].add(closer);
  return () => {
    closers[phase].delete(closer);
  };
}

/** Run every registered closer: leaves, then agents, each newest first. */
export function runExitClosers(exitCode: number): void {
  for (const phase of ["leaves", "agents"] as const) {
    for (const closer of [...closers[phase]].reverse()) {
      try {
        closer(exitCode);
      } catch {
        // Swallowed: an exception thrown inside `process.on("exit")` prints a
        // stack into the host's stderr and would skip the flush of everything
        // the other closers just queued.
      }
    }
  }
}

/** The error an agent is closed with when the process exits under it. */
export class ProcessExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, what: string) {
    super(`the process exited (code ${exitCode}) while ${what} was still running`);
    this.name = "ProcessExit";
    this.exitCode = exitCode;
  }
}
