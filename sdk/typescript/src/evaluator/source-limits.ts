/**
 * The handful of constants the sandbox worker and its parent must agree on.
 *
 * They live apart from `source.ts` so that `sandbox-worker.ts` can read them
 * without importing it — and importing it would drag `node:worker_threads`'s
 * `Worker`, the semaphore and the spawn logic into every sandbox child, giving
 * each evaluation the machinery for starting more of them. A worker that cannot
 * spawn a worker is a smaller thing to reason about.
 */

export const MAX_CONDITION_SOURCE_BYTES = 16 * 1024;
export const MAX_EVALUATOR_SOURCE_BYTES = 128 * 1024;

/** The names an evaluation expression may reference. */
export const SANDBOX_GLOBAL_NAMES = [
  "session",
  "EvalResult",
  "Score",
  "Metric",
  "Assertion",
  "ConditionResult",
  "Math",
  "Object",
  "Array",
  "Number",
  "JSON",
] as const;
