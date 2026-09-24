import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

type Mode = "conversation" | "model-fails" | "bad-arguments";

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
      const body = JSON.parse(raw || "{}") as ChatRequest;
      if (mode === "bad-arguments") {
        // First turn: a tool call whose arguments are not JSON. Second: answer.
        const answered = body.messages.some((m) => m.role === "tool");
        const message = answered
          ? { role: "assistant", content: "could not look it up" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_9", type: "function", function: { name: "price_of", arguments: "{not json" } }],
            };
        res.end(
          JSON.stringify({
            id: "chatcmpl-bad",
            object: "chat.completion",
            created: 0,
            model: "fake-model",
            choices: [{ index: 0, message, finish_reason: answered ? "stop" : "tool_calls" }],
            usage: usage(10, 5),
          }),
        );
        return;
      }
      res.end(JSON.stringify(reply(body)));
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

  it("the skill's no-framework snippet typechecks against the real openai types too", () => {
    // Users copy this block, not the example file. It failed `tsc --strict` once
    // openai's tool and tool-call types became unions, and nothing caught it.
    const page = readFileSync(join(ROOT, "..", "python", "skill", "references", "typescript.md"), "utf8");
    const blocks = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const snippet = blocks.find((block) => block.includes("// 1. the run"));
    expect(snippet, "the no-framework block in typescript.md").toBeDefined();
    const dir = join(FIXTURES, FIXTURE);
    // What the snippet leaves to the reader's own program.
    const context = [
      "declare const MODEL: string;",
      "declare const client: OpenAI;",
      "declare const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[];",
      "declare const question: string;",
      "declare const messages: ChatCompletionMessageParam[];",
      "declare function runTool(name: string, input: Record<string, unknown>): string;",
      "export {};",
    ].join("\n");
    writeFileSync(join(dir, "skill-snippet.ts"), `${snippet}\n${context}\n`);
    writeFileSync(
      join(dir, "tsconfig.skill.json"),
      JSON.stringify({ extends: "./tsconfig.json", files: ["skill-snippet.ts"] }),
    );
    try {
      expect(typecheck(FIXTURE, "tsconfig.skill.json")).toBe("");
    } finally {
      rmSync(join(dir, "skill-snippet.ts"), { force: true });
      rmSync(join(dir, "tsconfig.skill.json"), { force: true });
    }
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
      // A turn that is only tool calls still says what the model asked for.
      expect(responses.map((e) => (e.fw_tool_calls as Array<{ toolCallId: string }>).map((c) => c.toolCallId))).toEqual([
        ["call_1", "call_2"],
        ["call_3"],
        [],
      ]);
      for (const e of responses) expect(typeof e.duration_ms).toBe("number");

      // The model's own tool-call ids, and the failure on its tool_result only.
      expect(ofType(result.events, "tool_use").map((e) => e.tool_call_id)).toEqual(["call_1", "call_2", "call_3"]);
      const results = ofType(result.events, "tool_result");
      expect(results.map((e) => e.output ?? null)).toEqual(["42", "0", null]);
      expect(results[2]!.error).toMatch(/unknown item "doohickey"/);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(ofType(result.events, "agent_start")[0]!.goal).toBe("Price and stock for widget and gadget?");
    });

    it("records a tool call with malformed arguments, and the run recovers", async () => {
      const baseUrl = await startModel("bad-arguments");
      const result = await runAgentAsync(FIXTURE, format, "Price of widget?", {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseUrl,
        MODEL: "fake-model",
      });
      expect(result.status, describeTrace(result)).toBe(0);
      const use = ofType(result.events, "tool_use")[0]!;
      expect(use.tool_call_id).toBe("call_9");
      expect(use.input).toEqual({ arguments: "{not json" });
      const toolResult = ofType(result.events, "tool_result")[0]!;
      expect(toolResult.tool_call_id).toBe("call_9");
      expect(toolResult.error).toMatch(/^SyntaxError: /);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("success");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
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
      // The class, not the `name` openai's errors leave as "Error".
      expect(response.error).toMatch(/^BadRequestError: /);
      expect(ofType(result.events, "agent_end")[0]!.outcome).toBe("failed");
      expect(traceViolations(result.events), describeTrace(result)).toEqual([]);
    });
  });
});
