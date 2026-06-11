/**
 * Shared in-memory state between `/api/audit/run` and `/api/audit/status`.
 *
 * An audit can take arbitrarily long — a cold, all-history scan walks every
 * transcript on disk. The client UI needs to know whether one is in flight (to
 * keep polling and show the progress strip) and how the last one ended. Both
 * API routes import the same module-level state from here so they agree on what
 * "running" means.
 *
 * The run is fire-and-forget: `/api/audit/run` starts `runAudit()` as a detached
 * task in this long-lived server process and returns immediately; that task
 * calls `finishRun()` from its own try/catch when it settles (recording an error
 * message on failure). The client polls `/api/audit/status` until `running`
 * flips false.
 *
 * Caveats this lock does NOT cover:
 *
 *  - **Next.js dev-mode HMR** can reset module state mid-run; the status
 *    endpoint will then report `running: false` while the original task is
 *    still resolving. Production is unaffected.
 *
 *  - **Multi-worker (`next start` with PM2 cluster mode, or any
 *    multi-process Node deploy)**: the lock is per-process. Two POSTs
 *    that land on different workers will both succeed, both invoke
 *    `runAudit()`, and one result will overwrite the other in the cache
 *    file. A correct cross-worker lock needs external storage (Redis,
 *    DB row, filesystem lock) and is out of scope for the OSS dashboard,
 *    which expects a single worker process by default.
 *
 *  - **Process death mid-run** (OOM, SIGKILL, an uncaught throw that escapes the
 *    detached task's try/catch) would wedge the lock until the process restarts
 *    (a fresh server start resets module state). There is deliberately **no
 *    time-based auto-expiry**: a long but healthy run must not be mistaken for a
 *    wedged one — that premature "the run must be dead by now" timeout is exactly
 *    what we removed. On single-threaded Node a run that still yields to the
 *    event loop (so status polls keep answering) is progressing, not wedged. The
 *    lock releases only via `finishRun`.
 */
export interface RunState {
  /** True while a `runAudit()` call is in flight. */
  running: boolean;
  /** ms timestamp the current run was kicked off, if `running`. */
  startedAt?: number;
  /** Error message from the last finished run, or null on success / never-run.
   *  Surfaced to the client via /api/audit/status so a background failure isn't
   *  silently swallowed by the fire-and-forget POST. */
  error: string | null;
}

const state: RunState = { running: false, error: null };

export function getRunState(): RunState {
  return { ...state };
}

/** Atomically attempt to take the run lock. Returns true if the caller
 *  acquired it; false if a run is already in progress. Clears any prior run's
 *  error so a fresh run starts from a clean slate. */
export function tryAcquireRun(): boolean {
  if (state.running) return false;
  state.running = true;
  state.startedAt = Date.now();
  state.error = null;
  return true;
}

/** Mark the in-flight run finished and release the lock. Pass the failure
 *  message to surface via /status, or `null` on success. */
export function finishRun(error: string | null): void {
  state.running = false;
  state.startedAt = undefined;
  state.error = error;
}

/** Release the run lock cleanly (no error). Back-compat alias for
 *  `finishRun(null)`. Safe to call even when not held. */
export function releaseRun(): void {
  finishRun(null);
}
