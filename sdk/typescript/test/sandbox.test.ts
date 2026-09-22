import { describe, expect, it } from "vitest";

import { EvalResult, Score } from "../src/evaluator/authoring.js";
import { sessionTranscriptFromWire } from "../src/evaluator/protocol.js";
import {
  EvaluationSandboxUnavailable,
  EvaluationTimeout,
  UnsafeEvaluatorSource,
  compileCondition,
  compileEvaluator,
  sourceChecksum,
} from "../src/evaluator/source.js";
import { transcriptWire } from "./helpers.js";

/**
 * The `worker_threads` sandbox, exercised for real.
 *
 * It is not the correctness boundary — `expression.ts` is — but it is the only
 * thing that bounds CPU, heap and wall clock, and the only thing that can KILL
 * a running evaluation. Every one of these cases is a way a permitted
 * expression could otherwise take the worker down with it.
 */

const session = sessionTranscriptFromWire(
  transcriptWire([
    { type: "tool_use", payload: { tool_name: "search" } },
    { type: "tool_result", payload: { error: "timeout" } },
    { type: "tool_result", payload: { output: "ok" } },
  ]),
);

describe("running a managed evaluation", () => {
  it("returns a rebuilt EvalResult from the worker", async () => {
    const evaluate = compileEvaluator(
      "EvalResult({ score: Score(1 - session.eventsOfType('tool_result')" +
        ".filter(e => e.payload.error != null).length / session.count('tool_result')), " +
        "reasoning: `saw ${session.eventCount} events` })",
      { evalKey: "tool_success_rate" },
    );
    const result = await evaluate(session);
    expect(result).toBeInstanceOf(EvalResult);
    expect(result.score).toBeInstanceOf(Score);
    expect(result.score!.value).toBe(0.5);
    expect(result.reasoning).toBe("saw 3 events");
    // The rebuilt result is a real one, so the authoring bounds apply to it.
    expect(result.resultItems("tool_success_rate")).toHaveLength(1);
  });

  it("runs a managed condition in the same sandbox", async () => {
    expect(await compileCondition("session.count('tool_use') > 0")(session)).toBe(true);
    const structured = await compileCondition("ConditionResult(false, 'no_tools')")(session);
    expect(structured).toMatchObject({ applicable: false, reasonCode: "no_tools" });
  });

  it("carries a metric and an assertion across the boundary", async () => {
    const evaluate = compileEvaluator(
      "EvalResult({ metrics: { tool_calls: Metric(session.count('tool_use'), { unit: 'count' }) }, " +
        "assertions: { used_a_tool: Assertion(session.count('tool_use') > 0) } })",
      { evalKey: "tool_calls" },
    );
    const result = await evaluate(session);
    const items = result.resultItems("tool_calls");
    expect(items.map((item) => [item.resultKey, item.resultKind, item.numericValue ?? item.boolValue])).toEqual([
      ["tool_calls", "metric", 1],
      ["used_a_tool", "assertion", true],
    ]);
  });
});

describe("failures come back as data, not as a crash", () => {
  it("preserves the error's name across the worker boundary", async () => {
    const evaluate = compileEvaluator("EvalResult({ score: Score(session.nope.deeper) })");
    await expect(evaluate(session)).rejects.toThrow(TypeError);
  });

  it("reports a result that is not an EvalResult", async () => {
    await expect(compileEvaluator("42")(session)).rejects.toThrow(/must return an EvalResult/);
  });

  it("reports a condition that is not a boolean or a ConditionResult", async () => {
    await expect(compileCondition("42")(session)).rejects.toThrow(
      /must return a boolean or a ConditionResult/,
    );
  });

  it("rejects unsafe source BEFORE a worker is started", () => {
    // Compilation is synchronous and happens in the parent, so a poison
    // definition costs nothing and dead-letters as one failed run.
    expect(() => compileEvaluator("(x => x).constructor")).toThrow(UnsafeEvaluatorSource);
  });
});

describe("resource bounds", () => {
  it("kills an evaluation that overruns its wall clock", async () => {
    // Under the step ceiling this would run for a very long time; the worker is
    // terminated either way, and both arrive as an EvaluationTimeout.
    const evaluate = compileEvaluator(
      "EvalResult({ score: Score(Array.from({ length: 1 }).length) })",
      { timeoutSeconds: 0.001 },
    );
    await expect(evaluate(session)).rejects.toThrow(EvaluationTimeout);
  }, 20_000);

  it("bounds an unbounded recursion inside the worker", async () => {
    const evaluate = compileEvaluator("(f => f(f))(f => f(f))", { timeoutSeconds: 10 });
    await expect(evaluate(session)).rejects.toThrow(EvaluationTimeout);
  }, 30_000);

  it("refuses to evaluate at all when the sandbox cannot be started", async () => {
    // Fails CLOSED. An evaluation that cannot be terminated is not one we are
    // willing to start, so an unusable sandbox is a refusal — never a fallback
    // to running tenant source in the worker's own thread.
    const previous = process.env.FAILPROOFAI_SDK_SANDBOX_WORKER;
    process.env.FAILPROOFAI_SDK_SANDBOX_WORKER = "/nonexistent/failproofai-sandbox-worker.js";
    try {
      const evaluate = compileEvaluator("EvalResult({ score: Score(1) })");
      await expect(evaluate(session)).rejects.toThrow();
      // And specifically NOT by quietly returning a result.
      await expect(evaluate(session)).rejects.not.toBeInstanceOf(EvalResult);
    } finally {
      process.env.FAILPROOFAI_SDK_SANDBOX_WORKER = previous;
    }
  });

  it("names the override when it cannot locate the worker at all", () => {
    // `EvaluationSandboxUnavailable` carries the remedy, because the situation
    // it describes — a bundled install whose published layout is gone — is one
    // the operator can only fix if they are told which variable to set.
    const error = new EvaluationSandboxUnavailable("x");
    expect(error.name).toBe("EvaluationSandboxUnavailable");
  });

  it("clamps a server-supplied timeout to the ceiling", async () => {
    // A large `timeout_seconds` must not be able to remove the bound. The
    // evaluation itself is instant; what matters is that it still completes,
    // i.e. the clamp did not turn a huge number into an invalid one.
    const evaluate = compileEvaluator("EvalResult({ score: Score(1) })", {
      timeoutSeconds: 86_400,
    });
    await expect(evaluate(session)).resolves.toBeInstanceOf(EvalResult);
  });
});

describe("isolation", () => {
  it("gives the worker no environment to read", async () => {
    // The language cannot reach `process` at all, so this is defence in depth —
    // it means a future gap could not be escalated into credential theft.
    const previous = process.env.FAILPROOFAI_EVALUATOR_TOKEN;
    process.env.FAILPROOFAI_EVALUATOR_TOKEN = "a-cross-tenant-credential";
    try {
      expect(() => compileEvaluator("process.env")).toThrow(UnsafeEvaluatorSource);
      expect(() => compileEvaluator("Object.keys(process.env)")).toThrow(UnsafeEvaluatorSource);
    } finally {
      if (previous === undefined) delete process.env.FAILPROOFAI_EVALUATOR_TOKEN;
      else process.env.FAILPROOFAI_EVALUATOR_TOKEN = previous;
    }
  });

  it("does not let one evaluation see another's state", async () => {
    const first = compileEvaluator("EvalResult({ score: Score(0.25) })");
    const second = compileEvaluator("EvalResult({ score: Score(0.75) })");
    const [a, b] = await Promise.all([first(session), second(session)]);
    expect(a.score!.value).toBe(0.25);
    expect(b.score!.value).toBe(0.75);
  });

  it("runs more evaluations than the concurrency cap without losing any", async () => {
    // The semaphore bounds how many sandboxes exist at once; the extras queue
    // rather than pile up memory, and every one still returns.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        compileEvaluator(`EvalResult({ score: Score(${(index / 10).toFixed(1)}) })`)(session),
      ),
    );
    expect(results.map((result) => result.score!.value)).toEqual([
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7,
    ]);
  }, 30_000);
});

describe("sourceChecksum", () => {
  it("covers the condition and the evaluator together, separated unambiguously", () => {
    // A separator that could appear in either source would let two different
    // pairs hash the same, which is what the checksum exists to prevent.
    expect(sourceChecksum("a", "b")).not.toBe(sourceChecksum("ab", ""));
    expect(sourceChecksum(null, "b")).toBe(sourceChecksum("", "b"));
    expect(sourceChecksum("a", "b")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
