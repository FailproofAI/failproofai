import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogger } from "../src/logger.js";
import * as core from "../src/integrations/core.js";
import { session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The adapters' translation tables, exercised against the shapes the real
 * frameworks emit.
 *
 * These are the parts that can silently stop recording: a framework renames a
 * callback, moves its token counts, or changes where the model id lives, and
 * the adapter installs cleanly and produces nothing. Nothing else in the suite
 * would notice.
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

describe("the Vercel AI SDK tracer", () => {
  it("turns the SDK's own spans into an agent span, a model pair and a tool pair", async () => {
    const { telemetry } = await import("../src/integrations/ai.js");
    const { tracer } = telemetry({ functionId: "answer-question" });

    await session({ sessionId: "s1" }, async () => {
      // Exactly the shape `generateText` produces: a root span, a doGenerate
      // span inside it, and a toolCall span beside that.
      await tracer.startActiveSpan(
        "ai.generateText",
        { attributes: { "ai.operationId": "ai.generateText", "ai.telemetry.functionId": "answer-question" } },
        async (root: { setAttribute: (k: string, v: unknown) => unknown }) => {
          await tracer.startActiveSpan(
            "ai.generateText.doGenerate",
            {
              attributes: {
                "ai.operationId": "ai.generateText.doGenerate",
                "ai.model.id": "gpt-4o",
                "ai.model.provider": "openai",
                "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
              },
            },
            (span: { setAttributes: (a: Record<string, unknown>) => unknown }) => {
              span.setAttributes({
                "ai.response.text": "hello",
                "ai.response.finishReason": "stop",
                "ai.usage.inputTokens": 11,
                "ai.usage.outputTokens": 22,
              });
            },
          );
          await tracer.startActiveSpan(
            "ai.toolCall",
            {
              attributes: {
                "ai.operationId": "ai.toolCall",
                "ai.toolCall.name": "get_weather",
                "ai.toolCall.id": "call-1",
                "ai.toolCall.args": JSON.stringify({ city: "Faro" }),
              },
            },
            (span: { setAttribute: (k: string, v: unknown) => unknown }) => {
              span.setAttribute("ai.toolCall.result", JSON.stringify({ celsius: 21 }));
            },
          );
          root.setAttribute("ai.response.text", "hello");
        },
      );
    });

    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "tool_use",
      "tool_result",
      "agent_end",
    ]);

    const request = events.find((event) => event.type === "model_request")!;
    expect(request.model).toBe("gpt-4o");
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);

    const response = events.find((event) => event.type === "model_response")!;
    expect(response.input_tokens).toBe(11);
    expect(response.output_tokens).toBe(22);
    expect(response.stop_reason).toBe("stop");
    // The pair is correlated, which is what lets the dashboard join them.
    expect(response.request_id).toBe(request.request_id);

    const toolUse = events.find((event) => event.type === "tool_use")!;
    expect(toolUse.tool_name).toBe("get_weather");
    expect(toolUse.tool_call_id).toBe("call-1");
    expect(toolUse.input).toEqual({ city: "Faro" });
    expect(events.find((event) => event.type === "tool_result")!.output).toEqual({ celsius: 21 });

    // `functionId` names the agent span, and `agent_id` is a low-cardinality
    // facet, so it must be the label and not the span id.
    expect(events[0]!.agent_id).toBe("answer-question");
    expect(events.at(-1)!.outcome).toBe("success");
  });

  it("reads v4's token attribute names as well as v5's", async () => {
    const { tracer } = await import("../src/integrations/ai.js");
    const t = tracer();
    await session({ sessionId: "s1" }, () => {
      t.startActiveSpan(
        "ai.generateText.doGenerate",
        {
          attributes: {
            "ai.operationId": "ai.generateText.doGenerate",
            "ai.usage.promptTokens": 5,
            "ai.usage.completionTokens": 7,
          },
        },
        () => undefined,
      );
    });
    const response = (await flushed(spool)).find((event) => event.type === "model_response")!;
    expect([response.input_tokens, response.output_tokens]).toEqual([5, 7]);
  });

  it("records a thrown error as a failed span", async () => {
    const { tracer } = await import("../src/integrations/ai.js");
    const t = tracer();
    await session({ sessionId: "s1" }, () => {
      expect(() =>
        t.startActiveSpan(
          "ai.generateText",
          { attributes: { "ai.operationId": "ai.generateText" } },
          () => {
            throw new Error("provider is down");
          },
        ),
      ).toThrow("provider is down");
    });
    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual(["agent_start", "error", "agent_end"]);
    expect(events.at(-1)!.outcome).toBe("failed");
  });
});

describe("the AI SDK middleware", () => {
  it("records a model call and its usage", async () => {
    const { middleware } = await import("../src/integrations/ai.js");
    const mw = middleware() as {
      wrapGenerate: (arg: {
        doGenerate: () => Promise<unknown>;
        params: Record<string, unknown>;
        model?: { modelId?: string; provider?: string };
      }) => Promise<unknown>;
    };

    await session({ sessionId: "s1" }, async () => {
      await mw.wrapGenerate({
        params: { prompt: [{ role: "user", content: "hi" }] },
        model: { modelId: "claude-opus-5", provider: "anthropic" },
        doGenerate: async () => ({
          content: [{ type: "text", text: "hello" }],
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 4 },
        }),
      });
    });

    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual(["model_request", "model_response"]);
    expect(events[0]!.model).toBe("claude-opus-5");
    expect(events[1]!.input_tokens).toBe(3);
    expect(events[1]!.request_id).toBe(events[0]!.request_id);
  });

  it("emits the response only when a STREAM finishes, so usage is not lost", async () => {
    const { middleware } = await import("../src/integrations/ai.js");
    const mw = middleware() as {
      wrapStream: (arg: {
        doStream: () => Promise<unknown>;
        params: Record<string, unknown>;
        model?: { modelId?: string };
      }) => Promise<{ stream: ReadableStream<unknown> }>;
    };

    const result = await session({ sessionId: "s1" }, async () =>
      mw.wrapStream({
        params: { prompt: [{ role: "user", content: "hi" }] },
        model: { modelId: "claude-opus-5" },
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", delta: "hel" });
              controller.enqueue({ type: "text-delta", delta: "lo" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 2 },
              });
              controller.close();
            },
          }),
        }),
      }),
    );

    // Before the consumer reads it, only the request exists: a stream's usage
    // and finish reason live in its FINAL part.
    expect((await flushed(spool)).map((event) => event.type)).toEqual(["model_request"]);

    const chunks: unknown[] = [];
    for await (const chunk of result.stream as unknown as AsyncIterable<unknown>) chunks.push(chunk);
    // Every chunk still reaches the caller untouched.
    expect(chunks).toHaveLength(3);

    const events = await flushed(spool);
    const response = events.find((event) => event.type === "model_response")!;
    expect(response.content).toBe("hello");
    expect(response.output_tokens).toBe(2);
    expect(response.stop_reason).toBe("stop");
  });
});

describe("the LangChain adapter", () => {
  /** The `CallbackManager` shape `@langchain/core` exposes, minus the rest of it. */
  function fakeLangChain() {
    class CallbackManager {
      handlers: unknown[] = [];
      addHandler(handler: unknown): void {
        this.handlers.push(handler);
      }
      static configure(): CallbackManager | undefined {
        return undefined;
      }
    }
    return { CallbackManager };
  }

  it("translates the handler surface into events", async () => {
    // The adapter's `install()` imports `@langchain/core`, which is not a
    // dependency here. Its HANDLER is the translation table, and that is what
    // is worth testing — so drive it through the same tracker the adapter uses.
    const tracker = new core.RunTracker("langchain", {
      baseFields: core.frameworkFields("langchain"),
    });

    tracker.startAgent("chain-1", { agentId: "agent", sessionId: "s1", fw_run_type: "chain" });
    tracker.emit("modelRequest", "llm-1", {
      parentKey: "chain-1",
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      requestId: "llm-1",
    });
    tracker.emit("modelResponse", "llm-1", {
      parentKey: "chain-1",
      inputTokens: 9,
      outputTokens: 8,
      content: "hello",
      requestId: "llm-1",
    });
    tracker.emit("toolUse", "tool-1", {
      parentKey: "chain-1",
      toolName: "search",
      toolCallId: "tool-1",
      input: { input: "kites" },
    });
    tracker.emit("toolResult", "tool-1", {
      parentKey: "chain-1",
      toolName: "search",
      toolCallId: "tool-1",
      output: "results",
    });
    tracker.endAgent("chain-1", { outcome: "success" });

    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "tool_use",
      "tool_result",
      "agent_end",
    ]);
    // Every event carries the framework label, which is how a mixed process is
    // read back apart.
    expect(events.every((event) => event.framework === "langchain")).toBe(true);
    expect(events.every((event) => event.session_id === "s1")).toBe(true);
  });

  it("attaches itself to a manager `configure` built, idempotently", () => {
    const { CallbackManager } = fakeLangChain();
    const handler = { name: "failproofai" };
    const manager = new CallbackManager();
    // The adapter's `attach` is idempotent by identity: LangChain calls
    // `configure` per invocation and a child manager may inherit the parent's
    // handler list, so a blind add would emit each event once per attachment.
    const attach = (target: InstanceType<typeof CallbackManager>): void => {
      if (target.handlers.includes(handler)) return;
      target.addHandler(handler);
    };
    attach(manager);
    attach(manager);
    expect(manager.handlers).toHaveLength(1);
  });

  it("refuses to hand out a handler before the adapter is installed", async () => {
    const { langchainHandler } = await import("../src/integrations/langchain.js");
    expect(() => langchainHandler()).toThrow(/needs the adapter installed first/);
  });
});

describe("the Mastra helpers", () => {
  it("wraps a tool's execute without mutating the original", async () => {
    const { wrapTool } = await import("../src/integrations/mastra.js");
    const original = vi.fn(async () => ({ celsius: 21 }));
    const tool = { id: "get_weather", execute: original };
    const wrapped = wrapTool(tool);

    // A Mastra tool may be frozen, so wrapping returns a new object rather
    // than assigning into theirs.
    expect(wrapped).not.toBe(tool);
    expect(tool.execute).toBe(original);

    await session({ sessionId: "s1" }, async () => {
      await (wrapped.execute as (context: unknown) => Promise<unknown>)({
        toolCallId: "call-1",
        context: { city: "Faro" },
      });
    });

    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual(["tool_use", "tool_result"]);
    expect(events[0]!.tool_name).toBe("get_weather");
    expect(events[0]!.input).toEqual({ city: "Faro" });
    expect(events[1]!.output).toEqual({ celsius: 21 });
  });

  it("records a tool failure on the leaf and re-throws", async () => {
    const { wrapTool } = await import("../src/integrations/mastra.js");
    const wrapped = wrapTool({
      id: "flaky",
      execute: async () => {
        throw new RangeError("out of range");
      },
    });
    await session({ sessionId: "s1" }, async () => {
      await expect(
        (wrapped.execute as (context: unknown) => Promise<unknown>)({ toolCallId: "c1" }),
      ).rejects.toThrow("out of range");
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect(result.error).toBe("RangeError: out of range");
  });

  it("brackets a workflow run with an agent span", async () => {
    const { workflow } = await import("../src/integrations/mastra.js");
    await session({ sessionId: "s1" }, async () => {
      await workflow("nightly-report", async () => undefined);
    });
    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
    expect(events[0]!.agent_id).toBe("nightly-report");
    expect(events[0]!.fw_kind).toBe("workflow");
  });
});
