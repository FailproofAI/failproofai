import { describe, expect, it } from "vitest";

import {
  EvaluationBudgetExceeded,
  MAX_POW_EXPONENT,
  UnsafeEvaluatorSource,
  compileExpression,
} from "../src/evaluator/expression.js";
import { sessionTranscriptFromWire } from "../src/evaluator/protocol.js";
import { transcriptWire } from "./helpers.js";

/**
 * The language is the correctness boundary for server-authored source — the
 * `worker_threads` sandbox around it bounds RESOURCES, not reach. So the cases
 * that matter most here are the ones that must be refused, and every one of
 * them is a real escape in a naive `eval`- or `vm`-based design.
 */

const session = sessionTranscriptFromWire(
  transcriptWire([
    { type: "tool_use", payload: { tool_name: "search" } },
    { type: "tool_result", payload: { error: "timeout" } },
    { type: "tool_result", payload: { output: "ok" } },
  ]),
);

const GLOBALS = ["session", "Math", "Object", "Array", "Number", "JSON"] as const;

function run(source: string): unknown {
  const compiled = compileExpression(source, {
    fieldName: "evaluator_source",
    maximumBytes: 128 * 1024,
    globalNames: GLOBALS,
  });
  return compiled({ session });
}

function compileOnly(source: string): void {
  compileExpression(source, {
    fieldName: "evaluator_source",
    maximumBytes: 128 * 1024,
    globalNames: GLOBALS,
  });
}

describe("what the language can express", () => {
  it("reads the transcript surface", () => {
    expect(run("session.eventCount")).toBe(3);
    expect(run("session.count('tool_result')")).toBe(2);
    expect(run("session.eventsOfType('tool_use').length")).toBe(1);
    expect(run("session.agentId")).toBe("main");
  });

  it("reads arbitrary payload keys, which no static allowlist could enumerate", () => {
    expect(run("session.eventsOfType('tool_result')[0].payload.error")).toBe("timeout");
    expect(run("session.eventsOfType('tool_result')[1].payload['output']")).toBe("ok");
  });

  it("supports `!= null`, the idiom for an optional payload field", () => {
    // Mapping `!=` to `!==` would silently stop this matching a missing key,
    // so an evaluation over a payload that omits the field would report the
    // opposite of the truth.
    expect(
      run("session.eventsOfType('tool_result').filter(e => e.payload.error != null).length"),
    ).toBe(1);
    expect(run("session.eventsOfType('tool_result')[1].payload.error == null")).toBe(true);
  });

  it("supports arrow functions, arithmetic, comparison and the conditional operator", () => {
    expect(run("[1, 2, 3].map(x => x * 2).filter(x => x > 2)")).toEqual([4, 6]);
    expect(run("session.eventCount > 0 ? 'busy' : 'idle'")).toBe("busy");
    expect(run("Math.round(1 / 3 * 100) / 100")).toBe(0.33);
    expect(run("[1, 2, 3].reduce((a, b) => a + b, 0)")).toBe(6);
  });

  it("supports template strings and object literals", () => {
    expect(run("`saw ${session.eventCount} events`")).toBe("saw 3 events");
    expect(run("({ total: session.eventCount, ok: true })")).toEqual({ total: 3, ok: true });
  });

  it("supports the namespace globals it advertises", () => {
    expect(run("Object.keys({ a: 1, b: 2 })")).toEqual(["a", "b"]);
    expect(run("Array.isArray(session.events)")).toBe(true);
    expect(run("Number.isInteger(session.eventCount)")).toBe(true);
    expect(run("JSON.stringify({ a: 1 })")).toBe('{"a":1}');
  });
});

describe("escapes that must be refused", () => {
  const rejected: Array<[string, string]> = [
    ["a function constructor", "(x => x).constructor"],
    ["a literal computed constructor", "session['constructor']"],
    ["prototype", "session.prototype"],
    ["__proto__", "session.__proto__"],
    ["call", "session.count.call"],
    ["bind", "session.count.bind"],
    ["toString, which runs arbitrary code", "session.toString"],
    ["a reference to process", "process.env"],
    ["a reference to globalThis", "globalThis"],
    ["require", "require('fs')"],
    ["import", "import('fs')"],
    ["new", "new Object()"],
    ["a function expression", "function () { return 1 }"],
    ["assignment", "session.eventCount = 5"],
    ["a statement", "if (true) 1"],
    ["a block-bodied arrow", "(x) => { return x }"],
    ["an unbound identifier", "somethingElse"],
    ["a private name", "_secret"],
    ["a regular expression literal", "/abc/.test('abc')"],
    ["a comment, which the grammar does not accept", "1 // trailing"],
    ["a compile-time exponent bomb", "10 ** 99"],
    ["a generator", "function* () { yield 1 }"],
    ["a BigInt literal", "1n"],
    ["optional chaining onto a forbidden key", "session?.constructor"],
  ];

  for (const [label, source] of rejected) {
    it(`refuses ${label}`, () => {
      expect(() => compileOnly(source)).toThrow(UnsafeEvaluatorSource);
    });
  }

  it("refuses a bare method reference, which is only useful for smuggling one out", () => {
    expect(() => compileOnly("session.count")).toThrow(/only to call it/);
    expect(() => compileOnly("[].map")).toThrow(/only to call it/);
  });

  it("names the exponent ceiling in the message", () => {
    expect(() => compileOnly("2 ** 100")).toThrow(
      new RegExp(`integer constant in 0\\.\\.${MAX_POW_EXPONENT}`),
    );
  });

  it("refuses a RUNTIME-computed forbidden key, which no source check can see", () => {
    // This is why the boundary is `readProperty` and not the parser.
    expect(() => run("session[['con','structor'].join('')]")).toThrow(UnsafeEvaluatorSource);
    expect(() => run("session['con' + 'structor']")).toThrow(UnsafeEvaluatorSource);
  });

  it("refuses a non-allowlisted method on a built-in prototype", () => {
    expect(() => run("[1, 2].sort()")).toThrow(UnsafeEvaluatorSource);
    expect(() => run("'abc'.matchAll('a')")).toThrow(UnsafeEvaluatorSource);
  });

  it("refuses a namespace member outside its set", () => {
    expect(() => run("Object.getPrototypeOf({})")).toThrow(UnsafeEvaluatorSource);
    expect(() => run("Math.random()")).toThrow(UnsafeEvaluatorSource);
  });

  it("does not walk a prototype for a plain object's missing key", () => {
    expect(run("({}).somethingAbsent")).toBeUndefined();
  });
});

describe("budgets", () => {
  it("bounds unbounded self-application", () => {
    // `(f => f(f))(f => f(f))` is reachable with nothing but arrow functions,
    // and runs forever.
    expect(() => run("(f => f(f))(f => f(f))")).toThrow(EvaluationBudgetExceeded);
  });

  it("bounds a string bomb", () => {
    expect(() => run("'x'.repeat(64) .repeat(64) .repeat(64) .repeat(64)")).toThrow(
      EvaluationBudgetExceeded,
    );
  });

  it("refuses source above the byte ceiling", () => {
    expect(() =>
      compileExpression(`'${"x".repeat(200)}'`, {
        fieldName: "evaluator_source",
        maximumBytes: 100,
        globalNames: GLOBALS,
      }),
    ).toThrow(/exceeds 100 bytes/);
  });

  it("refuses empty source", () => {
    expect(() => compileOnly("   ")).toThrow(/must not be empty/);
  });
});
