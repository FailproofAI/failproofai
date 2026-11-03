import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLogger } from "../src/logger.js";
import * as core from "../src/integrations/core.js";
import { _internals, wrapTool } from "../src/integrations/mastra.js";
import { session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The Mastra adapter's translation tables, against the shapes Mastra and the
 * AI SDK model contract actually produce. `integration/mastra.test.ts` proves
 * the patches reach real releases; this proves what they read once there,
 * including the shapes no fixture happens to hit (V1 and V3 models, 0.20's
 * unwrapped step results).
 */

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
});
afterEach(async () => {
  await spool.cleanup();
  setLogger(null);
});

const {
  usageOf,
  finishReasonOf,
  promptOf,
  generateOutcome,
  foldStreamPart,
  toolCallArgs,
  isInternalRun,
  workflowOutcome,
  stepOutcome,
} = _internals;

describe("reading a model step", () => {
  it("reads token counts from every LanguageModel version", () => {
    // V2: plain numbers.
    expect(usageOf({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })).toEqual({ inputTokens: 11, outputTokens: 7 });
    // V1: the AI SDK 4 names.
    expect(usageOf({ promptTokens: 3, completionTokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4 });
    // V3: a breakdown whose `total` is the count.
    expect(usageOf({ inputTokens: { total: 20, noCache: 5 }, outputTokens: { total: 9, text: 9 } })).toEqual({
      inputTokens: 20,
      outputTokens: 9,
    });
    // Never a float or a negative: the column is a u32 and drops either whole.
    expect(usageOf({ inputTokens: 1.6, outputTokens: -1 })).toEqual({ inputTokens: 2, outputTokens: undefined });
    expect(usageOf(undefined)).toEqual({});
  });

  it("reads the finish reason as a string in every version", () => {
    expect(finishReasonOf("tool-calls")).toBe("tool-calls");
    expect(finishReasonOf({ unified: "stop", raw: "end_turn" })).toBe("stop");
    expect(finishReasonOf({ raw: "end_turn" })).toBe("end_turn");
    expect(finishReasonOf({})).toBeUndefined();
    expect(finishReasonOf("")).toBeUndefined();
  });

  it("splits the provider prompt into system, messages and tools", () => {
    const prompt = promptOf({
      prompt: [
        { role: "system", content: "Answer weather questions." },
        { role: "user", content: [{ type: "text", text: "Weather " }, { type: "text", text: "in Paris?" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "weather", input: { city: "Paris" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", toolName: "weather", output: { value: "sunny" } }],
        },
      ],
      tools: [{ type: "function", name: "weather", description: "Current weather", inputSchema: {} }],
    });
    expect(prompt.system).toBe("Answer weather questions.");
    expect(prompt.messages).toEqual([
      { role: "user", content: "Weather in Paris?" },
      { role: "assistant", content: [{ type: "tool_call", id: "call_1", name: "weather", input: { city: "Paris" } }] },
      { role: "tool", content: [{ type: "tool_result", id: "call_1", name: "weather", output: { value: "sunny" } }] },
    ]);
    expect(prompt.tools).toEqual([{ name: "weather", description: "Current weather" }]);
    // V1 puts the tools under `mode`.
    expect(promptOf({ prompt: [], mode: { type: "regular", tools: [{ name: "t" }] } }).tools).toEqual([
      { name: "t", description: undefined },
    ]);
  });

  it("reads a finished generation in the V2 and V1 shapes", () => {
    expect(
      generateOutcome({
        content: [
          { type: "text", text: "Checking." },
          { type: "tool-call", toolCallId: "call_1", toolName: "weather", input: '{"city":"Paris"}' },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 11, outputTokens: 7 },
        response: { modelId: "gpt-x-2026" },
      }),
    ).toEqual({
      model: "gpt-x-2026",
      finishReason: "tool-calls",
      usage: { inputTokens: 11, outputTokens: 7 },
      text: "Checking.",
      toolCalls: [{ id: "call_1", name: "weather", input: '{"city":"Paris"}' }],
    });
    const v1 = generateOutcome({
      text: "Hi",
      toolCalls: [{ toolCallId: "c", toolName: "t", args: "{}" }],
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 2 },
    });
    expect(v1.text).toBe("Hi");
    expect(v1.toolCalls).toEqual([{ id: "c", name: "t", input: "{}" }]);
    expect(usageOf(v1.usage)).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("assembles a streamed step from its parts", () => {
    const outcome = {};
    for (const part of [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r1", modelId: "served-model" },
      { type: "text-delta", id: "t", delta: "It is " },
      { type: "text-delta", textDelta: "sunny." }, // V1 spelling
      { type: "tool-call", toolCallId: "call_2", toolName: "weather", input: "{}" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: 5, outputTokens: 6 } },
    ]) {
      foldStreamPart(outcome, part);
    }
    expect(outcome).toEqual({
      model: "served-model",
      text: "It is sunny.",
      toolCalls: [{ id: "call_2", name: "weather", input: "{}" }],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    const failed: { error?: unknown } = {};
    foldStreamPart(failed, { type: "error", error: new Error("rate limited") });
    expect((failed.error as Error).message).toBe("rate limited");
  });
});

describe("reading a tool call", () => {
  it("reads 1.x's execute(input, context) with the model's id under context.agent", () => {
    expect(toolCallArgs([{ city: "Paris" }, { agent: { toolCallId: "call_9" }, requestContext: {} }])).toEqual({
      input: { city: "Paris" },
      toolCallId: "call_9",
    });
    // A direct call from user code passes the input alone.
    expect(toolCallArgs([{ city: "Rome" }])).toEqual({ input: { city: "Rome" }, toolCallId: undefined });
  });

  it("reads 0.x's execute({ context, runtimeContext }, { toolCallId })", () => {
    expect(toolCallArgs([{ context: { city: "Paris" }, runtimeContext: {} }, { toolCallId: "call_3" }])).toEqual({
      input: { city: "Paris" },
      toolCallId: "call_3",
    });
    expect(toolCallArgs([{ context: { city: "Rome" } }])).toEqual({ input: { city: "Rome" }, toolCallId: undefined });
  });

  it("does not mistake a 1.x input that has a `context` field for the 0.x envelope", () => {
    expect(toolCallArgs([{ context: "long", query: "q" }, { agent: { toolCallId: "c1" } }])).toEqual({
      input: { context: "long", query: "q" },
      toolCallId: "c1",
    });
  });
});

describe("reading a workflow", () => {
  it("recognises the runs Mastra marks as its own plumbing", () => {
    expect(isInternalRun({ isInternalWorkflow: true })).toBe(true);
    // The agentic loop's workflows carry InternalSpans.WORKFLOW (1) or ALL (15).
    expect(isInternalRun({ tracingPolicy: { internal: 1 } })).toBe(true);
    expect(isInternalRun({ tracingPolicy: { internal: 15 } })).toBe(true);
    // AGENT | TOOL without the WORKFLOW bit is a user workflow that hides other spans.
    expect(isInternalRun({ tracingPolicy: { internal: 6 } })).toBe(false);
    expect(isInternalRun({ workflowId: "weather-flow" })).toBe(false);
  });

  it("maps a run status onto an agent_end outcome the server counts correctly", () => {
    expect(workflowOutcome("success")).toBe("success");
    expect(workflowOutcome("failed")).toBe("failed");
    expect(workflowOutcome("canceled")).toBe("cancelled");
    expect(workflowOutcome("tripwire")).toBe("rejected");
    expect(workflowOutcome("suspended")).toBe("suspended");
    expect(workflowOutcome(undefined)).toBe("success");
  });

  it("reads a step result in the 0.24+ wrapped shape and the older bare one", () => {
    expect(stepOutcome({ result: { status: "success", output: { city: "Paris" } }, stepResults: {} })).toEqual({
      outcome: "success",
      output: { city: "Paris" },
    });
    expect(stepOutcome({ status: "success", output: 1 })).toEqual({ outcome: "success", output: 1 });
    // 1.x hands the error over as an object, 0.x as a string with its stack.
    expect(stepOutcome({ result: { status: "failed", error: { name: "Error", message: "step exploded" } } })).toEqual({
      outcome: "failed",
      error: "Error: step exploded",
    });
    expect(stepOutcome({ status: "failed", error: "Error: step exploded\n    at execute (file.js:1:1)" })).toEqual({
      outcome: "failed",
      error: "Error: step exploded",
    });
    expect(stepOutcome(undefined, new TypeError("boom"))).toEqual({ outcome: "failed", error: "TypeError: boom" });
    expect(stepOutcome({ result: { status: "suspended" } })).toEqual({ outcome: "suspended", output: undefined });
  });
});

describe("wrapTool", () => {
  class Tool {
    id = "weather";
    // 1.x's signature: the input, then the execution context.
    execute = async (input: { city: string }, context?: unknown) => {
      void context;
      return { city: input.city, forecast: "sunny" };
    };
    describe(): string {
      return `tool ${this.id}`;
    }
  }

  it("keeps the tool a Tool, so Mastra's own checks still accept it", () => {
    const tool = new Tool();
    const wrapped = wrapTool(tool);
    expect(wrapped).not.toBe(tool);
    expect(wrapped).toBeInstanceOf(Tool);
    expect(wrapped.describe()).toBe("tool weather");
    expect(wrapTool(wrapped)).toBe(wrapped);
  });

  it("records a call made with nothing open as its own run, named after the tool", async () => {
    const wrapped = wrapTool(new Tool());
    await expect(wrapped.execute({ city: "Rome" })).resolves.toEqual({ city: "Rome", forecast: "sunny" });
    const events = await flushed(spool);
    expect(events.map((e) => `${String(e.agent_id)} ${String(e.type)}`)).toEqual([
      "weather agent_start",
      "weather tool_use",
      "weather tool_result",
      "weather agent_end",
    ]);
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
    expect(events[1]!.input).toEqual({ city: "Rome" });
    expect(events[1]!.tool_call_id).toBe(events[2]!.tool_call_id);
    expect(events[3]!.outcome).toBe("success");
  });

  it("closes its own run failed when the tool throws, and re-throws", async () => {
    const wrapped = wrapTool({
      id: "flaky",
      execute: async (): Promise<never> => {
        throw new RangeError("out of range");
      },
    });
    await expect(wrapped.execute()).rejects.toThrow("out of range");
    const events = await flushed(spool);
    expect(events.map((e) => e.type)).toEqual(["agent_start", "tool_use", "tool_result", "agent_end"]);
    expect(events[2]!.error).toBe("RangeError: out of range");
    expect(events[3]!.outcome).toBe("failed");
  });

  it("records a call inside a scope under that scope, with no run of its own", async () => {
    const wrapped = wrapTool(new Tool());
    await session({ sessionId: "s1" }, () =>
      wrapped.execute({ city: "Faro" }, { agent: { toolCallId: "call_7" } }),
    );
    const events = await flushed(spool);
    expect(events.map((e) => e.type)).toEqual(["tool_use", "tool_result"]);
    expect(events[0]!.session_id).toBe("s1");
    expect(events[0]!.tool_call_id).toBe("call_7");
  });

  it("records a returned failure as a failure", async () => {
    // What Mastra 0.x's tool builder hands back instead of throwing.
    const wrapped = wrapTool({ id: "validated", execute: async () => ({ error: true, message: "bad input" }) });
    await session({ sessionId: "s1" }, () => wrapped.execute());
    const result = (await flushed(spool)).find((e) => e.type === "tool_result")!;
    expect(result.error).toBe("Error: bad input");
    expect(result.output).toBeUndefined();
  });
});
