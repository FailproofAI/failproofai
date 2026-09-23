// Mastra 1.x consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import the framework, instrument,
// run. The model is a hand-written AI SDK `LanguageModelV2` — Mastra's own
// model interface, so nothing here reaches a network — scripted per agent:
// the first call asks for a tool, the next one answers. Every agent gets its
// own script so the token counts in the trace say which call they came from.
import * as failproofai from "@failproofai/sdk";
import { wrapTool } from "@failproofai/sdk/mastra";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { MCPClient } from "@mastra/mcp";
import { Memory } from "@mastra/memory";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";

type Turn = { tool: string; input: Record<string, unknown>; usage: [number, number] } | { text: string; usage: [number, number] };

/**
 * Holds the FIRST streamed step open after its response metadata: `reached`
 * fires once the stream is parked there, and it moves on when `wait` settles.
 */
type Gate = { reached: () => void; wait: Promise<void> };

function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * A scripted `LanguageModelV2`: `turns` alternate per call, so a two-step tool
 * loop is turn 0 (tool call) then turn 1 (answer). `fail` makes every call
 * throw, which is how a provider error reaches Mastra. Tool call ids are
 * `<callPrefix>_<n>`, so two models in one session never reuse an id.
 */
function scriptedModel(turns: Turn[], options: { fail?: boolean; callPrefix?: string; gate?: Gate } = {}) {
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
      if (options.fail) throw new Error("model exploded");
      const turn = next();
      return "tool" in turn
        ? {
            content: [
              { type: "tool-call" as const, toolCallId: `${options.callPrefix ?? "call"}_${calls}`, toolName: turn.tool, input: JSON.stringify(turn.input) },
            ],
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
      if (options.fail) throw new Error("model exploded");
      const turn = next();
      const parts: unknown[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: `resp_${calls}`, modelId: "scripted-model", timestamp: new Date(0) },
      ];
      if ("tool" in turn) {
        parts.push({ type: "tool-call", toolCallId: `${options.callPrefix ?? "call"}_${calls}`, toolName: turn.tool, input: JSON.stringify(turn.input) });
        parts.push({ type: "finish", finishReason: "tool-calls", usage: usage(turn.usage) });
      } else {
        parts.push({ type: "text-start", id: "t" });
        // Two deltas, so a step's content has to be assembled from the stream.
        // (Not one per word: Mastra 0.24's textStream drops the third of five
        // such deltas on its own, instrumented or not.)
        const cut = turn.text.indexOf(" ", turn.text.length / 2) + 1;
        for (const delta of [turn.text.slice(0, cut), turn.text.slice(cut)]) {
          parts.push({ type: "text-delta", id: "t", delta });
        }
        parts.push({ type: "text-end", id: "t" });
        parts.push({ type: "finish", finishReason: "stop", usage: usage(turn.usage) });
      }
      const gate = calls === 1 ? options.gate : undefined;
      if (gate) {
        let index = 0;
        return {
          stream: new ReadableStream({
            async pull(controller) {
              if (index === 2) {
                gate.reached();
                await gate.wait;
              }
              if (index >= parts.length) controller.close();
              else controller.enqueue(parts[index++]);
            },
          }),
        };
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

const weather = createTool({
  id: "weather",
  description: "Current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async (input: { city: string }) => ({ city: input.city, forecast: "sunny" }),
});

const brokenWeather = createTool({
  id: "weather",
  description: "Current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async (): Promise<{ city: string }> => {
    throw new Error("tool exploded");
  },
});

const weatherAgent = (options: { fail?: boolean; tool?: typeof weather; gate?: Gate } = {}) =>
  new Agent({
    id: "weather-agent",
    name: "weather-agent",
    instructions: "Answer weather questions.",
    model: scriptedModel(WEATHER_TURNS, options) as never,
    tools: { weather: options.tool ?? weather },
  });

function buildWorkflow(fail = false) {
  const fetchCity = createStep({
    id: "fetch-city",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ city: z.string() }),
    execute: async () => ({ city: "Paris" }),
  });
  const ask = createStep({
    id: "ask-agent",
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    execute: async ({ inputData }) => {
      if (fail) throw new Error("step exploded");
      const out = await weatherAgent().generate(`Weather in ${inputData.city}?`);
      return { answer: out.text };
    },
  });
  return createWorkflow({
    id: "weather-flow",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
  })
    .then(fetchCity)
    .then(ask)
    .commit();
}

const report = (value: unknown) => console.log(JSON.stringify(value));
const question = "What is the weather in Paris?";

// ---------------------------------------------------------------------------
// The coverage cases below need a model that answers from what it is ASKED
// rather than from how often it has been called: concurrent runs share one
// model, and memory, networks and structured output change what a call sees.
// ---------------------------------------------------------------------------

type Prompt = Array<{ role: string; content: unknown }>;
type CallOptions = { prompt: Prompt; responseFormat?: { type?: string; schema?: { properties?: Record<string, unknown> } } };

/** The text of the LAST user message — the question this call answers. */
function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("");
    }
  }
  return "";
}

const cityOf = (text: string): string => /in ([A-Z][a-z]+)/.exec(text)?.[1] ?? "Paris";

/** Every text a call's prompt carries, system included, for routing on. */
const promptText = (prompt: Prompt): string => JSON.stringify(prompt);

let decidedCalls = 0;

/**
 * A `LanguageModelV2` whose every answer is `decide(options)`. Tool call ids
 * are `<prefix>_<n>` over one process-wide counter, so no two calls anywhere
 * reuse one — the concurrency case needs that to tell runs apart.
 */
function decidingModel(modelId: string, decide: (options: CallOptions) => Turn, prefix = "call") {
  const usage = ([input, output]: [number, number]) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
  const answer = (options: CallOptions) => {
    decidedCalls += 1;
    return { turn: decide(options), id: `${prefix}_${decidedCalls}` };
  };
  return {
    specificationVersion: "v2" as const,
    provider: "scripted",
    modelId,
    supportedUrls: {},
    async doGenerate(options: CallOptions) {
      const { turn, id } = answer(options);
      return "tool" in turn
        ? {
            content: [{ type: "tool-call" as const, toolCallId: id, toolName: turn.tool, input: JSON.stringify(turn.input) }],
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
    async doStream(options: CallOptions) {
      const { turn, id } = answer(options);
      const parts: unknown[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: `resp_${id}`, modelId, timestamp: new Date(0) },
      ];
      if ("tool" in turn) {
        parts.push({ type: "tool-call", toolCallId: id, toolName: turn.tool, input: JSON.stringify(turn.input) });
        parts.push({ type: "finish", finishReason: "tool-calls", usage: usage(turn.usage) });
      } else {
        parts.push({ type: "text-start", id: "t" });
        parts.push({ type: "text-delta", id: "t", delta: turn.text });
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

/** Ask `tool` for the city in the question, then answer from its result. */
const toolThenAnswer = (tool: string) => (options: CallOptions): Turn => {
  // Memory titling a new thread (on by default in 0.x) asks the agent's model.
  if (promptText(options.prompt).includes("short title")) return { text: "Weather", usage: [5, 3] };
  const city = cityOf(lastUserText(options.prompt));
  return options.prompt.at(-1)?.role === "tool"
    ? { text: `It is sunny in ${city}.`, usage: [23, 9] }
    : { tool, input: { city }, usage: [11, 7] };
};

const routedAgent = (name: string, tools: Record<string, unknown> = { weather }, extra: Record<string, unknown> = {}) =>
  new Agent({
    id: name,
    name,
    instructions: "Answer weather questions.",
    model: decidingModel("routed-model", toolThenAnswer(Object.keys(tools)[0] ?? "weather")) as never,
    tools: tools as never,
    ...extra,
  } as never);

const CITIES = ["Paris", "Rome", "Oslo", "Lima", "Cairo", "Tokyo", "Quito", "Dakar", "Hanoi", "Perth"];

const answerStep = createStep({
  id: "answer",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
  execute: async ({ inputData }) => ({ answer: `sunny in ${inputData.city}` }),
});

/** A two-step workflow, used on its own and nested inside another. */
function innerWorkflow() {
  const pick = createStep({
    id: "pick-city",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ city: z.string() }),
    execute: async ({ inputData }) => ({ city: cityOf(inputData.question) }),
  });
  return createWorkflow({
    id: "inner-flow",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
  })
    .then(pick)
    .then(answerStep)
    .commit();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one entry point for differently-typed workflows
function workflowCase(name: string): { createRun(): Promise<any> } {
  const input = z.object({ question: z.string() });
  const out = z.object({ answer: z.string() });
  const city = createStep({
    id: "city",
    inputSchema: input,
    outputSchema: z.object({ city: z.string() }),
    execute: async ({ inputData }) => ({ city: cityOf(inputData.question) }),
  });
  switch (name) {
    case "branch": {
      const sunny = createStep({ id: "sunny", inputSchema: z.object({ city: z.string() }), outputSchema: out, execute: async () => ({ answer: "sunny" }) });
      const rainy = createStep({ id: "rainy", inputSchema: z.object({ city: z.string() }), outputSchema: out, execute: async () => ({ answer: "rainy" }) });
      return createWorkflow({ id: "branch-flow", inputSchema: input, outputSchema: z.any() })
        .then(city)
        .branch([
          [async ({ inputData }) => inputData.city === "Paris", sunny],
          [async ({ inputData }) => inputData.city !== "Paris", rainy],
        ])
        .commit();
    }
    case "parallel": {
      const high = createStep({ id: "high", inputSchema: z.object({ city: z.string() }), outputSchema: z.object({ t: z.number() }), execute: async () => ({ t: 25 }) });
      const low = createStep({ id: "low", inputSchema: z.object({ city: z.string() }), outputSchema: z.object({ t: z.number() }), execute: async () => ({ t: 12 }) });
      return createWorkflow({ id: "parallel-flow", inputSchema: input, outputSchema: z.any() }).then(city).parallel([high, low]).commit();
    }
    case "loop": {
      const count = createStep({
        id: "count",
        inputSchema: z.object({ n: z.number() }),
        outputSchema: z.object({ n: z.number() }),
        execute: async ({ inputData }) => ({ n: inputData.n + 1 }),
      });
      const cities = createStep({
        id: "cities",
        inputSchema: z.object({ n: z.number() }),
        outputSchema: z.array(z.object({ city: z.string() })),
        execute: async () => [{ city: "Paris" }, { city: "Rome" }],
      });
      return createWorkflow({ id: "loop-flow", inputSchema: z.object({ n: z.number() }), outputSchema: z.any() })
        .dowhile(count, async ({ inputData }) => inputData.n < 3)
        .then(cities)
        .foreach(answerStep)
        .commit();
    }
    case "nested":
      return createWorkflow({ id: "outer-flow", inputSchema: input, outputSchema: out }).then(innerWorkflow()).commit();
    case "agent-step": {
      const toPrompt = createStep({
        id: "to-prompt",
        inputSchema: input,
        outputSchema: z.object({ prompt: z.string() }),
        execute: async ({ inputData }) => ({ prompt: inputData.question }),
      });
      return createWorkflow({ id: "agent-step-flow", inputSchema: input, outputSchema: z.any() })
        .then(toPrompt)
        .then(createStep(routedAgent("weather-agent")))
        .commit();
    }
    case "suspend": {
      const approve = createStep({
        id: "approve",
        inputSchema: z.object({ city: z.string() }),
        outputSchema: z.object({ city: z.string(), approved: z.boolean() }),
        suspendSchema: z.object({ prompt: z.string() }),
        resumeSchema: z.object({ approved: z.boolean() }),
        execute: async ({ inputData, resumeData, suspend }) => {
          if (resumeData === undefined) return (await suspend({ prompt: `Look up ${inputData.city}?` })) as never;
          return { city: inputData.city, approved: resumeData.approved };
        },
      });
      const done = createStep({
        id: "done",
        inputSchema: z.object({ city: z.string(), approved: z.boolean() }),
        outputSchema: out,
        execute: async ({ inputData }) => ({ answer: inputData.approved ? `sunny in ${inputData.city}` : "declined" }),
      });
      return createWorkflow({ id: "approval-flow", inputSchema: input, outputSchema: out }).then(city).then(approve).then(done).commit();
    }
    default:
      throw new Error(`unknown workflow ${name}`);
  }
}

const mcpServer = () => ({ command: process.execPath, args: [join(process.cwd(), "mcp-server.mjs")] });

async function main(scenario: string): Promise<void> {
  report({ instrumented: await failproofai.instrument("mastra") });

  switch (scenario) {
    case "generate": {
      const out = await weatherAgent().generate(question);
      report({ answer: out.text });
      break;
    }
    case "stream": {
      const out = await weatherAgent().stream(question);
      let text = "";
      for await (const chunk of out.textStream) text += chunk;
      report({ answer: text });
      break;
    }
    case "subagent": {
      const helper = new Agent({
        id: "helper",
        name: "helper",
        description: "Looks up the weather.",
        instructions: "Answer weather questions.",
        model: scriptedModel(WEATHER_TURNS) as never,
        tools: { weather },
      });
      const boss = new Agent({
        id: "boss",
        name: "boss",
        instructions: "Delegate weather questions.",
        model: scriptedModel([
          { tool: "agent-helper", input: { prompt: "Weather in Paris?" }, usage: [40, 12] },
          { text: "The helper says it is sunny.", usage: [60, 8] },
        ], { callPrefix: "delegate" }) as never,
        agents: { helper },
      });
      const out = await boss.generate(question);
      report({ answer: out.text });
      break;
    }
    case "workflow": {
      const run = await buildWorkflow().createRun();
      const out = await run.start({ inputData: { question } });
      report({ status: out.status });
      break;
    }
    case "workflow-error": {
      const run = await buildWorkflow(true).createRun();
      const out = await run.start({ inputData: { question } });
      report({ status: out.status });
      break;
    }
    case "wraptool": {
      const tool = wrapTool(weather);
      report({ out: await tool.execute!({ city: "Rome" }, {} as never) });
      break;
    }
    case "tool-error": {
      const out = await weatherAgent({ tool: brokenWeather as never }).generate(question);
      report({ answer: out.text });
      break;
    }
    case "model-error": {
      try {
        await weatherAgent({ fail: true }).generate(question);
        report({ threw: false });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    }
    case "stream-model-error": {
      const out = await weatherAgent({ fail: true }).stream(question);
      let chunks = 0;
      for await (const _ of out.fullStream) chunks += 1;
      report({ chunks, error: String(out.error) });
      break;
    }
    case "scope": {
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, () => weatherAgent().generate(question)),
      );
      break;
    }
    case "uninstrument": {
      report({ removed: failproofai.uninstrument() });
      await weatherAgent().generate(question);
      break;
    }
    case "uninstrument-midstream": {
      // uninstrument() lands while the first model step's stream is parked
      // mid-flight; the caller then reads the run to the end regardless.
      const reached = barrier();
      const gate = barrier();
      await failproofai.session({ sessionId: "req-1" }, async () => {
        const out = await weatherAgent({ gate: { reached: reached.open, wait: gate.wait } }).stream(question);
        const reading = (async () => {
          let text = "";
          for await (const chunk of out.textStream) text += chunk;
          return text;
        })();
        await reached.wait;
        report({ removed: failproofai.uninstrument() });
        gate.open();
        report({ answer: await reading });
      });
      break;
    }
    case "uninstrument-reuse": {
      // One Agent instance: run while instrumented, then again (both ways)
      // after uninstrument().
      await failproofai.session({ sessionId: "req-1" }, async () => {
        const agent = weatherAgent();
        await agent.generate(question);
        report({ removed: failproofai.uninstrument() });
        const again = await agent.generate(question);
        const streamed = await agent.stream(question);
        let text = "";
        for await (const chunk of streamed.textStream) text += chunk;
        report({ answers: [again.text, text] });
      });
      break;
    }
    case "reinstrument": {
      report({ removed: failproofai.uninstrument() });
      report({ instrumented: await failproofai.instrument("mastra") });
      const out = await weatherAgent().generate(question);
      report({ answer: out.text });
      break;
    }
    case "reinstrument-reuse": {
      // The same Agent instance across an uninstrument()/instrument() cycle.
      const agent = weatherAgent();
      await agent.generate(question);
      report({ removed: failproofai.uninstrument() });
      report({ instrumented: await failproofai.instrument("mastra") });
      const out = await agent.generate(question);
      report({ answer: out.text });
      break;
    }
    case "mastra-instance": {
      // Registered on a Mastra instance and fetched back through it — the
      // shape `mastra dev` and every deployer use.
      const mastra = new Mastra({
        agents: { weatherAgent: weatherAgent() },
        workflows: { weatherFlow: buildWorkflow() },
        logger: false,
      });
      const out = await mastra.getAgent("weatherAgent").generate(question);
      const run = await mastra.getWorkflow("weatherFlow").createRun();
      const flow = await run.start({ inputData: { question } });
      report({ answer: out.text, status: flow.status });
      break;
    }
    case "concurrent": {
      // Ten runs of ONE Agent instance at once, in one session.
      const agent = routedAgent("weather-agent");
      await failproofai.session({ sessionId: "req-1" }, async () => {
        const outs = await Promise.all(CITIES.map((city) => agent.generate(`What is the weather in ${city}?`)));
        report({ answers: outs.map((out) => out.text) });
      });
      break;
    }
    case "concurrent-sessions": {
      // The same, with no scope: every run is its own session, so a leaked
      // event would land in the wrong one where the test can see it.
      const agent = routedAgent("weather-agent");
      const outs = await Promise.all(
        CITIES.map((city, i) =>
          i % 2 === 0
            ? agent.generate(`What is the weather in ${city}?`).then((out) => out.text)
            : agent.stream(`What is the weather in ${city}?`).then(async (out) => {
                let text = "";
                for await (const chunk of out.textStream) text += chunk;
                return text;
              }),
        ),
      );
      report({ answers: outs });
      break;
    }
    case "memory": {
      // Two turns of one conversation (thread) through @mastra/memory.
      const agent = routedAgent("weather-agent", { weather }, {
        memory: new Memory({ storage: new InMemoryStore(), options: { lastMessages: 10 } }),
      });
      const memory = { thread: "thread-42", resource: "user-7" };
      const first = await agent.generate("What is the weather in Paris?", { memory });
      const second = await agent.stream("And what is the weather in Rome?", { memory });
      let text = "";
      for await (const chunk of second.textStream) text += chunk;
      report({ answers: [first.text, text] });
      break;
    }
    case "memory-scoped": {
      // An enclosing session scope wins over the thread.
      const agent = routedAgent("weather-agent", { weather }, {
        memory: new Memory({ storage: new InMemoryStore(), options: { lastMessages: 10 } }),
      });
      await failproofai.session({ sessionId: "req-1" }, () =>
        agent.generate(question, { memory: { thread: "thread-42", resource: "user-7" } }),
      );
      break;
    }
    case "wf-branch":
    case "wf-parallel":
    case "wf-loop":
    case "wf-nested":
    case "wf-agent-step": {
      const name = scenario.slice(3);
      const run = await workflowCase(name).createRun();
      const out = await run.start({ inputData: (name === "loop" ? { n: 0 } : { question }) as never });
      report({ status: out.status, result: out.status === "success" ? out.result : undefined });
      break;
    }
    case "wf-stream": {
      // A workflow run streamed rather than awaited.
      const run = await workflowCase("agent-step").createRun();
      const streamed = await run.stream({ inputData: { question } });
      let chunks = 0;
      for await (const _ of streamed.fullStream) chunks += 1;
      report({ chunks, status: await streamed.status });
      break;
    }
    case "wf-suspend": {
      // A resume reads the suspended run's snapshot back from storage.
      const mastra = new Mastra({ workflows: { approval: workflowCase("suspend") as never }, storage: new InMemoryStore(), logger: false });
      const run = await (mastra.getWorkflow("approval") as unknown as ReturnType<typeof workflowCase>).createRun();
      const first = await run.start({ inputData: { question } });
      report({ status: first.status });
      const second = await run.resume({ step: "approve", resumeData: { approved: true } });
      report({ status: second.status, result: second.status === "success" ? second.result : undefined });
      break;
    }
    case "processors": {
      // An input processor that rewrites the prompt and an output processor
      // that rewrites the answer: neither may add or lose an event.
      const agent = routedAgent("weather-agent", { weather }, {
        inputProcessors: [
          {
            id: "tag-input",
            processInput: ({ messages }: { messages: unknown[] }) => messages,
          },
        ],
        outputProcessors: [
          {
            id: "shout",
            processOutputResult: ({ messages }: { messages: unknown[] }) => messages,
          },
        ],
      });
      const out = await agent.generate(question);
      const streamed = await agent.stream(question);
      let text = "";
      for await (const chunk of streamed.textStream) text += chunk;
      report({ answers: [out.text, text] });
      break;
    }
    case "tripwire": {
      // A guardrail that blocks the prompt: no model call, the run rejected.
      const agent = routedAgent("weather-agent", { weather }, {
        inputProcessors: [
          {
            id: "block-paris",
            processInput: ({ messages, abort }: { messages: unknown[]; abort: (reason: string) => never }) =>
              JSON.stringify(messages).includes("Paris") ? abort("Paris is blocked") : messages,
          },
        ],
      });
      const out = await agent.generate(question);
      const streamed = await agent.stream(question);
      for await (const _ of streamed.fullStream) void _;
      report({ tripwire: Boolean((out as { tripwire?: unknown }).tripwire), text: out.text });
      break;
    }
    case "tripwire-output": {
      // A guardrail on the OUTPUT stream: the model answers, the processor
      // blocks the answer mid-stream.
      const agent = new Agent({
        id: "weather-agent",
        name: "weather-agent",
        instructions: "Answer weather questions.",
        model: decidingModel("routed-model", () => ({ text: "It is sunny in Paris.", usage: [9, 4] })) as never,
        outputProcessors: [
          {
            id: "block-answer",
            processOutputStream: ({ part, abort }: { part: { type: string }; abort: (reason: string) => never }) =>
              part.type === "text-delta" ? abort("answer blocked") : part,
          },
        ],
      } as never);
      const streamed = await agent.stream(question);
      let chunks = 0;
      for await (const _ of streamed.fullStream) chunks += 1;
      report({ chunks, tripwire: Boolean((streamed as { tripwire?: unknown }).tripwire) });
      break;
    }
    case "usage-openai-compatible": {
      // Mastra's own model for an OpenAI-compatible endpoint (`{ id, url }`),
      // against a loopback server that — like OpenAI — sends a streamed
      // step's usage only when the request asks for it, or always when
      // USAGE_ALWAYS=1 (as some compatible servers do).
      const requests: Array<{ stream?: boolean; streamOptions?: unknown }> = [];
      const usage = { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 };
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as { stream?: boolean; stream_options?: { include_usage?: boolean } };
          requests.push({ stream: body.stream, streamOptions: body.stream_options });
          const base = { id: "c1", created: 0, model: "compat-model" };
          if (!body.stream) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Sunny." }, finish_reason: "stop" }], usage }));
            return;
          }
          res.setHeader("content-type", "text/event-stream");
          const send = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Sunny." }, finish_reason: null }] });
          send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          if (process.env.USAGE_ALWAYS === "1" || body.stream_options?.include_usage) {
            send({ ...base, object: "chat.completion.chunk", choices: [], usage });
          }
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
        const agent = new Agent({ id: "compat-agent", name: "compat-agent", instructions: "Be brief.", model: { id: "custom/compat-model", url, apiKey: "test-key" } as never });
        const streamed = await agent.stream(question);
        let text = "";
        for await (const chunk of streamed.textStream) text += chunk;
        const streamedUsage = await streamed.usage;
        const generated = await agent.generate(question);
        report({ text, mastraStreamTokens: streamedUsage.inputTokens ?? 0, mastraGenerateTokens: generated.usage.inputTokens ?? 0, requests });
      } finally {
        server.close();
      }
      break;
    }
    case "mcp":
    case "mcp-toolsets": {
      const mcp = new MCPClient({ id: `mcp-${process.pid}`, servers: { weatherServer: mcpServer() } });
      try {
        if (scenario === "mcp") {
          const tools = await mcp.listTools();
          const agent = routedAgent("weather-agent", tools);
          const out = await agent.generate(question);
          report({ tools: Object.keys(tools), answer: out.text });
        } else {
          const agent = new Agent({
            id: "weather-agent",
            name: "weather-agent",
            instructions: "Answer weather questions.",
            model: decidingModel("routed-model", toolThenAnswer("forecast")) as never,
          });
          const out = await agent.generate(question, { toolsets: await mcp.listToolsets() });
          report({ answer: out.text });
        }
      } finally {
        await mcp.disconnect();
      }
      break;
    }
    case "structured": {
      const agent = new Agent({
        id: "weather-agent",
        name: "weather-agent",
        instructions: "Answer weather questions.",
        model: decidingModel("routed-model", (options) => ({
          text: JSON.stringify({ city: cityOf(lastUserText(options.prompt)), forecast: "sunny" }),
          usage: [15, 6],
        })) as never,
      });
      const schema = z.object({ city: z.string(), forecast: z.string() });
      const out = await agent.generate(question, { structuredOutput: { schema } });
      const streamed = await agent.stream(question, { structuredOutput: { schema } });
      report({ object: out.object, streamed: await streamed.object });
      break;
    }
    case "structured-model": {
      // Structuring by a SECOND model: Mastra runs it through an agent of
      // its own, after the main loop.
      const agent = routedAgent("weather-agent");
      const structurer = decidingModel("structuring-model", () => ({ text: JSON.stringify({ city: "Paris", forecast: "sunny" }), usage: [30, 5] }));
      const out = await agent.generate(question, {
        structuredOutput: { schema: z.object({ city: z.string(), forecast: z.string() }), model: structurer as never },
      });
      report({ object: out.object });
      break;
    }
    case "maxsteps-tool-error": {
      // One step only, and the tool it calls throws.
      const agent = routedAgent("weather-agent", { weather: brokenWeather });
      const out = await agent.generate(question, { maxSteps: 1 });
      report({ finishReason: out.finishReason, text: out.text });
      break;
    }
    case "network": {
      // An agent network: the planner's model routes to `helper` once, the
      // helper answers with its tool, the planner's model judges it complete.
      const helper = new Agent({
        id: "helper",
        name: "helper",
        description: "Looks up the weather.",
        instructions: "Answer weather questions.",
        model: decidingModel("routed-model", toolThenAnswer("weather")) as never,
        tools: { weather },
      });
      const planner = new Agent({
        id: "planner",
        name: "planner",
        instructions: "Coordinate the specialists.",
        model: decidingModel("router-model", (options) => {
          // Tell the calls apart by the schema they ask for, falling back to
          // the prompt when a release injects the schema as text instead. The
          // completion check comes first: its prompt quotes the routing answer.
          const fields = options.responseFormat?.schema?.properties ?? {};
          const asked = lastUserText(options.prompt);
          if ("isComplete" in fields || (asked.includes("evaluate") && asked.includes("complete"))) {
            return { text: JSON.stringify({ isComplete: true, completionReason: "answered", finalResult: "It is sunny in Paris." }), usage: [40, 6] };
          }
          if ("primitiveId" in fields || promptText(options.prompt).includes("primitiveId")) {
            return {
              text: JSON.stringify({ primitiveId: "helper", primitiveType: "agent", prompt: question, selectionReason: "weather" }),
              usage: [50, 10],
            };
          }
          return { text: "Weather in Paris", usage: [5, 3] };
        }) as never,
        agents: { helper },
        memory: new Memory({ storage: new InMemoryStore(), options: { lastMessages: 10 } }),
      });
      const stream = await planner.network(question, { memory: { thread: "thread-net", resource: "user-7" } });
      for await (const _ of stream) void _;
      report({ status: await stream.status });
      break;
    }
    case "agent-in-tool": {
      // Delegation by hand: a tool whose body runs another agent.
      const helper = routedAgent("helper");
      const ask = createTool({
        id: "ask-helper",
        description: "Ask the helper",
        inputSchema: z.object({ city: z.string() }),
        execute: async (input: { city: string }) => ({ answer: (await helper.generate(`What is the weather in ${input.city}?`)).text }),
      });
      const boss = routedAgent("boss", { "ask-helper": ask });
      const out = await boss.generate(question);
      report({ answer: out.text });
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "generate").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
