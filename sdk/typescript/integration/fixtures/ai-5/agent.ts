// Vercel AI SDK 5.x consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import `ai`, pass the adapter at
// the call site (or wrap the model, or instrument), run. The scripted mock
// model makes it deterministic and offline — the tool loop's first call asks
// for `weather`, the next one answers — and never touches a real provider.
//
// Everything below the `--- the same in every fixture` line is the same
// program in every ai-* fixture; only the model mock and the tool/loop
// spelling above it change between majors.
import * as failproofai from "@failproofai/sdk";
import { middleware, telemetry, tracer, wrapModel } from "@failproofai/sdk/ai";
import {
  generateObject,
  generateText,
  simulateReadableStream,
  stepCountIs,
  streamObject,
  streamText,
  tool,
  wrapLanguageModel,
} from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";

// --- version-specific: LanguageModelV2 (flat usage numbers, string finish reasons)

type Script = "loop" | "answer" | "object" | "fail";
type StreamPart = Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });

function scripted(script: Script = "loop") {
  let generated = 0;
  let streamed = 0;
  return new MockLanguageModelV2({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      generated += 1;
      if (script === "fail") throw new Error("model exploded");
      if (script === "object") {
        return { content: [{ type: "text", text: '{"city":"Paris"}' }], finishReason: "stop", usage: usage(5, 3), warnings: [] };
      }
      if (script === "loop" && generated === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "weather", input: '{"city":"Paris"}' }],
          finishReason: "tool-calls",
          usage: usage(11, 7),
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: "It is 20C in Paris." }], finishReason: "stop", usage: usage(23, 9), warnings: [] };
    },
    doStream: async () => {
      streamed += 1;
      if (script === "fail") throw new Error("model exploded");
      const text = (id: string, ...deltas: string[]): StreamPart[] => [
        { type: "text-start", id },
        ...deltas.map((delta): StreamPart => ({ type: "text-delta", id, delta })),
        { type: "text-end", id },
      ];
      const chunks: StreamPart[] =
        script === "object"
          ? [{ type: "stream-start", warnings: [] }, ...text("o", '{"city":', '"Paris"}'), { type: "finish", finishReason: "stop", usage: usage(5, 3) }]
          : script === "loop" && streamed === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call-s1", toolName: "weather", input: '{"city":"Rome"}' },
                { type: "finish", finishReason: "tool-calls", usage: usage(13, 4) },
              ]
            : [{ type: "stream-start", warnings: [] }, ...text("t", "Rome is ", "25C."), { type: "finish", finishReason: "stop", usage: usage(30, 6) }];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

const makeTools = (fail = false) => ({
  weather: tool({
    description: "Current weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => {
      if (fail) throw new Error("weather service down");
      return { city, celsius: city === "Paris" ? 20 : 25 };
    },
  }),
});
const loop = { stopWhen: stepCountIs(4) };

/** The bare tracer, as `experimental_telemetry.tracer` (v4–v6 only: v7 has no such option). */
async function viaTracer(prompt: string): Promise<string> {
  const { text } = await generateText({
    model: scripted("answer"),
    prompt,
    experimental_telemetry: { isEnabled: true, tracer: tracer() },
  });
  return text;
}

// --- the same in every fixture

type Telemetry = ReturnType<typeof telemetry> | { isEnabled: true; functionId: string };

async function ask(model: Parameters<typeof generateText>[0]["model"], options: { telemetry?: Telemetry; tools?: boolean; failTool?: boolean } = {}) {
  const result = await generateText({
    model,
    prompt: "Weather in Paris?",
    ...(options.tools === false ? {} : { tools: makeTools(options.failTool), ...loop }),
    ...(options.telemetry ? { experimental_telemetry: options.telemetry } : {}),
  });
  return result.text;
}

async function askStreaming(model: Parameters<typeof streamText>[0]["model"], options: { telemetry?: Telemetry; tools?: boolean } = {}) {
  const result = streamText({
    model,
    prompt: "Weather in Rome?",
    ...(options.tools === false ? {} : { tools: makeTools(), ...loop }),
    ...(options.telemetry ? { experimental_telemetry: options.telemetry } : {}),
  });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  return text;
}

const schema = z.object({ city: z.string() });
const report = (value: unknown) => console.log(JSON.stringify(value));

/** The README's call sites, verbatim apart from the mock standing in for a provider. */
async function readme(): Promise<void> {
  const model = scripted("answer");
  const prompt = "Weather in Paris?";
  const { text } = await generateText({
    model,
    prompt,
    experimental_telemetry: telemetry({ functionId: "answer-question" }),
  });
  const wrapped = await wrapModel(scripted("answer"));
  const viaMiddleware = wrapLanguageModel({ model: scripted("answer"), middleware: middleware() });
  const withMetadata = await generateText({
    model: scripted("answer"),
    prompt,
    experimental_telemetry: telemetry({ functionId: "tagged", metadata: { tenant: "acme", attempt: 1 } }),
  });
  report({ text, wrapped: (await generateText({ model: wrapped, prompt })).text, viaMiddleware: viaMiddleware.modelId, withMetadata: withMetadata.text, withTracer: await viaTracer(prompt) });
}

async function main(scenario: string): Promise<void> {
  switch (scenario) {
    case "generate":
      report({ text: await ask(scripted(), { telemetry: telemetry({ functionId: "weather-agent" }) }) });
      break;
    case "stream":
      report({ text: await askStreaming(scripted(), { telemetry: telemetry({ functionId: "weather-agent" }) }) });
      break;
    case "object": {
      const { object } = await generateObject({ model: scripted("object"), schema, prompt: "Where?", experimental_telemetry: telemetry({ functionId: "extractor" }) });
      report({ object });
      break;
    }
    case "stream-object": {
      const result = streamObject({ model: scripted("object"), schema, prompt: "Where?", experimental_telemetry: telemetry({ functionId: "extractor" }) });
      for await (const _ of result.partialObjectStream) void _;
      report({ object: await result.object });
      break;
    }
    case "wrap":
      report({ text: await ask(await wrapModel(scripted("answer")), { tools: false }) });
      break;
    case "wrap-stream":
      report({ text: await askStreaming(await wrapModel(scripted("answer")), { tools: false }) });
      break;
    case "wrap-in-agent":
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, async () => report({ text: await ask(await wrapModel(scripted())) })),
      );
      break;
    case "wrap-and-telemetry":
      report({ text: await ask(await wrapModel(scripted()), { telemetry: telemetry({ functionId: "weather-agent" }) }) });
      break;
    case "instrument":
      report({ instrumented: await failproofai.instrument("ai") });
      report({ text: await ask(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } }) });
      break;
    case "instrument-stream":
      report({ instrumented: await failproofai.instrument("ai") });
      report({ text: await askStreaming(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } }) });
      break;
    case "uninstrument":
      report({ instrumented: await failproofai.instrument("ai") });
      report({ removed: failproofai.uninstrument() });
      report({ text: await ask(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } }) });
      break;
    case "tool-error":
      try {
        report({ text: await ask(scripted(), { telemetry: telemetry({ functionId: "weather-agent" }), failTool: true }) });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    case "model-error":
      try {
        report({ text: await ask(scripted("fail"), { telemetry: telemetry({ functionId: "weather-agent" }), tools: false }) });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    case "scope":
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, () => ask(scripted(), { telemetry: telemetry({ functionId: "weather-agent" }) })),
      );
      break;
    case "readme":
      await readme();
      break;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "generate").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
