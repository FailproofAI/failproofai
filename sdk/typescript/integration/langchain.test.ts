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

/**
 * Both ends of the declared peer range (`@langchain/core >=0.3.0 <2`): the 0.3
 * line with LangGraph.js 0.4, and the 1.x line with LangGraph.js 1.x. They
 * differ in exactly the places an adapter breaks on — 0.3 passes no
 * `toolCallId` to `handleToolStart` and LangGraph 0.4 has no graph lifecycle
 * callbacks — so one set of expectations over both is the proof that the
 * adapter covers the range it declares, not just the release it was written on.
 */
const FIXTURES = ["langchain-0.3", "langchain-1"] as const;

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

/**
 * The expected trace of each plain-LangChain surface, per session.
 *
 * Captured from the Python adapter running the equivalent program
 * (langchain-core 1.6.3) with `GenericFakeChatModel`; the rule on both sides is
 * the table in `frameworks.md`: the ROOT run is the agent, named by the
 * framework's own run name; an LCEL step, a prompt, a parser, a lambda and a
 * `RunnableParallel` branch emit NOTHING (no `includeChains`); a chat model is
 * its request/response pair; a retriever is a `retriever:<name>` tool pair.
 *
 * Where the agent_id differs from Python's it is the FRAMEWORK's run name that
 * differs, not the mapping:
 *   * `RunnableParallel.from({...})` runs as `RunnableMap` in LangChain.js
 *     (Python: `RunnableParallel<a,b>`);
 *   * a `RunnableLambda` is named `RunnableLambda` whatever its function is
 *     called in JS (Python names it after the function), so the case sets the
 *     run name to Python's (`shout`) instead;
 *   * `withStructuredOutput` names its sequence `StructuredOutput` in JS
 *     (Python: `RunnableSequence`).
 * `.batch()` of three inputs is three roots — three sessions, exactly as
 * Python's `.batch()` is.
 */
const SURFACES: Record<string, { trace: string[]; sessions?: number }> = {
  lcel: { trace: modelRun("RunnableSequence") },
  sequence: { trace: ["RunnableSequence agent_start", "RunnableSequence agent_end"] },
  parallel: { trace: ["RunnableMap agent_start", "RunnableMap agent_end"] },
  lambda: { trace: ["shout agent_start", "shout agent_end"] },
  retriever: { trace: retrieverRun("Docs", "Docs") },
  vectorstore: { trace: retrieverRun("VectorStoreRetriever", "VectorStoreRetriever") },
  rag: {
    trace: [
      "RunnableSequence agent_start",
      "RunnableSequence tool_use retriever:Docs",
      "RunnableSequence tool_result retriever:Docs",
      "RunnableSequence model_request",
      "RunnableSequence model_response",
      "RunnableSequence agent_end",
    ],
  },
  batch3: { trace: modelRun("RunnableSequence"), sessions: 3 },
  // `streamEvents` v2 attaches LangChain's own event-stream handler beside
  // ours; the trace is the `.invoke()` one, with the stream folded in.
  "stream-events": { trace: modelRun("RunnableSequence") },
  "lcel-stream": { trace: modelRun("RunnableSequence") },
  structured: { trace: modelRun("StructuredOutput") },
  // `bindTools` returns a binding, which is not a run of its own: the model is
  // the root, exactly as Python's `bind_tools(...).invoke()`.
  "bind-tools": { trace: modelRun("ToolCallingModel") },
};

function modelRun(agent: string): string[] {
  return [`${agent} agent_start`, `${agent} model_request`, `${agent} model_response`, `${agent} agent_end`];
}

function retrieverRun(agent: string, retriever: string): string[] {
  return [
    `${agent} agent_start`,
    `${agent} tool_use retriever:${retriever}`,
    `${agent} tool_result retriever:${retriever}`,
    `${agent} agent_end`,
  ];
}

/**
 * The v1 `langchain` package's `createAgent` (langchain 1.5.12), which only the
 * 1.x line has — so it lives in the langchain-1 fixture's own `agent-v1.ts`.
 *
 * Python golden: `langchain.agents.create_agent` 1.4.2 with the same scripted
 * model, `name="weather_agent"`. Identical but for one name: LangChain.js calls
 * the model node `model_request` where Python calls it `model` — the graph's
 * own node name, which both adapters report verbatim.
 */
const CREATE_AGENT = [
  "weather_agent agent_start",
  "weather_agent hook_triggered model_request",
  "weather_agent model_request",
  "weather_agent model_response",
  "weather_agent hook_completed model_request",
  "weather_agent hook_triggered tools",
  "weather_agent tool_use get_weather",
  "weather_agent tool_result get_weather",
  "weather_agent hook_completed tools",
  "weather_agent hook_triggered model_request",
  "weather_agent model_request",
  "weather_agent model_response",
  "weather_agent hook_completed model_request",
  "weather_agent agent_end",
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

    it("records a tool that failed on its tool_result, and the run carries on", () => {
      const result = run("tool-error");
      // `ToolNode` turns the throw into an error ToolMessage, so the graph goes
      // on to answer: the same shape as a clean run, with the failure on the
      // tool span and nowhere else.
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(ofType(result.events, "tool_result")[0]!.error).toBe("Error: no weather for Paris");
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(count(result.events, "error")).toBe(0);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records an interrupt() and its Command resume as one paused agent", () => {
      const result = run("hitl");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "hitl_graph agent_start",
        "hitl_graph hook_triggered plan",
        "hitl_graph hook_completed plan",
        "hitl_graph hook_triggered approve",
        // The node did not fail, it stopped to ask a human.
        "hitl_graph hook_completed approve",
        "hitl_graph human_wait",
        "hitl_graph agent_pause",
        // The second `.invoke()` is the SAME agent: no second agent_start.
        "hitl_graph agent_resume",
        "hitl_graph human_input",
        "hitl_graph hook_triggered approve",
        "hitl_graph hook_completed approve",
        "hitl_graph hook_triggered act",
        "hitl_graph hook_completed act",
        "hitl_graph agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["t-1"]));
      expect(ofType(result.events, "hook_completed")[1]!.outcome).toBe("paused");
      const wait = ofType(result.events, "human_wait")[0]!;
      expect(wait.prompt).toBe("ship it?");
      expect(wait.options).toEqual(["yes", "no"]);
      expect(wait.reason).toBe("langgraph_interrupt");
      const pauseId = wait.input_id;
      expect(typeof pauseId).toBe("string");
      expect(ofType(result.events, "agent_pause")[0]!.pause_id).toBe(pauseId);
      expect(ofType(result.events, "agent_resume")[0]!.pause_id).toBe(pauseId);
      const answer = ofType(result.events, "human_input")[0]!;
      expect(answer.input_id).toBe(pauseId);
      expect(answer.response).toBe("yes");
      // Control flow, not failure: nothing red anywhere.
      expect(count(result.events, "error")).toBe(0);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
    });

    it("closes a paused agent as cancelled at uninstrument()", () => {
      const result = run("hitl-uninstrument");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "hitl_graph agent_start",
        "hitl_graph hook_triggered plan",
        "hitl_graph hook_completed plan",
        "hitl_graph hook_triggered approve",
        "hitl_graph hook_completed approve",
        "hitl_graph human_wait",
        "hitl_graph agent_pause",
        "hitl_graph agent_end",
      ]);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(result.stdout).toContain('"removed":["langchain"]');
    });

    it("closes a pause opened by another process when this one takes the answer", () => {
      // Process A interrupts and exits; process B shares only the checkpointer.
      // B has no memory of the pause, so the id is rebuilt from the interrupted
      // task's checkpoint namespace — the same derivation `interrupt()` used.
      const result = run("remote-resume");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "hitl_graph agent_start",
        "hitl_graph hook_triggered plan",
        "hitl_graph hook_completed plan",
        "hitl_graph hook_triggered approve",
        "hitl_graph hook_completed approve",
        "hitl_graph human_wait",
        "hitl_graph agent_pause",
        // Process B: its own root, then the pause closed where the answered
        // node finished.
        "hitl_graph agent_start",
        "hitl_graph hook_triggered approve",
        "hitl_graph hook_completed approve",
        "hitl_graph agent_resume",
        "hitl_graph human_input",
        "hitl_graph hook_triggered act",
        "hitl_graph hook_completed act",
        "hitl_graph agent_end",
      ]);
      const opened = ofType(result.events, "human_wait")[0]!.input_id;
      expect(ofType(result.events, "agent_resume")[0]!.pause_id).toBe(opened);
      const answer = ofType(result.events, "human_input")[0]!;
      expect(answer.input_id).toBe(opened);
      expect(answer.response).toBe("yes");
      expect(answer.fw_resumed_elsewhere).toBe(true);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["t-1"]));
      expect(count(result.events, "error")).toBe(0);
    });

    it("closes an aborted run as cancelled, not failed", () => {
      const result = run("abort");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "abort_graph agent_start",
        "abort_graph hook_triggered slow",
        "abort_graph hook_completed slow",
        "abort_graph agent_end",
      ]);
      // A caller that gave up is not a crash: nothing red, and the session
      // closed rather than left running forever.
      expect(ofType(result.events, "hook_completed")[0]!.outcome).toBe("cancelled");
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(count(result.events, "error")).toBe(0);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records a compiled subgraph as a nested agent under its host node", () => {
      const result = run("subgraph");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "parent_graph agent_start",
        "parent_graph hook_triggered pre",
        "parent_graph hook_completed pre",
        "parent_graph hook_triggered child",
        "parent_graph/child agent_start",
        "parent_graph/child hook_triggered inner",
        "parent_graph/child hook_completed inner",
        "parent_graph/child agent_end",
        "parent_graph hook_completed child",
        "parent_graph agent_end",
      ]);
      expect(ofType(result.events, "agent_start")[1]!.parent_id).toBe("parent_graph");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records each input of a .batch() as its own root", () => {
      const result = run("batch");
      const sessions = [...new Set(result.events.map((e) => e.session_id))];
      expect(sessions).toHaveLength(2);
      for (const session of sessions) {
        expect(shape(result.events.filter((e) => e.session_id === session))).toEqual([
          "ScriptedModel agent_start",
          "ScriptedModel model_request",
          "ScriptedModel model_response",
          "ScriptedModel agent_end",
        ]);
      }
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("folds a streamed model call into one model_response", () => {
      const result = run("stream-model");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "StreamingModel agent_start",
        "StreamingModel model_request",
        "StreamingModel model_response",
        "StreamingModel agent_end",
      ]);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.fw_streamed).toBe(true);
      expect(response.fw_chunks).toBe(5);
      expect(typeof response.fw_ttft_ms).toBe("number");
      expect(response.content).toBe("hello there friend");
    });

    it("records an intermediate chain only when includeChains names it", () => {
      const result = run("include-chains");
      expect(shape(result.events), describeTrace(result)).toEqual([
        "pipeline agent_start",
        "pipeline hook_triggered summarise",
        "pipeline hook_completed summarise",
        "pipeline agent_end",
      ]);
      expect(ofType(result.events, "hook_triggered")[0]!.trigger_event).toBe("pipeline");
    });

    it("pins every run to the sessionId option", () => {
      const result = run("session-option");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["fixed-session"]));
    });

    it("takes the session from the documented metadata key", () => {
      const result = run("metadata-session");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["meta-sid"]));
    });

    it("falls back to the LangGraph thread_id for the session", () => {
      const result = run("thread-session");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(new Set(result.events.map((e) => e.session_id))).toEqual(new Set(["thread-9"]));
    });

    it("drops prompts, messages and outputs under captureContent: false", () => {
      const result = run("capture-off");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      for (const event of result.events) {
        for (const key of ["goal", "input", "output", "messages", "content"]) {
          expect(event[key], `${event.type}.${key}`).toBeUndefined();
        }
      }
      // Structure, durations and token counts survive.
      expect(ofType(result.events, "model_response").map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [12, 5],
        [30, 7],
      ]);
      expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
    });

    // -- plain LangChain: every surface, instrumented and by explicit handler --

    describe.each(["instrument", "handler"] as const)("through %s", (mode) => {
      const runSurface = (surface: string) => run(mode === "handler" ? `handler:${surface}` : surface);

      it.each(Object.keys(SURFACES))("records %s as one root agent per input", (surface) => {
        const expected = SURFACES[surface]!;
        const result = runSurface(surface);
        const sessions = [...new Set(result.events.map((e) => e.session_id))];
        expect(sessions, describeTrace(result)).toHaveLength(expected.sessions ?? 1);
        for (const session of sessions) {
          expect(shape(result.events.filter((e) => e.session_id === session)), describeTrace(result)).toEqual(
            expected.trace,
          );
        }
        expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
        if (mode === "handler") expect(result.stdout).not.toContain("instrumented");
      });

      it("summarises a retriever's documents, never their text", () => {
        for (const surface of ["retriever", "rag"]) {
          const result = runSurface(surface);
          const use = ofType(result.events, "tool_use")[0]!;
          const done = ofType(result.events, "tool_result")[0]!;
          expect(use.tool_call_id, describeTrace(result)).toBe(done.tool_call_id);
          expect(use.input).toEqual({ query: surface === "rag" ? "weather?" : "weather in Paris" });
          expect(done.output).toEqual({ n: 2, sources: ["wx.txt", "wx2.txt"] });
          // Not in the retrieval's own events. (In `rag` the documents DO reach
          // the model_request — the chain put them into the prompt.)
          expect(JSON.stringify([use, done])).not.toContain("Rome is rainy");
        }
        const store = runSurface("vectorstore");
        expect(ofType(store.events, "tool_result")[0]!.output, describeTrace(store)).toEqual({ n: 1, sources: ["wx.txt"] });
      });

      it("folds a streamed chain's tokens into one model_response, usage included", () => {
        for (const surface of ["lcel-stream", "stream-events"]) {
          const result = runSurface(surface);
          const response = ofType(result.events, "model_response")[0]!;
          expect(response.fw_streamed, describeTrace(result)).toBe(true);
          expect(response.fw_chunks).toBe(5);
          expect(typeof response.fw_ttft_ms).toBe("number");
          expect(response.content).toBe("It is sunny in Paris.");
          // Usage arrives on the LAST chunk only; it survives the aggregation.
          expect([response.input_tokens, response.output_tokens]).toEqual([30, 7]);
        }
      });

      it("records the tools a model was bound to, for bindTools and withStructuredOutput", () => {
        const bound = runSurface("bind-tools");
        const request = ofType(bound.events, "model_request")[0]!;
        expect(request.model, describeTrace(bound)).toBe("tool-calling-1");
        expect((request.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual([
          "get_weather",
        ]);
        expect([ofType(bound.events, "model_response")[0]!.input_tokens]).toEqual([12]);
        const structured = runSurface("structured");
        const asked = ofType(structured.events, "model_request")[0]!;
        expect((asked.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(["Weather"]);
        expect(structured.stdout).toContain('{"out":{"city":"Paris","sky":"sunny"}}');
      });
    });
  });
});

describe("langchain-1: createAgent", () => {
  it("typechecks as a customer's nodenext ES-module project", () => {
    // `tsconfig.json` lists both programs, so this covers agent-v1.ts too.
    expect(typecheck("langchain-1")).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string) => {
      const result = runAgent("langchain-1", format, scenario, {}, "agent-v1");
      expect(result.status, describeTrace(result)).toBe(0);
      return result;
    };

    it.each(["create-agent", "handler:create-agent", "create-agent-stream"])(
      "records %s as one agent with its nodes as hooks",
      (scenario) => {
        const result = run(scenario);
        expect(shape(result.events), describeTrace(result)).toEqual(CREATE_AGENT);
        expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
        expect(new Set(result.events.map((e) => e.session_id)).size).toBe(1);
        for (const hook of ofType(result.events, "hook_triggered")) expect(hook.trigger_event).toBe("graph_node");
        expect(ofType(result.events, "tool_use")[0]!.tool_call_id).toBe("call_1");
        expect(ofType(result.events, "model_response").map((e) => [e.input_tokens, e.output_tokens])).toEqual([
          [12, 5],
          [30, 7],
        ]);
      },
    );

    it("records middleware: a node-shaped hook is a hook, a wrapping hook adds nothing", () => {
      // Python golden (`AgentMiddleware` with `before_model` + `wrap_model_call`):
      // `Audit.before_model` is a node before each model turn; `wrap_model_call`
      // runs INSIDE the model node and emits nothing of its own.
      const result = run("create-agent-mw");
      const before = ["weather_agent hook_triggered Audit.before_model", "weather_agent hook_completed Audit.before_model"];
      expect(shape(result.events), describeTrace(result)).toEqual([
        CREATE_AGENT[0],
        ...before,
        ...CREATE_AGENT.slice(1, 9),
        ...before,
        ...CREATE_AGENT.slice(9),
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("renders the model node's Command output as messages, not LangChain's serialization envelope", () => {
      // The model node returns `{ output: [Command] }`; its messages used to be
      // captured as `{lc: 1, type: "constructor", id: [...], kwargs}`.
      const result = run("create-agent");
      const done = ofType(result.events, "hook_completed").find((e) => e.hook_name === "model_request")!;
      const text = JSON.stringify(done.output);
      expect(text, describeTrace(result)).not.toContain('"lc":1');
      expect(text).toContain('"type":"ai"');
      expect(text).toContain('"lg_name":"Command"');
    });
  });
});

/**
 * Two copies of `@langchain/core` in one process: the app's 1.2.12 and 0.3.80
 * nested under a provider that pinned it (see the fixture's `agent.ts`).
 *
 * The nested copy's runs INSIDE an app run were always recorded — the child is
 * handed the parent's manager, handler and all. Its ROOT runs were recorded by
 * nothing under `instrument()` until the adapter learned to find and patch the
 * nested copy too. Python has no equivalent (one interpreter imports one
 * `langchain_core`), so the expectation is the mapping rule itself: identical
 * to the same run through the app's own copy.
 */
describe("langchain-dup-core: a provider nested on its own @langchain/core", () => {
  const DUP = "langchain-dup-core";

  it("typechecks as a customer's nodenext ES-module project", () => {
    expect(typecheck(DUP)).toBe("");
  });

  const NESTED_ROOTS: Record<string, string[]> = {
    "nested-model": modelRun("ChatWeather"),
    "nested-tool": [
      "get_weather agent_start",
      "get_weather tool_use get_weather",
      "get_weather tool_result get_weather",
      "get_weather agent_end",
    ],
    "nested-retriever": retrieverRun("WeatherRetriever", "WeatherRetriever"),
    "nested-runnable": ["forecast agent_start", "forecast agent_end"],
  };

  describe.each(FORMATS)("as %s", (format) => {
    const run = (scenario: string) => {
      const result = runAgent(DUP, format, scenario);
      expect(result.status, describeTrace(result)).toBe(0);
      return result;
    };

    it.each(Object.keys(NESTED_ROOTS))("records a root started by the nested copy (%s)", (scenario) => {
      const result = run(scenario);
      expect(shape(result.events), describeTrace(result)).toEqual(NESTED_ROOTS[scenario]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it.each(Object.keys(NESTED_ROOTS))("records it through an explicit handler too (%s)", (scenario) => {
      const result = run(`handler:${scenario}`);
      expect(shape(result.events), describeTrace(result)).toEqual(NESTED_ROOTS[scenario]);
    });

    it("does not double-record a nested root when the handler and instrument() are both active", () => {
      const result = run("both:nested-model");
      expect(shape(result.events), describeTrace(result)).toEqual(NESTED_ROOTS["nested-model"]);
    });

    it("records nothing through the nested copy after uninstrument()", () => {
      const result = run("uninstrument:nested-model");
      expect(result.events, describeTrace(result)).toEqual([]);
    });

    it("records the nested copy's model inside the app's chain", () => {
      const result = run("app-chain");
      expect(shape(result.events), describeTrace(result)).toEqual(modelRun("RunnableSequence"));
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });

    it("records the nested copy's model inside the app's lambda, parented through the shared async context", () => {
      const result = run("app-lambda");
      expect(shape(result.events), describeTrace(result)).toEqual(modelRun("outer"));
    });

    it("records the nested copy's model inside the app's LangGraph graph", () => {
      const result = run("app-graph");
      expect(shape(result.events), describeTrace(result)).toEqual(GRAPH);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
      expect(ofType(result.events, "model_response").map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [12, 5],
        [30, 7],
      ]);
    });
  });
});
