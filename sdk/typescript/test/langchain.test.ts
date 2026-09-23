import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "../src/integrations/core.js";
import {
  ABANDONED_ROOT_GRACE_MS,
  adapter,
  captureLimitOf,
  interruptIdOf,
  isCancellation,
  isControlFlow,
  langchainHandler,
  nodeOf,
  promptOf,
  readOptions,
  usageOf,
} from "../src/integrations/langchain.js";
import { setLogger } from "../src/logger.js";
import { agent, session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The LangChain adapter's translation table, driven with the callback
 * sequences LangChain.js and LangGraph.js actually dispatch — argument order,
 * metadata keys, tags and error shapes copied from recorded runs of
 * `@langchain/core` 0.3.80 / 1.2.12 and `@langchain/langgraph` 0.4.10 / 1.4.17.
 *
 * Every expectation is the Python adapter's output for the same run
 * (`sdk/python/failproofai_sdk/integrations/langchain.py`); many of these
 * are ports of `sdk/python/tests/integrations/test_langchain.py`, named after
 * the Python test they mirror. The real frameworks are exercised end to end in
 * `integration/langchain.test.ts`; this file pins the rules one at a time, fast
 * and with no framework installed.
 */

type Handler = Record<string | symbol, (...args: unknown[]) => unknown>;
type Event = Record<string, unknown>;

let spool: Spool;
let h: Handler;

beforeEach(() => {
  spool = useSpool();
  core.setStrict(true);
  core.resetFailures();
  h = langchainHandler() as Handler;
});
afterEach(async () => {
  adapter.uninstall();
  await spool.cleanup();
  core.setStrict(null);
  setLogger(null);
});

// -- a tiny LangChain -------------------------------------------------------

const msg = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  getType: () => type,
  content,
  ...extra,
});
const human = (content: string) => msg("human", content);
const callWeather = (id = "call_1", city = "Paris") =>
  msg("ai", "", { tool_calls: [{ id, name: "get_weather", args: { city }, type: "tool_call" }] });

const GRAPH = { lc: 1, type: "not_implemented", id: ["langgraph", "pregel", "CompiledStateGraph"] };
const MODEL = { lc: 1, type: "not_implemented", id: ["langchain", "chat_models", "scripted", "ScriptedModel"] };
const TOOL = { lc: 1, type: "not_implemented", id: ["langchain", "tools", "DynamicStructuredTool"] };

/** `handleChainStart(serialized, inputs, runId, parentRunId, tags, metadata, runType, runName)`. */
function chain(
  id: string,
  parent: string | undefined,
  name: string,
  opts: { inputs?: unknown; tags?: string[]; meta?: Record<string, unknown>; serialized?: unknown } = {},
): void {
  h.handleChainStart!(
    opts.serialized ?? { lc: 1, type: "constructor", id: ["langchain_core", "runnables", "RunnableSequence"] },
    opts.inputs ?? {},
    id,
    parent,
    opts.tags ?? [],
    opts.meta ?? {},
    undefined,
    name,
  );
}

function root(id: string, name: string, meta: Record<string, unknown> = {}, inputs: unknown = { messages: [human("weather?")] }) {
  chain(id, undefined, name, { inputs, meta: { ls_integration: "langgraph", ...meta }, serialized: GRAPH });
}

/** A LangGraph node's own run: named after the node, tagged `graph:step:N`. */
function node(id: string, parent: string, name: string, step: number, extra: Record<string, unknown> = {}) {
  chain(id, parent, name, {
    inputs: extra.inputs ?? { messages: [human("weather?")] },
    tags: [`graph:step:${step}`],
    meta: {
      langgraph_node: name,
      langgraph_step: step,
      langgraph_checkpoint_ns: (extra.ns) ?? `${name}:${id}`,
      ...(extra.meta as Record<string, unknown> | undefined),
    },
  });
}

function end(id: string, outputs: unknown = {}): void {
  h.handleChainEnd!(outputs, id);
}

function fail(id: string, error: unknown): void {
  h.handleChainError!(error, id);
}

function modelStart(id: string, parent: string | undefined, meta: Record<string, unknown> = {}, messages = [human("weather?")]) {
  h.handleChatModelStart!(MODEL, [messages], id, parent, { invocation_params: {} }, [], meta, undefined);
}

function modelEnd(id: string, message: Record<string, unknown> = msg("ai", "hi"), llmOutput?: Record<string, unknown>) {
  h.handleLLMEnd!({ generations: [[{ text: "", message }]], llmOutput }, id);
}

function toolStart(id: string, parent: string | undefined, input = '{"city":"Paris"}', toolCallId?: string, meta = {}) {
  h.handleToolStart!(TOOL, input, id, parent, [], meta, "get_weather", toolCallId);
}

function toolEnd(id: string, output: unknown = "sunny in Paris"): void {
  h.handleToolEnd!(output, id);
}

const events = (): Promise<Event[]> => flushed(spool);
const shape = (list: Event[]): string[] =>
  list.map((e) => [e.agent_id, e.type, e.hook_name ?? e.tool_name ?? ""].join(" ").trim());
const ofType = (list: Event[], type: string): Event[] => list.filter((e) => e.type === type);

/** The weather graph, exactly as LangGraph.js 1.x dispatches it. */
function weatherGraph(opts: { toolCallId?: boolean; meta?: Record<string, unknown> } = {}): void {
  const withId = opts.toolCallId ?? true;
  root("g", "weather_graph", opts.meta);
  chain("start", "g", "__start__", { tags: ["graph:step:0", "langsmith:hidden"], meta: { langgraph_node: "__start__", langgraph_step: 0 } });
  end("start");
  node("n1", "g", "agent", 1);
  modelStart("m1", "n1", { langgraph_node: "agent", langgraph_step: 1 });
  modelEnd("m1", msg("ai", "", {
    tool_calls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" }, type: "tool_call" }],
    usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
  }));
  chain("route1", "n1", "RunnableLambda", { meta: { langgraph_node: "agent", langgraph_step: 1 } });
  end("route1", { output: "tools" });
  end("n1");
  node("n2", "g", "tools", 2, { inputs: { messages: [human("weather?"), callWeather()] } });
  toolStart("t1", "n2", '{"city":"Paris"}', withId ? "call_1" : undefined, { langgraph_node: "tools" });
  toolEnd("t1", msg("tool", "sunny in Paris", { tool_call_id: "call_1", status: "success" }));
  end("n2");
  node("n3", "g", "agent", 3);
  modelStart("m2", "n3", { langgraph_node: "agent", langgraph_step: 3 });
  modelEnd("m2", msg("ai", "It is sunny in Paris.", {
    usage_metadata: { input_tokens: 30, output_tokens: 7, total_tokens: 37 },
    response_metadata: { finish_reason: "stop" },
  }));
  end("n3");
  end("g");
}

const GRAPH_SHAPE = [
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

class GraphInterrupt extends Error {
  interrupts: unknown[];
  constructor(interrupts: unknown[]) {
    super(JSON.stringify(interrupts));
    this.name = "GraphInterrupt";
    this.interrupts = interrupts;
  }
  get is_bubble_up(): boolean {
    return true;
  }
}

const command = (resume: unknown) => ({ lg_name: "Command", resume, goto: [] });

// -- the mapping ------------------------------------------------------------

describe("the graph mapping", () => {
  it("a_langgraph_node_is_a_hook_not_a_nested_agent", async () => {
    weatherGraph();
    const list = await events();
    expect(shape(list)).toEqual(GRAPH_SHAPE);
    for (const hook of ofType(list, "hook_triggered")) expect(hook.trigger_event).toBe("graph_node");
    // One agent, named after the graph, never a run id.
    expect(new Set(list.map((e) => e.agent_id))).toEqual(new Set(["weather_graph"]));
  });

  it("the root agent_start is the session's first event and every event carries one session", async () => {
    weatherGraph();
    const list = await events();
    expect(list[0]!.type).toBe("agent_start");
    expect(new Set(list.map((e) => e.session_id)).size).toBe(1);
    expect(list.every((e) => e.framework === "langchain")).toBe(true);
  });

  it("intermediate runnables, edge functions and hidden nodes emit nothing", async () => {
    weatherGraph();
    const names = (await events()).map((e) => e.hook_name).filter(Boolean);
    expect(names).not.toContain("__start__");
    expect(names).not.toContain("RunnableLambda");
  });

  it("carries the langgraph ids as fw_* extras, never as declared fields", async () => {
    weatherGraph();
    const hook = ofType(await events(), "hook_triggered")[0]!;
    expect(hook.fw_node).toBe("agent");
    expect(hook.fw_step).toBe(1);
    expect(hook.fw_run_id).toBe("n1");
    expect(hook.fw_parent_run_id).toBe("g");
    expect(hook.fw_tags).toEqual(["graph:step:1"]);
  });

  it("model events pair on request_id and always carry an int duration and the tokens", async () => {
    weatherGraph();
    const list = await events();
    const requests = ofType(list, "model_request");
    const responses = ofType(list, "model_response");
    expect(responses.map((r) => r.request_id)).toEqual(requests.map((r) => r.request_id));
    for (const response of responses) expect(Number.isInteger(response.duration_ms)).toBe(true);
    expect(responses.map((r) => [r.input_tokens, r.output_tokens])).toEqual([
      [12, 5],
      [30, 7],
    ]);
    expect(responses[1]!.usage).toEqual({ input_tokens: 30, output_tokens: 7, total_tokens: 37 });
    expect(responses[1]!.stop_reason).toBe("stop");
    expect(requests[0]!.model).toBe("ScriptedModel");
  });

  it("a node that returns a Command renders the messages inside it, not their serialization envelope", async () => {
    // `langchain`'s `createAgent` model node returns `{ output: [Command] }`.
    // A Command is neither a message nor LangChain `Serializable` (no
    // `lc_kwargs`), so the payload view used to hand it to `truncate` whole,
    // which dumps it through `toJSON()` — and the messages in its `update`
    // then through THEIRS, LangChain's `{lc, type: "constructor", id, kwargs}`
    // envelope: class paths with the content buried one level down.
    class Message {
      lc_kwargs = { content: "hi" };
      content = "hi";
      getType(): string {
        return "ai";
      }
      toJSON(): unknown {
        return { lc: 1, type: "constructor", id: ["langchain_core", "messages", "AIMessage"], kwargs: this.lc_kwargs };
      }
    }
    class Command {
      lg_name = "Command";
      update = { messages: [new Message()] };
      goto: string[] = [];
      toJSON(): unknown {
        return { lg_name: this.lg_name, update: this.update, resume: undefined, goto: this.goto };
      }
    }
    root("g", "weather_agent");
    node("n", "g", "model_request", 1);
    end("n", { output: [new Command()] });
    end("g");
    const done = ofType(await events(), "hook_completed")[0]!;
    expect(done.output).toEqual({
      output: [{ lg_name: "Command", update: { messages: [{ type: "ai", content: "hi" }] }, resume: null, goto: [] }],
    });
    expect(JSON.stringify(done.output)).not.toContain('"lc":1');
  });

  it("model_request carries normalized messages with their roles", async () => {
    root("g", "weather_graph");
    node("n", "g", "agent", 1);
    modelStart("m", "n", {}, [
      msg("system", "be brief"),
      human("weather?"),
      callWeather(),
      msg("tool", "sunny in Paris", { tool_call_id: "call_1" }),
    ]);
    modelEnd("m");
    end("n");
    end("g");
    expect(ofType(await events(), "model_request")[0]!.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" }, type: "tool_call" }],
      },
      { role: "tool", content: "sunny in Paris" },
    ]);
  });

  it("tool_use carries the MODEL's tool_call_id, and the tool's content not the message object", async () => {
    weatherGraph();
    const list = await events();
    expect(ofType(list, "tool_use")[0]!.tool_call_id).toBe("call_1");
    expect(ofType(list, "tool_use")[0]!.input).toEqual({ city: "Paris" });
    const result = ofType(list, "tool_result")[0]!;
    expect(result.tool_call_id).toBe("call_1");
    expect(result.output).toBe("sunny in Paris");
    expect(result.error).toBeUndefined();
  });

  it("recovers the tool_call_id on a core that does not pass one (0.3)", async () => {
    weatherGraph({ toolCallId: false });
    expect(ofType(await events(), "tool_use")[0]!.tool_call_id).toBe("call_1");
  });

  it("gives two identical tool calls their two different ids (0.3)", async () => {
    root("g", "weather_graph");
    node("n", "g", "tools", 1, {
      inputs: {
        messages: [
          msg("ai", "", {
            tool_calls: [
              { id: "call_a", name: "get_weather", args: { city: "Paris" } },
              { id: "call_b", name: "get_weather", args: { city: "Paris" } },
            ],
          }),
        ],
      },
    });
    toolStart("t1", "n");
    toolStart("t2", "n");
    toolEnd("t1");
    toolEnd("t2");
    end("n");
    end("g");
    const ids = ofType(await events(), "tool_use").map((e) => e.tool_call_id);
    expect(ids.sort()).toEqual(["call_a", "call_b"]);
  });

  it("falls back to the run id when no ancestor asked for the call", async () => {
    root("g", "weather_graph");
    node("n", "g", "tools", 1, { inputs: { messages: [human("hi")] } });
    toolStart("t1", "n");
    toolEnd("t1");
    end("n");
    end("g");
    expect(ofType(await events(), "tool_use")[0]!.tool_call_id).toBe("t1");
  });

  it("a_compiled_subgraph_becomes_a_nested_agent", async () => {
    root("p", "parent_graph", {}, { trail: [] });
    node("pre", "p", "pre", 1, { inputs: { trail: [] } });
    end("pre");
    node("host", "p", "child", 2, { ns: "child:aaa" });
    chain("sub", "host", "child_graph", { meta: { langgraph_node: "child" }, serialized: GRAPH });
    node("inner", "sub", "inner", 1, { ns: "child:aaa|inner:bbb" });
    end("inner");
    end("sub");
    end("host");
    end("p");
    const list = await events();
    expect(shape(list)).toEqual([
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
    expect(ofType(list, "agent_start")[1]!.parent_id).toBe("parent_graph");
  });

  it("records a bare model call as a root agent with its model pair inside", async () => {
    modelStart("m", undefined);
    modelEnd("m", msg("ai", "hi", { usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }));
    const list = await events();
    expect(shape(list)).toEqual([
      "ScriptedModel agent_start",
      "ScriptedModel model_request",
      "ScriptedModel model_response",
      "ScriptedModel agent_end",
    ]);
    expect(ofType(list, "model_request")[0]!.request_id).toBe(ofType(list, "model_response")[0]!.request_id);
    expect(ofType(list, "agent_start")[0]!.goal).toBe("weather?");
  });

  it("records a bare tool call as a root agent with its tool pair inside", async () => {
    toolStart("t", undefined, '{"city":"Rome"}');
    toolEnd("t", "sunny in Rome");
    expect(shape(await events())).toEqual([
      "get_weather agent_start",
      "get_weather tool_use get_weather",
      "get_weather tool_result get_weather",
      "get_weather agent_end",
    ]);
  });

  it("two_overlapping_roots_in_one_session_are_two_agents", async () => {
    // `.batch()` opens one root per input, concurrently.
    const handler = langchainHandler({ sessionId: "shared" }) as Handler;
    expect(handler).toBe(h);
    modelStart("a", undefined);
    modelStart("b", undefined);
    modelEnd("a");
    modelEnd("b");
    const list = await events();
    expect(ofType(list, "agent_start")).toHaveLength(2);
    expect(ofType(list, "agent_end")).toHaveLength(2);
    expect(ofType(list, "model_response")).toHaveLength(2);
    expect(ofType(list, "human_input")).toHaveLength(0);
  });

  it("retriever output is summarized, never the document text", async () => {
    root("g", "rag");
    h.handleRetrieverStart!({ id: ["x", "VectorStoreRetriever"] }, "kites", "r", "g", [], {}, undefined);
    h.handleRetrieverEnd!(
      [
        { pageContent: "a very long document", metadata: { source: "a.txt" } },
        { pageContent: "another", metadata: {} },
      ],
      "r",
    );
    end("g");
    const list = await events();
    expect(ofType(list, "tool_use")[0]!.tool_name).toBe("retriever:VectorStoreRetriever");
    expect(ofType(list, "tool_use")[0]!.input).toEqual({ query: "kites" });
    expect(ofType(list, "tool_result")[0]!.output).toEqual({ n: 2, sources: ["a.txt", "doc[1]"] });
  });

  it("streaming never emits per-token events; it folds into the model_response", async () => {
    modelStart("m", undefined);
    for (let i = 0; i < 5; i += 1) h.handleLLMNewToken!("x", {}, "m");
    modelEnd("m", msg("ai", "xxxxx"));
    const list = await events();
    expect(list.map((e) => e.type)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    const response = ofType(list, "model_response")[0]!;
    expect(response.fw_streamed).toBe(true);
    expect(response.fw_chunks).toBe(5);
    expect(Number.isInteger(response.fw_ttft_ms)).toBe(true);
  });

  it("records an intermediate chain only when includeChains names it", async () => {
    adapter.uninstall();
    h = langchainHandler({ includeChains: ["summarise"] }) as Handler;
    chain("p", undefined, "pipeline", { inputs: { input: "abc" } });
    chain("s1", "p", "RunnableLambda", { tags: ["seq:step:1"] });
    end("s1");
    chain("s2", "p", "summarise", { tags: ["seq:step:2"], inputs: { input: "abc" } });
    end("s2", { output: "ABC" });
    end("p");
    const list = await events();
    expect(shape(list)).toEqual([
      "pipeline agent_start",
      "pipeline hook_triggered summarise",
      "pipeline hook_completed summarise",
      "pipeline agent_end",
    ]);
    expect(ofType(list, "hook_triggered")[0]!.trigger_event).toBe("pipeline");
  });
});

describe("the node filter", () => {
  const meta = { langgraph_node: "lookup" };

  it("matches a node's own run", () => {
    expect(nodeOf({ name: "lookup", runType: "chain", tags: ["graph:step:1"] }, meta)).toBe("lookup");
  });

  it("a_node_named_after_its_tool_still_records_the_tool", () => {
    expect(nodeOf({ name: "lookup", runType: "tool", tags: [] }, meta)).toBeNull();
  });

  it("a_node_named_after_its_model_still_records_the_model", () => {
    expect(nodeOf({ name: "lookup", runType: "chat_model", tags: [] }, meta)).toBeNull();
  });

  it("an_inner_runnable_sharing_the_node_name_is_not_a_second_visit", () => {
    expect(nodeOf({ name: "lookup", runType: "chain", tags: ["seq:step:2"] }, meta)).toBeNull();
  });

  it("an inner runnable that merely inherits the metadata is not the node", () => {
    expect(nodeOf({ name: "RunnableLambda", runType: "chain", tags: [] }, meta)).toBeNull();
  });

  it("records the tool pair when a ToolNode is named after its tool", async () => {
    root("g", "graph");
    node("n", "g", "get_weather", 1, { inputs: { messages: [callWeather()] } });
    // The tool's own run has the SAME name and inherits the node metadata.
    h.handleToolStart!(TOOL, '{"city":"Paris"}', "t", "n", [], { langgraph_node: "get_weather" }, "get_weather", "call_1");
    toolEnd("t");
    end("n");
    end("g");
    expect(shape(await events())).toEqual([
      "graph agent_start",
      "graph hook_triggered get_weather",
      "graph tool_use get_weather",
      "graph tool_result get_weather",
      "graph hook_completed get_weather",
      "graph agent_end",
    ]);
  });
});

// -- failure ----------------------------------------------------------------

describe("failure", () => {
  it("a_failed_model_call_is_reported_on_the_model_span_and_counted_once", async () => {
    root("g", "weather_graph");
    node("n", "g", "agent", 1);
    modelStart("m", "n");
    h.handleLLMError!(new Error("model exploded"), "m");
    fail("n", new Error("model exploded"));
    fail("g", new Error("model exploded"));
    const list = await events();
    expect(shape(list)).toEqual([
      "weather_graph agent_start",
      "weather_graph hook_triggered agent",
      "weather_graph model_request",
      "weather_graph model_response",
      "weather_graph hook_completed agent",
      "weather_graph agent_end",
    ]);
    const response = ofType(list, "model_response")[0]!;
    expect(response.error).toBe("Error: model exploded");
    expect(response.stop_reason).toBe("error");
    expect(ofType(list, "hook_completed")[0]!.outcome).toBe("failed");
    const endEvent = ofType(list, "agent_end")[0]!;
    expect(endEvent.outcome).toBe("failed");
    expect(endEvent.summary).toBe("Error: model exploded");
    expect(ofType(list, "error")).toHaveLength(0);
  });

  it("a_failure_no_span_owns_produces_exactly_one_error_event", async () => {
    // `prompt | model | parser` whose parser raised: no span owns it.
    chain("p", undefined, "RunnableSequence", { inputs: { input: "x" } });
    chain("parser", "p", "StrOutputParser", { tags: ["seq:step:3"] });
    fail("parser", new TypeError("cannot parse"));
    fail("p", new TypeError("cannot parse"));
    const list = await events();
    expect(list.map((e) => e.type)).toEqual(["agent_start", "error", "agent_end"]);
    const error = ofType(list, "error")[0]!;
    expect(error.error_type).toBe("TypeError");
    // The bare message: the server prefixes the type itself.
    expect(error.message).toBe("cannot parse");
    expect(ofType(list, "agent_end")[0]!.outcome).toBe("failed");
  });

  it("a_failing_bare_tool_reports_its_error_once", async () => {
    toolStart("t", undefined);
    h.handleToolError!(new Error("no weather"), "t");
    const list = await events();
    expect(ofType(list, "tool_result")[0]!.error).toBe("Error: no weather");
    expect(ofType(list, "error")).toHaveLength(0);
    expect(ofType(list, "agent_end")[0]!.outcome).toBe("failed");
  });

  it("a_tool_that_fails_without_raising_is_still_an_error", async () => {
    root("g", "graph");
    node("n", "g", "tools", 1, { inputs: { messages: [callWeather()] } });
    toolStart("t", "n", '{"city":"Paris"}', "call_1");
    toolEnd("t", msg("tool", "Error: no weather\n Please fix your mistakes.", { status: "error", tool_call_id: "call_1" }));
    end("n");
    end("g");
    const result = ofType(await events(), "tool_result")[0]!;
    expect(result.error).toBe("Error: no weather\n Please fix your mistakes.");
    expect(result.output).toBe("Error: no weather\n Please fix your mistakes.");
  });

  it("a cancelled run ends cancelled, with no error event", async () => {
    root("g", "graph");
    node("n", "g", "agent", 1);
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    fail("n", abort);
    fail("g", abort);
    const list = await events();
    expect(ofType(list, "hook_completed")[0]!.outcome).toBe("cancelled");
    expect(ofType(list, "agent_end")[0]!.outcome).toBe("cancelled");
    expect(ofType(list, "error")).toHaveLength(0);
  });

  it("closes a root LangGraph abandoned after an abort, once it has been silent", async () => {
    vi.useFakeTimers();
    try {
      root("g", "abort_graph");
      node("n", "g", "slow", 1);
      const abort = new Error("This operation was aborted");
      abort.name = "AbortError";
      fail("n", abort);
      // LangGraph.js 1.x: no end callback for the root, ever.
      vi.advanceTimersByTime(ABANDONED_ROOT_GRACE_MS - 1);
      expect(ofType(await events(), "agent_end")).toHaveLength(0);
      vi.advanceTimersByTime(1);
      const list = await events();
      expect(list.map((e) => e.type)).toEqual(["agent_start", "hook_triggered", "hook_completed", "agent_end"]);
      expect(ofType(list, "agent_end")[0]!.outcome).toBe("cancelled");
      expect(ofType(list, "error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reap a root that carried on after a node's own abort (a retry)", async () => {
    vi.useFakeTimers();
    try {
      root("g", "graph");
      node("n1", "g", "fetch", 1);
      const abort = new Error("timed out");
      abort.name = "AbortError";
      fail("n1", abort);
      vi.advanceTimersByTime(500);
      node("n2", "g", "fetch", 1); // the retry
      vi.advanceTimersByTime(ABANDONED_ROOT_GRACE_MS * 2);
      expect(ofType(await events(), "agent_end")).toHaveLength(0);
      end("n2");
      end("g");
      const list = await events();
      expect(ofType(list, "agent_end").map((e) => e.outcome)).toEqual(["success"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies control flow and cancellation", () => {
    expect(isControlFlow(new GraphInterrupt([]))).toBe(true);
    const named = new Error("x");
    named.name = "ParentCommand";
    expect(isControlFlow(named)).toBe(true);
    expect(isControlFlow(new Error("x"))).toBe(false);
    expect(isCancellation(new Error("Aborted"))).toBe(true);
    expect(isCancellation(new Error("Abort"))).toBe(true);
    expect(isCancellation(Object.assign(new Error("x"), { code: "ABORT_ERR" }))).toBe(true);
    expect(isCancellation(new Error("x"))).toBe(false);
  });

  it("open leaves are closed when the root run ends without them", async () => {
    root("g", "graph");
    node("n", "g", "tools", 1, { inputs: { messages: [callWeather()] } });
    toolStart("t", "n", '{"city":"Paris"}', "call_1");
    // The framework skipped both end callbacks.
    end("g");
    const list = await events();
    const result = ofType(list, "tool_result")[0]!;
    expect(result.fw_incomplete).toBe(true);
    expect(ofType(list, "hook_completed")[0]!.outcome).toBe("cancelled");
    expect(list.at(-1)!.type).toBe("agent_end");
  });
});

// -- human in the loop ------------------------------------------------------

function interruptRun(rootId = "r1", threadId = "t-1"): void {
  root(rootId, "hitl_graph", { thread_id: threadId }, { trail: [] });
  node(`${rootId}-approve`, rootId, "approve", 2, { inputs: { trail: ["plan"] } });
  fail(`${rootId}-approve`, new GraphInterrupt([{ id: "int-1", value: { prompt: "ship it?", options: ["yes", "no"] } }]));
  end(rootId, { trail: ["plan"] });
}

describe("human in the loop", () => {
  it("interrupt_and_resume_emit_both_pairs_in_order", async () => {
    interruptRun();
    root("r2", "hitl_graph", { thread_id: "t-1" }, command("yes"));
    node("r2-approve", "r2", "approve", 2);
    end("r2-approve", { trail: ["approve:yes"] });
    end("r2");
    const list = await events();
    expect(shape(list)).toEqual([
      "hitl_graph agent_start",
      "hitl_graph hook_triggered approve",
      "hitl_graph hook_completed approve",
      "hitl_graph human_wait",
      "hitl_graph agent_pause",
      "hitl_graph agent_resume",
      "hitl_graph human_input",
      "hitl_graph hook_triggered approve",
      "hitl_graph hook_completed approve",
      "hitl_graph agent_end",
    ]);
    expect(ofType(list, "hook_completed")[0]!.outcome).toBe("paused");
    const wait = ofType(list, "human_wait")[0]!;
    expect([wait.input_id, wait.prompt, wait.options]).toEqual(["int-1", "ship it?", ["yes", "no"]]);
    const answer = ofType(list, "human_input")[0]!;
    expect([answer.input_id, answer.response, answer.fw_prompt]).toEqual(["int-1", "yes", "ship it?"]);
    expect(ofType(list, "agent_end")[0]!.outcome).toBe("success");
    expect(new Set(list.map((e) => e.session_id))).toEqual(new Set(["t-1"]));
  });

  it("an_interrupt_is_control_flow_not_an_error", async () => {
    interruptRun();
    const list = await events();
    expect(ofType(list, "error")).toHaveLength(0);
    // Deliberately still open: the resume closes it.
    expect(ofType(list, "agent_end")).toHaveLength(0);
  });

  it("the_two_interrupt_paths_do_not_double_emit", async () => {
    root("r1", "hitl_graph", { thread_id: "t-1" }, { trail: [] });
    node("a", "r1", "approve", 2);
    const interrupts = [{ id: "int-1", value: "ok?" }];
    fail("a", new GraphInterrupt(interrupts));
    // LangGraph.js >= 1 also delivers it through the lifecycle callback.
    h.handleInterrupt!({ runId: "r1", status: "pending", checkpointNs: [], interrupts });
    end("r1");
    const list = await events();
    expect(ofType(list, "human_wait")).toHaveLength(1);
    expect(ofType(list, "agent_pause")).toHaveLength(1);
  });

  it("interrupt events survive without the graph lifecycle callbacks", async () => {
    adapter.uninstall();
    h = langchainHandler({ graphCallbacks: false }) as Handler;
    expect(h[Symbol.for("langgraph.graph_callback_handler")]).toBe(false);
    interruptRun();
    expect(ofType(await events(), "human_wait")).toHaveLength(1);
  });

  it("carries the LangGraph lifecycle marker by default", () => {
    expect(h[Symbol.for("langgraph.graph_callback_handler")]).toBe(true);
  });

  it("an_unrelated_run_during_a_pause_is_not_read_as_the_approval", async () => {
    interruptRun();
    // A different graph on the same thread, with FRESH state.
    root("other", "other", { thread_id: "t-1" }, { vals: [] });
    end("other");
    const list = await events();
    expect(ofType(list, "agent_resume")).toHaveLength(0);
    expect(ofType(list, "human_input")).toHaveLength(0);
    expect(ofType(list, "agent_start").map((e) => e.agent_id)).toContain("other");
  });

  it("a_none_input_is_still_a_continuation_of_the_pause", async () => {
    interruptRun();
    root("r2", "hitl_graph", { thread_id: "t-1" }, { input: null });
    end("r2");
    const list = await events();
    expect(ofType(list, "agent_start")).toHaveLength(1);
    expect(ofType(list, "agent_resume")).toHaveLength(1);
  });

  it("an_unrelated_runnable_invoked_with_none_is_not_the_humans_approval", async () => {
    interruptRun();
    // `someRunnable.invoke(null)` inside the same session scope: the same
    // `{input: null}` shape, but no graph metadata.
    langchainHandler({ sessionId: "t-1" });
    chain("hb", undefined, "heartbeat", { inputs: { input: null } });
    end("hb");
    const list = await events();
    expect(ofType(list, "agent_resume")).toHaveLength(0);
  });

  it("closes a paused agent as cancelled at uninstall", async () => {
    interruptRun();
    adapter.uninstall();
    const list = await events();
    expect(list.at(-1)!.type).toBe("agent_end");
    expect(list.at(-1)!.outcome).toBe("cancelled");
  });

  it("drops the prompt and the answer under captureContent: false", async () => {
    adapter.uninstall();
    h = langchainHandler({ captureContent: false }) as Handler;
    interruptRun();
    root("r2", "hitl_graph", { thread_id: "t-1" }, command("yes"));
    end("r2");
    const list = await events();
    expect(ofType(list, "human_wait")[0]!.prompt).toBeUndefined();
    expect(ofType(list, "human_wait")[0]!.options).toBeUndefined();
    expect(ofType(list, "human_input")[0]!.response).toBeUndefined();
    expect(ofType(list, "human_input")[0]!.fw_prompt).toBeUndefined();
  });

  it("reads a prompt out of the interrupt payload", () => {
    expect(promptOf({ question: "ok?", options: ["y", 2] })).toEqual({ prompt: "ok?", options: ["y", "2"] });
    expect(promptOf("plain")).toEqual({ prompt: "plain" });
    expect(promptOf({ record: 1 })).toEqual({ prompt: '{"record":1}', options: undefined });
  });

  it("derives no cross-process pause id when LangGraph is not installed", () => {
    // The remote path degrades to "no resume pair", never to a made-up id.
    expect(interruptIdOf("approve:1234")).toBeNull();
  });
});

// -- sessions ---------------------------------------------------------------

describe("session resolution", () => {
  it("an explicit sessionId option wins over everything", async () => {
    adapter.uninstall();
    h = langchainHandler({ sessionId: "opt" }) as Handler;
    weatherGraph({ meta: { failproofai_sdk_session_id: "meta", thread_id: "th" } });
    expect(new Set((await events()).map((e) => e.session_id))).toEqual(new Set(["opt"]));
  });

  it("session_id_prefers_the_documented_metadata_key_over_thread_id", async () => {
    weatherGraph({ meta: { failproofai_sdk_session_id: "meta", thread_id: "th" } });
    expect(new Set((await events()).map((e) => e.session_id))).toEqual(new Set(["meta"]));
  });

  it("session_id_falls_back_to_thread_id", async () => {
    weatherGraph({ meta: { thread_id: "th" } });
    expect(new Set((await events()).map((e) => e.session_id))).toEqual(new Set(["th"]));
  });

  it("session_id_falls_back_to_the_root_run_id", async () => {
    weatherGraph();
    expect(new Set((await events()).map((e) => e.session_id))).toEqual(new Set(["g"]));
  });

  it("an_ambient_agent_scope_and_the_adapter_produce_one_tree", async () => {
    await session({ sessionId: "req-1" }, () =>
      agent("planner", () => {
        weatherGraph({ meta: { thread_id: "th" } });
      }),
    );
    const list = await events();
    expect(new Set(list.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
    const graphStart = ofType(list, "agent_start").find((e) => e.agent_id === "weather_graph")!;
    expect(graphStart.parent_id).toBe("planner");
  });
});

// -- options and teardown ---------------------------------------------------

describe("options", () => {
  it("captureContent: false keeps structure, durations and tokens, and drops the rest", async () => {
    adapter.uninstall();
    h = langchainHandler({ captureContent: false }) as Handler;
    weatherGraph();
    const list = await events();
    expect(shape(list)).toEqual(GRAPH_SHAPE);
    for (const event of list) {
      for (const key of ["goal", "input", "output", "messages", "content"]) {
        expect(event[key], `${String(event.type)}.${key}`).toBeUndefined();
      }
    }
    expect(ofType(list, "model_response").map((e) => e.output_tokens)).toEqual([5, 7]);
  });

  it("captureLimit bounds captured values", async () => {
    adapter.uninstall();
    h = langchainHandler({ captureLimit: 20 }) as Handler;
    toolStart("t", undefined);
    toolEnd("t", "x".repeat(200));
    const output = ofType(await events(), "tool_result")[0]!.output as string;
    expect(output.length).toBeLessThanOrEqual(20);
    expect(output.endsWith(core.TRUNCATION_MARKER)).toBe(true);
  });

  it("an unusable captureLimit falls back rather than throwing", () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(captureLimitOf(undefined)).toBe(core.FIELD_LIMIT);
    expect(captureLimitOf("4096")).toBe(4096);
    for (const bad of [Infinity, Number.NaN, -1, 0, 1.5, "lots", {}]) {
      expect(captureLimitOf(bad)).toBe(core.FIELD_LIMIT);
    }
  });

  it("reads Python's option names in camelCase, and ignores other adapters' options", () => {
    const options = readOptions({
      sessionId: "s",
      includeChains: "one",
      captureContent: false,
      graphCallbacks: false,
      steps: false,
    });
    expect(options.sessionId).toBe("s");
    expect([...options.includeChains]).toEqual(["one"]);
    expect(options.captureContent).toBe(false);
    expect(options.graphCallbacks).toBe(false);
    expect(readOptions({ includeChains: ["a", "b"] }).includeChains).toEqual(new Set(["a", "b"]));
  });

  it("uninstall stops recording, even through a handler already handed out", async () => {
    adapter.uninstall();
    modelStart("m", undefined);
    modelEnd("m");
    expect(await events()).toEqual([]);
  });

  it("asking for the handler again after uninstall records again", async () => {
    adapter.uninstall();
    h = langchainHandler() as Handler;
    modelStart("m", undefined);
    modelEnd("m");
    expect((await events()).map((e) => e.type)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "agent_end",
    ]);
  });

  it("follows strict mode for LangChain's own handler firewall", () => {
    core.setStrict(false);
    expect(h.raiseError).toBe(false);
    core.setStrict(true);
    expect(h.raiseError).toBe(true);
  });

  it("is awaited, so its events stay in the caller's async context and order", () => {
    expect(h.awaitHandlers).toBe(true);
  });
});

describe("token counts", () => {
  it("prefers usage_metadata, with its detail", () => {
    expect(
      usageOf({
        generations: [[{ message: { usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_token_details: { cache_read: 1 } } } }]],
      }),
    ).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7, input_token_details: { cache_read: 1 } });
  });

  it("falls back to llmOutput in both spellings", () => {
    expect(usageOf({ generations: [[{ text: "" }]], llmOutput: { tokenUsage: { promptTokens: 9, completionTokens: 8 } } })).toEqual({
      input_tokens: 9,
      output_tokens: 8,
      total_tokens: 17,
    });
    expect(usageOf({ generations: [], llmOutput: { token_usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } })).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    });
    expect(usageOf({ generations: [] })).toBeUndefined();
  });
});
