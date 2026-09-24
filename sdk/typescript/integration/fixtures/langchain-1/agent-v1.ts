// The v1 `langchain` package's `createAgent`. Run as `node agent-v1.{mjs,cjs} <case>`.
//
// Its own program, beside `agent.ts`, because `langchain` 1.x exists only on
// the 1.x line: `agent.ts` is shared verbatim with the 0.3 fixture and must
// keep to APIs present across the whole declared peer range.
//
// `createAgent` compiles to a LangGraph `StateGraph` — a `model` node and a
// `tools` node, plus one node per middleware hook (`<Name>.before_model`, …) —
// so the expected trace is the Python SDK's for `langchain.agents.create_agent`
// with the same scripted model (langchain 1.4.2, langchain-core 1.6.3,
// langgraph 1.2.11): the agent named after the agent, its nodes as hooks.
import * as failproofai from "@failproofai/sdk";
import { langchainHandler } from "@failproofai/sdk/langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { createAgent, createMiddleware } from "langchain";
import { z } from "zod";

/** First call asks for `get_weather`, the next one answers. */
class ScriptedModel extends BaseChatModel {
  _llmType(): string {
    return "scripted";
  }

  // The script decides the tool calls; binding only has to hand back a model.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const answered = messages.some((m) => m.getType() === "tool");
    const message = answered
      ? new AIMessage({
          content: "It is sunny in Paris.",
          usage_metadata: { input_tokens: 30, output_tokens: 7, total_tokens: 37 },
          response_metadata: { finish_reason: "stop" },
        })
      : new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" }, type: "tool_call" }],
          usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
          response_metadata: { finish_reason: "tool_calls" },
        });
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

const getWeather = tool(async ({ city }: { city: string }) => `sunny in ${city}`, {
  name: "get_weather",
  description: "Current weather for a city",
  schema: z.object({ city: z.string() }),
});

/**
 * One node-shaped hook (`beforeModel`, which becomes a graph node) and one
 * wrapping hook (`wrapModelCall`, which runs INSIDE the model node and so must
 * add nothing of its own) — the two ways middleware reaches the callbacks.
 */
const audit = createMiddleware({
  name: "Audit",
  beforeModel: () => undefined,
  wrapModelCall: (request, handler) => handler(request),
});

const question = { messages: [new HumanMessage("weather?")] };

const CASES: Record<string, (config: RunnableConfig) => Promise<unknown>> = {
  "create-agent": (config) =>
    createAgent({ model: new ScriptedModel({}), tools: [getWeather], name: "weather_agent" }).invoke(question, config),
  "create-agent-mw": (config) =>
    createAgent({ model: new ScriptedModel({}), tools: [getWeather], name: "weather_agent", middleware: [audit] }).invoke(
      question,
      config,
    ),
  "create-agent-stream": async (config) => {
    const agent = createAgent({ model: new ScriptedModel({}), tools: [getWeather], name: "weather_agent" });
    let chunks = 0;
    for await (const _ of await agent.stream(question, { ...config, streamMode: "updates" })) chunks += 1;
    return chunks;
  },
};

async function main(scenario: string): Promise<void> {
  const explicit = scenario.startsWith("handler:");
  const run = CASES[explicit ? scenario.slice("handler:".length) : scenario];
  if (run === undefined) throw new Error(`unknown scenario ${scenario}`);
  if (!explicit) console.log(JSON.stringify({ instrumented: await failproofai.instrument("langchain") }));
  const out = (await run(explicit ? { callbacks: [langchainHandler() as never] } : {})) as { messages?: BaseMessage[] };
  console.log(JSON.stringify({ answer: out.messages?.at(-1)?.content ?? out }));
  await failproofai.flush();
}

main(process.argv[2] ?? "create-agent").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
