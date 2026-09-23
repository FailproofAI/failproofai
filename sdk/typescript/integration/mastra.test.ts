import { describe, expect, it } from "vitest";

import {
  FORMATS,
  count,
  describeTrace,
  ofType,
  runAgent,
  traceViolations,
  typecheck,
  type Event,
} from "./harness.js";

/**
 * Mastra (`@mastra/core`), against real releases.
 *
 * Mastra has no Python counterpart, so the expected traces are derived from the
 * rule every adapter follows (`sdk/python/skill/references/frameworks.md`, "The
 * rule the mappings follow"), using CrewAI and LlamaIndex as the analogues:
 *
 *   * an `Agent.generate()` / `.stream()` call owns an LLM decision loop, so it
 *     is an AGENT, named after the Mastra agent — never its id if that is a
 *     UUID, never a constant;
 *   * a Mastra agent another agent calls (Mastra's `agents: {…}` delegation) is
 *     a nested agent under the caller, reached through the caller's tool call;
 *   * every LLM step is its own `model_request`/`model_response` pair — a
 *     two-step tool loop is two pairs, not one — carrying the model id, integer
 *     tokens and a string stop reason;
 *   * a tool is a `tool_use`/`tool_result` pair carrying the MODEL's tool call
 *     id, attributed to the agent that called it;
 *   * a workflow run is an agent named after the workflow, and its steps are
 *     HOOKS (`trigger_event="workflow_step"`), exactly as LlamaIndex workflow
 *     steps are;
 *   * Mastra's own machinery — the agentic loop is itself built from internal
 *     workflows — emits nothing;
 *   * a failure is carried by the events it happened in: no `error` events.
 */

const FIXTURES = ["mastra-1", "mastra-0"] as const;

/** One line per event: `agent_id type [hook|tool]`. */
const shape = (events: Event[]): string[] =>
  events.map((e) =>
    [e.agent_id, e.type, (e.hook_name ?? e.tool_name ?? "") as string].join(" ").trim(),
  );

const loop = (agent: string): string[] => [
  `${agent} agent_start`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} tool_use weather`,
  `${agent} tool_result weather`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} agent_end`,
];

const LOOP = loop("weather-agent");

describe.each(FIXTURES)("%s", (fixture) => {
  it("typechecks as a customer's nodenext ES-module project", () => {
    expect(typecheck(fixture)).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string) => {
      const result = runAgent(fixture, format, scenario);
      expect(result.status, describeTrace(result)).toBe(0);
      return result;
    };

    it("records generate() as one agent with one model pair per LLM step", () => {
      const result = run("generate");
      expect(shape(result.events), describeTrace(result)).toEqual(LOOP);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);

      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [11, 7],
        [23, 9],
      ]);
      expect(responses.map((e) => e.stop_reason)).toEqual(["tool-calls", "stop"]);
      for (const event of [...ofType(result.events, "model_request"), ...responses]) {
        expect(event.model).toBe("scripted-model");
      }
      expect(responses[1]!.content).toBe("It is sunny in Paris.");
      const request = ofType(result.events, "model_request")[0]!;
      expect(JSON.stringify(request.messages)).toContain("What is the weather in Paris?");

      // The model's own tool call id, so a tool_use joins to the tool call in
      // the model_response that asked for it.
      const use = ofType(result.events, "tool_use")[0]!;
      expect(use.tool_call_id).toBe("call_1");
      expect(use.input).toEqual({ city: "Paris" });
      const toolResult = ofType(result.events, "tool_result")[0]!;
      expect(toolResult.tool_call_id).toBe("call_1");
      expect(toolResult.output).toEqual({ city: "Paris", forecast: "sunny" });
      expect(typeof toolResult.duration_ms).toBe("number");

      const end = ofType(result.events, "agent_end")[0]!;
      expect(end.outcome).toBe("success");
      expect(typeof end.duration_ms).toBe("number");
      for (const event of result.events) {
        expect(event.framework).toBe("mastra");
        expect(typeof event.framework_version).toBe("string");
      }
      expect(result.stdout).toContain("It is sunny in Paris.");
    });

    it("records a fully consumed stream() exactly like generate()", () => {
      const result = run("stream");
      expect(shape(result.events), describeTrace(result)).toEqual(LOOP);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [11, 7],
        [23, 9],
      ]);
      expect(responses.map((e) => e.stop_reason)).toEqual(["tool-calls", "stop"]);
      expect(responses[1]!.content).toBe("It is sunny in Paris.");
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(result.stdout).toContain("It is sunny in Paris.");
    });

    it("nests a sub-agent under the agent whose tool call delegated to it", () => {
      const result = run("subagent");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "boss agent_start",
        "boss model_request",
        "boss model_response",
        "boss tool_use agent-helper",
        ...loop("helper"),
        "boss tool_result agent-helper",
        "boss model_request",
        "boss model_response",
        "boss agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
      const starts = ofType(result.events, "agent_start");
      expect(starts[0]!.parent_id).toBeUndefined();
      expect(starts[1]!.parent_id).toBe("boss");
      expect(
        ofType(result.events, "model_response")
          .filter((e) => e.agent_id === "boss")
          .map((e) => [e.input_tokens, e.output_tokens]),
      ).toEqual([
        [40, 12],
        [60, 8],
      ]);
    });

    it("records a workflow run as one agent with its steps as hooks", () => {
      const result = run("workflow");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-flow agent_start",
        "weather-flow hook_triggered fetch-city",
        "weather-flow hook_completed fetch-city",
        "weather-flow hook_triggered ask-agent",
        ...LOOP,
        "weather-flow hook_completed ask-agent",
        "weather-flow agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
      for (const hook of ofType(result.events, "hook_triggered")) {
        expect(hook.trigger_event).toBe("workflow_step");
      }
      for (const hook of ofType(result.events, "hook_completed")) {
        expect(hook.outcome).toBe("success");
      }
      // The agent a step calls is nested under the workflow, and the tool that
      // agent calls is ITS tool, not the workflow's.
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("weather-flow");
      expect(ofType(result.events, "tool_use")[0]!.agent_id).toBe("weather-agent");
      expect(ofType(result.events, "agent_end").at(-1)!.outcome).toBe("success");
      expect(result.stdout).toContain('"status":"success"');
    });

    it("records a failed workflow step once, on the step", () => {
      const result = run("workflow-error");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-flow agent_start",
        "weather-flow hook_triggered fetch-city",
        "weather-flow hook_completed fetch-city",
        "weather-flow hook_triggered ask-agent",
        "weather-flow hook_completed ask-agent",
        "weather-flow agent_end",
      ]);
      const failed = ofType(result.events, "hook_completed")[1]!;
      expect(failed.outcome).toBe("failed");
      expect(String(failed.error)).toMatch(/step exploded/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(count(result.events, "error")).toBe(0);
    });

    it("records a bare wrapTool() call as its own run", () => {
      const result = run("wraptool");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather agent_start",
        "weather tool_use weather",
        "weather tool_result weather",
        "weather agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(ofType(result.events, "tool_use")[0]!.input).toEqual({ city: "Rome" });
      expect(ofType(result.events, "tool_result")[0]!.output).toEqual({ city: "Rome", forecast: "sunny" });
    });

    it("records a tool failure on the tool, and the agent carries on", () => {
      const result = run("tool-error");
      expect(shape(result.events), describeTrace(result)).toEqual(LOOP);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(String(ofType(result.events, "tool_result")[0]!.error)).toMatch(/tool exploded/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(count(result.events, "error")).toBe(0);
    });

    for (const scenario of ["model-error", "stream-model-error"]) {
      it(`records a model failure once, where it happened (${scenario})`, () => {
        const result = run(scenario);
        expect(result.stdout).toContain("model exploded");
        // Once per provider call. Mastra 0.x retries a failed model call
        // itself (`maxRetries: 2` by default); each retry is a real request —
        // it costs latency and, against a real provider, tokens — so each is
        // its own pair, each carrying the error. 1.x does not retry.
        const attempts = fixture === "mastra-0" ? 3 : 1;
        expect(shape(result.events), describeTrace(result)).toEqual([
          "weather-agent agent_start",
          ...Array.from({ length: attempts }, () => [
            "weather-agent model_request",
            "weather-agent model_response",
          ]).flat(),
          "weather-agent agent_end",
        ]);
        expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
        for (const response of ofType(result.events, "model_response")) {
          expect(String(response.error)).toMatch(/model exploded/);
        }
        expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
        expect(count(result.events, "error")).toBe(0);
      });
    }

    it("nests the agent under an enclosing agent() scope", () => {
      const result = run("scope");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        ...LOOP,
        "planner agent_end",
      ]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("planner");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records nothing after uninstrument()", () => {
      const result = run("uninstrument");
      expect(result.events, describeTrace(result)).toEqual([]);
      expect(result.stdout).toContain('"removed":["mastra"]');
    });

    // uninstrument() does not reach what an instrumented run already built —
    // a model behind a proxy, tools behind wrappers, a stream the caller is
    // still reading — so each of these runs inside a session scope, where a
    // stray event would have somewhere to land instead of being dropped.

    it("stops a stream in flight at uninstrument(), closing its agent cancelled", () => {
      const result = run("uninstrument-midstream");
      expect(result.stdout).toContain('"removed":["mastra"]');
      // The stream is the caller's: it runs to the end, tool call and all.
      expect(result.stdout).toContain("It is sunny in Paris.");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.stop_reason).toBe("cancelled");
      expect(response.fw_incomplete).toBe(true);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
    });

    it("records nothing from an Agent reused after uninstrument()", () => {
      const result = run("uninstrument-reuse");
      expect(result.stdout).toContain('"answers":["It is sunny in Paris.","It is sunny in Paris."]');
      expect(shape(result.events), describeTrace(result)).toEqual(LOOP);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a run once after instrument() → uninstrument() → instrument()", () => {
      const result = run("reinstrument");
      expect(result.stdout).toContain('"removed":["mastra"]');
      expect(shape(result.events), describeTrace(result)).toEqual(LOOP);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records an Agent reused across uninstrument() → instrument() once per run", () => {
      const result = run("reinstrument-reuse");
      expect(shape(result.events), describeTrace(result)).toEqual([...LOOP, ...LOOP]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const sessions = result.events.map((e) => e.session_id);
      expect(new Set(sessions.slice(0, LOOP.length)).size).toBe(1);
      expect(new Set(sessions.slice(LOOP.length)).size).toBe(1);
    });
  });
});
