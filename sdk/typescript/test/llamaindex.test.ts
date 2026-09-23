import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogger } from "../src/logger.js";
import * as compat from "../src/integrations/compat.js";
import * as core from "../src/integrations/core.js";
import {
  adapter,
  attach,
  parseOptions,
  summarizeNodes,
  usageOf,
  type WorkflowModule,
} from "../src/integrations/llamaindex.js";
import { runtime } from "../src/runtime.js";
import { session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The LlamaIndex.TS adapter's logic, against stand-ins for the two framework
 * surfaces it attaches to: the callback bus and the workflow runtime's context
 * middleware. `integration/llamaindex.test.ts` proves the same against real
 * releases; this proves the cases a real scripted run cannot reach cheaply —
 * a model call that throws, a stale leaf, a subscriber that is not there.
 */

type Event = Record<string, unknown>;

/** `Settings.callbackManager`, dispatching synchronously with an EventCaller chain. */
class FakeBus {
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  on(event: string, handler: (event: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  off(event: string, handler: (event: unknown) => void): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    );
    return this;
  }
  emit(event: string, detail: Event, callers: unknown[] = []): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ detail, reason: { computedCallers: callers } });
    }
  }
  /** Dispatch with a real-shaped `EventCaller` as `reason` (see `EventCaller` below). */
  emitReason(event: string, detail: Event, reason: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ detail, reason });
    }
  }
  count(): number {
    return [...this.handlers.values()].reduce((sum, list) => sum + list.length, 0);
  }
}

function subscribable() {
  const subs = new Set<(...args: never[]) => unknown>();
  return {
    subs,
    subscribe(callback: (...args: never[]) => unknown) {
      subs.add(callback);
      return () => subs.delete(callback);
    },
  };
}

/** A workflow-core context, reduced to the two middleware hooks and a step runner. */
function fakeContext() {
  const callContext = subscribable();
  const sendEvent = subscribable();
  return {
    __internal__call_context: callContext,
    __internal__call_send_event: sendEvent,
    step(handler: (...args: unknown[]) => unknown, input: unknown): unknown {
      const cbs = [...callContext.subs] as Array<(c: unknown, next: (c: unknown) => void) => void>;
      let i = 0;
      let result: unknown;
      const next = (context: unknown): void => {
        if (i === cbs.length) {
          const c = context as { handler: (...a: unknown[]) => unknown; inputs: unknown[] };
          result = c.handler(this, ...c.inputs);
          return;
        }
        cbs[i++]!(context, next);
      };
      next({ handler, inputs: [input] });
      return result;
    },
    send(event: unknown): void {
      for (const sub of sendEvent.subs) (sub as (e: unknown, h: unknown) => void)(event, {});
    },
  };
}

type Ctx = ReturnType<typeof fakeContext>;
const ev = (kind: string, data: Event = {}) => ({ kind, data });
const is = (kind: string) => ({ include: (event: unknown) => (event as { kind?: unknown })?.kind === kind });

/** An `AgentWorkflow`: step handlers are instance arrow fields, as in the real one. */
class AgentWorkflow {
  workflow: { createContext: () => Ctx };
  agents: Map<string, { llm: { metadata: { model: string } } }>;
  rootAgentName: string;
  done: Promise<void> = Promise.resolve();
  input: unknown;
  program: (ctx: Ctx, self: AgentWorkflow) => Promise<void>;
  handleInputStep: (ctx: unknown, event: unknown) => Promise<void> = async () => {};
  runAgentStep: (ctx: unknown, event: unknown) => Promise<void> = async () => {};
  executeToolCalls: (ctx: unknown, event: unknown) => Promise<void> = async () => {};

  constructor(names: string[], program: AgentWorkflow["program"]) {
    this.workflow = { createContext: () => fakeContext() };
    this.agents = new Map(names.map((name) => [name, { llm: { metadata: { model: `${name}-model` } } }]));
    this.rootAgentName = names[0]!;
    this.program = program;
  }

  runStream(input: unknown): string {
    this.input = input;
    const ctx = this.workflow.createContext();
    this.done = this.program(ctx, this);
    return "stream";
  }
}

const workflowModule = (): WorkflowModule => ({
  AgentWorkflow,
  stopAgentEvent: is("stop"),
  agentToolCallEvent: is("toolCall"),
  agentToolCallResultEvent: is("toolResult"),
});

let spool: Spool;
let bus: FakeBus;

function install(options: Record<string, unknown> = {}, workflows: WorkflowModule[] = [workflowModule()]) {
  bus = new FakeBus();
  return attach({ reaperInterval: 0, ...options }, {
    globals: [{ Settings: { callbackManager: bus } }],
    workflows,
  });
}

const shape = (events: Event[]): string[] =>
  events.map((e) => [e.agent_id, e.type, (e.hook_name ?? e.tool_name ?? "") as string].join(" ").trim());

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
  core.setStrict(true);
});
afterEach(async () => {
  adapter.uninstall();
  core.setStrict(null);
  compat.setStrictIntegrations(null);
  compat.resetWarnings();
  await spool.cleanup();
  setLogger(null);
});

describe("usage extraction", () => {
  it("finds a streamed call's usage on the chunk that carries it", () => {
    // `wrapLLMEvent` hands `llm-end` the ARRAY of chunks as `raw`; OpenAI puts
    // the usage on the last, content-less one.
    const usage = usageOf({
      raw: [{ delta: "hi", raw: { choices: [] } }, { delta: "", raw: { usage: { prompt_tokens: 7, completion_tokens: 3 } } }],
    });
    expect(usage).toEqual({ usage: { prompt_tokens: 7, completion_tokens: 3 }, inputTokens: 7, outputTokens: 3 });
  });

  it("reads a non-streamed response and the camelCase spellings", () => {
    expect(usageOf({ raw: { usage: { inputTokens: 4, outputTokens: 2 } } })).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(usageOf({ raw: { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } } })).toMatchObject({
      inputTokens: 9,
      outputTokens: 1,
    });
  });

  it("ships an unrecognised usage object without inventing token counts", () => {
    expect(usageOf({ raw: { usage: { units: 12 } } })).toEqual({ usage: { units: 12 }, inputTokens: undefined, outputTokens: undefined });
    expect(usageOf({ raw: null })).toEqual({});
    expect(usageOf(undefined)).toEqual({});
  });
});

describe("summarizeNodes", () => {
  it("keeps the count, the scores and a prefix of the top few", () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({
      node: { id_: `n${i}`, getContent: () => "x".repeat(500) },
      score: i / 10,
    }));
    const summary = summarizeNodes(nodes);
    expect(summary.num_nodes).toBe(7);
    expect(summary.top).toHaveLength(5);
    expect(summary.top[0]).toMatchObject({ id: "n0", score: 0 });
    expect(String(summary.top[0]!.text).length).toBeLessThanOrEqual(200);
    expect(summarizeNodes(undefined)).toEqual({ num_nodes: 0, top: [] });
  });
});

describe("options", () => {
  it("mirrors the Python adapter's options, in camelCase", () => {
    expect(parseOptions({})).toEqual({
      captureMessages: true,
      steps: true,
      embeddings: false,
      staleAfter: 600,
      reaperInterval: 30,
      captureLimit: undefined,
    });
    expect(parseOptions({ captureMessages: false, steps: false, embeddings: true, staleAfter: 5, reaperInterval: 0 })).toMatchObject({
      captureMessages: false,
      steps: false,
      embeddings: true,
      staleAfter: 5,
      reaperInterval: 0,
    });
  });
});

describe("the callback bus", () => {
  class LLMAgent {
    llm = { metadata: { model: "legacy-model" } };
  }

  it("records a legacy task as ONE agent across every step, not one per step", async () => {
    install();
    const runner = new LLMAgent();
    const step1 = { id: "s1", prevStep: null, context: { store: { messages: [{ content: "weather?" }] } } };
    const step2 = { id: "s2", prevStep: step1, context: {} };
    // `agent-start` fires for EVERY step, `agent-end` only after the last.
    bus.emit("agent-start", { startStep: step1 }, [runner]);
    bus.emit("llm-start", { id: "m1", messages: [] }, [runner]);
    bus.emit("llm-end", { id: "m1", response: { message: { content: "" }, raw: { usage: { prompt_tokens: 1, completion_tokens: 1 } } } }, [runner]);
    bus.emit("llm-tool-call", { toolCall: { id: "t1", name: "get_weather", input: { city: "Rome" } } }, [runner]);
    bus.emit("agent-start", { startStep: step2 }, [runner]);
    // `callTool` dispatched no `llm-tool-result` — the tool threw. The next model
    // call carries its result, with `isError`.
    bus.emit(
      "llm-start",
      { id: "m2", messages: [{ role: "user", content: "x", options: { toolResult: { id: "t1", result: "Error: boom", isError: true } } }] },
      [runner],
    );
    bus.emit("llm-end", { id: "m2", response: { message: { content: "It is sunny." } } }, [runner]);
    bus.emit("agent-end", { endStep: step2 }, [runner]);

    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "LLMAgent agent_start",
      "LLMAgent model_request",
      "LLMAgent model_response",
      "LLMAgent tool_use get_weather",
      "LLMAgent tool_result get_weather",
      "LLMAgent model_request",
      "LLMAgent model_response",
      "LLMAgent agent_end",
    ]);
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
    expect(events.find((e) => e.type === "tool_result")!.error).toBe("Error: boom");
    expect(events.find((e) => e.type === "model_request")!.model).toBe("legacy-model");
    const end = events.find((e) => e.type === "agent_end")!;
    expect(end.outcome).toBe("success");
    expect(end.summary).toBe("It is sunny.");
    expect(events[0]!.goal).toBe("weather?");
  });

  it("defers a run's end until its streamed model call has been consumed", async () => {
    install();
    const runner = new LLMAgent();
    const step = { id: "s1", prevStep: null };
    bus.emit("agent-start", { startStep: step }, [runner]);
    bus.emit("llm-start", { id: "m1", messages: [] }, [runner]);
    bus.emit("llm-stream", { id: "m1", chunk: { delta: "a" } }, [runner]);
    // The last step returns a stream: `agent-end` fires before anyone reads it.
    bus.emit("agent-end", { endStep: step }, [runner]);
    bus.emit(
      "llm-end",
      { id: "m1", response: { message: { content: "a" }, raw: [{ raw: {} }, { raw: { usage: { input_tokens: 5, output_tokens: 2 } } }] } },
      [runner],
    );
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["LLMAgent agent_start", "LLMAgent model_request", "LLMAgent model_response", "LLMAgent agent_end"]);
    const response = events.find((e) => e.type === "model_response")!;
    expect([response.input_tokens, response.output_tokens]).toEqual([5, 2]);
    expect(response.fw_chunks).toBe(2);
    expect(typeof response.fw_ttft_ms).toBe("number");
    expect(typeof response.duration_ms).toBe("number");
  });

  it("makes a bare model call its own run, named after the model's class", async () => {
    install();
    class OpenAI {
      metadata = { model: "gpt-x" };
    }
    const llm = new OpenAI();
    bus.emit("llm-start", { id: "m1", messages: [{ role: "user", content: "hi" }] }, [llm]);
    bus.emit("llm-end", { id: "m1", response: { message: { content: "hello" } } }, [llm]);
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["OpenAI agent_start", "OpenAI model_request", "OpenAI model_response", "OpenAI agent_end"]);
    expect(events.find((e) => e.type === "model_request")!.model).toBe("gpt-x");
    expect(events[1]!.request_id).toBe("m1");
    expect(events[2]!.request_id).toBe("m1");
  });

  it("joins an enclosing session() scope instead of inventing one", async () => {
    install();
    await session({ sessionId: "req-9" }, () => {
      bus.emit("llm-start", { id: "m1", messages: [] });
      bus.emit("llm-end", { id: "m1", response: {} });
    });
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["llm agent_start", "llm model_request", "llm model_response", "llm agent_end"]);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["req-9"]));
  });

  it("records a top-level query engine call as a run, with its retrieval inside it", async () => {
    install();
    class RetrieverQueryEngine {}
    const engine = new RetrieverQueryEngine();
    bus.emit("query-start", { id: "q1", query: "what?" }, [engine]);
    bus.emit("retrieve-start", { id: "r1", query: { query: "what?" } }, [engine]);
    bus.emit("retrieve-end", { id: "r1", nodes: [{ node: { id_: "a", text: "alpha" }, score: 0.9 }] }, [engine]);
    bus.emit("synthesize-start", { id: "y1" }, [engine]);
    bus.emit("query-end", { id: "q1", response: { message: { content: "answer" } } }, [engine]);
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "RetrieverQueryEngine agent_start",
      "RetrieverQueryEngine tool_use retriever",
      "RetrieverQueryEngine tool_result retriever",
      "RetrieverQueryEngine agent_end",
    ]);
    expect(events[2]!.output).toEqual({ num_nodes: 1, top: [{ id: "a", score: 0.9, text: "alpha" }] });
    expect(events[3]!.summary).toBe("answer");
  });

  it("suffixes a repeated tool call id within one run rather than pairing it wrongly", async () => {
    install();
    const runner = new LLMAgent();
    bus.emit("agent-start", { startStep: { id: "s1" } }, [runner]);
    for (let i = 0; i < 2; i += 1) {
      bus.emit("llm-tool-call", { toolCall: { id: "c1", name: "t", input: {} } }, [runner]);
      bus.emit("llm-tool-result", { toolCall: { id: "c1" }, toolResult: { output: i, isError: false } }, [runner]);
    }
    bus.emit("agent-end", { endStep: { id: "s1" } }, [runner]);
    const events = await flushed(spool);
    expect(events.filter((e) => e.type === "tool_use").map((e) => e.tool_call_id)).toEqual(["c1", "c1#1"]);
    expect(events.filter((e) => e.type === "tool_result").map((e) => e.tool_call_id)).toEqual(["c1", "c1#1"]);
  });

  it("drops every payload under captureMessages: false, keeping structure and tokens", async () => {
    install({ captureMessages: false });
    bus.emit("llm-start", { id: "m1", messages: [{ role: "user", content: "secret" }] });
    bus.emit("llm-end", { id: "m1", response: { message: { content: "secret" }, raw: { usage: { prompt_tokens: 2, completion_tokens: 1 } } } });
    const events = await flushed(spool);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events.find((e) => e.type === "model_response")!.input_tokens).toBe(2);
  });

  it("closes a leaf nobody will close once it is stale, and ends the bare run it opened", async () => {
    // A model call that throws has no `llm-end`: wrapLLMEvent has no error path.
    const handle = install({ staleAfter: 60 });
    bus.emit("llm-start", { id: "m1", messages: [] });
    expect(handle.sweep(performance.now())).toBe(0);
    expect(handle.sweep(performance.now() + 61_000)).toBe(1);
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["llm agent_start", "llm model_request", "llm model_response", "llm agent_end"]);
    expect(events[2]!.fw_closed_by).toBe("stale");
    // We never learned how that call ended; it is not a success.
    expect(events[3]!.outcome).toBe("cancelled");
  });

  it("ends a legacy task that will never send agent-end once it has been silent too long", async () => {
    // A legacy step that throws dispatches nothing: no `llm-end`, no `agent-end`.
    const handle = install({ staleAfter: 60 });
    const runner = new LLMAgent();
    bus.emit("agent-start", { startStep: { id: "s1" } }, [runner]);
    expect(handle.sweep(performance.now() + 30_000)).toBe(0);
    expect(handle.sweep(performance.now() + 61_000)).toBe(1);
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["LLMAgent agent_start", "LLMAgent agent_end"]);
    expect(events[1]).toMatchObject({ outcome: "cancelled", fw_run_id: expect.any(String) as unknown });
    // And a later event for that task starts nothing stale: it is forgotten.
    bus.emit("agent-end", { endStep: { id: "s1" } }, [runner]);
    expect(await flushed(spool)).toHaveLength(2);
  });

  it("makes a bare tool call its own run, named after the tool", async () => {
    install();
    bus.emit("llm-tool-call", { toolCall: { id: "c1", name: "get_weather", input: { city: "Rome" } } });
    bus.emit("llm-tool-result", { toolCall: { id: "c1" }, toolResult: { output: "sunny", isError: false } });
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "get_weather agent_start",
      "get_weather tool_use get_weather",
      "get_weather tool_result get_weather",
      "get_weather agent_end",
    ]);
    expect(events[2]!.output).toBe("sunny");
    expect(events[3]!.outcome).toBe("success");
  });

  it("detaches from the bus on uninstall and closes what is open as cancelled", async () => {
    install();
    bus.emit("llm-start", { id: "m1", messages: [] });
    expect(bus.count()).toBeGreaterThan(0);
    adapter.uninstall();
    expect(bus.count()).toBe(0);
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["llm agent_start", "llm model_request", "llm model_response", "llm agent_end"]);
    expect(events[3]!.outcome).toBe("cancelled");
  });
});

describe("the workflow runtime", () => {
  const model = (id: string, content = "", callers: unknown[] = []) => {
    bus.emit("llm-start", { id, messages: [] }, callers);
    bus.emit("llm-end", { id, response: { message: { content }, raw: { usage: { prompt_tokens: 3, completion_tokens: 1 } } } }, callers);
  };

  it("records a run as the agent, its steps as hooks, and closes it on the stop event", async () => {
    install();
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      await ctx.step(self.handleInputStep, ev("start", { userInput: "q" }));
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent" }));
      await ctx.step(self.executeToolCalls, ev("toolCalls", { agentName: "Agent" }));
      ctx.send(ev("stop", { result: "done", state: { memory: "huge" } }));
    });
    wf.runAgentStep = async () => {
      model("m1");
    };
    wf.executeToolCalls = async () => {
      // The runtime announces the call, THEN `callTool` dispatches on the bus
      // too (workflow ≥1.1.2x): one call, recorded once.
      current!.send(ev("toolCall", { toolName: "get_weather", toolId: "call_1", toolKwargs: { city: "Paris" } }));
      bus.emit("llm-tool-call", { toolCall: { id: "call_1", name: "get_weather", input: { city: "Paris" } } });
      bus.emit("llm-tool-result", { toolCall: { id: "call_1" }, toolResult: { output: "sunny", isError: false } });
      current!.send(ev("toolResult", { toolId: "call_1", toolOutput: { result: "sunny", isError: false }, raw: "sunny" }));
    };
    let current: Ctx | null = null;
    const create = wf.workflow.createContext;
    wf.workflow.createContext = () => (current = create());
    expect(wf.runStream("q")).toBe("stream");
    await wf.done;

    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "Agent agent_start",
      "Agent hook_triggered handleInputStep",
      "Agent hook_completed handleInputStep",
      "Agent hook_triggered runAgentStep",
      "Agent model_request",
      "Agent model_response",
      "Agent hook_completed runAgentStep",
      "Agent hook_triggered executeToolCalls",
      "Agent tool_use get_weather",
      "Agent tool_result get_weather",
      "Agent hook_completed executeToolCalls",
      "Agent agent_end",
    ]);
    expect(events.find((e) => e.type === "hook_triggered")!.trigger_event).toBe("workflow_step");
    // No `llm-start` caller chain here: the model comes from the agent the step names.
    expect(events.find((e) => e.type === "model_request")!.model).toBe("Agent-model");
    expect(events.find((e) => e.type === "tool_result")!.output).toBe("sunny");
    expect(events.at(-1)!.summary).toBe("done");
    expect(events[0]!.goal).toBe("q");
  });

  it("opens a nested agent per agent holding the turn, closing it on handoff", async () => {
    install();
    const wf = new AgentWorkflow(["triage", "forecaster"], async (ctx, self) => {
      await ctx.step(self.handleInputStep, ev("start"));
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "triage" }));
      // A tool step names `agentName`, not `currentAgentName`; a step naming
      // neither keeps whoever holds the turn.
      await ctx.step(self.executeToolCalls, ev("toolCalls", { agentName: "triage" }));
      await ctx.step(self.handleInputStep, ev("other"));
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "forecaster" }));
      ctx.send(ev("stop", { result: "ok" }));
    });
    wf.runAgentStep = async () => {
      model(`m${Math.random()}`);
    };
    wf.runStream("q");
    await wf.done;
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "AgentWorkflow agent_start",
      "AgentWorkflow hook_triggered handleInputStep",
      "AgentWorkflow hook_completed handleInputStep",
      "triage agent_start",
      "triage hook_triggered runAgentStep",
      "triage model_request",
      "triage model_response",
      "triage hook_completed runAgentStep",
      "triage hook_triggered executeToolCalls",
      "triage hook_completed executeToolCalls",
      "triage hook_triggered handleInputStep",
      "triage hook_completed handleInputStep",
      "triage agent_end",
      "forecaster agent_start",
      "forecaster hook_triggered runAgentStep",
      "forecaster model_request",
      "forecaster model_response",
      "forecaster hook_completed runAgentStep",
      "forecaster agent_end",
      "AgentWorkflow agent_end",
    ]);
    for (const start of events.filter((e) => e.type === "agent_start").slice(1)) {
      expect(start.parent_id).toBe("AgentWorkflow");
    }
  });

  it("fails the step, its open model call and the run when a step throws", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    install();
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      await Promise.resolve(ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent" }))).catch(() => undefined);
    });
    wf.runAgentStep = async () => {
      // A provider that throws: `llm-start` went out, `llm-end` never will.
      bus.emit("llm-start", { id: "m1", messages: [] });
      throw new Error("model exploded");
    };
    wf.runStream("q");
    await wf.done;
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "Agent agent_start",
      "Agent hook_triggered runAgentStep",
      "Agent model_request",
      "Agent model_response",
      "Agent hook_completed runAgentStep",
      "Agent agent_end",
    ]);
    expect(events[3]!.error).toMatch(/model exploded/);
    expect(events[4]!.outcome).toBe("failed");
    expect(events[5]!.outcome).toBe("failed");
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  it("reports a step failure no hook or leaf carries as ONE error event (steps: false)", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    install({ steps: false });
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      await Promise.resolve(ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent" }))).catch(() => undefined);
    });
    wf.runAgentStep = async () => {
      throw new TypeError("bad state");
    };
    wf.runStream("q");
    await wf.done;
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["Agent agent_start", "Agent error", "Agent agent_end"]);
    expect(events[1]).toMatchObject({ error_type: "TypeError", message: "bad state" });
    expect(events[2]).toMatchObject({ outcome: "failed", summary: "TypeError: bad state" });
  });

  it("reports a runStream() that throws before any step ran", async () => {
    install();
    const wf = new AgentWorkflow(["Agent"], async () => {});
    wf.workflow.createContext = () => {
      throw new Error("No agents added to workflow");
    };
    expect(() => wf.runStream("q")).toThrow("No agents added to workflow");
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["Agent agent_start", "Agent error", "Agent agent_end"]);
    expect(events[2]!.outcome).toBe("failed");
  });

  it("records a tool that threw from the runtime's own tool-result event", async () => {
    install();
    let current: Ctx | null = null;
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      current = ctx;
      await ctx.step(self.executeToolCalls, ev("toolCalls", { agentName: "Agent" }));
      ctx.send(ev("stop", { result: "ok" }));
    });
    wf.executeToolCalls = async () => {
      current!.send(ev("toolCall", { toolName: "broken", toolId: "c1", toolKwargs: {} }));
      // `callTool` catches the throw and dispatches no `llm-tool-result`.
      current!.send(ev("toolResult", { toolId: "c1", toolOutput: { result: "Error: Error: Error: tool exploded", isError: true } }));
    };
    wf.runStream("q");
    await wf.done;
    const events = await flushed(spool);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.error).toBe("Error: tool exploded");
    expect(result.tool_call_id).toBe("c1");
    expect(events.at(-1)!.outcome).toBe("success");
  });

  it("keeps correlating under steps: false, emitting no hooks", async () => {
    install({ steps: false });
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent" }));
      ctx.send(ev("stop", { result: "ok" }));
    });
    wf.runAgentStep = async () => {
      model("m1");
    };
    wf.runStream("q");
    await wf.done;
    expect(shape(await flushed(spool))).toEqual([
      "Agent agent_start",
      "Agent model_request",
      "Agent model_response",
      "Agent agent_end",
    ]);
  });

  it("records the run but not its steps when the context has no call-context hook", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    compat.setStrictIntegrations(false);
    install();
    const wf = new AgentWorkflow(["Agent"], async (ctx) => {
      ctx.send(ev("stop", { result: "ok" }));
    });
    wf.workflow.createContext = () => {
      const ctx = fakeContext();
      delete (ctx as Partial<Ctx>).__internal__call_context;
      return ctx;
    };
    wf.runStream("q");
    await wf.done;
    expect(shape(await flushed(spool))).toEqual(["Agent agent_start", "Agent agent_end"]);
  });

  it("restores the prototype and cancels an open run on uninstall", async () => {
    const proto = AgentWorkflow.prototype as unknown as Record<string, unknown>;
    const original = proto.runStream;
    install();
    expect(proto.runStream).not.toBe(original);
    const wf = new AgentWorkflow(["Agent"], async () => {});
    wf.runStream("q");
    adapter.uninstall();
    expect(proto.runStream).toBe(original);
    const events = await flushed(spool);
    expect(shape(events)).toEqual(["Agent agent_start", "Agent agent_end"]);
    expect(events[1]!.outcome).toBe("cancelled");
  });

  it("records nothing from a context that outlives uninstall()", async () => {
    install();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let current: Ctx | null = null;
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      current = ctx;
      await gate;
      ctx.send(ev("toolCall", { toolName: "late", toolId: "c9", toolKwargs: {} }));
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent" }));
      ctx.send(ev("stop", { result: "ok" }));
    });
    wf.runAgentStep = async () => {
      model("m-late");
    };
    wf.runStream("q");
    adapter.uninstall();
    release();
    await wf.done;
    expect(current).not.toBeNull();
    expect(shape(await flushed(spool))).toEqual(["Agent agent_start", "Agent agent_end"]);
  });

  it("leaves a workflow whose context it cannot reach unrecorded as a run, and says so", async () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    compat.setStrictIntegrations(false);
    install();
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      await ctx.step(self.runAgentStep, ev("setup"));
    });
    // A `createContext` on a prototype, not an own writable property.
    const create = wf.workflow.createContext;
    wf.workflow = Object.create({ createContext: create }) as AgentWorkflow["workflow"];
    wf.runAgentStep = async () => {
      model("m1");
    };
    wf.runStream("q");
    await wf.done;
    // No run that would never end — the model call is recorded as its own run.
    expect(shape(await flushed(spool))).toEqual(["llm agent_start", "llm model_request", "llm model_response", "llm agent_end"]);
    expect(warn).toHaveBeenCalled();
  });

  it("never changes what runStream returns or throws", () => {
    install();
    const wf = new AgentWorkflow(["Agent"], async () => {});
    const failure = new Error("No agents added to workflow");
    wf.workflow.createContext = () => {
      throw failure;
    };
    expect(() => wf.runStream("q")).toThrow(failure);
    // The createContext override is removed again, whatever happened.
    expect(Object.getOwnPropertyDescriptor(wf.workflow, "createContext")!.value).toBeTypeOf("function");
  });
});

/**
 * LlamaIndex's own `EventCaller`, as `@llamaindex/core/global` builds it: a
 * FRESH object per `@wrapEventCaller` invocation, chained to the invocation it
 * ran inside. Two concurrent `engine.query()` calls share `caller` (the engine)
 * and nothing else.
 */
class EventCaller {
  constructor(
    readonly caller: unknown,
    readonly parent: EventCaller | null = null,
  ) {}
  get computedCallers(): unknown[] {
    const callers: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking the chain from here
    for (let node: EventCaller | null = this; node !== null; node = node.parent) callers.push(node.caller);
    return callers;
  }
}

/** Dispatch the way the real bus does: `reason` is the EventCaller bound at dispatch. */
function emitIn(event: string, detail: Event, reason: EventCaller | null): void {
  bus.emitReason(event, detail, reason);
}

const bySession = (events: Event[]): Map<unknown, string[]> => {
  const out = new Map<unknown, string[]>();
  for (const e of events) out.set(e.session_id, [...(out.get(e.session_id) ?? []), shape([e])[0]!]);
  return out;
};

class LLMAgentStandIn {
  llm = { metadata: { model: "legacy-model" } };
}
class OpenAIStandIn {
  metadata = { model: "gpt-x" };
}
class RetrieverQueryEngineStandIn {}

describe("concurrent runs on ONE shared object", () => {
  const answer = (text: string) => ({ message: { content: text }, raw: { usage: { prompt_tokens: 1, completion_tokens: 1 } } });

  it("keeps two interleaved queries on one engine in two sessions", async () => {
    install();
    const engine = new RetrieverQueryEngineStandIn();
    const llm = new OpenAIStandIn();
    // One engine, built once, serving two requests at the same time.
    const a = new EventCaller(engine);
    const b = new EventCaller(engine);
    emitIn("query-start", { id: "qA", query: "question A" }, a);
    emitIn("query-start", { id: "qB", query: "question B" }, b);
    emitIn("retrieve-start", { id: "rB", query: "retrieval B" }, b);
    emitIn("retrieve-start", { id: "rA", query: "retrieval A" }, a);
    emitIn("retrieve-end", { id: "rA", nodes: [] }, a);
    emitIn("retrieve-end", { id: "rB", nodes: [{ node: { id_: "b" } }] }, b);
    emitIn("llm-start", { id: "mB", messages: [{ role: "user", content: "B" }] }, new EventCaller(llm, b));
    emitIn("llm-start", { id: "mA", messages: [{ role: "user", content: "A" }] }, new EventCaller(llm, a));
    emitIn("llm-end", { id: "mA", response: answer("answer A") }, new EventCaller(llm, a));
    emitIn("llm-end", { id: "mB", response: answer("answer B") }, new EventCaller(llm, b));
    emitIn("query-end", { id: "qB", response: { response: "answer B" } }, b);
    emitIn("query-end", { id: "qA", response: { response: "answer A" } }, a);

    const events = await flushed(spool);
    const sessions = bySession(events);
    expect(sessions.size).toBe(2);
    const run = [
      "RetrieverQueryEngineStandIn agent_start",
      "RetrieverQueryEngineStandIn tool_use retriever",
      "RetrieverQueryEngineStandIn tool_result retriever",
      "RetrieverQueryEngineStandIn model_request",
      "RetrieverQueryEngineStandIn model_response",
      "RetrieverQueryEngineStandIn agent_end",
    ];
    for (const shapeOf of sessions.values()) expect(shapeOf).toEqual(run);
    const sessionOf = (pred: (e: Event) => boolean) => events.find(pred)!.session_id;
    const sa = sessionOf((e) => e.type === "agent_start" && e.goal === "question A");
    const sb = sessionOf((e) => e.type === "agent_start" && e.goal === "question B");
    expect(sa).not.toBe(sb);
    expect(sessionOf((e) => e.type === "tool_use" && JSON.stringify(e.input).includes("retrieval A"))).toBe(sa);
    expect(sessionOf((e) => e.type === "tool_use" && JSON.stringify(e.input).includes("retrieval B"))).toBe(sb);
    expect(sessionOf((e) => e.type === "model_response" && e.content === "answer A")).toBe(sa);
    expect(sessionOf((e) => e.type === "model_response" && e.content === "answer B")).toBe(sb);
    expect(sessionOf((e) => e.type === "agent_end" && e.summary === "answer A")).toBe(sa);
    expect(sessionOf((e) => e.type === "agent_end" && e.summary === "answer B")).toBe(sb);
    for (const e of events.filter((x) => x.type === "agent_start")) expect(e.parent_id ?? null).toBeNull();
  });

  it("does not nest a second query under the first when the bus gives only the caller list", async () => {
    // The reviewer's repro: no EventCaller chain, only `computedCallers`. A run
    // that the SAME object owns cannot be told apart from a concurrent sibling
    // there, and a sibling is the normal case — so it is never taken as the parent.
    install();
    const engine = new RetrieverQueryEngineStandIn();
    bus.emit("query-start", { id: "qA", query: "question from user A" }, [engine]);
    bus.emit("query-start", { id: "qB", query: "question from user B" }, [engine]);
    bus.emit("query-end", { id: "qB", response: "answer B" }, [engine]);
    bus.emit("query-end", { id: "qA", response: "answer A" }, [engine]);
    const events = await flushed(spool);
    const starts = events.filter((e) => e.type === "agent_start");
    expect(starts.map((e) => e.goal)).toEqual(["question from user A", "question from user B"]);
    expect(new Set(events.map((e) => e.session_id)).size).toBe(2);
    const ends = events.filter((e) => e.type === "agent_end");
    expect(ends.map((e) => e.summary)).toEqual(["answer B", "answer A"]);
    expect(ends[0]!.session_id).toBe(starts[1]!.session_id);
    expect(ends[1]!.session_id).toBe(starts[0]!.session_id);
  });

  it("keeps two interleaved legacy chats on one LLMAgent in two sessions", async () => {
    install();
    const runner = new LLMAgentStandIn();
    const llm = new OpenAIStandIn();
    const a = new EventCaller(runner);
    const b = new EventCaller(runner);
    const stepA = { id: "a1", prevStep: null, context: { store: { messages: [{ content: "goal A" }] } } };
    const stepB = { id: "b1", prevStep: null, context: { store: { messages: [{ content: "goal B" }] } } };
    emitIn("agent-start", { startStep: stepA }, a);
    emitIn("agent-start", { startStep: stepB }, b);
    // B is the newest run on the runner; A's calls must still go to A.
    emitIn("llm-start", { id: "mA", messages: [] }, new EventCaller(llm, a));
    emitIn("llm-end", { id: "mA", response: answer("") }, new EventCaller(llm, a));
    emitIn("llm-tool-call", { toolCall: { id: "tA", name: "tool_a", input: {} } }, a);
    emitIn("llm-start", { id: "mB", messages: [] }, new EventCaller(llm, b));
    emitIn("llm-tool-result", { toolCall: { id: "tA" }, toolResult: { output: "ra", isError: false } }, a);
    emitIn("llm-end", { id: "mB", response: answer("done B") }, new EventCaller(llm, b));
    emitIn("agent-end", { endStep: stepB }, b);
    emitIn("llm-start", { id: "mA2", messages: [] }, new EventCaller(llm, a));
    emitIn("llm-end", { id: "mA2", response: answer("done A") }, new EventCaller(llm, a));
    emitIn("agent-end", { endStep: stepA }, a);

    const events = await flushed(spool);
    const starts = events.filter((e) => e.type === "agent_start");
    expect(starts.map((e) => e.goal)).toEqual(["goal A", "goal B"]);
    for (const start of starts) expect(start.parent_id ?? null).toBeNull();
    const [sa, sb] = starts.map((e) => e.session_id);
    expect(sa).not.toBe(sb);
    const sessions = bySession(events);
    expect(sessions.get(sa)).toEqual([
      "LLMAgentStandIn agent_start",
      "LLMAgentStandIn model_request",
      "LLMAgentStandIn model_response",
      "LLMAgentStandIn tool_use tool_a",
      "LLMAgentStandIn tool_result tool_a",
      "LLMAgentStandIn model_request",
      "LLMAgentStandIn model_response",
      "LLMAgentStandIn agent_end",
    ]);
    expect(sessions.get(sb)).toEqual([
      "LLMAgentStandIn agent_start",
      "LLMAgentStandIn model_request",
      "LLMAgentStandIn model_response",
      "LLMAgentStandIn agent_end",
    ]);
    expect(events.find((e) => e.type === "agent_end" && e.session_id === sa)!.summary).toBe("done A");
    expect(events.find((e) => e.type === "agent_end" && e.session_id === sb)!.summary).toBe("done B");
  });

  it("still nests a query INSIDE another invocation's chain", async () => {
    // A sub-engine queried from inside an outer engine's query (SubQuestion-
    // QueryEngine), and the SAME engine re-entered from inside its own query:
    // both run inside the outer invocation, so neither opens a run.
    install();
    const outer = new RetrieverQueryEngineStandIn();
    const inner = new RetrieverQueryEngineStandIn();
    const top = new EventCaller(outer);
    emitIn("query-start", { id: "q1", query: "outer" }, top);
    const sub = new EventCaller(inner, top);
    emitIn("query-start", { id: "q2", query: "inner" }, sub);
    emitIn("retrieve-start", { id: "r2", query: "inner" }, sub);
    emitIn("retrieve-end", { id: "r2", nodes: [] }, sub);
    emitIn("query-end", { id: "q2", response: "inner answer" }, sub);
    const again = new EventCaller(outer, top);
    emitIn("query-start", { id: "q3", query: "again" }, again);
    emitIn("query-end", { id: "q3", response: "again answer" }, again);
    emitIn("query-end", { id: "q1", response: "outer answer" }, top);
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "RetrieverQueryEngineStandIn agent_start",
      "RetrieverQueryEngineStandIn tool_use retriever",
      "RetrieverQueryEngineStandIn tool_result retriever",
      "RetrieverQueryEngineStandIn agent_end",
    ]);
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
  });

  it("keeps two concurrent workflow runs of one shared agent apart", async () => {
    install();
    const gates: Array<() => void> = [];
    const wait = () => new Promise<void>((resolve) => gates.push(resolve));
    const wf = new AgentWorkflow(["Agent"], async (ctx, self) => {
      const input = String(self.input);
      await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "Agent", q: input }));
      ctx.send(ev("stop", { result: `answer ${input}` }));
    });
    wf.runAgentStep = async (_ctx, event) => {
      const q = String((event as { data: { q: string } }).data.q);
      await wait();
      bus.emit("llm-start", { id: `m-${q}`, messages: [{ role: "user", content: q }] });
      await wait();
      bus.emit("llm-end", { id: `m-${q}`, response: answer(`reply ${q}`) });
    };
    wf.runStream("A");
    const doneA = wf.done;
    wf.runStream("B");
    const doneB = wf.done;
    // Interleave: each round releases the waiting calls newest first, so B's
    // model call starts before A's.
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of gates.splice(0).reverse()) release();
    }
    await Promise.all([doneA, doneB]);
    const events = await flushed(spool);
    const starts = events.filter((e) => e.type === "agent_start");
    expect(starts.map((e) => e.goal)).toEqual(["A", "B"]);
    const [sa, sb] = starts.map((e) => e.session_id);
    expect(sa).not.toBe(sb);
    const requests = events.filter((e) => e.type === "model_request");
    expect(requests.map((e) => e.session_id)).toEqual([sb, sa]);
    const sessions = bySession(events);
    const run = [
      "Agent agent_start",
      "Agent hook_triggered runAgentStep",
      "Agent model_request",
      "Agent model_response",
      "Agent hook_completed runAgentStep",
      "Agent agent_end",
    ];
    expect(sessions.get(sa)).toEqual(run);
    expect(sessions.get(sb)).toEqual(run);
    expect(events.find((e) => e.type === "model_response" && e.content === "reply A")!.session_id).toBe(sa);
    expect(events.find((e) => e.type === "model_response" && e.content === "reply B")!.session_id).toBe(sb);
    expect(events.find((e) => e.type === "agent_end" && e.session_id === sa)!.summary).toBe("answer A");
    expect(events.find((e) => e.type === "agent_end" && e.session_id === sb)!.summary).toBe("answer B");
  });
});

describe("attach()", () => {
  it("refuses to replace an install that is still live, leaving it removable", () => {
    install();
    const live = bus;
    const subscribed = live.count();
    const proto = AgentWorkflow.prototype as unknown as Record<string, unknown>;
    const patched = proto.runStream;
    const second = new FakeBus();
    expect(() =>
      attach({ reaperInterval: 0 }, { globals: [{ Settings: { callbackManager: second } }], workflows: [workflowModule()] }),
    ).toThrow(/already installed/);
    // Nothing of the refused attach happened, and the live one is untouched.
    expect(second.count()).toBe(0);
    expect(live.count()).toBe(subscribed);
    expect(proto.runStream).toBe(patched);
    // So uninstall() still reaches every subscription and the patch.
    adapter.uninstall();
    expect(live.count()).toBe(0);
    expect(proto.runStream).not.toBe(patched);
    // And once removed, attaching again works.
    install();
    expect(bus.count()).toBe(subscribed);
  });
});

describe("state after a run ends", () => {
  it("leaves no residue after 20k completed runs of every kind", async () => {
    // Every per-run entry — the adapter's own maps AND the tracker's links —
    // must go when its run ends. A leaked link is not just memory: at the
    // tracker's FIFO cap the next eviction takes a LIVE run's link, and its
    // events drop.
    const original = runtime.event;
    runtime.event = new Proxy({}, { get: () => () => undefined }) as typeof runtime.event;
    try {
      const handle = install({ staleAfter: 60 });
      const engine = new RetrieverQueryEngineStandIn();
      const runner = new LLMAgentStandIn();
      const llm = new OpenAIStandIn();
      const N = 20_000;
      for (let i = 0; i < N; i += 1) {
        switch (i % 6) {
          case 0: {
            // A query, with its retrieval and model call.
            const q = new EventCaller(engine);
            emitIn("query-start", { id: `q${i}`, query: "q" }, q);
            emitIn("retrieve-start", { id: `r${i}`, query: "q" }, q);
            emitIn("retrieve-end", { id: `r${i}`, nodes: [] }, q);
            emitIn("llm-start", { id: `m${i}`, messages: [] }, new EventCaller(llm, q));
            emitIn("llm-end", { id: `m${i}`, response: {} }, new EventCaller(llm, q));
            emitIn("query-end", { id: `q${i}`, response: "a" }, q);
            break;
          }
          case 1: {
            // A two-step legacy task with a tool call.
            const c = new EventCaller(runner);
            const s1 = { id: `s${i}a`, prevStep: null };
            const s2 = { id: `s${i}b`, prevStep: s1 };
            emitIn("agent-start", { startStep: s1 }, c);
            emitIn("llm-tool-call", { toolCall: { id: `t${i}`, name: "t", input: {} } }, c);
            emitIn("llm-tool-result", { toolCall: { id: `t${i}` }, toolResult: { output: 1, isError: false } }, c);
            emitIn("agent-start", { startStep: s2 }, c);
            emitIn("agent-end", { endStep: s2 }, c);
            break;
          }
          case 2: {
            // A bare model call.
            bus.emit("llm-start", { id: `b${i}`, messages: [] }, [llm]);
            bus.emit("llm-end", { id: `b${i}`, response: {} }, [llm]);
            break;
          }
          case 3:
          case 4: {
            // A workflow run: steps, a model call, a handoff to a sub-agent —
            // once with hooks and once under steps: false's twin path (a step
            // that throws, so no hook_completed success).
            const fail = i % 6 === 4;
            const wf = new AgentWorkflow(["triage", "forecaster"], async (ctx, self) => {
              await ctx.step(self.handleInputStep, ev("start"));
              await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "triage" }));
              await ctx.step(self.runAgentStep, ev("setup", { currentAgentName: "forecaster" }));
              ctx.send(ev("stop", { result: "ok" }));
            });
            wf.runAgentStep = async () => {
              bus.emit("llm-start", { id: `w${i}`, messages: [] });
              bus.emit("llm-end", { id: `w${i}`, response: {} });
              if (fail) throw new Error("step failed");
            };
            wf.runStream("q");
            await wf.done.catch(() => undefined);
            break;
          }
          default: {
            // A task that never ends on its own, with a model call left open:
            // the reaper closes both.
            const c = new EventCaller(runner);
            emitIn("agent-start", { startStep: { id: `o${i}`, prevStep: null } }, c);
            emitIn("llm-start", { id: `o${i}`, messages: [] }, new EventCaller(llm, c));
            handle.sweep(performance.now() + 61_000);
          }
        }
      }
      const residue = handle.residue();
      expect({ runs: residue.runs, leaves: residue.leaves, tasks: residue.tasks, queries: residue.queries }).toEqual({
        runs: 0,
        leaves: 0,
        tasks: 0,
        queries: 0,
      });
      expect(residue.tracker.openAgents()).toEqual([]);
      expect((residue.tracker as unknown as { links: Map<unknown, unknown> }).links.size).toBe(0);
    } finally {
      runtime.event = original;
    }
  }, 60_000);
});
