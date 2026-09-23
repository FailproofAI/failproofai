// Vercel AI SDK 4.x consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import `ai`, pass the adapter at
// the call site (or wrap the model, or instrument), run. The scripted mock
// model makes it deterministic and offline — the tool loop's first call asks
// for `weather`, the next one answers — and never touches a real provider.
//
// Everything below the `--- the same in every fixture` line is the same
// program in every ai-* fixture; only the model mock and the tool/loop
// spelling above it change between majors.
import { createRequire } from "node:module";
import { join } from "node:path";

import * as failproofai from "@failproofai/sdk";
import { middleware, telemetry, tracer, wrapModel } from "@failproofai/sdk/ai";
import {
  generateObject,
  generateText,
  simulateReadableStream,
  streamObject,
  streamText,
  tool,
  wrapLanguageModel,
} from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { z } from "zod";

// --- version-specific: LanguageModelV1 (promptTokens/completionTokens, `text` + `toolCalls`)

type Script = "loop" | "answer" | "object" | "fail";
type StreamPart = Awaited<ReturnType<MockLanguageModelV1["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

const usage = (input: number, output: number) => ({ promptTokens: input, completionTokens: output });
const rawCall = { rawPrompt: null, rawSettings: {} };

function scripted(script: Script = "loop") {
  let generated = 0;
  let streamed = 0;
  return new MockLanguageModelV1({
    provider: "mock-provider",
    modelId: "mock-model",
    // v4 asks the model how to produce an object; v5+ always use JSON mode.
    defaultObjectGenerationMode: "json",
    doGenerate: async () => {
      generated += 1;
      if (script === "fail") throw new Error("model exploded");
      if (script === "object") return { text: '{"city":"Paris"}', finishReason: "stop", usage: usage(5, 3), rawCall };
      if (script === "loop" && generated === 1) {
        return {
          toolCalls: [{ toolCallType: "function", toolCallId: "call-1", toolName: "weather", args: '{"city":"Paris"}' }],
          finishReason: "tool-calls",
          usage: usage(11, 7),
          rawCall,
        };
      }
      return { text: "It is 20C in Paris.", finishReason: "stop", usage: usage(23, 9), rawCall };
    },
    doStream: async () => {
      streamed += 1;
      if (script === "fail") throw new Error("model exploded");
      const text = (...deltas: string[]): StreamPart[] => deltas.map((textDelta): StreamPart => ({ type: "text-delta", textDelta }));
      const chunks: StreamPart[] =
        script === "object"
          ? [...text('{"city":', '"Paris"}'), { type: "finish", finishReason: "stop", usage: usage(5, 3) }]
          : script === "loop" && streamed === 1
            ? [
                { type: "tool-call", toolCallType: "function", toolCallId: "call-s1", toolName: "weather", args: '{"city":"Rome"}' },
                { type: "finish", finishReason: "tool-calls", usage: usage(13, 4) },
              ]
            : [...text("Rome is ", "25C."), { type: "finish", finishReason: "stop", usage: usage(30, 6) }];
      return { stream: simulateReadableStream({ chunks }), rawCall };
    },
  });
}

const makeTools = (fail = false) => ({
  weather: tool({
    description: "Current weather for a city",
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => {
      if (fail) throw new Error("weather service down");
      return { city, celsius: city === "Paris" ? 20 : 25 };
    },
  }),
});
const loop = { maxSteps: 4 };

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

/**
 * The customer's own OpenTelemetry, set up AFTER `instrument("ai")` — the
 * usual order when tracing starts in a module loaded later (a `NodeSDK`
 * started from an instrumentation file). Null when `@opentelemetry/api` is not
 * installed (ai 7 dropped the dependency).
 */
function customerTracing(): { registered: boolean; ended: () => string[] } | null {
  interface Api {
    trace: {
      setGlobalTracerProvider(provider: unknown): boolean;
      getTracer(name: string): { startSpan(name: string): { end(): void } };
    };
  }
  let api: Api;
  try {
    api = createRequire(join(process.cwd(), "agent.js"))("@opentelemetry/api") as Api;
  } catch {
    return null;
  }
  const ended: string[] = [];
  const span = (name: string) => ({
    setAttribute() { return this; },
    setAttributes() { return this; },
    addEvent() { return this; },
    addLink() { return this; },
    addLinks() { return this; },
    setStatus() { return this; },
    updateName() { return this; },
    recordException() {},
    isRecording: () => true,
    spanContext: () => ({ traceId: "0".repeat(31) + "1", spanId: "0".repeat(15) + "1", traceFlags: 1 }),
    end: () => void ended.push(name),
  });
  const theirs = {
    startSpan: (name: string) => span(name),
    startActiveSpan: (name: string, ...rest: unknown[]) => (rest[rest.length - 1] as (s: unknown) => unknown)(span(name)),
  };
  const registered = api.trace.setGlobalTracerProvider({ getTracer: () => theirs });
  // What an http / pg / Next.js instrumentation does with the global API.
  api.trace.getTracer("my-service").startSpan("http.request").end();
  return { registered, ended: () => [...new Set(ended)].sort() };
}

/** A model whose stream breaks part-way: the provider connection dropped. */
function breakMidStream<M>(model: M): M {
  const target = model as unknown as { doStream: (options: unknown) => PromiseLike<{ stream: ReadableStream<unknown> }> };
  const original = target.doStream.bind(target);
  target.doStream = async (options: unknown) => {
    const result = await original(options);
    const reader = result.stream.getReader();
    let parts = 0;
    return {
      ...result,
      stream: new ReadableStream<unknown>({
        async pull(controller) {
          if (parts++ === 2) {
            controller.error(new Error("connection reset"));
            return;
          }
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      }),
    };
  };
  return model;
}

/** Call a model's `doStream` directly, as a provider-level consumer does. */
async function openStream(model: unknown): Promise<ReadableStreamDefaultReader<unknown>> {
  const call = {
    inputFormat: "prompt",
    mode: { type: "regular" },
    prompt: [{ role: "user", content: [{ type: "text", text: "Weather in Rome?" }] }],
  };
  const { stream } = await (model as { doStream(options: unknown): PromiseLike<{ stream: ReadableStream<unknown> }> }).doStream(call);
  return stream.getReader();
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
    case "instrument-global":
      report({ instrumented: await failproofai.instrument("ai", { registerGlobalTracer: true }) });
      report({ text: await ask(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } }) });
      break;
    case "instrument-global-stream":
      report({ instrumented: await failproofai.instrument("ai", { registerGlobalTracer: true }) });
      report({ text: await askStreaming(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } }) });
      break;
    case "instrument-then-otel": {
      report({ instrumented: await failproofai.instrument("ai") });
      const customer = customerTracing();
      const text = await ask(scripted(), { telemetry: { isEnabled: true, functionId: "weather-agent" } });
      report({ text, customer: customer === null ? "absent" : { registered: customer.registered, ended: customer.ended() } });
      break;
    }
    case "wrap-stream-cancel": {
      const reader = await openStream(await wrapModel(scripted("answer")));
      await reader.read();
      await reader.cancel("client disconnected");
      report({ cancelled: true });
      break;
    }
    case "wrap-stream-error": {
      const reader = await openStream(await wrapModel(breakMidStream(scripted("answer"))));
      try {
        while (!(await reader.read()).done) {
          // drain
        }
        report({ drained: true });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    }
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
