import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUN_FORMATS,
  DENO_FORMATS,
  FIXTURES,
  FORMATS,
  count,
  describeTrace,
  runAgentAsync,
  runProcess,
  runtimeCommand,
  traceViolations,
  type Event,
} from "./harness.js";

/**
 * The SDK with no framework, under every runtime it can be imported in with a
 * filesystem — Node, Bun, Deno — as an ES module and as CommonJS; and the
 * short-lived-handler shapes (AWS Lambda, Cloud Functions, a queue worker)
 * whose last events are the ones most easily lost.
 *
 * Agent: `fixtures/runtimes/agent.ts`.
 */

const ALL = [...FORMATS, ...BUN_FORMATS, ...DENO_FORMATS];

/** All 15 event types, each exactly as often as `core()` emits it. */
const CORE_COUNTS: Record<string, number> = {
  agent_start: 2,
  agent_end: 2,
  model_request: 2,
  model_response: 2,
  tool_use: 2,
  tool_result: 2,
  hook_triggered: 1,
  hook_completed: 1,
  agent_pause: 1,
  agent_resume: 1,
  human_wait: 1,
  human_input: 1,
  human_pause: 1,
  human_interrupt: 1,
  error: 1,
};

const shape = (events: Event[]) => events.map((e) => `${e.agent_id} ${e.type}`);

/**
 * `traceViolations`, less the one rule this program breaks by design: a
 * hand-emitted `model_response` carries no `duration_ms` (the SDK measures only
 * the pairs it can see open — tools, hooks, pauses, human input — exactly like
 * the Python SDK). The adapters are what supply model timings.
 */
const violations = (events: Event[]) =>
  traceViolations(events).filter((problem) => !problem.endsWith("has no duration_ms"));

/** One handler invocation's trace: one agent, one model call. */
const INVOCATION = ["lambda-agent agent_start", "lambda-agent model_request", "lambda-agent model_response", "lambda-agent agent_end"];

describe.each(ALL)("as %s", (format) => {
  const run = (scenario: string) => runAgentAsync("runtimes", format, scenario);

  it("records every scope and all 15 event methods, and flush() writes them", async () => {
    const result = await run("core");
    expect(result.status, describeTrace(result)).toBe(0);
    expect(violations(result.events), describeTrace(result)).toEqual([]);
    const counts = Object.fromEntries(Object.keys(CORE_COUNTS).map((type) => [type, count(result.events, type)]));
    expect(counts, describeTrace(result)).toEqual(CORE_COUNTS);
    expect(result.events).toHaveLength(21);
    for (const event of result.events) expect(event.session_id).toBe("core-session");
    const helper = result.events.find((e) => e.type === "agent_start" && e.agent_id === "helper")!;
    expect(helper.parent_id).toBe("planner");
    expect(result.stderr, describeTrace(result)).not.toContain("[failproofai-sdk]");
  });

  describe("a short-lived handler", () => {
    it("await flush() before returning puts every event on disk, even if the sandbox is killed next", async () => {
      const result = await run("lambda-flush");
      expect(result.status, describeTrace(result)).not.toBe(0); // SIGKILLed on purpose
      expect(shape(result.events), describeTrace(result)).toEqual(INVOCATION);
      expect(violations(result.events)).toEqual([]);
    });

    it("without flush(), a sandbox frozen or reclaimed after the return loses the whole invocation", async () => {
      // Documenting, not endorsing: the interval (500 ms) never gets to run and
      // there is no `exit` for the listener to hear. The README must say so.
      const result = await run("lambda-no-flush");
      expect(result.stdout).toContain('"ok":true');
      expect(result.events, describeTrace(result)).toEqual([]);
    });

    it("without flush(), SIGTERM with no handler installed loses it too", async () => {
      const result = await run("lambda-sigterm");
      expect(result.stdout).toContain('"ok":true');
      expect(result.events, describeTrace(result)).toEqual([]);
    });

    it("without flush(), a process that ends normally is still covered by the exit flush", async () => {
      const result = await run("lambda-return");
      expect(result.status, describeTrace(result)).toBe(0);
      expect(shape(result.events), describeTrace(result)).toEqual(INVOCATION);
    });

    it("a warm container flushing per invocation keeps every invocation", async () => {
      const result = await run("lambda-warm");
      expect(shape(result.events), describeTrace(result)).toEqual([...INVOCATION, ...INVOCATION, ...INVOCATION]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["lambda-1", "lambda-2", "lambda-3"]));
      expect(violations(result.events)).toEqual([]);
    });
  });
});

describe("Deno with npm: specifiers", () => {
  const GEN = [
    "weather-agent agent_start",
    "weather-agent model_request",
    "weather-agent model_response",
    "weather-agent tool_use",
    "weather-agent tool_result",
    "weather-agent model_request",
    "weather-agent model_response",
    "weather-agent agent_end",
  ];
  const run = (scenario: string) =>
    runProcess([...runtimeCommand("deno"), "deno-npm.ts", scenario], {
      cwd: join(FIXTURES, "runtimes"),
      label: "deno-npm",
    });

  // wrapModel() sees model calls only — the tools run outside the model — so
  // its trace is GEN without the tool pair, exactly as `ai.test.ts` expects.
  const WRAPPED = GEN.filter((line) => !line.includes(" tool_"));

  it.each([
    ["telemetry", GEN],
    ["wrap", WRAPPED],
  ])("records an ai tool loop through %s()", async (scenario, expected) => {
    const result = await run(scenario);
    expect(result.status, describeTrace(result)).toBe(0);
    expect(result.stdout).toContain("It is 20C in Paris.");
    expect(shape(result.events), describeTrace(result)).toEqual(expected);
    expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    expect(
      result.events.filter((e) => e.type === "model_response").map((e) => [e.input_tokens, e.output_tokens]),
    ).toEqual([
      [11, 7],
      [23, 9],
    ]);
    expect(result.stderr, describeTrace(result)).not.toContain("[failproofai-sdk]");
  });
});
