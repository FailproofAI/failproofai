// The ai-7 fixture's scripted model and tool, verbatim, so a route's trace can
// be compared with that fixture's trace under plain Node.
import { simulateReadableStream, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason: "stop" | "tool-calls") => ({ unified: reason, raw: reason });

export function scripted() {
  let generated = 0;
  let streamed = 0;
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      generated += 1;
      if (generated === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "weather", input: '{"city":"Paris"}' }],
          finishReason: finish("tool-calls"),
          usage: usage(11, 7),
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: "It is 20C in Paris." }], finishReason: finish("stop"), usage: usage(23, 9), warnings: [] };
    },
    doStream: async () => {
      streamed += 1;
      const text = (id: string, ...deltas: string[]): StreamPart[] => [
        { type: "text-start", id },
        ...deltas.map((delta): StreamPart => ({ type: "text-delta", id, delta })),
        { type: "text-end", id },
      ];
      const chunks: StreamPart[] =
        streamed === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call-s1", toolName: "weather", input: '{"city":"Rome"}' },
              { type: "finish", finishReason: finish("tool-calls"), usage: usage(13, 4) },
            ]
          : [{ type: "stream-start", warnings: [] }, ...text("t", "Rome is ", "25C."), { type: "finish", finishReason: finish("stop"), usage: usage(30, 6) }];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

export const tools = () => ({
  weather: tool({
    description: "Current weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => ({ city, celsius: city === "Paris" ? 20 : 25 }),
  }),
});

export const loop = { stopWhen: stepCountIs(4) };
