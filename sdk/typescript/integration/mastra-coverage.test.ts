import { describe, expect, it } from "vitest";

import { FORMATS, count, describeTrace, ofType, runAgent, traceViolations, type Event } from "./harness.js";

/**
 * Mastra, every commonly used surface beyond a bare `new Agent().generate()`,
 * against real 0.x and 1.x releases in both module systems. The mapping each
 * case expects is the one `src/integrations/mastra.ts` documents; the cases in
 * `mastra.test.ts` cover the core loop, errors and the instrument lifecycle.
 *
 * Every model here is a mock that answers from what it is ASKED (the city in
 * the question, whether the last message is a tool result, which schema the
 * call requests), so concurrent runs, memory, networks and structured output
 * can share one without a script going out of step. Nothing reaches a
 * network; the MCP server is a local stdio child process.
 */

const FIXTURES = ["mastra-1", "mastra-0"] as const;

const CITIES = ["Paris", "Rome", "Oslo", "Lima", "Cairo", "Tokyo", "Quito", "Dakar", "Hanoi", "Perth"];

/** One line per event: `agent_id type [hook|tool]`. */
const shape = (events: Event[]): string[] =>
  events.map((e) => [e.agent_id, e.type, (e.hook_name ?? e.tool_name ?? "") as string].join(" ").trim());

const loop = (agent: string, tool = "weather"): string[] => [
  `${agent} agent_start`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} tool_use ${tool}`,
  `${agent} tool_result ${tool}`,
  `${agent} model_request`,
  `${agent} model_response`,
  `${agent} agent_end`,
];

const sessions = (events: Event[]): string[] => [...new Set(events.map((e) => e.session_id))];

const bySession = (events: Event[]): Event[][] => sessions(events).map((id) => events.filter((e) => e.session_id === id));

const hooks = (flow: string, ...steps: string[]): string[] =>
  steps.flatMap((step) => [`${flow} hook_triggered ${step}`, `${flow} hook_completed ${step}`]);

describe.each(FIXTURES)("%s", (fixture) => {
  const zero = fixture === "mastra-0";

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string) => {
      const result = runAgent(fixture, format, scenario);
      expect(result.status, describeTrace(result)).toBe(0);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      return result;
    };

    it("records an agent and a workflow fetched back from a Mastra instance", () => {
      const result = run("mastra-instance");
      expect(shape(result.events), describeTrace(result)).toEqual([
        ...loop("weather-agent"),
        "weather-flow agent_start",
        ...hooks("weather-flow", "fetch-city"),
        "weather-flow hook_triggered ask-agent",
        ...loop("weather-agent"),
        "weather-flow hook_completed ask-agent",
        "weather-flow agent_end",
      ]);
      expect(sessions(result.events)).toHaveLength(2);
    });

    it("keeps 10 concurrent runs of one Agent apart in one session", () => {
      const result = run("concurrent");
      expect(sessions(result.events)).toEqual(["req-1"]);
      expect(count(result.events, "agent_start")).toBe(10);
      expect(count(result.events, "agent_end")).toBe(10);
      expect(count(result.events, "model_request")).toBe(20);
      expect(count(result.events, "model_response")).toBe(20);
      const uses = ofType(result.events, "tool_use");
      expect(uses.map((e) => (e.input as { city: string }).city).sort()).toEqual([...CITIES].sort());
      expect(new Set(uses.map((e) => e.tool_call_id)).size).toBe(10);
      for (const end of ofType(result.events, "agent_end")) expect(end.outcome).toBe("success");
      expect(new Set(ofType(result.events, "agent_start").map((e) => e.goal)).size).toBe(10);
    });

    it("keeps 10 concurrent runs of one Agent (generate and stream) apart across sessions", () => {
      const result = run("concurrent-sessions");
      const perSession = bySession(result.events);
      expect(perSession).toHaveLength(10);
      const seen: string[] = [];
      for (const events of perSession) {
        expect(shape(events), describeTrace(result)).toEqual(loop("weather-agent"));
        // Every event of the run is about the run's own city: nothing crossed.
        const city = /in ([A-Z][a-z]+)/.exec(String(events[0]!.goal))![1]!;
        seen.push(city);
        expect((ofType(events, "tool_use")[0]!.input as { city: string }).city).toBe(city);
        expect(ofType(events, "tool_result")[0]!.output).toEqual({ city, forecast: "sunny" });
        expect(ofType(events, "model_response")[1]!.content).toBe(`It is sunny in ${city}.`);
        for (const request of ofType(events, "model_request")) {
          expect(JSON.stringify(request.messages)).toContain(city);
          for (const other of CITIES.filter((c) => c !== city)) {
            expect(JSON.stringify(request.messages)).not.toContain(other);
          }
        }
      }
      expect(seen.sort()).toEqual([...CITIES].sort());
    });

    it("makes a memory thread the session of every run on it", () => {
      const result = run("memory");
      expect(sessions(result.events)).toEqual(["thread-42"]);
      const starts = ofType(result.events, "agent_start");
      expect(starts.map((e) => e.goal)).toEqual(["What is the weather in Paris?", "And what is the weather in Rome?"]);
      for (const start of starts) expect(start).toMatchObject({ fw_thread_id: "thread-42", fw_resource_id: "user-7" });
      expect(count(result.events, "agent_end")).toBe(2);
      expect(ofType(result.events, "tool_use").map((e) => (e.input as { city: string }).city)).toEqual(["Paris", "Rome"]);
      // 0.x titles a new thread with the agent's own model: a real call,
      // recorded on the run that made it.
      expect(count(result.events, "model_request")).toBe(zero ? 5 : 4);
      // Memory is real: the second run's first request carries the first run.
      const second = result.events.findIndex((e) => e.type === "agent_start" && e.goal !== starts[0]!.goal);
      const recalled = result.events.slice(second).find((e) => e.type === "model_request")!;
      expect(JSON.stringify(recalled.messages)).toContain("What is the weather in Paris?");
    });

    it("lets an enclosing session scope win over the memory thread", () => {
      const result = run("memory-scoped");
      expect(sessions(result.events)).toEqual(["req-1"]);
      expect(ofType(result.events, "agent_start")[0]).toMatchObject({ fw_thread_id: "thread-42" });
    });

    it("records a branch as the branch taken", () => {
      const result = run("wf-branch");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "branch-flow agent_start",
        ...hooks("branch-flow", "city", "sunny"),
        "branch-flow agent_end",
      ]);
    });

    it("records parallel steps each as a hook", () => {
      const result = run("wf-parallel");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "parallel-flow agent_start",
        ...hooks("parallel-flow", "city"),
        "parallel-flow hook_triggered high",
        "parallel-flow hook_triggered low",
        "parallel-flow hook_completed high",
        "parallel-flow hook_completed low",
        "parallel-flow agent_end",
      ]);
    });

    it("records every iteration of a dowhile and a foreach", () => {
      const result = run("wf-loop");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "loop-flow agent_start",
        ...hooks("loop-flow", "count", "count", "count", "cities", "answer", "answer"),
        "loop-flow agent_end",
      ]);
      expect(new Set(ofType(result.events, "hook_triggered").map((e) => e.hook_id)).size).toBe(6);
    });

    it("nests a nested workflow under the step that runs it", () => {
      const result = run("wf-nested");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "outer-flow agent_start",
        "outer-flow hook_triggered inner-flow",
        "inner-flow agent_start",
        ...hooks("inner-flow", "pick-city", "answer"),
        "inner-flow agent_end",
        "outer-flow hook_completed inner-flow",
        "outer-flow agent_end",
      ]);
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("outer-flow");
    });

    it("nests an agent used as a step (createStep(agent)) under the workflow", () => {
      const result = run("wf-agent-step");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "agent-step-flow agent_start",
        ...hooks("agent-step-flow", "to-prompt"),
        "agent-step-flow hook_triggered weather-agent",
        ...loop("weather-agent"),
        "agent-step-flow hook_completed weather-agent",
        "agent-step-flow agent_end",
      ]);
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("agent-step-flow");
    });

    it("records a streamed workflow run (run.stream()) exactly like an awaited one", () => {
      const result = run("wf-stream");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "agent-step-flow agent_start",
        ...hooks("agent-step-flow", "to-prompt"),
        "agent-step-flow hook_triggered weather-agent",
        ...loop("weather-agent"),
        "agent-step-flow hook_completed weather-agent",
        "agent-step-flow agent_end",
      ]);
      expect(ofType(result.events, "agent_end").at(-1)!.outcome).toBe("success");
    });

    it("records suspend / resume as a human wait on ONE workflow span", () => {
      const result = run("wf-suspend");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "approval-flow agent_start",
        ...hooks("approval-flow", "city", "approve"),
        "approval-flow human_wait",
        "approval-flow agent_pause",
        "approval-flow agent_resume",
        "approval-flow human_input",
        ...hooks("approval-flow", "approve", "done"),
        "approval-flow agent_end",
      ]);
      const runId = String(ofType(result.events, "agent_start")[0]!.fw_workflow_run_id);
      expect(sessions(result.events)).toEqual([runId]);
      const pauseId = `${runId}:approve`;
      expect(ofType(result.events, "human_wait")[0]).toMatchObject({ input_id: pauseId, prompt: "Look up Paris?" });
      expect(ofType(result.events, "agent_pause")[0]).toMatchObject({ pause_id: pauseId });
      expect(ofType(result.events, "agent_resume")[0]).toMatchObject({ pause_id: pauseId });
      expect(ofType(result.events, "human_input")[0]).toMatchObject({ input_id: pauseId, response: '{"approved":true}' });
      expect(ofType(result.events, "hook_completed")[1]!.outcome).toBe("suspended");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(result.stdout).toContain('"status":"suspended"');
      expect(result.stdout).toContain('"answer":"sunny in Paris"');
    });

    it("records a run through input and output processors exactly as one without", () => {
      const result = run("processors");
      expect(shape(result.events), describeTrace(result)).toEqual([...loop("weather-agent"), ...loop("weather-agent")]);
      expect(sessions(result.events)).toHaveLength(2);
      expect(result.stdout).toContain('"answers":["It is sunny in Paris.","It is sunny in Paris."]');
    });

    it("closes a run an input processor blocks, rejected — generate and stream", () => {
      const result = run("tripwire");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent agent_end",
        "weather-agent agent_start",
        "weather-agent agent_end",
      ]);
      expect(ofType(result.events, "agent_end").map((e) => e.outcome)).toEqual(["rejected", "rejected"]);
    });

    // 0.x's output offers no end signal for a stream an OUTPUT processor
    // blocks (no callback fires, no `_waitUntilFinished`), so there its agent
    // stays open until uninstrument() — a known limitation.
    it.skipIf(zero)("closes a stream an output processor blocks, rejected, with its model step", () => {
      const result = run("tripwire-output");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ]);
      expect(ofType(result.events, "model_response")[0]).toMatchObject({ input_tokens: 9, output_tokens: 4 });
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("rejected");
    });

    // The manual finding "Mastra streams from OpenAI-compatible providers carry
    // no tokens": Mastra's own model never asks for streamed usage, so there is
    // nothing to record — and when the stream does carry it, it is recorded.
    it("records a streamed OpenAI-compatible step's tokens only when the stream carries them", () => {
      const result = run("usage-openai-compatible");
      const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
        mastraStreamTokens: number;
        mastraGenerateTokens: number;
        requests: Array<{ stream?: boolean; streamOptions?: unknown }>;
      };
      // The streamed request did not ask (no `stream_options`), and Mastra
      // itself reports zero; the non-streamed call reports the real count.
      expect(report.requests[0]).toEqual({ stream: true });
      expect(report.mastraStreamTokens).toBe(0);
      expect(report.mastraGenerateTokens).toBe(17);
      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [undefined, undefined],
        [17, 5],
      ]);

      const always = runAgent(fixture, format, "usage-openai-compatible", { USAGE_ALWAYS: "1" });
      expect(always.status, describeTrace(always)).toBe(0);
      expect(ofType(always.events, "model_response").map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [17, 5],
        [17, 5],
      ]);
    });

    it("records an MCP tool (listTools) under its namespaced MCP name", () => {
      const result = run("mcp");
      expect(shape(result.events), describeTrace(result)).toEqual(loop("weather-agent", "weatherServer_forecast"));
      expect(ofType(result.events, "tool_use")[0]!.input).toEqual({ city: "Paris" });
      expect(JSON.stringify(ofType(result.events, "tool_result")[0]!.output)).toContain("Forecast for Paris: sunny");
      expect(ofType(result.events, "tool_result")[0]!.error).toBeUndefined();
    });

    it("records an MCP tool passed as a toolset under the name the model called", () => {
      const result = run("mcp-toolsets");
      expect(shape(result.events), describeTrace(result)).toEqual(loop("weather-agent", "forecast"));
      const call = (ofType(result.events, "model_response")[0]!.fw_tool_calls as Array<{ name: string }>)[0]!;
      expect(call.name).toBe("forecast");
      expect(JSON.stringify(ofType(result.events, "tool_result")[0]!.output)).toContain("Forecast for Paris: sunny");
    });

    it("records structured output (generate and stream) as one model step each", () => {
      const result = run("structured");
      const one = [
        "weather-agent agent_start",
        "weather-agent model_request",
        "weather-agent model_response",
        "weather-agent agent_end",
      ];
      expect(shape(result.events), describeTrace(result)).toEqual([...one, ...one]);
      for (const response of ofType(result.events, "model_response")) {
        expect(response).toMatchObject({ input_tokens: 15, output_tokens: 6 });
        expect(JSON.parse(String(response.content))).toEqual({ city: "Paris", forecast: "sunny" });
      }
      expect(result.stdout).toContain('"object":{"city":"Paris","forecast":"sunny"}');
    });

    it("nests structuring by a second model as its own agent, inside the run", () => {
      const result = run("structured-model");
      expect(shape(result.events), describeTrace(result)).toEqual([
        ...loop("weather-agent").slice(0, -1),
        "structured-output-structurer agent_start",
        "structured-output-structurer model_request",
        "structured-output-structurer model_response",
        "structured-output-structurer agent_end",
        "weather-agent agent_end",
      ]);
      const structurer = ofType(result.events, "agent_start")[1]!;
      expect(structurer.parent_id).toBe("weather-agent");
      expect(ofType(result.events, "model_response")[2]).toMatchObject({ model: "structuring-model", input_tokens: 30 });
    });

    it("records a one-step run whose tool fails: one model step, the failure on the tool", () => {
      const result = run("maxsteps-tool-error");
      expect(shape(result.events), describeTrace(result)).toEqual(loop("weather-agent").filter((_, i) => i !== 5 && i !== 6));
      expect(String(ofType(result.events, "tool_result")[0]!.error)).toMatch(/tool exploded/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(count(result.events, "error")).toBe(0);
    });

    it("nests an agent a tool runs by hand under that tool call", () => {
      const result = run("agent-in-tool");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "boss agent_start",
        "boss model_request",
        "boss model_response",
        "boss tool_use ask-helper",
        ...loop("helper"),
        "boss tool_result ask-helper",
        "boss model_request",
        "boss model_response",
        "boss agent_end",
      ]);
      expect(sessions(result.events)).toHaveLength(1);
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("boss");
    });

    it("records an agent network as one agent: its router's steps, its delegate nested", () => {
      const result = run("network");
      // 0.x titles the network's new memory thread with the router's model.
      const title = zero ? ["planner model_request", "planner model_response"] : [];
      expect(shape(result.events), describeTrace(result)).toEqual([
        "planner agent_start",
        ...title,
        "planner model_request",
        "planner model_response",
        ...loop("helper"),
        "planner model_request",
        "planner model_response",
        "planner agent_end",
      ]);
      expect(sessions(result.events)).toEqual(["thread-net"]);
      const [planner, helper] = ofType(result.events, "agent_start");
      expect(planner).toMatchObject({ fw_method: "network", fw_thread_id: "thread-net" });
      expect(helper!.parent_id).toBe("planner");
      const tokens = ofType(result.events, "model_response")
        .filter((e) => e.agent_id === "planner")
        .map((e) => [e.input_tokens, e.output_tokens]);
      expect(tokens).toEqual([...(zero ? [[5, 3]] : []), [50, 10], [40, 6]]);
      expect(ofType(result.events, "agent_end").at(-1)!.outcome).toBe("success");
      expect(result.stdout).toContain('"status":"success"');
    });
  });
});
