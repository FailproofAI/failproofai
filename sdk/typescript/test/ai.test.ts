import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as core from "../src/integrations/core.js";
import {
  adapter,
  integration,
  middleware,
  responseContent,
  stopReasonOf,
  tracer,
  usageTokens,
} from "../src/integrations/ai.js";
import { setLogger } from "../src/logger.js";
import { agent, session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The Vercel AI SDK adapter's logic, against the shapes each `ai` major hands
 * it. The real-framework proof is `integration/ai.test.ts`; this file pins the
 * translation rules it depends on, without installing four copies of `ai`.
 */

let spool: Spool;
const warnings: string[] = [];

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
  warnings.length = 0;
  setLogger({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: (message: string) => warnings.push(message),
  });
});
afterEach(async () => {
  adapter.uninstall();
  await spool.cleanup();
  setLogger(null);
});

const types = (events: Array<Record<string, unknown>>) => events.map((e) => e.type);

interface Span {
  setAttributes: (a: Record<string, unknown>) => unknown;
  recordException: (e: unknown) => void;
  setStatus: (s: { code: number; message?: string }) => unknown;
  end: () => void;
}

describe("reading every major's spelling", () => {
  it("reads tokens from v4, v5, v6+ and v7-normalised usage", () => {
    expect(usageTokens({ promptTokens: 5, completionTokens: 7 })).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(usageTokens({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(
      usageTokens({ inputTokens: { total: 23, noCache: 23 }, outputTokens: { total: 9, text: 9 } }),
    ).toEqual({ inputTokens: 23, outputTokens: 9 });
    expect(usageTokens({ tokens: 4 })).toEqual({ inputTokens: 4, outputTokens: undefined });
    expect(usageTokens(undefined)).toEqual({});
    // A count that is not a count is dropped, never shipped as NaN.
    expect(usageTokens({ inputTokens: { total: undefined }, outputTokens: "x" })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it("reduces every finish-reason shape to a string", () => {
    expect(stopReasonOf("stop")).toBe("stop");
    expect(stopReasonOf({ unified: "tool-calls", raw: "tool_use" })).toBe("tool-calls");
    expect(stopReasonOf(["length"])).toBe("length");
    expect(stopReasonOf("")).toBeUndefined();
    expect(stopReasonOf({})).toBeUndefined();
  });

  it("uses the tool calls as content when a step produced no text", () => {
    const call = { type: "tool-call", toolCallId: "c1", toolName: "weather", input: '{"city":"Paris"}' };
    expect(responseContent({ content: [call] })).toEqual([
      { toolCallId: "c1", toolName: "weather", input: { city: "Paris" } },
    ]);
    expect(responseContent({ content: [{ type: "text", text: "hi" }, call] })).toBe("hi");
    // v4: `text` is "" on a tool-call step — "" is not content.
    expect(
      responseContent({ text: "", toolCalls: [{ toolCallId: "c1", toolName: "weather", args: "{}" }] }),
    ).toEqual([{ toolCallId: "c1", toolName: "weather", input: {} }]);
    expect(responseContent({ text: "" })).toBeUndefined();
  });
});

describe("the tracer (ai v4–v6)", () => {
  it("never ends a span for the caller: a stream span stays open until the SDK ends it", async () => {
    const t = tracer();
    let stream: Span | undefined;
    await session({ sessionId: "s1" }, async () => {
      // `streamText` opens its root span with endWhenDone: false and returns
      // before a single token has been produced.
      await t.startActiveSpan(
        "ai.streamText",
        { attributes: { "ai.operationId": "ai.streamText", "ai.telemetry.functionId": "streamer" } },
        async (span: Span) => {
          stream = span;
        },
      );
    });
    expect(types(await flushed(spool))).toEqual(["agent_start"]);
    stream!.end();
    expect(types(await flushed(spool))).toEqual(["agent_start", "agent_end"]);
  });

  it("stamps the model request when the step starts, before the tool it causes", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () =>
      t.startActiveSpan("ai.streamText", { attributes: { "ai.operationId": "ai.streamText" } }, async (root: Span) => {
        let step: Span | undefined;
        t.startActiveSpan(
          "ai.streamText.doStream",
          { attributes: { "ai.operationId": "ai.streamText.doStream", "ai.model.id": "m" } },
          (span: Span) => {
            step = span;
          },
        );
        // The tool runs while the model's stream is still open.
        t.startActiveSpan(
          "ai.toolCall",
          { attributes: { "ai.operationId": "ai.toolCall", "ai.toolCall.name": "weather", "ai.toolCall.id": "c1" } },
          (span: Span) => span.end(),
        );
        step!.setAttributes({
          "ai.response.finishReason": "tool-calls",
          "ai.response.text": "",
          "ai.response.toolCalls": JSON.stringify([{ toolCallId: "c1", toolName: "weather", input: "{}" }]),
        });
        step!.end();
        root.end();
      }),
    );
    const events = await flushed(spool);
    expect(types(events)).toEqual([
      "agent_start",
      "model_request",
      "tool_use",
      "tool_result",
      "model_response",
      "agent_end",
    ]);
    expect(events.every((e) => e.agent_id === "ai.streamText")).toBe(true);
    const response = events.find((e) => e.type === "model_response")!;
    expect(response.stop_reason).toBe("tool-calls");
    expect(response.content).toEqual([{ toolCallId: "c1", toolName: "weather", input: "{}" }]);
  });

  it("records a failed model step once, on its model_response", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, async () => {
      await expect(
        t.startActiveSpan("ai.generateText", { attributes: { "ai.operationId": "ai.generateText" } }, async (root: Span) => {
          try {
            await t.startActiveSpan(
              "ai.generateText.doGenerate",
              { attributes: { "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": "m" } },
              async (span: Span) => {
                const error = new Error("model exploded");
                span.recordException(error);
                span.setStatus({ code: 2, message: error.message });
                span.end();
                throw error;
              },
            );
          } catch (error) {
            root.recordException(error);
            root.setStatus({ code: 2 });
            root.end();
            throw error;
          }
        }),
      ).rejects.toThrow("model exploded");
    });
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    const response = events.find((e) => e.type === "model_response")!;
    expect(response.error).toBe("Error: model exploded");
    expect(response.stop_reason).toBe("error");
    expect(events.at(-1)!.outcome).toBe("failed");
  });

  it("nests an operation under an enclosing agent() scope", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () =>
      agent("planner", () =>
        t.startActiveSpan("ai.generateText", { attributes: { "ai.operationId": "ai.generateText" } }, (span: Span) =>
          span.end(),
        ),
      ),
    );
    const events = await flushed(spool);
    const start = events.find((e) => e.type === "agent_start" && e.agent_id === "ai.generateText")!;
    expect(start.parent_id).toBe("planner");
    expect(start.session_id).toBe("s1");
  });
});

describe("the telemetry integration (ai v7)", () => {
  const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });

  it("turns v7's lifecycle callbacks into one agent, model pairs and tool pairs", async () => {
    await session({ sessionId: "s1" }, async () => {
      const callId = "call-abc";
      const base = { callId, functionId: "weather-agent", provider: "p", modelId: "m" };
      integration.onStart({ ...base, operationId: "ai.generateText" });
      integration.onLanguageModelCallStart({ ...base, messages: [{ role: "user", content: "hi" }] });
      await integration.executeLanguageModelCall({ callId, execute: async () => "ok" });
      integration.onLanguageModelCallEnd({
        ...base,
        finishReason: "tool-calls",
        usage: usage(11, 7),
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "Paris" } }],
        performance: { responseTimeMs: 12.6 },
      });
      const toolCall = { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "Paris" } };
      integration.onToolExecutionStart({ ...base, toolCall });
      integration.onToolExecutionEnd({ ...base, toolCall, toolOutput: { type: "tool-result", output: { c: 20 } } });
      integration.onLanguageModelCallStart({ ...base, messages: [] });
      integration.onLanguageModelCallEnd({ ...base, finishReason: "stop", usage: usage(23, 9), content: [{ type: "text", text: "sunny" }] });
      integration.onEnd({ ...base, finishReason: "stop" });
    });
    const events = await flushed(spool);
    expect(types(events)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "tool_use",
      "tool_result",
      "model_request",
      "model_response",
      "agent_end",
    ]);
    expect(events.every((e) => e.agent_id === "weather-agent" && e.session_id === "s1")).toBe(true);
    const responses = events.filter((e) => e.type === "model_response");
    expect(responses.map((e) => [e.input_tokens, e.output_tokens, e.stop_reason])).toEqual([
      [11, 7, "tool-calls"],
      [23, 9, "stop"],
    ]);
    expect(responses[0]!.duration_ms).toBe(13);
    const requests = events.filter((e) => e.type === "model_request");
    expect(responses.map((e) => e.request_id)).toEqual(requests.map((e) => e.request_id));
    expect(events.find((e) => e.type === "tool_use")!.tool_call_id).toBe("tc1");
    expect(events.find((e) => e.type === "tool_result")!.output).toEqual({ c: 20 });
    expect(events.at(-1)!.outcome).toBe("success");
  });

  it("ignores ai v6's integration events, which carry no callId (v6 records through the tracer)", async () => {
    await session({ sessionId: "s1" }, () => {
      integration.onStart({ functionId: "x", model: { modelId: "m" } });
      integration.onToolExecutionStart({ toolCall: { toolCallId: "t", toolName: "w" } });
      integration.onEnd({ finishReason: "stop" });
    });
    expect(await flushed(spool)).toEqual([]);
  });

  it("records a failing provider call once, on its model_response", async () => {
    await session({ sessionId: "s1" }, async () => {
      const base = { callId: "c2", functionId: "f", modelId: "m" };
      integration.onStart({ ...base, operationId: "ai.generateText" });
      integration.onLanguageModelCallStart(base);
      await expect(
        integration.executeLanguageModelCall({
          callId: "c2",
          execute: async () => {
            throw new Error("model exploded");
          },
        }),
      ).rejects.toThrow("model exploded");
      integration.onError({ callId: "c2", error: new Error("model exploded") });
    });
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[2]!.error).toBe("Error: model exploded");
    expect(events[2]!.stop_reason).toBe("error");
    expect(events[3]!.outcome).toBe("failed");
  });

  it("emits a single error when the operation itself failed and no leaf carried it", async () => {
    await session({ sessionId: "s1" }, () => {
      integration.onStart({ callId: "c3", operationId: "ai.streamObject", functionId: "extract" });
      integration.onEnd({ callId: "c3", error: new Error("schema mismatch") });
    });
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "error", "agent_end"]);
    expect(events[2]!.outcome).toBe("failed");
  });

  it("records a failing tool on its tool_result", async () => {
    await session({ sessionId: "s1" }, () => {
      const toolCall = { toolCallId: "t1", toolName: "weather", input: {} };
      integration.onStart({ callId: "c4", operationId: "ai.generateText", functionId: "f" });
      integration.onToolExecutionStart({ callId: "c4", toolCall });
      integration.onToolExecutionEnd({ callId: "c4", toolCall, toolOutput: { type: "tool-error", error: new Error("down") } });
      integration.onEnd({ callId: "c4" });
    });
    const events = await flushed(spool);
    expect(events.find((e) => e.type === "tool_result")!.error).toBe("Error: down");
    expect(types(events)).not.toContain("error");
  });

  it("nests an operation started inside a tool under the operation that called it", async () => {
    await session({ sessionId: "s1" }, async () => {
      integration.onStart({ callId: "outer", operationId: "ai.generateText", functionId: "supervisor" });
      await integration.executeTool({
        callId: "outer",
        execute: async () => {
          integration.onStart({ callId: "inner", operationId: "ai.generateText", functionId: "researcher" });
          integration.onEnd({ callId: "inner" });
        },
      });
      integration.onEnd({ callId: "outer" });
    });
    const events = await flushed(spool);
    const inner = events.find((e) => e.type === "agent_start" && e.agent_id === "researcher")!;
    expect(inner.parent_id).toBe("supervisor");
  });

  it("is registered process-wide by instrument() exactly once, and removed by uninstrument()", async () => {
    const g = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
    const before = g.AI_SDK_TELEMETRY_INTEGRATIONS;
    try {
      g.AI_SDK_TELEMETRY_INTEGRATIONS = [{ someone: "else" }];
      await adapter.install({});
      await adapter.install({});
      expect(g.AI_SDK_TELEMETRY_INTEGRATIONS.filter((i) => i === integration)).toHaveLength(1);
      adapter.uninstall();
      expect(g.AI_SDK_TELEMETRY_INTEGRATIONS).toEqual([{ someone: "else" }]);
    } finally {
      g.AI_SDK_TELEMETRY_INTEGRATIONS = before;
    }
  });
});

describe("the middleware", () => {
  const generate = (result: Record<string, unknown>) => ({
    params: { prompt: [{ role: "user", content: "hi" }] },
    model: { modelId: "gpt-x", provider: "p" },
    doGenerate: async () => result,
  });

  it("makes a call outside any scope its own run, in a session of its own", async () => {
    await middleware().wrapGenerate(generate({ content: [{ type: "text", text: "hi" }], finishReason: "stop" }));
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events.every((e) => e.agent_id === "gpt-x")).toBe(true);
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("records a call inside agent() as a step of that agent", async () => {
    await session({ sessionId: "s1" }, () =>
      agent("planner", () =>
        middleware().wrapGenerate(
          generate({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: { inputTokens: { total: 3 }, outputTokens: { total: 4 } },
          }),
        ),
      ),
    );
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events.every((e) => e.agent_id === "planner")).toBe(true);
    const response = events[2]!;
    expect([response.input_tokens, response.output_tokens, response.stop_reason]).toEqual([3, 4, "stop"]);
  });

  it("records a failing model on its model_response, and rethrows", async () => {
    await expect(
      middleware().wrapGenerate({
        params: {},
        model: { modelId: "gpt-x" },
        doGenerate: async () => {
          throw new Error("rate limited");
        },
      }),
    ).rejects.toThrow("rate limited");
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[2]!.error).toBe("Error: rate limited");
    expect(events[3]!.outcome).toBe("failed");
  });

  it("defers to the tracer inside a model span, so each call is recorded once", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () =>
      t.startActiveSpan(
        "ai.generateText.doGenerate",
        { attributes: { "ai.operationId": "ai.generateText.doGenerate" } },
        async (span: Span) => {
          await middleware().wrapGenerate(generate({ text: "x" }));
          span.end();
        },
      ),
    );
    const events = await flushed(spool);
    expect(types(events)).toEqual(["model_request", "model_response"]);
  });

  it("defers to the v7 integration inside executeLanguageModelCall", async () => {
    await integration.executeLanguageModelCall({
      execute: () => middleware().wrapGenerate(generate({ text: "x" })),
    });
    expect(await flushed(spool)).toEqual([]);
  });

  it("reads a v4 stream's textDelta parts", async () => {
    const result = await middleware().wrapStream({
      params: {},
      model: { modelId: "gpt-x" },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "he" });
            controller.enqueue({ type: "text-delta", textDelta: "y" });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2 } });
            controller.close();
          },
        }),
      }),
    });
    for await (const _ of result.stream as unknown as AsyncIterable<unknown>) void _;
    const response = (await flushed(spool)).find((e) => e.type === "model_response")!;
    expect([response.content, response.input_tokens, response.output_tokens, response.stop_reason]).toEqual([
      "hey",
      1,
      2,
      "stop",
    ]);
  });
});
