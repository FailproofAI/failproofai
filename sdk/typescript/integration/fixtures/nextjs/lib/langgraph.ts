// The langchain-1 fixture's graph and scripted model, verbatim, so a route's
// trace can be compared with that fixture's trace under plain Node.
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

export class ScriptedModel extends BaseChatModel {
  calls = 0;

  constructor(fields: BaseChatModelParams = {}) {
    super(fields);
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
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

export function buildGraph(model: ScriptedModel) {
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

export const question = () => ({ messages: [new HumanMessage("weather?")] });
