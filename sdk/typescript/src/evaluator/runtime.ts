/**
 * The async worker state machine for Evaluator v2.
 *
 * Claim -> fetch the transcript -> run each definition's condition -> submit a
 * plan -> run the planned evaluations under a heartbeat -> submit each result.
 *
 * ## What is different from the Python worker, and why
 *
 * Python runs synchronous evaluations in a sized thread pool, because a
 * blocking customer function would otherwise stall its event loop. JavaScript
 * has no such option: a synchronous evaluation that does not return blocks the
 * one thread there is, and no timeout can fire while it does. So the contract
 * here is explicit — **an evaluation must yield.** An `async` function that
 * awaits, or a sandboxed managed evaluation (which runs in its own Worker and
 * IS killable), can always be bounded. A synchronous busy-loop cannot be, by
 * anyone, and `DEFAULT_EVAL_TIMEOUT_SECONDS` will not save a worker from one.
 *
 * The bound that does hold everywhere: every evaluation is raced against a
 * deadline, and a run that loses the race is reported `timed_out` and its
 * result submitted, so the assignment does not sit unresolved. The evaluation
 * itself may still be running — a promise cannot be cancelled — which is
 * counted as `evaluations_orphaned` and logged with the eval key, so a hung one
 * is findable.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { logException, logger } from "../logger.js";
import { VERSION } from "../version.js";
import { EvalResult, Evaluator, ConditionResult } from "./authoring.js";
import type { EvalDefinition } from "./authoring.js";
import { EvaluatorAPIError, EvaluatorClient } from "./client.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  ExecutionMode,
  MAX_CLAIM_CAPACITY,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_WORKER_ID_BYTES,
  TerminalRunStatus,
} from "./protocol.js";
import type {
  Assignment,
  AssignmentDefinition,
  EvalSelection,
  ResultItem,
  SessionTranscript,
  SkippedEval,
} from "./protocol.js";
import {
  EvaluationTimeout,
  UnsafeEvaluatorSource,
  compileCondition,
  compileEvaluator,
  sourceChecksum,
} from "./source.js";

/**
 * Reserved out of the lease for the plan request (and network jitter) so the
 * pre-plan condition phase always leaves time to submit the plan before the
 * lease expires.
 */
const CONDITION_PHASE_SAFETY_MARGIN_SECONDS = 5;

/**
 * Fallback wall-clock bound for an evaluation whose definition declares no
 * timeout. A LOCAL (customer-authored) eval has no sandbox backstop, so without
 * this a hang — a wedged `await`, an unbounded judge HTTP call — would hold its
 * worker slot and the assignment lease forever. Matches the storage contract's
 * 5-minute per-eval default.
 */
export const DEFAULT_EVAL_TIMEOUT_SECONDS = 300;

function utcNow(): string {
  return `${new Date().toISOString().slice(0, -1)}000Z`;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

export interface WorkerConfig {
  serverUrl: string;
  credential: string;
  workerId: string;
  maxConcurrency: number;
  requestTimeoutSeconds: number;
  drainTimeoutSeconds: number;
  allowInsecureHttp: boolean;
}

export function workerConfigFromEnv(): WorkerConfig {
  const serverUrl = (process.env.FAILPROOFAI_EVALUATOR_URL ?? "").trim();
  const credential = (process.env.FAILPROOFAI_EVALUATOR_TOKEN ?? "").trim();
  if (!serverUrl) throw new Error("FAILPROOFAI_EVALUATOR_URL is required");
  if (!credential) throw new Error("FAILPROOFAI_EVALUATOR_TOKEN is required");

  let workerId = (process.env.FAILPROOFAI_EVALUATOR_WORKER_ID ?? "").trim();
  if (!workerId) workerId = `${hostname()}-${process.pid}`;
  if (Buffer.byteLength(workerId, "utf8") > MAX_WORKER_ID_BYTES) {
    throw new Error(`FAILPROOFAI_EVALUATOR_WORKER_ID exceeds ${MAX_WORKER_ID_BYTES} bytes`);
  }
  for (const char of workerId) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 127) {
      throw new Error("FAILPROOFAI_EVALUATOR_WORKER_ID must not contain control characters");
    }
  }

  const config: WorkerConfig = {
    serverUrl,
    credential,
    workerId,
    maxConcurrency: positiveIntEnv("FAILPROOFAI_EVALUATOR_CONCURRENCY", 1),
    requestTimeoutSeconds: positiveIntEnv("FAILPROOFAI_EVALUATOR_REQUEST_TIMEOUT_SECONDS", 30),
    drainTimeoutSeconds: positiveIntEnv("FAILPROOFAI_EVALUATOR_DRAIN_TIMEOUT_SECONDS", 60),
    allowInsecureHttp: booleanEnv("FAILPROOFAI_EVALUATOR_ALLOW_INSECURE_HTTP"),
  };
  if (config.maxConcurrency > MAX_CLAIM_CAPACITY) {
    throw new Error(`FAILPROOFAI_EVALUATOR_CONCURRENCY exceeds ${MAX_CLAIM_CAPACITY}`);
  }
  return config;
}

/** A deadline race that reports which side won, so the caller can count it. */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      expiry,
    ]);
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function sleep(ms: number, signal?: { aborted: boolean }): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Compile server-authored source LAZILY, at invocation time.
 *
 * Compilation can reject unsafe or malformed source. Building the definition
 * with this thunk instead of a pre-compiled function routes that failure
 * through the same per-run `try/catch` that turns any evaluation error into a
 * bounded FAILED result — so a poison definition dead-letters cleanly as one
 * failed run instead of throwing out of assignment setup, crashing the task,
 * and forcing the whole assignment to be reclaimed and retried until its
 * attempt budget is exhausted.
 */
function deferredManagedEval(
  source: string,
  timeoutSeconds: number | null,
  evalKey: string,
  compiler: Evaluator["managedCompiler"],
): (session: SessionTranscript) => Promise<EvalResult> | EvalResult {
  return (session: SessionTranscript) => {
    const compile = compiler ?? ((s, o) => compileEvaluator(s, o));
    return compile(source, { timeoutSeconds, evalKey })(session);
  };
}

export class WorkerRuntime {
  readonly evaluator: Evaluator;
  readonly config: WorkerConfig;
  readonly client: EvaluatorClient;

  private stopping = false;
  private stopWaiters: Array<() => void> = [];
  private readonly activeAssignments = new Set<Promise<void>>();
  private heartbeatInterval = 30;
  private pollInterval: number = DEFAULT_POLL_INTERVAL_SECONDS;
  private claimLimit: number;
  private leaseDuration = 120;
  private disabledDefinitions = new Set<string>();
  private registered = false;
  private lastServerContact: number | null = null;
  private readonly metricCounts = new Map<string, number>();
  private readonly slots: { inUse: number; waiters: Array<() => void> };

  constructor(evaluator: Evaluator, config: WorkerConfig, options: { client?: EvaluatorClient } = {}) {
    this.evaluator = evaluator;
    this.config = config;
    this.claimLimit = config.maxConcurrency;
    this.client =
      options.client ??
      new EvaluatorClient({
        baseUrl: config.serverUrl,
        credential: config.credential,
        timeoutSeconds: config.requestTimeoutSeconds,
        allowInsecureHttp: config.allowInsecureHttp,
      });
    this.slots = { inUse: 0, waiters: [] };
  }

  async register(): Promise<void> {
    let response;
    try {
      response = await this.call(() =>
        this.client.register({
          workerId: this.config.workerId,
          sdkVersion: VERSION,
          catalogRevision: this.evaluator.catalogRevision,
          maxConcurrency: this.config.maxConcurrency,
          definitions: this.evaluator.catalog(),
        }),
      );
    } catch (error) {
      this.increment("registration_failure");
      throw error;
    }
    this.heartbeatInterval = response.heartbeatIntervalSeconds;
    this.pollInterval = response.pollIntervalSeconds;
    this.leaseDuration = response.leaseDurationSeconds;
    this.claimLimit = Math.min(this.config.maxConcurrency, response.claimLimit);
    if (
      this.heartbeatInterval <= 0 ||
      this.pollInterval <= 0 ||
      this.leaseDuration <= this.heartbeatInterval ||
      this.claimLimit <= 0
    ) {
      this.increment("registration_failure");
      throw new Error("server returned invalid evaluator timing or claim limits");
    }
    this.disabledDefinitions = new Set(response.disabledDefinitions);
    this.registered = true;
    this.increment("registration_success");
  }

  async runForever(): Promise<void> {
    await this.register();
    let retryDelay = 1;
    try {
      while (!this.stopping) {
        const capacity = this.claimLimit - this.activeAssignments.size;
        if (capacity <= 0) {
          await this.waitForProgress();
          continue;
        }
        let response;
        try {
          response = await this.call(() =>
            this.client.claim({
              workerId: this.config.workerId,
              catalogRevision: this.evaluator.catalogRevision,
              capacity,
            }),
          );
        } catch (error) {
          if (!(error instanceof EvaluatorAPIError)) throw error;
          this.increment("claim_failures");
          logger.warn(`evaluator claim failed (code=${error.code}, retryable=${error.retryable})`);
          if (!error.retryable) throw error;
          // A transport failure with no status means the server is unreachable,
          // not busy — back off by the whole lease rather than hammering it.
          const delay = error.status === null ? this.leaseDuration : retryDelay;
          await this.waitOrStop(delay * 1000);
          retryDelay = Math.min(retryDelay * 2, 30);
          continue;
        }
        retryDelay = 1;
        const assignments = validatedAssignments(response.assignments, capacity);
        for (const assignment of assignments) this.spawn(assignment);
        this.increment("assignments_claimed", assignments.length);
        if (assignments.length === 0) {
          // Normal short poll: the server returns immediately, so when nothing
          // is queued we wait the advertised interval instead of hot-looping.
          // When work IS returned we loop straight back to drain any backlog.
          await this.waitOrStop(this.pollInterval * 1000);
        }
      }
    } finally {
      await this.drain();
    }
  }

  /** Claim once and finish the returned assignments; useful for jobs and tests. */
  async runOnce(): Promise<number> {
    const response = await this.call(() =>
      this.client.claim({
        workerId: this.config.workerId,
        catalogRevision: this.evaluator.catalogRevision,
        capacity: this.claimLimit,
      }),
    );
    const assignments = validatedAssignments(response.assignments, this.claimLimit);
    this.increment("assignments_claimed", assignments.length);
    await Promise.all(assignments.map((assignment) => this.processAssignment(assignment)));
    return assignments.length;
  }

  stop(): void {
    this.stopping = true;
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async drain(): Promise<void> {
    if (this.activeAssignments.size === 0) return;
    const outcome = await withDeadline(
      Promise.allSettled([...this.activeAssignments]).then(() => undefined),
      this.config.drainTimeoutSeconds * 1000,
    );
    if (outcome.timedOut) {
      logger.warn(
        `drain timed out with ${this.activeAssignments.size} assignment(s) still running; ` +
          "their results may not be submitted",
      );
    }
    this.activeAssignments.clear();
  }

  private spawn(assignment: Assignment): void {
    const task = this.processAssignment(assignment)
      .catch((error: unknown) => {
        logException("evaluator assignment failed", error);
      })
      .finally(() => {
        this.activeAssignments.delete(task);
        this.notifyProgress();
      });
    this.activeAssignments.add(task);
  }

  async processAssignment(assignment: Assignment): Promise<void> {
    let session: SessionTranscript;
    try {
      session = await this.call(() => this.client.transcript(assignment, this.config.workerId));
    } catch (error) {
      if (error instanceof EvaluatorAPIError && error.code === "transcript_too_large") {
        // No runs are planned yet, so there is nothing to submit a per-run
        // result for, and the error is non-retryable — re-throwing would only
        // wedge the poll loop and burn the assignment's whole retry budget
        // against a transcript that can never shrink. The server terminalizes
        // the assignment itself.
        logger.warn(
          `assignment ${assignment.assignmentId} transcript is too large to evaluate; skipping`,
        );
        this.increment("transcripts_too_large");
        return;
      }
      throw error;
    }
    if (session.sessionRevisionId !== assignment.sessionRevisionId) {
      throw new Error("transcript session revision does not match assignment");
    }

    const descriptors = await this.assignmentDefinitions(assignment);
    // Every descriptor the assignment carries, keyed for reconstruction: on an
    // idempotent replay the server re-serves the first attempt's run set, which
    // may include a run this attempt's re-derived plan would have skipped.
    const descriptorByKey = new Map<string, AssignmentDefinition>(
      descriptors.map((item) => [`${item.evalKey}@${item.evalVersion}`, item]),
    );
    const localDefinitions = new Map<string, EvalDefinition>(
      this.evaluator.definitions.map((item) => [`${item.evalKey}@${item.evalVersion}`, item]),
    );

    const selected: Array<[AssignmentDefinition, EvalDefinition | null]> = [];
    const skipped: SkippedEval[] = [];
    // The assignment lease is fixed at claim time and cannot be renewed until
    // the plan is submitted (the server only extends a lease for a *planned*
    // assignment with running runs). A slow condition phase can therefore burn
    // the whole lease and get the plan fenced as `lease_lost`, so every
    // condition is bounded by the lease it must leave time to plan within.
    const conditionDeadline = this.conditionPhaseDeadline(assignment);

    for (const descriptor of descriptors) {
      const key = `${descriptor.evalKey}@${descriptor.evalVersion}`;
      const local = localDefinitions.get(key) ?? null;
      if (descriptor.executionMode === ExecutionMode.LOCAL && local === null) {
        throw new Error("server requested a definition absent from this worker");
      }
      if (this.disabledDefinitions.has(descriptor.evalKey)) {
        skipped.push(skippedOf(descriptor, "disabled_by_server"));
        this.increment("conditions_skipped");
        continue;
      }

      let applicable: boolean;
      let reasonCode = "condition_false";
      try {
        // Whose condition decides applicability follows the EXECUTION MODE: a
        // LOCAL definition's condition is client-authored; a sandboxed
        // (server-authored) definition's is server-authored and MUST govern
        // even when the worker also registered the same key/version locally.
        // Keying `local` on key+version alone means a managed definition can
        // collide with a local one; selecting the local condition there would
        // let it override the server's rule and run the managed evaluator
        // against the operator's intent.
        let condition: ((s: SessionTranscript) => unknown) | null = null;
        let managedConditionSource: string | null = null;
        if (descriptor.executionMode === ExecutionMode.LOCAL) {
          condition = local?.condition ?? null;
        } else if (descriptor.conditionSource) {
          managedConditionSource = descriptor.conditionSource;
        }
        if (condition === null && managedConditionSource === null) {
          selected.push([descriptor, local]);
          continue;
        }
        const budget = this.conditionBudget(conditionDeadline, descriptor.timeoutSeconds);
        if (budget <= 0) {
          // Not enough lease left to evaluate this condition and still submit
          // the plan in time; skip it (and, as the loop proceeds, every later
          // condition) rather than do work the server will fence as
          // `lease_lost` and reclaim in a loop.
          skipped.push(skippedOf(descriptor, "lease_exhausted"));
          this.increment("conditions_skipped");
          this.increment("conditions_lease_exhausted");
          continue;
        }
        // Compiled INSIDE the try, and only once the lease budget is known: a
        // managed condition the sandbox rejects must dead-letter as
        // `condition_error`, not throw out of the plan loop and strand the
        // whole assignment until its retry budget is exhausted.
        if (managedConditionSource !== null) {
          condition = compileCondition(managedConditionSource, { timeoutSeconds: budget });
        }
        const outcome = await withDeadline(
          Promise.resolve(condition!(session)),
          budget * 1000,
        );
        if (outcome.timedOut) throw new EvaluationTimeout("condition exceeded its budget");
        const value = outcome.value;
        if (value instanceof ConditionResult) {
          applicable = value.applicable;
          reasonCode = value.reasonCode;
        } else if (typeof value === "boolean") {
          applicable = value;
        } else {
          throw new TypeError("condition must return a boolean or a ConditionResult");
        }
      } catch (error) {
        logger.warn(
          `evaluator condition failed (assignment=${assignment.assignmentId}, ` +
            `error=${error instanceof Error ? error.name : typeof error})`,
        );
        skipped.push(skippedOf(descriptor, "condition_error"));
        this.increment("conditions_skipped");
        continue;
      }

      if (applicable) {
        selected.push([descriptor, local]);
        this.increment("conditions_selected");
      } else {
        skipped.push(skippedOf(descriptor, reasonCode));
        this.increment("conditions_skipped");
      }
    }

    const plan = await this.call(() =>
      this.client.plan(assignment.assignmentId, {
        workerId: this.config.workerId,
        leaseGeneration: assignment.leaseGeneration,
        selected: selected.map(
          ([item]): EvalSelection => ({ evalKey: item.evalKey, evalVersion: item.evalVersion }),
        ),
        skipped,
      }),
    );
    if (plan.assignmentId !== assignment.assignmentId) {
      throw new Error("server returned a plan for a different assignment");
    }
    // On an idempotent replay the server's status is authoritative: this
    // attempt may have selected a different set than the first, so a mismatch
    // against our own `selected` is expected, not an error.
    if (!plan.idempotentReplay) {
      const expected = selected.length > 0 ? "planned" : "skipped";
      if (plan.assignmentStatus !== expected) {
        throw new Error("server returned an inconsistent assignment status");
      }
    }

    const pending = new Map<string, [AssignmentDefinition, EvalDefinition | null]>(
      selected.map(([item, local]) => [`${item.evalKey}@${item.evalVersion}`, [item, local]]),
    );
    const runDefinitions: Array<[string, EvalDefinition]> = [];
    const runIds = new Set<string>();
    for (const run of plan.runs) {
      if (runIds.has(run.evaluationRunId)) {
        throw new Error("server returned a duplicate evaluation run id");
      }
      runIds.add(run.evaluationRunId);
      const key = `${run.evalKey}@${run.evalVersion}`;
      let entry = pending.get(key);
      pending.delete(key);
      if (entry === undefined) {
        // On an idempotent replay the server's run set is AUTHORITATIVE — it
        // re-serves the first attempt's runs even for a definition this
        // attempt's condition phase would have skipped. Reconstruct from the
        // assignment's descriptors rather than throwing and dead-lettering an
        // assignment that could otherwise never converge.
        const replay = plan.idempotentReplay ? descriptorByKey.get(key) : undefined;
        if (replay === undefined) throw new Error("server returned an unrequested evaluation run");
        entry = [replay, localDefinitions.get(key) ?? null];
      }
      const [descriptor, local] = entry;
      if (run.executionMode !== descriptor.executionMode) {
        throw new Error("server changed the evaluation execution mode");
      }

      let definition: EvalDefinition;
      if (run.executionMode === ExecutionMode.LOCAL) {
        if (local === null) throw new Error("local evaluation definition is unavailable");
        definition = local;
      } else {
        if (!run.evaluatorSource || !run.sourceChecksum) {
          throw new Error("server omitted managed evaluation source");
        }
        const expected = sourceChecksum(descriptor.conditionSource, run.evaluatorSource);
        if (
          expected !== run.sourceChecksum ||
          (descriptor.sourceChecksum && descriptor.sourceChecksum !== run.sourceChecksum)
        ) {
          throw new Error("managed evaluation source checksum mismatch");
        }
        const timeoutSeconds = run.timeoutSeconds ?? descriptor.timeoutSeconds;
        definition = {
          evalKey: descriptor.evalKey,
          displayName: descriptor.displayName,
          evalVersion: descriptor.evalVersion,
          resultKind: descriptor.resultKind,
          labels: descriptor.labels,
          function: deferredManagedEval(
            run.evaluatorSource,
            timeoutSeconds,
            descriptor.evalKey,
            this.evaluator.managedCompiler,
          ),
          condition: null,
          onCancel: null,
          timeoutSeconds,
        };
      }
      runDefinitions.push([run.evaluationRunId, definition]);
    }
    if (pending.size > 0 && !plan.idempotentReplay) {
      throw new Error("server omitted a selected evaluation run");
    }

    const states = new Map<string, { done: boolean; cancelled: boolean }>();
    const tasks = runDefinitions.map(([runId, definition]) => {
      const state = { done: false, cancelled: false };
      states.set(runId, state);
      return this.executeRun(assignment, runId, definition, session, state).finally(() => {
        state.done = true;
      });
    });
    const heartbeat = this.heartbeat(assignment, states);
    try {
      const outcomes = await Promise.allSettled(tasks);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason as Error;
      }
    } finally {
      heartbeat.cancel();
      await heartbeat.finished;
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.slots.inUse < this.config.maxConcurrency) {
      this.slots.inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slots.waiters.push(resolve));
    this.slots.inUse += 1;
  }

  private releaseSlot(): void {
    this.slots.inUse -= 1;
    const waiter = this.slots.waiters.shift();
    if (waiter) waiter();
  }

  private async executeRun(
    assignment: Assignment,
    runId: string,
    definition: EvalDefinition,
    session: SessionTranscript,
    state: { done: boolean; cancelled: boolean },
  ): Promise<void> {
    await this.acquireSlot();
    try {
      await this.executeRunInSlot(assignment, runId, definition, session, state);
    } finally {
      this.releaseSlot();
    }
  }

  private async executeRunInSlot(
    assignment: Assignment,
    runId: string,
    definition: EvalDefinition,
    session: SessionTranscript,
    state: { done: boolean; cancelled: boolean },
  ): Promise<void> {
    const startedAt = utcNow();
    const started = Date.now();
    let items: readonly ResultItem[] = [];
    let status: TerminalRunStatus;
    let summary: string | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      if (state.cancelled) throw new EvaluationCancelled();
      // Always bound the evaluation. A definition with no declared timeout
      // falls back to the default rather than awaiting unbounded — an unbounded
      // local eval that hangs would wedge its worker slot and hold the lease
      // forever.
      const timeoutSeconds = definition.timeoutSeconds ?? DEFAULT_EVAL_TIMEOUT_SECONDS;
      const outcome = await withDeadline(
        Promise.resolve(definition.function(session)),
        timeoutSeconds * 1000,
      );
      if (outcome.timedOut) throw new EvaluationTimeout("evaluation exceeded its timeout");
      const result = outcome.value;
      if (!(result instanceof EvalResult)) throw new TypeError("evaluation must return an EvalResult");
      items = result.resultItems(definition.evalKey);
      if (
        !items.some(
          (item) => item.resultKey === definition.evalKey && item.resultKind === definition.resultKind,
        )
      ) {
        throw new Error("evaluation result does not contain its declared primary result");
      }
      status = TerminalRunStatus.SUCCEEDED;
      summary = result.summary ?? null;
    } catch (error) {
      await this.cancelHook(definition, session);
      if (error instanceof EvaluationCancelled || state.cancelled) {
        status = TerminalRunStatus.CANCELLED;
        errorCode = "lease_lost";
        errorMessage = "the assignment lease was lost before this run finished";
      } else if (error instanceof EvaluationTimeout) {
        // A SANDBOXED evaluation that loses this race has already been
        // terminated by the worker sandbox, so nothing is left running. A LOCAL
        // one cannot be: a promise has no cancel, so the customer's function
        // keeps going. Count it and name the eval so a hung one is findable.
        this.increment("evaluations_orphaned");
        logger.warn(
          `evaluation ${JSON.stringify(definition.evalKey)} exceeded its timeout ` +
            `(assignment=${assignment.assignmentId}). If it is a local evaluation it is still ` +
            "running — a promise cannot be cancelled — and its worker slot is freed only when " +
            "it settles.",
        );
        status = TerminalRunStatus.TIMED_OUT;
        errorCode = "eval_timeout";
        errorMessage = "evaluation exceeded its configured timeout";
      } else if (error instanceof UnsafeEvaluatorSource) {
        // Surface the REASON for a rejected server-authored definition. This is
        // deliberately narrower than the generic branch below:
        // `UnsafeEvaluatorSource` is raised by our own validator before any
        // customer source runs, and its message is SDK-authored text about the
        // source's shape — it embeds no transcript content, so it is safe to
        // send back over the wire. Without it the author sees only "evaluation
        // raised UnsafeEvaluatorSource" on every session, with no way to learn
        // what was wrong.
        status = TerminalRunStatus.FAILED;
        errorCode = "eval_error";
        const detail = error.message.trim();
        errorMessage = truncateUtf8(
          detail ? `evaluator source rejected: ${detail}` : "evaluator source rejected by the validator",
          MAX_ERROR_MESSAGE_BYTES,
        );
      } else {
        // Type name ONLY on the wire. A customer eval's error text can quote
        // the transcript it was reading, and this field is persisted and shown
        // in the dashboard. But log the FULL error LOCALLY: this runs on the
        // customer's own pod over their own data, and without it an author
        // whose eval throws sees only "evaluation raised TypeError" in the
        // dashboard and nothing at all in their logs.
        logException(
          `evaluation ${JSON.stringify(definition.evalKey)} threw; reported to the server as a failed run`,
          error,
        );
        status = TerminalRunStatus.FAILED;
        errorCode = "eval_error";
        errorMessage = `evaluation raised ${error instanceof Error ? error.name : typeof error}`;
      }
    }

    await this.call(() =>
      this.client.submitResult(runId, {
        submissionId: randomUUID(),
        workerId: this.config.workerId,
        leaseGeneration: assignment.leaseGeneration,
        status,
        startedAt,
        finishedAt: utcNow(),
        durationMs: Math.max(0, Math.round(Date.now() - started)),
        summary,
        results: items,
        errorCode,
        errorMessage,
      }),
    );
    this.increment(`runs_${status}`);
  }

  private async cancelHook(definition: EvalDefinition, session: SessionTranscript): Promise<void> {
    if (definition.onCancel === null) return;
    try {
      await definition.onCancel(session);
    } catch (error) {
      logger.warn(
        `evaluator cancellation hook failed (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  }

  private heartbeat(
    assignment: Assignment,
    states: Map<string, { done: boolean; cancelled: boolean }>,
  ): { cancel: () => void; finished: Promise<void> } {
    let cancelled = false;
    const finished = (async () => {
      // Beat IMMEDIATELY, before the first sleep. The pre-plan condition phase
      // may have consumed most of the claim-time lease, and the server only
      // renews a planned assignment's lease on heartbeat — so sleeping a full
      // interval here can let the lease expire after the runs have started,
      // cancelling every one of them.
      let first = true;
      while (!cancelled) {
        if (!first) await sleep(this.heartbeatInterval * 1000);
        if (cancelled) return;
        first = false;
        const active = [...states.entries()]
          .filter(([, state]) => !state.done)
          .map(([runId]) => ({ evaluationRunId: runId, state: "running" }));
        if (active.length === 0) return;
        try {
          const response = await this.call(() =>
            this.client.heartbeat({
              workerId: this.config.workerId,
              leaseGeneration: assignment.leaseGeneration,
              runs: active,
            }),
          );
          const accepted = new Set(response.acceptedRunIds);
          for (const [runId, state] of states) {
            if (!state.done && !accepted.has(runId)) state.cancelled = true;
          }
        } catch (error) {
          if (error instanceof EvaluatorAPIError && error.code === "lease_lost") {
            this.increment("leases_lost");
            for (const state of states.values()) state.cancelled = true;
            return;
          }
          logger.warn(
            `evaluator heartbeat failed (assignment=${assignment.assignmentId}, ` +
              `${error instanceof EvaluatorAPIError ? `code=${error.code}` : `error=${error instanceof Error ? error.name : typeof error}`})`,
          );
          this.increment("heartbeat_failures");
        }
      }
    })();
    return {
      cancel: () => {
        cancelled = true;
      },
      finished,
    };
  }

  /**
   * The clock reading by which the pre-plan condition phase must end.
   *
   * The real `leaseExpiresAt` is used when it is in the future (production); a
   * past or unparseable value (clock skew, or a replayed transcript in a test)
   * falls back to the negotiated lease duration measured from now, so the bound
   * never fires spuriously on a stale deadline.
   */
  private conditionPhaseDeadline(assignment: Assignment): number {
    let remaining = this.leaseDuration;
    const expires = Date.parse(assignment.leaseExpiresAt);
    if (Number.isFinite(expires)) {
      const parsed = (expires - Date.now()) / 1000;
      if (parsed > 0) remaining = parsed;
    }
    return Date.now() + remaining * 1000;
  }

  /**
   * Seconds a single condition may run: the lease left before the
   * plan-submission margin, capped by the definition's own timeout.
   */
  private conditionBudget(deadline: number, timeoutSeconds: number | null): number {
    let remaining = (deadline - Date.now()) / 1000 - CONDITION_PHASE_SAFETY_MARGIN_SECONDS;
    if (timeoutSeconds !== null) remaining = Math.min(remaining, timeoutSeconds);
    return remaining;
  }

  private async assignmentDefinitions(assignment: Assignment): Promise<AssignmentDefinition[]> {
    if (assignment.definitionsUrl) {
      const response = await this.call(() =>
        this.client.definitions(assignment, this.config.workerId),
      );
      if (response.assignmentId !== assignment.assignmentId) {
        throw new Error("server returned definitions for another assignment");
      }
      return [...response.definitions];
    }
    return this.evaluator.definitions.map((item) => ({
      evalKey: item.evalKey,
      displayName: item.displayName,
      evalVersion: item.evalVersion,
      resultKind: item.resultKind,
      labels: item.labels,
      executionMode: ExecutionMode.LOCAL,
      conditionSource: null,
      sourceChecksum: null,
      timeoutSeconds: item.timeoutSeconds,
    }));
  }

  private progressWaiters: Array<() => void> = [];

  private notifyProgress(): void {
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private async waitForProgress(): Promise<void> {
    if (this.activeAssignments.size === 0) return;
    await new Promise<void>((resolve) => {
      this.progressWaiters.push(resolve);
      this.stopWaiters.push(resolve);
    });
  }

  private async waitOrStop(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.stopWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    this.lastServerContact = Date.now();
    return result;
  }

  private increment(name: string, amount = 1): void {
    this.metricCounts.set(name, (this.metricCounts.get(name) ?? 0) + amount);
  }

  metrics(): Record<string, number> {
    return Object.fromEntries(this.metricCounts);
  }

  isReady(): boolean {
    if (this.stopping || !this.registered || this.lastServerContact === null) return false;
    return (Date.now() - this.lastServerContact) / 1000 <= Math.max(this.leaseDuration, 60);
  }
}

class EvaluationCancelled extends Error {
  constructor() {
    super("evaluation cancelled");
    this.name = "EvaluationCancelled";
  }
}

function skippedOf(definition: AssignmentDefinition, reasonCode: string): SkippedEval {
  return { evalKey: definition.evalKey, evalVersion: definition.evalVersion, reasonCode };
}

function validatedAssignments(
  assignments: readonly Assignment[],
  capacity: number,
): Assignment[] {
  if (assignments.length > capacity) {
    throw new Error("server returned more assignments than requested");
  }
  const ids = assignments.map((item) => item.assignmentId);
  if (new Set(ids).size !== ids.length) throw new Error("server returned duplicate assignments");
  return [...assignments];
}

/** Cut to `maximum` BYTES without splitting a multi-byte character. */
function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximum) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maximum)).replace(
    /�$/,
    "",
  );
}
