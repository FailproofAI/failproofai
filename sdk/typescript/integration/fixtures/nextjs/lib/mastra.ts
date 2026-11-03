// The mastra-1 fixture's scripted model, tool and agent, verbatim (minus the
// gate/failure options no route uses), so a route's trace can be compared with
// that fixture's trace under plain Node.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

type Turn = { tool: string; input: Record<string, unknown>; usage: [number, number] } | { text: string; usage: [number, number] };

function scriptedModel(turns: Turn[]) {
  let calls = 0;
  const next = (): Turn => turns[calls++ % turns.length]!;
  const usage = ([input, output]: [number, number]) => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  });
  return {
    specificationVersion: "v2" as const,
    provider: "scripted",
    modelId: "scripted-model",
    supportedUrls: {},
    async doGenerate() {
      const turn = next();
      return "tool" in turn
        ? {
            content: [{ type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: turn.tool, input: JSON.stringify(turn.input) }],
            finishReason: "tool-calls" as const,
            usage: usage(turn.usage),
            warnings: [],
          }
        : {
            content: [{ type: "text" as const, text: turn.text }],
            finishReason: "stop" as const,
            usage: usage(turn.usage),
            warnings: [],
          };
    },
    async doStream() {
      const turn = next();
      const parts: unknown[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: `resp_${calls}`, modelId: "scripted-model", timestamp: new Date(0) },
      ];
      if ("tool" in turn) {
        parts.push({ type: "tool-call", toolCallId: `call_${calls}`, toolName: turn.tool, input: JSON.stringify(turn.input) });
        parts.push({ type: "finish", finishReason: "tool-calls", usage: usage(turn.usage) });
      } else {
        parts.push({ type: "text-start", id: "t" });
        const cut = turn.text.indexOf(" ", turn.text.length / 2) + 1;
        for (const delta of [turn.text.slice(0, cut), turn.text.slice(cut)]) {
          parts.push({ type: "text-delta", id: "t", delta });
        }
        parts.push({ type: "text-end", id: "t" });
        parts.push({ type: "finish", finishReason: "stop", usage: usage(turn.usage) });
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

const WEATHER_TURNS: Turn[] = [
  { tool: "weather", input: { city: "Paris" }, usage: [11, 7] },
  { text: "It is sunny in Paris.", usage: [23, 9] },
];

export const weather = createTool({
  id: "weather",
  description: "Current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async (input: { city: string }) => ({ city: input.city, forecast: "sunny" }),
});

export const weatherAgent = () =>
  new Agent({
    id: "weather-agent",
    name: "weather-agent",
    instructions: "Answer weather questions.",
    model: scriptedModel(WEATHER_TURNS) as never,
    tools: { weather },
  });

export const question = "What is the weather in Paris?";
