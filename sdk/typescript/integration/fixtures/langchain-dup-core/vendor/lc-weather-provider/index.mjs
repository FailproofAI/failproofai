// A provider package built on ITS OWN copy of @langchain/core (0.3.80, nested
// under this package by npm because the app runs 1.x). Every class here comes
// from that nested copy — its own Runnable, its own CallbackManager.
// index.cjs is the same module for `require`; keep the two in step.
import { Document } from "@langchain/core/documents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { BaseRetriever } from "@langchain/core/retrievers";
import { RunnableLambda } from "@langchain/core/runnables";
import { DynamicTool } from "@langchain/core/tools";

const typeOf = (message) => (typeof message._getType === "function" ? message._getType() : message.getType());

/** First call asks for `get_weather`, the next one answers — the fixture's usual script. */
export class ChatWeather extends BaseChatModel {
  _llmType() {
    return "weather";
  }

  bindTools() {
    return this;
  }

  async _generate(messages) {
    const answered = messages.some((m) => typeOf(m) === "tool");
    const message = answered
      ? new AIMessage({
          content: "It is sunny in Paris.",
          usage_metadata: { input_tokens: 30, output_tokens: 7, total_tokens: 37 },
        })
      : new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" }, type: "tool_call" }],
          usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        });
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

export class WeatherRetriever extends BaseRetriever {
  lc_namespace = ["lc_weather_provider"];

  async _getRelevantDocuments() {
    return [new Document({ pageContent: "Paris is sunny", metadata: { source: "wx.txt" } })];
  }
}

export const weatherTool = new DynamicTool({
  name: "get_weather",
  description: "Current weather for a city",
  func: async (city) => `sunny in ${city}`,
});

/** A provider-built runnable the app invokes directly. */
export const forecast = RunnableLambda.from(async (city) => `sunny in ${city}`).withConfig({ runName: "forecast" });
