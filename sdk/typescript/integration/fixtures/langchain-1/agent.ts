// LangChain.js / LangGraph.js consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import the framework, instrument,
// run. The scripted model makes it deterministic and offline — first call asks
// for the `get_weather` tool, the next one answers — and mirrors the Python
// SDK's golden trace for the same graph, which is what the assertions compare
// against.
import * as failproofai from "@failproofai/sdk";
import { langchainHandler } from "@failproofai/sdk/langchain";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

class ScriptedModel extends BaseChatModel {
  calls = 0;
  private readonly fail: boolean;

  constructor(fields: BaseChatModelParams & { fail?: boolean } = {}) {
    super(fields);
    this.fail = fields.fail ?? false;
  }

  _llmType(): string {
    return "scripted";
  }

  // The script decides the tool calls; binding only has to hand back a model.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    if (this.fail) throw new Error("model exploded");
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

function buildGraph(model: ScriptedModel) {
  const callModel = async (state: typeof MessagesAnnotation.State) => ({
    messages: [await model.invoke(state.messages)],
  });
  const route = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return last.tool_calls?.length ? "tools" : END;
  };
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode([getWeather]))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ name: "weather_graph" });
}

const question = { messages: [new HumanMessage("weather?")] };
const report = (value: unknown) => console.log(JSON.stringify(value));

async function main(scenario: string): Promise<void> {
  if (scenario !== "handler") {
    report({ instrumented: await failproofai.instrument("langchain") });
  }

  switch (scenario) {
    case "graph": {
      const out = await buildGraph(new ScriptedModel()).invoke(question);
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "stream": {
      let chunks = 0;
      for await (const _ of await buildGraph(new ScriptedModel()).stream(question, { streamMode: "updates" })) {
        chunks += 1;
      }
      report({ chunks });
      break;
    }
    case "react": {
      const agent = createReactAgent({ llm: new ScriptedModel(), tools: [getWeather], name: "react_bot" });
      const out = await agent.invoke(question);
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "error": {
      try {
        await buildGraph(new ScriptedModel({ fail: true })).invoke({ messages: [new HumanMessage("x")] });
        report({ threw: false });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    }
    case "model": {
      const out = await new ScriptedModel().invoke([new HumanMessage("hi")]);
      report({ toolCalls: (out as AIMessage).tool_calls?.length });
      break;
    }
    case "tool": {
      report({ out: await getWeather.invoke({ city: "Rome" }) });
      break;
    }
    case "scope": {
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, () => buildGraph(new ScriptedModel()).invoke(question)),
      );
      break;
    }
    case "handler": {
      // No instrument(): the explicit handler is the patch-free path.
      const out = await buildGraph(new ScriptedModel()).invoke(question, {
        callbacks: [langchainHandler() as never],
      });
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "handler-and-instrument": {
      report({ instrumented: await failproofai.instrument("langchain") });
      await buildGraph(new ScriptedModel()).invoke(question, { callbacks: [langchainHandler() as never] });
      break;
    }
    case "uninstrument": {
      report({ removed: failproofai.uninstrument() });
      await buildGraph(new ScriptedModel()).invoke(question);
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "graph").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
