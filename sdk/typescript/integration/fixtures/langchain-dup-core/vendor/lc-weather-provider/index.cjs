"use strict";
// The `require` build of index.mjs — the same module; keep the two in step.
const { Document } = require("@langchain/core/documents");
const { BaseChatModel } = require("@langchain/core/language_models/chat_models");
const { AIMessage } = require("@langchain/core/messages");
const { BaseRetriever } = require("@langchain/core/retrievers");
const { RunnableLambda } = require("@langchain/core/runnables");
const { DynamicTool } = require("@langchain/core/tools");

const typeOf = (message) => (typeof message._getType === "function" ? message._getType() : message.getType());

class ChatWeather extends BaseChatModel {
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

class WeatherRetriever extends BaseRetriever {
  lc_namespace = ["lc_weather_provider"];

  async _getRelevantDocuments() {
    return [new Document({ pageContent: "Paris is sunny", metadata: { source: "wx.txt" } })];
  }
}

const weatherTool = new DynamicTool({
  name: "get_weather",
  description: "Current weather for a city",
  func: async (city) => `sunny in ${city}`,
});

const forecast = RunnableLambda.from(async (city) => `sunny in ${city}`).withConfig({ runName: "forecast" });

module.exports = { ChatWeather, WeatherRetriever, weatherTool, forecast };
