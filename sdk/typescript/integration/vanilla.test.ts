import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FIXTURES, FORMATS, ROOT, describeTrace, ofType, runAgentAsync, traceViolations, typecheck, type Event } from "./harness.js";

/**
 * An agent with NO framework — the documented `examples/research-agent.ts`,
 * run as a customer would: the real `openai` client, the packed SDK, as an ES
 * module and as CommonJS.
 *
 * The fixture's `agent.ts` IS the example, byte for byte (the first test holds
 * that), so what the docs tell a customer to copy is what this proves records a
 * full trace: agent_start/agent_end around the run, a model_request/
 * model_response pair per turn with tokens and duration, a tool_use/tool_result
 * pair per tool carrying the model's own tool-call id — the same shape the
 * framework adapters produce.
 *
 * The model is a local OpenAI-compatible server playing a fixed conversation:
 * two tools in parallel, then one that fails (an unknown item), then the answer.
 */

const FIXTURE = "vanilla";

type Mode = "conversation" | "model-fails";

interface ChatRequest {
  messages: Array<{ role: string; content?: unknown }>;
}

const usage = (input: number, output: number) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
});

const toolCall = (id: string, name: string, item: string) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify({ item }) },
});

/** The reply for this point of the conversation, decided by how many tool results it carries. */
function reply(body: ChatRequest): Record<string, unknown> {
  const results = body.messages.filter((m) => m.role === "tool").length;
  const message =
    results === 0
      ? { role: "assistant", content: null, tool_calls: [toolCall("call_1", "price_of", "widget"), toolCall("call_2", "stock_of", "gadget")] }
      : results === 2
        ? { role: "assistant", content: null, tool_calls: [toolCall("call_3", "stock_of", "doohickey")] }
        : { role: "assistant", content: "widget 42 (120 in stock); gadget 17.5, out of stock." };
  return {
    id: `chatcmpl-${results}`,
    object: "chat.completion",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, message, finish_reason: message.content ? "stop" : "tool_calls" }],
    usage: usage(20 + results * 10, 7 + results),
  };
}

let server: Server | null = null;

async function startModel(mode: Mode): Promise<string> {
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (mode === "model-fails") {
        // 400: not retried by the openai client, so the failure is immediate.
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "model gpt-imaginary does not exist", type: "invalid_request_error" } }));
        return;
      }
      res.end(JSON.stringify(reply(JSON.parse(raw || "{}") as ChatRequest)));
    });
  });
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolveClose) => (server ? server.close(() => resolveClose()) : resolveClose()));
  server = null;
});

const shape = (events: Event[]): string[] =>
  events.map((e) => [e.agent_id, e.type, (e.tool_name ?? "") as string].join(" ").trim());

describe("an agent with no framework (examples/research-agent.ts)", () => {
  it("is the documented example, byte for byte", () => {
    const example = readFileSync(join(ROOT, "examples", "research-agent.ts"), "utf8");
    const fixture = readFileSync(join(FIXTURES, FIXTURE, "agent.ts"), "utf8");
    expect(fixture, "copy examples/research-agent.ts over integration/fixtures/vanilla/agent.ts").toBe(example);
  });

  it("typechecks against the real openai types", () => {
    expect(typecheck(FIXTURE)).toBe("");
  });

  describe.each(FORMATS)("as %s", (format) => {
    it("records the full trace: the run, every model turn, every tool", async () => {
      const baseUrl = await startModel("conversation");
      const result = await runAgentAsync(FIXTURE, format, "Price and stock for widget and gadget?", {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseUrl,
        MODEL: "fake-model",
      });
      expect(result.status, describeTrace(result)).toBe(0);
      expect(result.stdout).toContain("gadget 17.5, out of stock");

      expect(shape(result.events), describeTrace(result)).toEqual([
        "inventory agent_start",
        "inventory model_request",
        "inventory model_response",
        "inventory tool_use price_of",
        "inventory tool_result price_of",
        "inventory tool_use stock_of",
        "inventory tool_result stock_of",
        "inventory model_request",
        "inventory model_response",
        "inventory tool_use stock_of",
        "inventory tool_result stock_of",
        "inventory model_request",
        "inventory model_response",
        "inventory agent_end",
      ]);
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);

      const responses = ofType(result.events, "model_response");
      expect(responses.map((e) => [e.input_tokens, e.output_tokens])).toEqual([
        [20, 7],
        [40, 9],
        [50, 10],
      ]);
      expect(responses.map((e) => e.stop_reason)).toEqual(["tool_calls", "tool_calls", "stop"]);
      for (const e of responses) expect(typeof e.duration_ms).toBe("number");

      // The model's own tool-call ids, and the failure on its tool_result only.
      expect(ofType(result.events, "tool_use").map((e) => e.tool_call_id)).toEqual(["call_1", "call_2", "call_3"]);
      const results = ofType(result.events, "tool_result");
      expect(results.map((e) => e.output ?? null)).toEqual(["42", "0", null]);
      expect(results[2]!.error).toMatch(/unknown item "doohickey"/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(ofType(result.events, "agent_start")[0]!.goal).toBe("Price and stock for widget and gadget?");
    });

    it("records a failed model call once, and ends the run failed", async () => {
      const baseUrl = await startModel("model-fails");
      const result = await runAgentAsync(FIXTURE, format, "Price of widget?", {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseUrl,
        MODEL: "gpt-imaginary",
      });
      expect(result.status, describeTrace(result)).toBe(1);
      expect(shape(result.events), describeTrace(result)).toEqual([
        "inventory agent_start",
        "inventory model_request",
        "inventory model_response",
        "inventory error",
        "inventory agent_end",
      ]);
      const response = ofType(result.events, "model_response")[0]!;
      expect(response.stop_reason).toBe("error");
      expect(response.error).toMatch(/does not exist/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });
  });
});
