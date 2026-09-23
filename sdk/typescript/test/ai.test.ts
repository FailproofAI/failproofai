import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as core from "../src/integrations/core.js";
import {
  FailproofSpan,
  _internals,
  adapter,
  integration,
  middleware,
  responseContent,
  stopReasonOf,
  toolCallsOf,
  tracer,
  usageTokens,
} from "../src/integrations/ai.js";
import { setLogger } from "../src/logger.js";
import { runtime } from "../src/runtime.js";
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
const count = (events: Array<Record<string, unknown>>, type: string) => events.filter((e) => e.type === type).length;

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
    // The call's input is parsed, as on every other path — not a JSON string in JSON.
    expect(response.content).toEqual([{ toolCallId: "c1", toolName: "weather", input: {} }]);
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

describe("the middleware on a stream that does not finish", () => {
  const endless = (onCancel: (reason: unknown) => void) =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue({ type: "text-delta", delta: "x" });
      },
      cancel(reason) {
        onCancel(reason);
      },
    });

  it("closes a streamed call the consumer cancels, as cancelled, and cancels the provider stream", async () => {
    let sourceCancelled: unknown;
    const result = await middleware().wrapStream({
      params: {},
      model: { modelId: "gpt-x" },
      doStream: async () => ({ stream: endless((reason) => (sourceCancelled = reason)) }),
    });
    const reader = (result.stream as ReadableStream<unknown>).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel("client disconnected");
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    const response = events[2]!;
    expect(response.stop_reason).toBe("cancelled");
    expect(response.error).toBeUndefined();
    expect(response.content).toMatch(/^x+$/);
    expect(response.request_id).toBe(events[1]!.request_id);
    expect(events[3]!.outcome).toBe("cancelled");
    expect(sourceCancelled).toBe("client disconnected");
    expect(count(events, "error")).toBe(0);
  });

  it("closes a streamed call whose stream errors, with the error, and ends its run failed", async () => {
    const result = await middleware().wrapStream({
      params: {},
      model: { modelId: "gpt-x" },
      doStream: async () => ({
        stream: new ReadableStream({
          async pull(controller) {
            controller.enqueue({ type: "text-delta", delta: "y" });
            await Promise.resolve();
            controller.error(new Error("ECONNRESET"));
          },
        }),
      }),
    });
    const reader = (result.stream as ReadableStream<unknown>).getReader();
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("ECONNRESET");
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[2]!.stop_reason).toBe("error");
    expect(events[2]!.error).toBe("Error: ECONNRESET");
    expect(events[3]!.outcome).toBe("failed");
    // Recorded once, on the model_response — not again as an `error` event.
    expect(count(events, "error")).toBe(0);
  });

  it("closes a cancelled call inside agent() without ending the enclosing agent", async () => {
    await session({ sessionId: "s1" }, () =>
      agent("planner", async () => {
        const result = await middleware().wrapStream({
          params: {},
          model: { modelId: "gpt-x" },
          doStream: async () => ({ stream: endless(() => undefined) }),
        });
        const reader = (result.stream as ReadableStream<unknown>).getReader();
        await reader.read();
        await reader.cancel();
      }),
    );
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events.every((e) => e.agent_id === "planner")).toBe(true);
    expect(events[2]!.stop_reason).toBe("cancelled");
    // The only agent_end is the planner's own, from its scope.
    expect(events[3]!.outcome).toBe("success");
  });
});

describe("instrument('ai') and the process-wide OpenTelemetry slot", () => {
  /**
   * A throwaway application with `ai` at `version` and a stand-in for
   * `@opentelemetry/api` that keeps the real one's global-registration rule:
   * the first provider wins and every later `setGlobalTracerProvider` returns
   * false. (The real API against real `ai` releases is proven in
   * `integration/ai.test.ts`.)
   */
  const apps: string[] = [];
  const makeApp = (version: string): string => {
    const app = mkdtempSync(join(tmpdir(), "failproofai-ai-otel-"));
    apps.push(app);
    const write = (path: string, text: string): void => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(app, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version, main: "index.js" }));
    write(join(app, "node_modules", "ai", "index.js"), "module.exports = {};\n");
    write(
      join(app, "node_modules", "@opentelemetry", "api", "package.json"),
      JSON.stringify({ name: "@opentelemetry/api", version: "1.9.0", main: "index.js" }),
    );
    write(
      join(app, "node_modules", "@opentelemetry", "api", "index.js"),
      [
        "let delegate = null;",
        "class NoopTracerProvider { getTracer() { return {}; } }",
        "class ProxyTracerProvider { getDelegate() { return delegate ?? new NoopTracerProvider(); } }",
        "const proxy = new ProxyTracerProvider();",
        "module.exports = {",
        "  ProxyTracerProvider,",
        "  trace: {",
        "    setGlobalTracerProvider(p) { if (delegate) return false; delegate = p; return true; },",
        "    getTracerProvider() { return proxy; },",
        "    disable() { delegate = null; },",
        "  },",
        "};",
      ].join("\n"),
    );
    return app;
  };
  interface FakeOtel {
    trace: {
      setGlobalTracerProvider(p: unknown): boolean;
      getTracerProvider(): { getDelegate(): unknown };
    };
  }
  const otelOf = (app: string): FakeOtel => createRequire(join(app, "main.js"))("@opentelemetry/api") as FakeOtel;
  const inApp = async (app: string, fn: () => unknown): Promise<void> => {
    const cwd = process.cwd();
    process.chdir(app);
    try {
      await fn();
    } finally {
      process.chdir(cwd);
    }
  };
  afterEach(() => {
    for (const app of apps.splice(0)) rmSync(app, { recursive: true, force: true });
  });

  it.each(["4.3.19", "5.0.0", "6.0.288"])(
    "on ai %s does not take the global slot by default, so the customer's own provider still registers",
    async (version) => {
      const app = makeApp(version);
      await inApp(app, () => adapter.install({}));
      const theirs = { getTracer: () => ({ theirs: true }) };
      expect(otelOf(app).trace.setGlobalTracerProvider(theirs)).toBe(true);
      expect(otelOf(app).trace.getTracerProvider().getDelegate()).toBe(theirs);
      // …and says, once, what instrument("ai") does and does not cover here.
      await inApp(app, () => adapter.install({}));
      const advice = warnings.filter((w) => w.includes("registerGlobalTracer"));
      expect(advice).toHaveLength(1);
      expect(advice[0]).toContain("telemetry()");
      // …naming an import that exists. The root package has no `ai` export, so
      // `failproofai.ai.telemetry()` sent the reader to `undefined`.
      expect(advice[0]).toContain('from "@failproofai/sdk/ai"');
      expect(advice[0]).not.toContain("failproofai.ai.");
    },
  );

  it("registers the global tracer on ai 4–6 only when asked to", async () => {
    const app = makeApp("6.0.288");
    await inApp(app, () => adapter.install({ registerGlobalTracer: true }));
    const delegate = otelOf(app).trace.getTracerProvider().getDelegate() as { getTracer?: () => unknown };
    expect((delegate.getTracer?.() as object | undefined)?.constructor.name).toBe("FailproofTracer");
    expect(warnings.filter((w) => w.includes("registerGlobalTracer"))).toEqual([]);
    // uninstrument() gives the slot back.
    adapter.uninstall();
    expect(otelOf(app).trace.setGlobalTracerProvider({ getTracer: () => ({}) })).toBe(true);
  });

  it("stays quiet on ai 4–6 when told registerGlobalTracer: false", async () => {
    const app = makeApp("5.0.0");
    await inApp(app, () => adapter.install({ registerGlobalTracer: false }));
    expect(warnings).toEqual([]);
    expect(otelOf(app).trace.setGlobalTracerProvider({ getTracer: () => ({}) })).toBe(true);
  });

  it("on ai 7 neither touches OpenTelemetry nor warns", async () => {
    const app = makeApp("7.0.111");
    await inApp(app, () => adapter.install({}));
    expect(warnings).toEqual([]);
    expect(otelOf(app).trace.setGlobalTracerProvider({ getTracer: () => ({}) })).toBe(true);
  });
});

describe("bookkeeping", () => {
  interface TrackerMaps {
    links: Map<unknown, unknown>;
    runs: Map<unknown, unknown>;
  }
  const maps = (): TrackerMaps => _internals.tracker() as unknown as TrackerMaps;

  it("leaves no residue after 20k completed operations, and never evicts a live run's links", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const original = runtime.event;
    runtime.event = new Proxy(
      {},
      {
        get: (_, method) => (options: Record<string, unknown>) =>
          captured.push({ method: String(method), ...options }),
      },
    ) as typeof runtime.event;
    try {
      const t = tracer();
      const mw = middleware();

      // A run that stays open throughout: a root operation with an
      // intermediate span under it, whose child only arrives at the very end.
      let liveRoot: FailproofSpan | undefined;
      let liveStep: FailproofSpan | undefined;
      await session({ sessionId: "live" }, () =>
        t.startActiveSpan(
          "ai.generateText",
          { attributes: { "ai.operationId": "ai.generateText", "ai.telemetry.functionId": "live-agent" } },
          (root) => {
            liveRoot = root;
            t.startActiveSpan("ai.step", (step) => {
              liveStep = step;
            });
          },
        ),
      );

      const stream = (mode: "finish" | "cancel" | "error") => async () => ({
        stream: new ReadableStream({
          pull(controller) {
            controller.enqueue({ type: "text-delta", delta: "x" });
            if (mode === "finish") {
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            } else if (mode === "error") {
              controller.error(new Error("reset"));
            }
          },
        }),
      });
      const drain = async (s: unknown, cancel: boolean): Promise<void> => {
        const reader = (s as ReadableStream<unknown>).getReader();
        try {
          if (cancel) {
            await reader.read();
            await reader.cancel();
            return;
          }
          while (!(await reader.read()).done) {
            /* drain */
          }
        } catch {
          // the errored stream
        }
      };

      const N = 20_000;
      for (let i = 0; i < N; i += 1) {
        // ai v4–v6: the tracer, every span kind.
        t.startActiveSpan("ai.generateText", { attributes: { "ai.operationId": "ai.generateText" } }, (root) => {
          t.startActiveSpan(
            "ai.generateText.doGenerate",
            { attributes: { "ai.operationId": "ai.generateText.doGenerate" } },
            (span) => span.end(),
          );
          t.startActiveSpan(
            "ai.toolCall",
            { attributes: { "ai.operationId": "ai.toolCall", "ai.toolCall.id": `t${String(i)}` } },
            (span) => span.end(),
          );
          t.startActiveSpan("ai.other", (span) => span.end());
          if (i % 2 === 0) root.recordException(new Error("x"));
          root.end();
        });
        // ai v7: the integration — success, error and abort paths.
        const callId = `c${String(i)}`;
        const toolCall = { toolCallId: `tc${String(i)}`, toolName: "w", input: {} };
        integration.onStart({ callId, operationId: "ai.generateText", functionId: "f" });
        integration.onLanguageModelCallStart({ callId });
        integration.onLanguageModelCallEnd({ callId, finishReason: "tool-calls" });
        integration.onToolExecutionStart({ callId, toolCall });
        if (i % 3 === 0) {
          integration.onToolExecutionEnd({ callId, toolCall, toolOutput: { type: "tool-result", output: 1 } });
          integration.onEnd({ callId });
        } else if (i % 3 === 1) {
          integration.onLanguageModelCallStart({ callId });
          integration.onError({ callId, error: new Error("boom") });
        } else {
          integration.onAbort({ callId });
        }
        // The middleware: generate, and a stream that finishes, is cancelled, or errors.
        await mw.wrapGenerate({ params: {}, model: { modelId: "m" }, doGenerate: async () => ({ text: "x" }) });
        const mode = (["finish", "cancel", "error"] as const)[i % 3]!;
        const result = await mw.wrapStream({ params: {}, model: { modelId: "m" }, doStream: stream(mode) });
        await drain(result.stream, mode === "cancel");
      }

      // Only the live run is left: its agent, and its intermediate span's link.
      expect(maps().runs.size).toBe(1);
      expect(maps().links.size).toBe(1);
      expect(_internals.openCalls()).toBe(0);

      // That link survived 20k runs through the table: the live run's late
      // child still resolves to it.
      captured.length = 0;
      const step = new FailproofSpan("ai.generateText.doGenerate", liveStep, {
        "ai.operationId": "ai.generateText.doGenerate",
      });
      step.end();
      liveStep!.end();
      liveRoot!.end();
      expect(captured.map((e) => [e.method, e.agentId, e.sessionId])).toEqual([
        ["modelRequest", "live-agent", "live"],
        ["modelResponse", "live-agent", "live"],
        ["agentEnd", "live-agent", "live"],
      ]);
      expect(maps().runs.size).toBe(0);
      expect(maps().links.size).toBe(0);
    } finally {
      runtime.event = original;
    }
  }, 120_000);
});

describe("tool calls in a model_response", () => {
  it("reads every major's ai.response.toolCalls into one shape, input parsed", () => {
    // v4: toolCallType + args as a JSON string.
    expect(toolCallsOf(JSON.stringify([{ toolCallType: "function", toolCallId: "a", toolName: "w", args: '{"city":"Paris"}' }]))).toEqual([
      { toolCallId: "a", toolName: "w", input: { city: "Paris" } },
    ]);
    // v5/v6 generateText: input as a JSON string.
    expect(toolCallsOf(JSON.stringify([{ toolCallId: "b", toolName: "w", input: '{"city":"Rome"}' }]))).toEqual([
      { toolCallId: "b", toolName: "w", input: { city: "Rome" } },
    ]);
    // v5/v6 streamText: a typed part with input already an object.
    expect(toolCallsOf(JSON.stringify([{ type: "tool-call", toolCallId: "c", toolName: "w", input: { city: "Oslo" } }]))).toEqual([
      { toolCallId: "c", toolName: "w", input: { city: "Oslo" } },
    ]);
    expect(toolCallsOf(undefined)).toBeUndefined();
    expect(toolCallsOf("[]")).toBeUndefined();
    expect(toolCallsOf("not json")).toBeUndefined();
  });
});

describe("the tracer when a stream does not finish (ai v4–v6)", () => {
  type Tracer = ReturnType<typeof tracer>;
  const streamRoot = (t: Tracer, functionId: string, body: (root: Span) => void): void => {
    t.startActiveSpan(
      "ai.streamText",
      { attributes: { "ai.operationId": "ai.streamText", "ai.telemetry.functionId": functionId } },
      (root: Span) => body(root),
    );
  };
  const openStep = (t: Tracer): Span => {
    let step: Span | undefined;
    t.startActiveSpan(
      "ai.streamText.doStream",
      { attributes: { "ai.operationId": "ai.streamText.doStream", "ai.model.id": "m" } },
      (span: Span) => {
        step = span;
      },
    );
    return step!;
  };

  it("closes the model call an aborted stream left open, and ends the agent cancelled", async () => {
    const t = tracer();
    let step: Span | undefined;
    await session({ sessionId: "s1" }, () => {
      streamRoot(t, "counter", (root) => {
        step = openStep(t);
        // v5/v6 on abort: the root ends from the result stream's flush; the
        // model step's span is never ended.
        root.end();
      });
    });
    // A late end of the abandoned step is not news.
    step!.setAttributes({ "ai.response.finishReason": "stop" });
    step!.end();
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    const response = events.find((e) => e.type === "model_response")!;
    expect(response.stop_reason).toBe("cancelled");
    expect(response.model).toBe("m");
    expect(response.request_id).toBe(events.find((e) => e.type === "model_request")!.request_id);
    expect(events.at(-1)!.outcome).toBe("cancelled");
    expect(count(events, "error")).toBe(0);
    expect(_internals.tracker()!.stats()).toEqual({ runs: 0, links: 0 });
  });

  it("closes a tool a cut-off operation left running, as cancelled", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () => {
      streamRoot(t, "agent", (root) => {
        t.startActiveSpan(
          "ai.toolCall",
          { attributes: { "ai.operationId": "ai.toolCall", "ai.toolCall.name": "weather", "ai.toolCall.id": "tc1" } },
          () => undefined,
        );
        root.end();
      });
    });
    const events = await flushed(spool);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.tool_call_id).toBe("tc1");
    expect(result.error).toMatch(/cancelled/);
    expect(events.at(-1)!.outcome).toBe("cancelled");
  });

  it("ends a streamText that finished no step as cancelled, and a completed one as success", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () => {
      streamRoot(t, "aborted-between-steps", (root) => root.end());
      streamRoot(t, "finished", (root) => {
        root.setAttributes({ "ai.response.finishReason": "stop" });
        root.end();
      });
      t.startActiveSpan("ai.generateText", { attributes: { "ai.operationId": "ai.generateText" } }, (root: Span) => root.end());
    });
    const ends = (await flushed(spool)).filter((e) => e.type === "agent_end");
    expect(ends.map((e) => [e.agent_id, e.outcome])).toEqual([
      ["aborted-between-steps", "cancelled"],
      ["finished", "success"],
      ["ai.generateText", "success"],
    ]);
  });

  it("ends an operation nothing will ever end — its root span collected — as cancelled and abandoned", async () => {
    const { setFlagsFromString } = await import("node:v8");
    const { runInNewContext } = await import("node:vm");
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;

    // A client that disconnected: the SDK's result stream never flushes, so
    // neither span is ended, and every reference to them is then dropped.
    const start = (): void => {
      const t = tracer();
      streamRoot(t, "disconnected", () => {
        openStep(t);
      });
    };
    await session({ sessionId: "s1" }, () => {
      start();
    });
    for (let i = 0; i < 20 && _internals.tracker()!.stats().runs > 0; i += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[2]!.stop_reason).toBe("cancelled");
    expect(events.at(-1)!.outcome).toBe("cancelled");
    expect(events.at(-1)!.fw_abandoned).toBe(true);
    expect(events.every((e) => e.session_id === "s1" && e.agent_id === "disconnected")).toBe(true);
    expect(_internals.tracker()!.stats()).toEqual({ runs: 0, links: 0 });
  });
});

describe("embeddings", () => {
  type Tracer = ReturnType<typeof tracer>;
  const embedSpans = (t: Tracer, operation = "ai.embed", functionId?: string): void => {
    t.startActiveSpan(
      operation,
      { attributes: { "ai.operationId": operation, ...(functionId ? { "ai.telemetry.functionId": functionId } : {}) } },
      (root: Span) => {
        t.startActiveSpan(
          `${operation}.doEmbed`,
          { attributes: { "ai.operationId": `${operation}.doEmbed`, "ai.model.id": "embedder" } },
          (span: Span) => {
            span.setAttributes({ "ai.usage.tokens": 3 });
            span.end();
          },
        );
        root.end();
      },
    );
  };
  const lines = (events: Array<Record<string, unknown>>) => events.map((e) => `${String(e.agent_id)} ${String(e.type)}`);

  it("tracer: a bare embed() is its own run, named by functionId", async () => {
    embedSpans(tracer(), "ai.embed", "indexer");
    const events = await flushed(spool);
    expect(lines(events)).toEqual([
      "indexer agent_start",
      "indexer model_request",
      "indexer model_response",
      "indexer agent_end",
    ]);
    expect(events[2]!.input_tokens).toBe(3);
  });

  it("tracer: an embed() inside agent() is a model call of that agent, not a nested agent", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () =>
      agent("rag", () => {
        embedSpans(t);
        embedSpans(t, "ai.embedMany");
      }),
    );
    const events = await flushed(spool);
    expect(lines(events)).toEqual([
      "rag agent_start",
      "rag model_request",
      "rag model_response",
      "rag model_request",
      "rag model_response",
      "rag agent_end",
    ]);
    expect(_internals.tracker()!.stats()).toEqual({ runs: 0, links: 0 });
  });

  it("tracer: an embed() inside a tool is a model call of the operation that ran the tool", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () => {
      t.startActiveSpan(
        "ai.generateText",
        { attributes: { "ai.operationId": "ai.generateText", "ai.telemetry.functionId": "weather-agent" } },
        (root: Span) => {
          t.startActiveSpan(
            "ai.toolCall",
            { attributes: { "ai.operationId": "ai.toolCall", "ai.toolCall.name": "lookup", "ai.toolCall.id": "tc1" } },
            (tool: Span) => {
              embedSpans(t);
              tool.end();
            },
          );
          root.end();
        },
      );
    });
    const events = await flushed(spool);
    expect(lines(events)).toEqual([
      "weather-agent agent_start",
      "weather-agent tool_use",
      "weather-agent model_request",
      "weather-agent model_response",
      "weather-agent tool_result",
      "weather-agent agent_end",
    ]);
    expect(events.at(-1)!.outcome).toBe("success");
  });

  it("tracer: a failing enclosed embed() reports its error under the enclosing agent", async () => {
    const t = tracer();
    await session({ sessionId: "s1" }, () =>
      agent("rag", () => {
        t.startActiveSpan("ai.embed", { attributes: { "ai.operationId": "ai.embed" } }, (root: Span) => {
          root.recordException(new Error("too many values"));
          root.end();
        });
      }),
    );
    expect(lines(await flushed(spool))).toEqual(["rag agent_start", "rag error", "rag agent_end"]);
  });

  it("v7: bare, inside agent(), and inside a tool — the same three answers", async () => {
    const embed = (callId: string, functionId?: string): void => {
      integration.onStart({ callId, operationId: "ai.embed", ...(functionId ? { functionId } : {}) });
      integration.onEmbedStart({ callId, modelId: "embedder", values: ["a"] });
      integration.onEmbedEnd({ callId, modelId: "embedder", usage: { tokens: 3 } });
      integration.onEnd({ callId });
    };
    embed("bare", "indexer");
    await session({ sessionId: "s1" }, async () => {
      await agent("rag", () => {
        embed("scoped");
      });
      integration.onStart({ callId: "outer", operationId: "ai.generateText", functionId: "weather-agent" });
      await integration.executeTool({
        callId: "outer",
        execute: async () => {
          embed("in-tool");
        },
      });
      integration.onEnd({ callId: "outer" });
    });
    const events = await flushed(spool);
    expect(lines(events)).toEqual([
      "indexer agent_start",
      "indexer model_request",
      "indexer model_response",
      "indexer agent_end",
      "rag agent_start",
      "rag model_request",
      "rag model_response",
      "rag agent_end",
      "weather-agent agent_start",
      "weather-agent model_request",
      "weather-agent model_response",
      "weather-agent agent_end",
    ]);
    expect(events.filter((e) => e.type === "model_response").map((e) => e.input_tokens)).toEqual([3, 3, 3]);
    expect(_internals.openCalls()).toBe(0);
    expect(_internals.tracker()!.stats()).toEqual({ runs: 0, links: 0 });
  });
});

describe("the telemetry integration on abort and failure (ai v7)", () => {
  it("closes the interrupted model call as cancelled, keeping its model", async () => {
    await session({ sessionId: "s1" }, () => {
      integration.onStart({ callId: "a1", operationId: "ai.streamText", functionId: "counter" });
      integration.onLanguageModelCallStart({ callId: "a1", modelId: "m" });
      integration.onAbort({ callId: "a1" });
    });
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[2]!.stop_reason).toBe("cancelled");
    expect(events[2]!.model).toBe("m");
    expect(events[3]!.outcome).toBe("cancelled");
  });

  it("keeps the model on a call closed by a failure", async () => {
    await session({ sessionId: "s1" }, () => {
      integration.onStart({ callId: "e1", operationId: "ai.generateText", functionId: "f" });
      integration.onLanguageModelCallStart({ callId: "e1", modelId: "m" });
      integration.onError({ callId: "e1", error: new Error("boom") });
    });
    const response = (await flushed(spool)).find((e) => e.type === "model_response")!;
    expect(response.stop_reason).toBe("error");
    expect(response.model).toBe("m");
  });
});
