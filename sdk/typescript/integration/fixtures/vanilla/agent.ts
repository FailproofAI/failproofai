/**
 * No framework — a real agent loop, hand-instrumented.
 *
 *     npm install @failproofai/sdk openai
 *     OPENAI_API_KEY=… npx tsx examples/research-agent.ts
 *
 * A working tool-calling loop against the OpenAI API with no agent framework at
 * all, instrumented by hand. The reference for "my agent is bespoke" — and the
 * TypeScript twin of the Python SDK's `docs/manual/examples/research_agent.py`.
 *
 * Every hand-built agent already has three places this touches, whatever its
 * functions are called:
 *
 *   1. where ONE RUN starts and ends      → failproofai.agent()          agent_start / agent_end
 *   2. the ONE FUNCTION that calls a model → event.modelRequest/Response  one pair per model turn
 *   3. the ONE FUNCTION that runs a tool   → failproofai.toolCall()       tool_use / tool_result
 *
 * Identity is ambient: everything inside `agent()` lands on its session, so
 * nothing else in the program changes. The one rule: emit the pairs — a
 * `model_request` with no `model_response` is a span the dashboard shows as
 * running forever.
 *
 * Environment: OPENAI_API_KEY; optionally OPENAI_BASE_URL (any OpenAI-compatible
 * endpoint) and MODEL (default gpt-4o-mini).
 */
import { randomUUID } from "node:crypto";

import * as failproofai from "@failproofai/sdk";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

failproofai.configure({ environment: "examples" });

const client = new OpenAI(); // reads OPENAI_API_KEY / OPENAI_BASE_URL
const MODEL = process.env.MODEL ?? "gpt-4o-mini";

// ---------------------------------------------------------------- the tools

const PRICE: Record<string, number> = { widget: 42.0, gadget: 17.5 };
const STOCK: Record<string, number> = { widget: 120, gadget: 0 };

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "price_of",
      description: "Unit price of an item. Valid: widget, gadget.",
      parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_of",
      description: "Units in stock. Valid: widget, gadget.",
      parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
    },
  },
];

function runTool(name: string, args: { item?: string }): string {
  const item = String(args.item ?? "").toLowerCase().trim();
  const table = name === "price_of" ? PRICE : name === "stock_of" ? STOCK : null;
  if (table === null) throw new Error(`unknown tool ${name}`);
  if (!(item in table)) throw new Error(`unknown item ${JSON.stringify(item)}`);
  return String(table[item]);
}

// ---------------------------------------------------------- edit site 2 of 3
// The one function that calls the model. `requestId` pairs the two halves even
// when calls overlap; `duration_ms` is yours to set — model events are not
// timed for you. A failed call still closes its pair, with the error, before
// rethrowing: the enclosing agent() then ends "failed". Only the provider call
// sits in the `try`, so nothing but a failed call can reach the error path.

async function callModel(messages: ChatCompletionMessageParam[]) {
  const requestId = randomUUID();
  const started = Date.now();
  failproofai.event.modelRequest({
    model: MODEL,
    requestId,
    // Role and content, plus the ids that link a tool result to the call that
    // asked for it: what a reader of the trace needs, not the provider's full
    // message objects.
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content),
      ...(m.role === "tool" ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.role === "assistant" && m.tool_calls ? { tool_calls: m.tool_calls.map((c) => c.id) } : {}),
    })),
    tools: TOOLS.flatMap((t) => (t.type === "function" ? [{ name: t.function.name, description: t.function.description ?? "" }] : [])),
  });
  let reply: OpenAI.Chat.Completions.ChatCompletion;
  try {
    reply = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS });
  } catch (error) {
    failproofai.event.modelResponse({
      model: MODEL,
      requestId,
      stopReason: "error",
      error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
      duration_ms: Date.now() - started,
    });
    throw error;
  }
  const choice = reply.choices[0]!;
  const calls = (choice.message.tool_calls ?? []).filter((c) => c.type === "function");
  failproofai.event.modelResponse({
    model: reply.model,
    requestId,
    role: choice.message.role,
    content: choice.message.content ?? "",
    stopReason: choice.finish_reason,
    inputTokens: reply.usage?.prompt_tokens ?? null,
    outputTokens: reply.usage?.completion_tokens ?? null,
    duration_ms: Date.now() - started,
    // What the model asked for, so a turn that is only tool calls is not blank —
    // the field and shape the framework adapters write.
    fw_tool_calls: calls.map((c) => ({ toolCallId: c.id, toolName: c.function.name, input: c.function.arguments })),
  });
  return choice.message;
}

// ---------------------------------------------------------- edit site 3 of 3
// The one function that runs tools. Reuse the model's own tool-call id, so a
// tool_use lines up with the tool_calls[] entry that asked for it. toolCall()
// times it and records a throw as tool_result.error — then rethrows, and here
// the loop turns that into a tool message so the model can recover.

async function dispatch(call: { id: string; function: { name: string; arguments: string } }): Promise<string> {
  // Malformed arguments from the model are still a tool call: recorded with the
  // raw text as input and failed inside toolCall(), so the trace shows it and
  // the model gets an error it can recover from — not a crashed run, and not a
  // call that silently never appears.
  let args: { item?: string } = {};
  let malformed: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}") as { item?: string };
  } catch (error) {
    malformed = error;
  }
  try {
    const input = malformed === undefined ? args : { arguments: call.function.arguments };
    return await failproofai.toolCall(call.function.name, { toolCallId: call.id, input }, async () => {
      if (malformed !== undefined) throw malformed;
      return runTool(call.function.name, args);
    });
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---------------------------------------------------------- edit site 1 of 3
// Where one run starts and ends. In a service, pass your own request or job id
// as `sessionId`, so a session on the dashboard and a record in your own
// database are the same string.

async function main(): Promise<void> {
  const question = process.argv[2] || "Price and stock for widget and gadget?";
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "Use the tools for every number. Be terse." },
    { role: "user", content: question },
  ];

  let sessionId = "";
  const answer = await failproofai.agent("inventory", { goal: question }, async (identity) => {
    sessionId = identity.sessionId ?? "";
    for (let turn = 0; turn < 6; turn++) {
      // bounded: an unbounded agent loop is its own bug
      const message = await callModel(messages);
      const calls = (message.tool_calls ?? []).filter((c) => c.type === "function");
      if (calls.length === 0) return message.content ?? "";
      messages.push(message);
      for (const call of calls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await dispatch(call) });
      }
    }
    return "(gave up after 6 turns)";
  });

  console.log(answer);
  console.log(`session ${sessionId}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // A short script must flush before it exits; a server flushes on its own.
  .finally(() => failproofai.flush());
