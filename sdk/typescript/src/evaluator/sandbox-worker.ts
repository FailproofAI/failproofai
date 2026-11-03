/**
 * The sandbox worker entry: evaluates ONE piece of server-authored source and
 * posts the result back.
 *
 * Started by `source.ts` as a fresh `worker_threads` Worker per evaluation,
 * with V8 heap limits, an empty environment and a wall-clock `terminate()`
 * above it. Nothing here is trusted to enforce those — a worker cannot bound
 * itself, which is exactly why the bound lives in the parent.
 *
 * What this file IS responsible for:
 *
 * * **Re-validating the source.** The parent already parsed it. Parsing it
 *   again here means a worker can never evaluate source the parent has not
 *   vetted, whatever reaches `workerData`.
 * * **Bounding the result before it crosses back.** A permitted expression can
 *   build a result far larger than any real evaluation; measuring it here means
 *   the parent never has to hold it to find that out.
 * * **Reporting failures as data, not as a crash.** An evaluation that throws
 *   is an ordinary outcome — a failed run — and has to arrive as one, with the
 *   original error's name preserved so the parent can rebuild its semantics.
 */

import { parentPort, workerData } from "node:worker_threads";

import { Assertion, ConditionResult, EvalResult, Metric, Score } from "./authoring.js";
import {
  MAX_CONDITION_SOURCE_BYTES,
  MAX_EVALUATOR_SOURCE_BYTES,
  SANDBOX_GLOBAL_NAMES,
} from "./source-limits.js";
import { compileExpression } from "./expression.js";
import { sessionTranscriptFromWire } from "./protocol.js";
import type { WireObject } from "./protocol.js";

interface SandboxRequest {
  kind: "condition" | "evaluator";
  source: string;
  session: WireObject;
  evalKey: string | null;
  maxResultBytes: number;
}

type SandboxOutcome =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string };

/**
 * The constructors the language exposes, as plain functions.
 *
 * Callable WITHOUT `new`, so an expression reads the way the Python SDK's does
 * (`EvalResult(score=Score(0.9))` there, `EvalResult({score: Score(0.9)})`
 * here). The interpreter has no `new` in its grammar at all, so a class would
 * simply be uncallable.
 */
function sandboxGlobals(session: unknown): Record<string, unknown> {
  return {
    session,
    EvalResult: (options?: ConstructorParameters<typeof EvalResult>[0]) => new EvalResult(options),
    Score: (value: number, options?: ConstructorParameters<typeof Score>[1]) =>
      new Score(value, options),
    Metric: (value: number, options?: ConstructorParameters<typeof Metric>[1]) =>
      new Metric(value, options),
    Assertion: (passed: boolean, options?: ConstructorParameters<typeof Assertion>[1]) =>
      new Assertion(passed, options),
    ConditionResult: (applicable: boolean, reasonCode?: string) =>
      new ConditionResult(applicable, reasonCode),
  };
}

function serializeEvalResult(result: EvalResult): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  for (const [key, metric] of Object.entries(result.metrics)) {
    metrics[key] =
      metric instanceof Metric
        ? {
            value: metric.value,
            unit: metric.unit,
            displayValue: metric.displayValue,
            description: metric.description,
          }
        : metric;
  }
  const assertions: Record<string, unknown> = {};
  for (const [key, assertion] of Object.entries(result.assertions)) {
    assertions[key] =
      assertion instanceof Assertion
        ? { passed: assertion.passed, description: assertion.description }
        : assertion;
  }
  return {
    score:
      result.score === undefined
        ? undefined
        : {
            value: result.score.value,
            passed: result.score.passed,
            unit: result.score.unit,
            displayValue: result.score.displayValue,
            description: result.score.description,
          },
    metrics,
    assertions,
    reasoning: result.reasoning,
    summary: result.summary,
    labels: [...result.labels],
  };
}

function run(request: SandboxRequest): unknown {
  const isCondition = request.kind === "condition";
  const compiled = compileExpression(request.source, {
    fieldName: isCondition ? "condition_source" : "evaluator_source",
    maximumBytes: isCondition ? MAX_CONDITION_SOURCE_BYTES : MAX_EVALUATOR_SOURCE_BYTES,
    globalNames: SANDBOX_GLOBAL_NAMES,
  });

  const session = sessionTranscriptFromWire(request.session);
  const value = compiled(sandboxGlobals(session));

  if (isCondition) {
    if (typeof value === "boolean") return value;
    if (value instanceof ConditionResult) {
      return { applicable: value.applicable, reasonCode: value.reasonCode };
    }
    throw new TypeError("condition_source must return a boolean or a ConditionResult");
  }

  if (!(value instanceof EvalResult)) {
    throw new TypeError("evaluator_source must return an EvalResult");
  }
  // Validate the item count HERE, where the result is still cheap to discard.
  // The parent would reject it too, but only after paying to receive it.
  if (request.evalKey !== null) value.resultItems(request.evalKey);
  return serializeEvalResult(value);
}

function main(): void {
  const port = parentPort;
  if (port === null) {
    // Started as a main module rather than as a worker. There is nothing to
    // report to and nothing to evaluate; exiting quietly is the only sensible
    // behaviour, and a non-zero code says it was not a normal run.
    process.exitCode = 2;
    return;
  }
  const request = workerData as SandboxRequest;

  let outcome: SandboxOutcome;
  try {
    const value = run(request);
    const encoded = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    if (encoded > request.maxResultBytes) {
      outcome = {
        ok: false,
        name: "EvaluationBudgetExceeded",
        message: `evaluation result is ${encoded} bytes; the limit is ${request.maxResultBytes}`,
      };
    } else {
      outcome = { ok: true, value };
    }
  } catch (error) {
    outcome =
      error instanceof Error
        ? { ok: false, name: error.name || "Error", message: error.message }
        : { ok: false, name: "Error", message: String(error) };
  }

  port.postMessage(outcome);
}

main();
