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
 * LlamaIndex.TS, against real releases.
 *
 * The expected traces follow the Python SDK's LlamaIndex adapter, captured from
 * llama-index-core 0.14.24 running the equivalent `FunctionAgent` program with a
 * scripted model (same tool, same tool call id, same two turns). The two SDKs
 * write into one pipe, so for the same program they must draw the same tree
 * (`sdk/python/skill/references/frameworks.md`):
 *
 *   * a workflow run is the agent — session + `agent_start`/`agent_end` — named
 *     after the agent (`FunctionAgent.name`, `"Agent"` by default), never an id;
 *   * each workflow step is a HOOK (`trigger_event="workflow_step"`);
 *   * a multi-agent workflow is `AgentWorkflow` with one nested agent per agent
 *     holding the turn;
 *   * a bare model call outside any run is its own run, named after the class;
 *   * a tool failure lives on its `tool_result`, not in an `error` event.
 *
 * Where TS genuinely differs, it is the framework and not the adapter: the step
 * NAMES are LlamaIndex.TS's own handler names (`runAgentStep`, where Python has
 * `run_agent_step`), TS executes every tool call of a turn in ONE
 * `executeToolCalls` step (Python runs a `call_tool` step per call), and
 * `parseAgentOutput` starts INSIDE `runAgentStep` because the TS runtime
 * dispatches the next step synchronously from `sendEvent`.
 */

/**
 * The supported floor and the latest release. 0.11.4 is the first `llamaindex`
 * on `@llamaindex/workflow` 1.1 (then still `@llama-flow/core` underneath, with
 * step handlers called as `handler(event)` and no bus event for a tool call);
 * 0.9–0.11.3 ship workflow 1.0, a different runtime whose `AgentWorkflow` has no
 * `runStream` at all.
 */
const FIXTURES = ["llamaindex-0.11", "llamaindex-0.12"] as const;

/** One line per event: `agent_id type [hook|tool]`. */
const shape = (events: Event[]): string[] =>
  events.map((e) => [e.agent_id, e.type, (e.hook_name ?? e.tool_name ?? "") as string].join(" ").trim());

const hook = (agentId: string, name: string, body: string[] = []): string[] => [
  `${agentId} hook_triggered ${name}`,
  ...body,
  `${agentId} hook_completed ${name}`,
];

const MODEL = (agentId: string) => [`${agentId} model_request`, `${agentId} model_response`];

/** One `FunctionAgent` turn that asks for `tool`, then the turn that answers. */
const agentLoop = (agentId: string, tool: string): string[] => [
  ...hook(agentId, "setupAgent"),
  `${agentId} hook_triggered runAgentStep`,
  ...MODEL(agentId),
  ...hook(agentId, "parseAgentOutput"),
  `${agentId} hook_completed runAgentStep`,
  ...hook(agentId, "executeToolCalls", [`${agentId} tool_use ${tool}`, `${agentId} tool_result ${tool}`]),
  ...hook(agentId, "processToolResults"),
  ...hook(agentId, "setupAgent"),
  `${agentId} hook_triggered runAgentStep`,
  ...MODEL(agentId),
  `${agentId} hook_triggered parseAgentOutput`,
  `${agentId} hook_completed runAgentStep`,
  `${agentId} hook_completed parseAgentOutput`,
];

const WORKFLOW = (agentId = "Agent", tool = "get_weather"): string[] => [
  `${agentId} agent_start`,
  ...hook(agentId, "handleInputStep"),
  ...agentLoop(agentId, tool),
  `${agentId} agent_end`,
];

describe.each(FIXTURES)("%s", (fixture) => {
  it("typechecks as a customer's nodenext ES-module project", () => {
    expect(typecheck(fixture)).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string) => {
      const result = runAgent(fixture, format, scenario);
      expect(result.status, describeTrace(result)).toBe(0);
      // Instrumenting must never load a second copy of the framework: LlamaIndex
      // detects it and prints this to the customer's terminal.
      expect(result.stderr).not.toContain("already imported");
      expect(result.stdout).toContain('"instrumented":["llamaindex"]');
      return result;
    };

    it("records a workflow agent run as one agent with its steps as hooks", () => {
      const result = run("workflow");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW());
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
      for (const event of ofType(result.events, "hook_triggered")) {
        expect(event.trigger_event).toBe("workflow_step");
      }
      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [12, 5],
        [30, 7],
      ]);
      for (const event of [...ofType(result.events, "model_request"), ...responses]) {
        expect(event.model).toBe("scripted-1");
      }
      // The model's own tool call id, so a tool_use joins to the tool call that
      // asked for it.
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
      expect(ofType(result.events, "tool_result")[0]!.output).toBe("sunny in Paris");
      const end = ofType(result.events, "agent_end")[0]!;
      expect(end.outcome).toBe("success");
      expect(end.summary).toBe("It is sunny in Paris.");
      expect(ofType(result.events, "agent_start")[0]!.goal).toBe("weather in Paris?");
      for (const event of result.events) {
        expect(event.framework).toBe("llamaindex");
        expect(typeof event.framework_version).toBe("string");
      }
      expect(result.stdout).toContain("It is sunny in Paris.");
    });

    it("names the run after the agent", () => {
      const result = run("named");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW("weather_bot"));
    });

    it("records an agent built before instrument()", () => {
      const result = run("early");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW());
    });

    it("records runStream() exactly like run()", () => {
      const result = run("stream");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW());
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a multi-agent handoff as nested agents under the workflow", () => {
      const result = run("handoff");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "AgentWorkflow agent_start",
        ...hook("AgentWorkflow", "handleInputStep"),
        "triage agent_start",
        ...hook("triage", "setupAgent"),
        "triage hook_triggered runAgentStep",
        ...MODEL("triage"),
        ...hook("triage", "parseAgentOutput"),
        "triage hook_completed runAgentStep",
        ...hook("triage", "executeToolCalls", ["triage tool_use handOff", "triage tool_result handOff"]),
        ...hook("triage", "processToolResults"),
        "triage agent_end",
        "forecaster agent_start",
        ...agentLoop("forecaster", "get_weather"),
        "forecaster agent_end",
        "AgentWorkflow agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      for (const start of ofType(result.events, "agent_start").slice(1)) {
        expect(start.parent_id).toBe("AgentWorkflow");
      }
    });

    it("records a legacy LLMAgent as one agent across all its steps", () => {
      const result = run("legacy");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "LLMAgent agent_start",
        ...MODEL("LLMAgent"),
        "LLMAgent tool_use get_weather",
        "LLMAgent tool_result get_weather",
        ...MODEL("LLMAgent"),
        "LLMAgent agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
      expect(ofType(result.events, "model_response").map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [12, 5],
        [30, 7],
      ]);
      expect(ofType(result.events, "model_request")[0]!.model).toBe("scripted-1");
    });

    it("records a bare model call as its own run", () => {
      const result = run("model");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "ScriptedLLM agent_start",
        ...MODEL("ScriptedLLM"),
        "ScriptedLLM agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      const response = ofType(result.events, "model_response")[0]!;
      expect([response.input_tokens, response.output_tokens]).toEqual([3, 1]);
      expect(response.model).toBe("scripted-1");
    });

    it("nests the run under an enclosing agent() scope", () => {
      const result = run("scope");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        ...WORKFLOW(),
        "planner agent_end",
      ]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("planner");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a failing tool on its tool_result, once", () => {
      const result = run("tool-error");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW("Agent", "broken"));
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(ofType(result.events, "tool_result")[0]!.error).toMatch(/tool exploded/);
      expect(ofType(result.events, "hook_completed").every((e) => e.outcome === "success")).toBe(true);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(count(result.events, "error")).toBe(0);
    });

    it("records nothing after uninstrument()", () => {
      const result = run("uninstrument");
      expect(shape(result.events), describeTrace(result)).toEqual(WORKFLOW());
      expect(result.stdout).toContain('"removed":["llamaindex"]');
    });
  });
});
