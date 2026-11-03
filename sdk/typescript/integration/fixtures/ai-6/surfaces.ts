// Vercel AI SDK 6.x: every commonly used surface. Run as `node surfaces.{mjs,cjs} <case>`.
//
// The coverage companion to agent.ts. agent.ts pins the README call sites
// and the adapter's core paths; this program walks the rest of the SDK a
// customer actually uses — the agent classes, embeddings, structured output,
// every tool feature, every way of consuming a stream, reasoning models and
// concurrency — against the same scripted, offline mock.
//
// Everything below the `--- the same in every fixture` line is the same
// program in every ai-* fixture; the section above it spells one major's API.
import * as failproofai from "@failproofai/sdk";
import * as adapter from "@failproofai/sdk/ai";
import { telemetry, wrapModel } from "@failproofai/sdk/ai";
import {
  Output,
  ToolLoopAgent,
  embed,
  embedMany,
  generateObject,
  generateText,
  simulateReadableStream,
  stepCountIs,
  streamObject,
  streamText,
  tool,
  type ModelMessage,
} from "ai";
import { MockEmbeddingModelV3, MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

// --- version-specific: ai 6 (LanguageModelV3, ToolLoopAgent, needsApproval)

const MAJOR = 6;

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
/** One scripted model step: what the model "says" on its n-th call. */
interface Step {
  text?: string;
  reasoning?: string;
  calls?: Call[];
  usage: [number, number];
  reasoningTokens?: number;
  fail?: string;
  delayMs?: number;
}
interface ModelOptions {
  modelId?: string;
  chunkDelayMs?: number;
  /** Break the provider stream after this many parts: the connection dropped. */
  breakAfterParts?: number;
}

type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;
type Content = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>["content"][number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A string as two stream deltas. */
const halves = (text: string): string[] => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];

const usageOf = (step: Step) => ({
  inputTokens: { total: step.usage[0], noCache: step.usage[0], cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: step.usage[1], text: step.usage[1] - (step.reasoningTokens ?? 0), reasoning: step.reasoningTokens },
});
const finishOf = (step: Step) => {
  const reason = step.calls?.length ? "tool-calls" : "stop";
  return { unified: reason, raw: reason } as const;
};

function model(steps: Step[], options: ModelOptions = {}) {
  let n = 0;
  const next = async (): Promise<Step> => {
    const step = steps[Math.min(n, steps.length - 1)]!;
    n += 1;
    if (step.delayMs) await sleep(step.delayMs);
    if (step.fail) throw new Error(step.fail);
    return step;
  };
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: options.modelId ?? "mock-model",
    doGenerate: async () => {
      const step = await next();
      const content: Content[] = [];
      if (step.reasoning) content.push({ type: "reasoning", text: step.reasoning });
      if (step.text) content.push({ type: "text", text: step.text });
      for (const call of step.calls ?? []) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) });
      }
      return { content, finishReason: finishOf(step), usage: usageOf(step), warnings: [] };
    },
    doStream: async ({ abortSignal }) => {
      const step = await next();
      const chunks: StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (step.reasoning) {
        chunks.push({ type: "reasoning-start", id: "r" });
        for (const delta of halves(step.reasoning)) chunks.push({ type: "reasoning-delta", id: "r", delta });
        chunks.push({ type: "reasoning-end", id: "r" });
      }
      if (step.text) {
        chunks.push({ type: "text-start", id: "t" });
        for (const delta of halves(step.text)) chunks.push({ type: "text-delta", id: "t", delta });
        chunks.push({ type: "text-end", id: "t" });
      }
      for (const call of step.calls ?? []) {
        chunks.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) });
      }
      chunks.push({ type: "finish", finishReason: finishOf(step), usage: usageOf(step) });
      return { stream: abortable(simulateReadableStream({ chunks, chunkDelayInMs: options.chunkDelayMs ?? 0 }), abortSignal, options.breakAfterParts) };
    },
  });
}

function embedder() {
  return new MockEmbeddingModelV3({
    provider: "mock-provider",
    modelId: "mock-embedder",
    maxEmbeddingsPerCall: 2,
    doEmbed: async ({ values }) => ({ embeddings: values.map((_, i) => [i, 0.5]), usage: { tokens: values.length * 3 }, warnings: [] }),
  });
}

const citySchema = z.object({ city: z.string() });
type Weather = { city: string; celsius: number };

function weatherTool(options: { fail?: boolean; delayMs?: (city: string) => number; onRun?: (city: string) => Promise<void> } = {}) {
  return tool({
    description: "Current weather for a city",
    inputSchema: citySchema,
    execute: async ({ city }: { city: string }): Promise<Weather> => {
      if (options.delayMs) await sleep(options.delayMs(city));
      if (options.onRun) await options.onRun(city);
      if (options.fail) throw new Error("weather service down");
      return { city, celsius: city.length * 4 };
    },
  });
}
/** A client-side tool: no `execute`, so the SDK hands the call back to the caller. */
const clientTool = () => tool({ description: "Ask the user", inputSchema: citySchema });
const HAS_APPROVAL = true;
const approvalTool = () =>
  tool({
    description: "Book a trip",
    inputSchema: citySchema,
    needsApproval: true,
    execute: async ({ city }: { city: string }) => ({ booked: city }),
  });

const steps = (n: number) => ({ stopWhen: stepCountIs(n) });
const HAS_AGENT = true;

type Settings = Parameters<typeof generateText>[0];
type Telemetry = NonNullable<Settings["experimental_telemetry"]>;

function makeAgent(options: { model: Settings["model"]; telemetry?: Telemetry; id?: string; tools?: Settings["tools"] }) {
  const agent = new ToolLoopAgent({
    model: options.model,
    ...(options.id ? { id: options.id } : {}),
    tools: options.tools ?? { weather: weatherTool() },
    ...steps(4),
    ...(options.telemetry ? { experimental_telemetry: options.telemetry } : {}),
  });
  return {
    generate: async (prompt: string) => (await agent.generate({ prompt })).text,
    stream: async (prompt: string) => {
      const result = await agent.stream({ prompt });
      let text = "";
      for await (const delta of result.textStream) text += delta;
      return text;
    },
  };
}

/** `generateText` / `streamText` with `output: Output.object(...)`. */
const HAS_OUTPUT = true;
async function textWithOutput(m: Settings["model"], tel: Telemetry): Promise<unknown> {
  const result = await generateText({ model: m, prompt: "Where?", output: Output.object({ schema: citySchema }), experimental_telemetry: tel });
  return result.output;
}
async function streamWithOutput(m: Settings["model"], tel: Telemetry): Promise<unknown[]> {
  const result = streamText({ model: m, prompt: "Where?", output: Output.object({ schema: citySchema }), experimental_telemetry: tel });
  const partials: unknown[] = [];
  for await (const partial of result.partialOutputStream) partials.push(partial);
  return partials;
}

/** What a Next.js route handler returns. */
const toResponse = (result: { toUIMessageStreamResponse(): Response }): Response => result.toUIMessageStreamResponse();

const repairOption = (fixed: Record<string, unknown>) => ({
  experimental_repairToolCall: async <T extends { input: string }>({ toolCall }: { toolCall: T }) => ({ ...toolCall, input: JSON.stringify(fixed) }),
});
const prepareStepOption = (second: Settings["model"]) => ({
  prepareStep: async ({ stepNumber }: { stepNumber: number }) => (stepNumber === 1 ? { model: second } : {}),
});

/** Run a tool that needs approval: ask, approve, resume. Returns the final text. */
async function approveAndResume(m: Settings["model"], tel: Telemetry): Promise<{ pending: number; text: string }> {
  const prompt: ModelMessage[] = [{ role: "user", content: "Book Paris" }];
  const first = await generateText({ model: m, messages: prompt, tools: { book: approvalTool() }, ...steps(4), experimental_telemetry: tel });
  const requests = first.content.filter((part) => part.type === "tool-approval-request");
  const approvals: ModelMessage = {
    role: "tool",
    content: requests.map((request) => ({ type: "tool-approval-response" as const, approvalId: request.approvalId, approved: true })),
  };
  const second = await generateText({
    model: m,
    messages: [...prompt, ...first.response.messages, approvals],
    tools: { book: approvalTool() },
    ...steps(4),
    experimental_telemetry: tel,
  });
  return { pending: requests.length, text: second.text };
}

const partialObjects = async (m: Settings["model"], tel: Telemetry) => {
  const result = streamObject({ model: m, schema: citySchema, prompt: "Where?", experimental_telemetry: tel });
  const partials: unknown[] = [];
  for await (const partial of result.partialObjectStream) partials.push(partial);
  return { partials, object: await result.object };
};

// --- the same in every fixture

const report = (value: unknown) => console.log(JSON.stringify(value));

/**
 * A provider stream that honours the call's abort signal, as a real provider's
 * `fetch` does — once aborted, the next read fails with an AbortError — and
 * that can drop its connection part-way (`breakAfter`).
 */
function abortable<T>(stream: ReadableStream<T>, signal: AbortSignal | undefined, breakAfter?: number): ReadableStream<T> {
  const reader = stream.getReader();
  let parts = 0;
  return new ReadableStream<T>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      if (breakAfter !== undefined && parts++ === breakAfter) {
        controller.error(new Error("connection reset"));
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * Run the garbage collector until it has had a real chance at everything
 * unreachable. `--expose-gc` switched on at runtime, so the harness needs no
 * special flags.
 */
async function collectGarbage(): Promise<void> {
  const v8 = await import("node:v8");
  const vm = await import("node:vm");
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  for (let i = 0; i < 10; i += 1) {
    gc();
    await sleep(20);
  }
}

/**
 * A route's streamed Response whose client went away after three chunks.
 * Its own function, so nothing of the stream is left on `main`'s frame
 * afterwards — the garbage collector may take all of it.
 */
async function disconnectedClient(withSignal = false): Promise<{ chunks: number }> {
  // A Next.js route can pass `abortSignal: request.signal`; the disconnect then
  // aborts the call as well as cancelling the body.
  const controller = new AbortController();
  const m = model([{ text: "one two three four five six seven eight", usage: [9, 8] }], { chunkDelayMs: 30 });
  const result = streamText({
    model: m,
    prompt: "Count",
    ...(withSignal ? { abortSignal: controller.signal } : {}),
    experimental_telemetry: telemetry({ functionId: "counter" }),
  });
  const reader = toResponse(result).body!.getReader();
  let chunks = 0;
  while (chunks < 3 && !(await reader.read()).done) chunks += 1;
  controller.abort();
  await reader.cancel("client disconnected");
  return { chunks };
}

/** An aborted stream, in a function of its own for the same reason. */
async function abortedStream(): Promise<{ text: string; threw: string | false }> {
  const controller = new AbortController();
  const m = model([{ text: "one two three four five six seven eight", usage: [9, 8] }], { chunkDelayMs: 30 });
  const result = streamText({ model: m, prompt: "Count", abortSignal: controller.signal, experimental_telemetry: telemetry({ functionId: "counter" }), onError: () => undefined });
  let text = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      controller.abort();
    }
    return { text, threw: false };
  } catch (error) {
    return { text, threw: (error as Error).name };
  }
}

/** A stream started and never read. */
function neverRead(): void {
  streamText({ model: model(LOOP), prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
}

/** A stream whose provider connection drops part-way; the error is the caller's to see. */
async function brokenStream(): Promise<{ text: string; threw: string | false }> {
  const m = model([{ text: "one two three four five six seven eight", usage: [9, 8] }], { breakAfterParts: 2 });
  const result = streamText({ model: m, prompt: "Count", experimental_telemetry: telemetry({ functionId: "counter" }), onError: () => undefined });
  let text = "";
  try {
    for await (const delta of result.textStream) text += delta;
    return { text, threw: false };
  } catch (error) {
    return { text, threw: (error as Error).message };
  }
}

/** The adapter's bookkeeping (internal, untyped): what it still holds open. */
const held = () => {
  const internals = (adapter as unknown as { _internals: { openCalls(): number; tracker(): { stats(): unknown } | null } })._internals;
  return { openCalls: internals.openCalls(), stats: internals.tracker()?.stats() ?? null };
};

const LOOP: Step[] = [
  { calls: [{ id: "call-1", name: "weather", input: { city: "Paris" } }], usage: [11, 7] },
  { text: "It is 20C in Paris.", usage: [23, 9] },
];

async function drainText(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const delta of stream) text += delta;
  return text;
}

async function main(scenario: string): Promise<void> {
  switch (scenario) {
    // ---- 1. the agent classes
    case "agent-generate":
    case "agent-stream": {
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      const agent = makeAgent({ model: model(LOOP), telemetry: telemetry({ functionId: "support-agent" }) });
      report({ text: scenario === "agent-generate" ? await agent.generate("Weather in Paris?") : await agent.stream("Weather in Paris?") });
      break;
    }
    case "agent-id": {
      // The agent's own `id` never reaches telemetry: the SDK spreads it into
      // generateText, which drops it. functionId is what names the agent.
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      const agent = makeAgent({ model: model(LOOP), id: "support-agent", telemetry: telemetry() });
      report({ text: await agent.generate("Weather in Paris?") });
      break;
    }
    case "agent-instrument":
    case "agent-instrument-stream": {
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      report({ instrumented: await failproofai.instrument("ai") });
      const agent = makeAgent({ model: model(LOOP), telemetry: { isEnabled: true, functionId: "support-agent" } });
      report({ text: scenario === "agent-instrument" ? await agent.generate("Weather in Paris?") : await agent.stream("Weather in Paris?") });
      break;
    }
    case "agent-instrument-bare": {
      // No telemetry setting at all: ai 7 records every call once an
      // integration is registered; ai 4–6 record nothing without isEnabled.
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      report({ instrumented: await failproofai.instrument("ai", { registerGlobalTracer: false }) });
      report({ text: await makeAgent({ model: model(LOOP) }).generate("Weather in Paris?") });
      break;
    }
    case "agent-wrap": {
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      const agent = makeAgent({ model: await wrapModel(model(LOOP)) });
      report({ text: await agent.generate("Weather in Paris?") });
      break;
    }
    case "agent-wrap-in-scope": {
      if (!HAS_AGENT) return report({ skipped: "no agent class" });
      const agent = makeAgent({ model: await wrapModel(model(LOOP)) });
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("support-agent", { goal: "help" }, async () => report({ text: await agent.stream("Weather in Paris?") })),
      );
      break;
    }

    // ---- 2. embeddings
    case "embed":
      report({ embedding: (await embed({ model: embedder(), value: "Paris", experimental_telemetry: telemetry({ functionId: "indexer" }) })).embedding });
      break;
    case "embed-many": {
      const { embeddings } = await embedMany({ model: embedder(), values: ["Paris", "Rome", "Oslo"], experimental_telemetry: telemetry() });
      report({ embeddings: embeddings.length });
      break;
    }
    case "embed-in-agent":
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("rag", { goal: "answer" }, async () => {
          await embed({ model: embedder(), value: "Paris", experimental_telemetry: telemetry() });
          await embedMany({ model: embedder(), values: ["Paris", "Rome", "Oslo"], experimental_telemetry: telemetry() });
          report({ embedded: true });
        }),
      );
      break;
    case "embed-in-tool": {
      const lookup = weatherTool({
        onRun: async (city) => {
          await embed({ model: embedder(), value: city, experimental_telemetry: telemetry() });
        },
      });
      const { text } = await generateText({ model: model(LOOP), prompt: "Weather?", tools: { weather: lookup }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ text });
      break;
    }

    // ---- 3. structured output
    case "object-partial": {
      const m = model([{ text: '{"city":"Paris"}', usage: [5, 3] }]);
      report(await partialObjects(m, telemetry({ functionId: "extractor" })));
      break;
    }
    case "object-invalid":
      try {
        await generateObject({ model: model([{ text: '{"town":"Paris"}', usage: [5, 3] }]), schema: citySchema, prompt: "Where?", experimental_telemetry: telemetry({ functionId: "extractor" }) });
        report({ threw: false });
      } catch (error) {
        report({ threw: (error as Error).name });
      }
      break;
    case "text-output": {
      if (!HAS_OUTPUT) return report({ skipped: "no Output" });
      report({ output: await textWithOutput(model([{ text: '{"city":"Paris"}', usage: [5, 3] }]), telemetry({ functionId: "extractor" })) });
      break;
    }
    case "stream-output": {
      if (!HAS_OUTPUT) return report({ skipped: "no Output" });
      const partials = await streamWithOutput(model([{ text: '{"city":"Paris"}', usage: [5, 3] }]), telemetry({ functionId: "extractor" }));
      report({ partials: partials.length, last: partials[partials.length - 1] });
      break;
    }

    // ---- 4. tool features
    case "parallel-tools": {
      const m = model([
        {
          calls: [
            { id: "call-p1", name: "weather", input: { city: "Paris" } },
            { id: "call-p2", name: "weather", input: { city: "Rome" } },
          ],
          usage: [11, 7],
        },
        { text: "Paris 20C, Rome 16C.", usage: [40, 9] },
      ]);
      // Rome finishes first: results arrive out of call order.
      const tools = { weather: weatherTool({ delayMs: (city) => (city === "Paris" ? 40 : 5) }) };
      const { text } = await generateText({ model: m, prompt: "Weather?", tools, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ text });
      break;
    }
    case "client-tool": {
      const m = model([{ calls: [{ id: "call-c1", name: "ask", input: { city: "Paris" } }], usage: [11, 7] }]);
      const result = await generateText({ model: m, prompt: "Weather?", tools: { ask: clientTool() }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ toolCalls: result.toolCalls.length });
      break;
    }
    case "tool-choice-required": {
      const { text } = await generateText({ model: model(LOOP), prompt: "Weather?", tools: { weather: weatherTool() }, toolChoice: "required", ...steps(1), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ text });
      break;
    }
    case "repair": {
      const m = model([{ calls: [{ id: "call-r1", name: "weather", input: { town: "Paris" } }], usage: [11, 7] }, LOOP[1]!]);
      const { text } = await generateText({ model: m, prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), ...repairOption({ city: "Paris" }), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ text });
      break;
    }
    case "prepare-step": {
      const second = model([LOOP[1]!], { modelId: "mock-model-large" });
      const { text } = await generateText({ model: model(LOOP), prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), ...prepareStepOption(second), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      report({ text });
      break;
    }
    case "unknown-tool": {
      const m = model([{ calls: [{ id: "call-u1", name: "teleport", input: { city: "Paris" } }], usage: [11, 7] }, LOOP[1]!]);
      try {
        const { text } = await generateText({ model: m, prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
        report({ text });
      } catch (error) {
        report({ threw: (error as Error).name });
      }
      break;
    }
    case "approval": {
      if (!HAS_APPROVAL) return report({ skipped: "no tool approval" });
      const m = model([{ calls: [{ id: "call-a1", name: "book", input: { city: "Paris" } }], usage: [11, 7] }, { text: "Booked Paris.", usage: [30, 4] }]);
      report(await approveAndResume(m, telemetry({ functionId: "travel-agent" })));
      break;
    }

    // ---- 5. consuming a stream
    case "stream-full": {
      const result = streamText({ model: model(LOOP), prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      const types = new Set<string>();
      for await (const part of result.fullStream) types.add(part.type);
      report({ parts: [...types].sort(), text: await result.text });
      break;
    }
    case "stream-response": {
      const result = streamText({ model: model(LOOP), prompt: "Weather?", tools: { weather: weatherTool() }, ...steps(4), experimental_telemetry: telemetry({ functionId: "weather-agent" }) });
      const response = toResponse(result);
      const body = await response.text();
      report({ status: response.status, containsAnswer: body.includes("Paris"), bytes: body.length });
      break;
    }
    case "stream-response-cancel":
      // The browser went away mid-stream. Nothing in the SDK ends the operation
      // after that; the adapter closes it once the stream is garbage.
      report(await disconnectedClient());
      await sleep(100);
      report({ before: held() });
      await collectGarbage();
      report({ after: held() });
      break;
    case "stream-response-cancel-signal":
      report(await disconnectedClient(true));
      await sleep(100);
      report({ before: held() });
      await collectGarbage();
      report({ after: held() });
      break;
    case "stream-error":
      report(await brokenStream());
      await sleep(50);
      await collectGarbage();
      report({ after: held() });
      break;
    case "stream-on-finish": {
      let finished = "";
      const result = streamText({
        model: model(LOOP),
        prompt: "Weather?",
        tools: { weather: weatherTool() },
        ...steps(4),
        experimental_telemetry: telemetry({ functionId: "weather-agent" }),
        onFinish: ({ text }) => {
          finished = text;
        },
      });
      await result.consumeStream();
      report({ finished });
      break;
    }
    case "stream-abort":
      report(await abortedStream());
      await sleep(100);
      report({ before: held() });
      await collectGarbage();
      report({ after: held() });
      break;
    case "stream-unconsumed":
      // Never read. Nothing waits on it, so nothing should be held open.
      neverRead();
      await sleep(200);
      report({ before: held() });
      await collectGarbage();
      report({ after: held() });
      break;

    // ---- 6. reasoning models
    case "reasoning-generate":
    case "reasoning-stream": {
      const m = model([{ reasoning: "The user wants a city.", text: "Paris.", usage: [12, 20], reasoningTokens: 15 }]);
      const options = { model: m, prompt: "Capital of France?", providerOptions: { mock: { reasoningEffort: "high" } }, experimental_telemetry: telemetry({ functionId: "thinker" }) };
      if (scenario === "reasoning-generate") {
        const result = await generateText(options);
        report({ text: result.text });
      } else {
        const result = streamText(options);
        report({ text: await drainText(result.textStream) });
      }
      break;
    }
    case "reasoning-wrap": {
      const m = await wrapModel(model([{ reasoning: "The user wants a city.", text: "Paris.", usage: [12, 20], reasoningTokens: 15 }]));
      const result = streamText({ model: m, prompt: "Capital of France?" });
      report({ text: await drainText(result.textStream) });
      break;
    }

    // ---- 7. concurrency
    case "concurrent":
    case "concurrent-stream": {
      const one = async (i: number) => {
        const m = model([
          { calls: [{ id: `call-${i}`, name: "weather", input: { city: `city-${i}` } }], usage: [100 + i, 1], delayMs: (i * 7) % 11 },
          { text: `answer ${i}`, usage: [200 + i, 2], delayMs: (i * 3) % 5 },
        ]);
        const tools = { weather: weatherTool({ delayMs: () => (i * 13) % 17 }) };
        const options = { model: m, prompt: `q${i}`, tools, ...steps(4), experimental_telemetry: telemetry({ functionId: `worker-${i}` }) };
        if (scenario === "concurrent") return (await generateText(options)).text;
        return await drainText(streamText(options).textStream);
      };
      const texts = await failproofai.session({ sessionId: "busy" }, () => Promise.all(Array.from({ length: 10 }, (_, i) => one(i))));
      report({ texts });
      break;
    }
    case "concurrent-unscoped": {
      const texts = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const m = model([
            { calls: [{ id: `call-${i}`, name: "weather", input: { city: `city-${i}` } }], usage: [100 + i, 1], delayMs: (i * 7) % 11 },
            { text: `answer ${i}`, usage: [200 + i, 2] },
          ]);
          const tools = { weather: weatherTool({ delayMs: () => (i * 13) % 17 }) };
          return (await generateText({ model: m, prompt: `q${i}`, tools, ...steps(4), experimental_telemetry: telemetry({ functionId: "worker" }) })).text;
        }),
      );
      report({ texts });
      break;
    }
    case "concurrent-wrap": {
      const texts = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const m = await wrapModel(model([{ text: `answer ${i}`, usage: [100 + i, 1], delayMs: (i * 7) % 11 }], { modelId: `model-${i}` }));
          return (await generateText({ model: m, prompt: `q${i}` })).text;
        }),
      );
      report({ texts });
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  report({ major: MAJOR });
  await failproofai.flush();
}

main(process.argv[2] ?? "agent-generate").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
