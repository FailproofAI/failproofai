/**
 * Compiling and sandboxing server-authored ("managed") evaluations.
 *
 * Two independent boundaries, and they guard different things:
 *
 * 1. **The language** (`expression.ts`). Parsed and interpreted, never `eval`'d
 *    and never handed to `node:vm`, so tenant source has no reachable path to a
 *    function constructor, a module, `process`, or anything else in the worker.
 *    This is the CORRECTNESS boundary and it holds on its own.
 *
 * 2. **A `worker_threads` sandbox** (this file). A fresh Worker per evaluation
 *    with V8 `resourceLimits` on the heap, a wall-clock `terminate()`, a cap on
 *    the bytes the result may occupy, and a semaphore bounding how many run at
 *    once. This is the RESOURCE boundary: it stops a permitted expression from
 *    eating the worker even though every operation in it is individually legal.
 *
 * This is the same division the Python SDK draws between its AST allowlist and
 * its fork+RLIMIT subprocess, with one difference that matters: there, the
 * subprocess is the real bound because `eval` with empty builtins is porous.
 * Here the language is genuinely closed, so the sandbox is defence in depth
 * rather than the only thing holding.
 *
 * **It still fails closed.** If the sandbox cannot be established — no
 * `worker_threads`, no resolvable worker entry — managed source is REFUSED
 * rather than run unbounded in the worker's own thread. An evaluation that
 * cannot be terminated is not an evaluation we are willing to start.
 */

import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import { resolveFrom } from "../node-require.js";
import { Assertion, ConditionResult, EvalResult, Metric, Score } from "./authoring.js";
import { UnsafeEvaluatorSource, compileExpression } from "./expression.js";
import type { SessionTranscript } from "./protocol.js";
import {
  MAX_CONDITION_SOURCE_BYTES,
  MAX_EVALUATOR_SOURCE_BYTES,
  SANDBOX_GLOBAL_NAMES,
} from "./source-limits.js";

export { UnsafeEvaluatorSource };
export { MAX_CONDITION_SOURCE_BYTES, MAX_EVALUATOR_SOURCE_BYTES, SANDBOX_GLOBAL_NAMES };

/** Wall-clock and heap budget for ONE sandboxed evaluation. */
export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30;
/**
 * The effective budget is CLAMPED to this ceiling regardless of the
 * (server-set) per-definition timeout, so a large `timeout_seconds` can never
 * remove the execution bound.
 */
export const MAX_SANDBOX_TIMEOUT_SECONDS = 60;
/**
 * Per-sandbox heap cap. A managed eval works over a transcript (<= 25 MiB) and
 * returns a small result, so this is generous; it also stops an allocation bomb
 * before it can return a valid result.
 */
export const SANDBOX_MEMORY_MB = 512;
/**
 * A per-worker cap alone does not bound the HOST: a worker with
 * `maxConcurrency: 32` could run 32 sandboxes at once. Capping how many run
 * concurrently makes the AGGREGATE bounded independently of the claim
 * concurrency; extra evaluations queue on the semaphore rather than pile up
 * memory.
 */
export const MAX_CONCURRENT_SANDBOXES = 4;
/**
 * The result crossing back is bounded so that a permitted expression which
 * builds a huge result cannot exhaust the parent even though the child's heap
 * limit let it construct one. A valid result (<= 25 items, bounded fields) is
 * far under this.
 */
export const SANDBOX_MAX_RESULT_BYTES = 1024 * 1024;

/**
 * A sandboxed evaluation exceeded its CPU/memory/wall-clock budget.
 *
 * Distinct from an eval that *returned* an error: the computation was forcibly
 * terminated because it could not be allowed to keep running.
 */
export class EvaluationTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationTimeout";
  }
}

/**
 * The killable sandbox could not be established.
 *
 * Thrown instead of running server-authored source unsandboxed — if the worker
 * cannot be started there is no way to bound or terminate the evaluation, so we
 * fail closed.
 */
export class EvaluationSandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationSandboxUnavailable";
  }
}

export function sourceChecksum(
  conditionSource: string | null | undefined,
  evaluatorSource: string,
): string {
  const payload = Buffer.concat([
    Buffer.from(conditionSource ?? "", "utf8"),
    Buffer.from([0]),
    Buffer.from(evaluatorSource, "utf8"),
  ]);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * The wall-clock/heap budget for one evaluation: a positive value no larger
 * than `MAX_SANDBOX_TIMEOUT_SECONDS`. Server-provided timeouts cannot exceed it.
 */
function clampBudget(timeoutSeconds: number | null | undefined): number {
  const requested = Number(timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS);
  const positive =
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SANDBOX_TIMEOUT_SECONDS;
  return Math.min(positive, MAX_SANDBOX_TIMEOUT_SECONDS);
}

// ---------------------------------------------------------------------------
// Locating the worker entry
// ---------------------------------------------------------------------------

/**
 * Where the sandbox worker's compiled entry lives.
 *
 * `import.meta.url` would answer this in one line and is deliberately not used:
 * it is a syntax error in the CommonJS half of this package's dual build, and a
 * telemetry SDK that only works from one module system is a telemetry SDK half
 * its users cannot install. The resolution order instead is:
 *
 *   1. `FAILPROOFAI_SDK_SANDBOX_WORKER` — an explicit path. Used by this
 *      repository's own tests, and the supported answer for anyone bundling
 *      this package into a single file, where the published layout is gone.
 *   2. The package's own `./sandbox-worker` export, resolved through the
 *      consuming application. This is the installed case and needs no setup.
 *
 * Failure names the variable rather than falling back to an unsandboxed run.
 */
function sandboxWorkerPath(): string {
  const override = process.env.FAILPROOFAI_SDK_SANDBOX_WORKER;
  if (override) return override;
  const resolved = resolveFrom("@failproofai/sdk/sandbox-worker");
  if (resolved !== null) return resolved;
  throw new EvaluationSandboxUnavailable(
    "could not locate the evaluator sandbox worker. This happens when @failproofai/sdk has " +
      "been bundled and its published file layout is gone. Set " +
      "FAILPROOFAI_SDK_SANDBOX_WORKER to the path of the package's sandbox-worker entry, " +
      "or run managed evaluations from an unbundled install. Refusing to evaluate " +
      "server-authored source without a sandbox.",
  );
}

// ---------------------------------------------------------------------------
// The concurrency gate
// ---------------------------------------------------------------------------

class Semaphore {
  private available: number;
  private readonly waiters: Array<(granted: boolean) => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  /**
   * Acquire within `timeoutMs`, or resolve false.
   *
   * The timeout is not decoration: the runtime awaits an evaluation with its
   * own deadline, and a queue wait that ignored it would let a thread launch a
   * sandbox after its run had already been reported timed out — twenty-eight
   * of them queued behind four long sandboxes, all still to come.
   */
  acquire(timeoutMs: number): Promise<boolean> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(true);
    }
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const waiter = (granted: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(granted);
      };
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.available += 1;
      return;
    }
    waiter(true);
  }
}

const slots = new Semaphore(MAX_CONCURRENT_SANDBOXES);

// ---------------------------------------------------------------------------
// Running one evaluation in a sandbox
// ---------------------------------------------------------------------------

interface SandboxRequest {
  kind: "condition" | "evaluator";
  source: string;
  session: Record<string, unknown>;
  evalKey: string | null;
  maxResultBytes: number;
}

type SandboxOutcome =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string };

async function runSandboxed(
  request: Omit<SandboxRequest, "maxResultBytes">,
  budgetSeconds: number,
): Promise<unknown> {
  const workerPath = sandboxWorkerPath();
  const deadline = Date.now() + budgetSeconds * 1000;

  // One deadline covers BOTH the queue wait and the execution, so a run cannot
  // spend its whole budget waiting and then start anyway.
  const granted = await slots.acquire(deadline - Date.now());
  if (!granted) throw new EvaluationTimeout("evaluation timed out waiting for a sandbox slot");

  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Slot acquired exactly at the deadline: a worker started now could only
      // be killed immediately, so do not start one at all.
      throw new EvaluationTimeout("evaluation timed out waiting for a sandbox slot");
    }
    return await runWorker(workerPath, { ...request, maxResultBytes: SANDBOX_MAX_RESULT_BYTES }, remaining);
  } finally {
    slots.release();
  }
}

function runWorker(
  workerPath: string,
  request: SandboxRequest,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        workerData: request,
        // Nothing from the parent's environment crosses. On a hosted worker
        // `FAILPROOFAI_EVALUATOR_TOKEN` is the credential the fleet
        // authenticates with; the language cannot reach `process` at all, so
        // this is defence in depth rather than a fix for a live escape — it
        // means a future gap could not be escalated into credential theft.
        env: {},
        argv: [],
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: SANDBOX_MEMORY_MB,
          maxYoungGenerationSizeMb: 64,
          codeRangeSizeMb: 32,
          stackSizeMb: 8,
        },
        stdin: false,
        stdout: true,
        stderr: true,
      });
    } catch (error) {
      reject(
        new EvaluationSandboxUnavailable(
          `could not start the evaluation sandbox: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      run();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new EvaluationTimeout("evaluation exceeded its wall-clock budget"));
      });
    }, timeoutMs);
    timer.unref?.();

    worker.on("message", (outcome: SandboxOutcome) => {
      finish(() => {
        if (outcome.ok) {
          resolve(outcome.value);
          return;
        }
        // Preserve the child's original error SEMANTICS, so an eval's
        // TypeError and the sandbox's own UnsafeEvaluatorSource read the same
        // as they would in-process.
        if (outcome.name === "UnsafeEvaluatorSource") {
          reject(new UnsafeEvaluatorSource(outcome.message));
          return;
        }
        if (outcome.name === "EvaluationBudgetExceeded") {
          reject(new EvaluationTimeout(outcome.message));
          return;
        }
        reject(rebuildError(outcome.name, outcome.message));
      });
    });

    worker.on("error", (error: Error & { code?: string }) => {
      finish(() => {
        // A heap-limit kill arrives here, not as a message. It is a resource
        // failure, not an evaluation that returned something.
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(new EvaluationTimeout("evaluation exceeded its memory budget"));
          return;
        }
        reject(error);
      });
    });

    worker.on("exit", (code) => {
      finish(() => {
        reject(
          new EvaluationTimeout(
            `evaluation was terminated before producing a result (exit code ${code})`,
          ),
        );
      });
    });
  });
}

/**
 * The built-in error types an evaluation can realistically produce.
 *
 * Reconstructing the REAL constructor, rather than an `Error` with its `name`
 * reassigned, is what keeps `instanceof TypeError` true on this side of the
 * worker boundary. An author debugging their own evaluation — or a `catch` in a
 * custom managed compiler — cannot tell a sandboxed run from an in-process one
 * otherwise, which turns every sandbox-only bug into a mystery.
 */
const BUILTIN_ERRORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError: TypeError,
  RangeError: RangeError,
  ReferenceError: ReferenceError,
  SyntaxError: SyntaxError,
  EvalError: EvalError,
  URIError: URIError,
};

function rebuildError(name: string, message: string): Error {
  const Builtin = BUILTIN_ERRORS[name];
  if (Builtin !== undefined) return new Builtin(message);
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---------------------------------------------------------------------------
// Rebuilding results on this side of the boundary
// ---------------------------------------------------------------------------

interface WireScore {
  value: number;
  passed?: boolean;
  unit?: string;
  displayValue?: string;
  description?: string;
}

interface WireEvalResult {
  score?: WireScore;
  metrics?: Record<string, number | { value: number; unit?: string; displayValue?: string; description?: string }>;
  assertions?: Record<string, boolean | { passed: boolean; description?: string }>;
  reasoning?: string;
  summary?: string;
  labels?: string[];
}

function rebuildEvalResult(value: unknown): EvalResult {
  const wire = value as WireEvalResult;
  if (typeof wire !== "object" || wire === null) {
    throw new TypeError("evaluator source must return an EvalResult");
  }
  const metrics: Record<string, Metric | number> = {};
  for (const [key, metric] of Object.entries(wire.metrics ?? {})) {
    metrics[key] =
      typeof metric === "number"
        ? metric
        : new Metric(metric.value, {
            unit: metric.unit,
            displayValue: metric.displayValue,
            description: metric.description,
          });
  }
  const assertions: Record<string, Assertion | boolean> = {};
  for (const [key, assertion] of Object.entries(wire.assertions ?? {})) {
    assertions[key] =
      typeof assertion === "boolean"
        ? assertion
        : new Assertion(assertion.passed, { description: assertion.description });
  }
  return new EvalResult({
    score:
      wire.score === undefined
        ? undefined
        : new Score(wire.score.value, {
            passed: wire.score.passed,
            unit: wire.score.unit,
            displayValue: wire.score.displayValue,
            description: wire.score.description,
          }),
    metrics,
    assertions,
    reasoning: wire.reasoning,
    summary: wire.summary,
    labels: wire.labels ?? [],
  });
}

function rebuildCondition(value: unknown): boolean | ConditionResult {
  if (typeof value === "boolean") return value;
  const wire = value as { applicable?: unknown; reasonCode?: unknown };
  if (typeof wire?.applicable !== "boolean") {
    throw new TypeError("condition source must return a boolean or a ConditionResult");
  }
  return new ConditionResult(
    wire.applicable,
    typeof wire.reasonCode === "string" ? wire.reasonCode : undefined,
  );
}

// ---------------------------------------------------------------------------
// Public compile API
// ---------------------------------------------------------------------------

/**
 * Validate `source` here, in the PARENT, so unsafe or malformed source is
 * rejected before any worker is started — and return a function that runs it in
 * the sandbox. The worker parses it again as defence in depth, so a worker can
 * never evaluate source the parent has not vetted.
 */
function validateLocally(source: string, kind: "condition" | "evaluator"): void {
  compileExpression(source, {
    fieldName: kind === "condition" ? "condition_source" : "evaluator_source",
    maximumBytes: kind === "condition" ? MAX_CONDITION_SOURCE_BYTES : MAX_EVALUATOR_SOURCE_BYTES,
    globalNames: SANDBOX_GLOBAL_NAMES,
  });
}

export function compileCondition(
  source: string,
  options: { timeoutSeconds?: number | null } = {},
): (session: SessionTranscript) => Promise<boolean | ConditionResult> {
  validateLocally(source, "condition");
  const budget = clampBudget(options.timeoutSeconds);

  return async (session: SessionTranscript): Promise<boolean | ConditionResult> => {
    // Conditions are sandboxed exactly like evaluators. A condition has no
    // runtime-level timeout above it, so an unbounded one would block the
    // worker with no deadline at all.
    const value = await runSandboxed(
      { kind: "condition", source, session: session.toWire(), evalKey: null },
      budget,
    );
    return rebuildCondition(value);
  };
}

export function compileEvaluator(
  source: string,
  options: { timeoutSeconds?: number | null; evalKey?: string | null } = {},
): (session: SessionTranscript) => Promise<EvalResult> {
  validateLocally(source, "evaluator");
  const budget = clampBudget(options.timeoutSeconds);
  const evalKey = options.evalKey ?? null;

  return async (session: SessionTranscript): Promise<EvalResult> => {
    const value = await runSandboxed(
      { kind: "evaluator", source, session: session.toWire(), evalKey },
      budget,
    );
    return rebuildEvalResult(value);
  };
}
