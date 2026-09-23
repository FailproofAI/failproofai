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
 * LangChain.js / LangGraph.js, against real releases.
 *
 * The expected traces are the Python SDK's, captured from its LangChain adapter
 * running the same graph with the same scripted model (langchain-core 1.6.3,
 * langgraph 1.2.11). The two SDKs write into one pipe and the dashboard cannot
 * tell which language wrote what — so for the same program they must draw the
 * same tree. In particular (`sdk/python/skill/references/frameworks.md`):
 *
 *   * the root run is the agent, named after the graph;
 *   * a LangGraph node is a HOOK (`hook_triggered`/`hook_completed`,
 *     `trigger_event="graph_node"`), never a nested agent;
 *   * `__start__`, routers, `RunnableSequence` steps and every other piece of
 *     machinery emit nothing;
 *   * a failure is carried by the events it happened in — no stack of `error`
 *     events, one per layer the exception unwound through.
 */

const FIXTURES = ["langchain-1"] as const;

/** One line per event: `agent_id type [hook|tool]`. */
const shape = (events: Event[]): string[] =>
  events.map((e) =>
    [e.agent_id, e.type, (e.hook_name ?? e.tool_name ?? "") as string].join(" ").trim(),
  );

const GRAPH = [
  "weather_graph agent_start",
  "weather_graph hook_triggered agent",
  "weather_graph model_request",
  "weather_graph model_response",
  "weather_graph hook_completed agent",
  "weather_graph hook_triggered tools",
  "weather_graph tool_use get_weather",
  "weather_graph tool_result get_weather",
  "weather_graph hook_completed tools",
  "weather_graph hook_triggered agent",
  "weather_graph model_request",
  "weather_graph model_response",
  "weather_graph hook_completed agent",
  "weather_graph agent_end",
];

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

    it("records a graph run as one agent with its nodes as hooks", () => {
      const result = run("graph");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
      for (const hook of ofType(result.events, "hook_triggered")) {
        expect(hook.trigger_event).toBe("graph_node");
      }
      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [12, 5],
        [30, 7],
      ]);
      // The model's own tool call id, so a tool_use joins to the tool_calls[]
      // entry that asked for it.
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      for (const event of result.events) {
        expect(event.framework).toBe("langchain");
        expect(typeof event.framework_version).toBe("string");
      }
      expect(result.stdout).toContain("It is sunny in Paris.");
    });

    it("records .stream() exactly like .invoke()", () => {
      const result = run("stream");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
    });

    it("records a prebuilt ReAct agent under its own name", () => {
      const result = run("react");
      expect(shape(result.events), describeTrace(result)).toEqual(
        GRAPH.map((line) => line.replace("weather_graph", "react_bot")),
      );
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a failure once, where it happened", () => {
      const result = run("error");
      expect(result.stdout).toContain("model exploded");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather_graph agent_start",
        "weather_graph hook_triggered agent",
        "weather_graph model_request",
        "weather_graph model_response",
        "weather_graph hook_completed agent",
        "weather_graph agent_end",
      ]);
      expect(ofType(result.events, "model_response")[0]!.error).toMatch(/model exploded/);
      expect(ofType(result.events, "hook_completed")[0]!.outcome).toBe("failed");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(count(result.events, "error")).toBe(0);
    });

    it("records a bare model call as its own run", () => {
      const result = run("model");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "ScriptedModel agent_start",
        "ScriptedModel model_request",
        "ScriptedModel model_response",
        "ScriptedModel agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a bare tool call as its own run", () => {
      const result = run("tool");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "get_weather agent_start",
        "get_weather tool_use get_weather",
        "get_weather tool_result get_weather",
        "get_weather agent_end",
      ]);
    });

    it("nests the graph under an enclosing agent() scope", () => {
      const result = run("scope");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        ...GRAPH,
        "planner agent_end",
      ]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("planner");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records through an explicit langchainHandler() without instrument()", () => {
      const result = run("handler");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
    });

    it("does not double-record when the handler and instrument() are both active", () => {
      const result = run("handler-and-instrument");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
    });

    it("records nothing after uninstrument()", () => {
      const result = run("uninstrument");
      expect(result.events, describeTrace(result)).toEqual([]);
      expect(result.stdout).toContain('"removed":["langchain"]');
    });
  });
});
