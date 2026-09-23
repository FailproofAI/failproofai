// Mastra 0.x consumer (the last 0.x line). Run as `node agent.{mjs,cjs} <case>`.
//
// The same program as `../mastra-1/agent.ts`, differing only where the 0.x API
// does: a tool's `execute` receives `{ context }` rather than the input itself,
// and a workflow run is created with `createRunAsync()`.
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
import { z } from "zod";

type Turn = { tool: string; input: Record<string, unknown>; usage: [number, number] } | { text: string; usage: [number, number] };

/**
 * A scripted `LanguageModelV2`: `turns` alternate per call, so a two-step tool
 * loop is turn 0 (tool call) then turn 1 (answer). `fail` makes every call
 * throw, which is how a provider error reaches Mastra. Tool call ids are
 * `<callPrefix>_<n>`, so two models in one session never reuse an id.
 */
function scriptedModel(turns: Turn[], options: { fail?: boolean; callPrefix?: string } = {}) {
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
  execute: async ({ context }: { context: { city: string } }) => ({ city: context.city, forecast: "sunny" }),
});

const brokenWeather = createTool({
  id: "weather",
  description: "Current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async (): Promise<{ city: string }> => {
    throw new Error("tool exploded");
  },
});

const weatherAgent = (options: { fail?: boolean; tool?: typeof weather } = {}) =>
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
      const run = await buildWorkflow().createRunAsync();
      const out = await run.start({ inputData: { question } });
      report({ status: out.status });
      break;
    }
    case "workflow-error": {
      const run = await buildWorkflow(true).createRunAsync();
      const out = await run.start({ inputData: { question } });
      report({ status: out.status });
      break;
    }
    case "wraptool": {
      const tool = wrapTool(weather);
      report({ out: await tool.execute!({ context: { city: "Rome" } } as never) });
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
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "generate").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
