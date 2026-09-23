// LlamaIndex.TS consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import the framework, instrument,
// run. The scripted model makes it deterministic and offline, and it is built
// the way LlamaIndex's own provider packages build theirs (`@llamaindex/openai`
// decorates `chat` with exactly `@wrapEventCaller @wrapLLMEvent`), so the
// callback events it produces are the ones a real provider produces. The
// assertions compare against the Python SDK's golden trace for the equivalent
// `FunctionAgent` program.
import * as failproofai from "@failproofai/sdk";
import { wrapEventCaller, wrapLLMEvent } from "@llamaindex/core/decorator";
import {
  ToolCallLLM,
  type ChatMessage,
  type ChatResponse,
  type ChatResponseChunk,
  type LLMChatParamsNonStreaming,
  type LLMChatParamsStreaming,
  type LLMMetadata,
  type ToolCallLLMMessageOptions,
} from "@llamaindex/core/llms";
import { agent, multiAgent } from "@llamaindex/workflow";
import { LLMAgent, tool } from "llamaindex";
import { z } from "zod";

type Options = ToolCallLLMMessageOptions;

/** One scripted turn: either a tool call or a final answer, with its usage. */
interface Turn {
  tool?: { name: string; input: Record<string, unknown>; id: string };
  text?: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

const weatherTurns = (): Turn[] => [
  { tool: { name: "get_weather", input: { city: "Paris" }, id: "call_1" }, usage: { prompt_tokens: 12, completion_tokens: 5 } },
  { text: "It is sunny in Paris.", usage: { prompt_tokens: 30, completion_tokens: 7 } },
];

class ScriptedLLM extends ToolCallLLM {
  supportToolCall = true;
  metadata: LLMMetadata = {
    model: "scripted-1",
    temperature: 0,
    topP: 1,
    contextWindow: 4096,
    tokenizer: undefined,
    structuredOutput: false,
  };
  private readonly turns: Turn[];

  constructor(turns: Turn[] = weatherTurns()) {
    super();
    this.turns = turns;
  }

  chat(params: LLMChatParamsStreaming<object, Options>): Promise<AsyncIterable<ChatResponseChunk<Options>>>;
  chat(params: LLMChatParamsNonStreaming<object, Options>): Promise<ChatResponse<Options>>;
  @wrapEventCaller
  @wrapLLMEvent
  async chat(
    params: LLMChatParamsStreaming<object, Options> | LLMChatParamsNonStreaming<object, Options>,
  ): Promise<AsyncIterable<ChatResponseChunk<Options>> | ChatResponse<Options>> {
    const turn = this.turns.shift() ?? { text: "done", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const options: Options = turn.tool ? { toolCall: [turn.tool] } : {};
    const message: ChatMessage<Options> = { role: "assistant", content: turn.text ?? "", options };
    if (params.stream) {
      // OpenAI's stream shape: content chunks, then a content-less chunk whose
      // `raw` carries the usage (what `stream_options.include_usage` sends).
      return (async function* (): AsyncGenerator<ChatResponseChunk<Options>> {
        yield { delta: turn.text ?? "", raw: { choices: [{ delta: {} }] }, options };
        yield { delta: "", raw: { choices: [], usage: turn.usage }, options: {} };
      })();
    }
    return { message, raw: { choices: [{ finish_reason: turn.tool ? "tool_calls" : "stop" }], usage: turn.usage } };
  }
}

const getWeather = tool({
  name: "get_weather",
  description: "Current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});

const broken = tool({
  name: "broken",
  description: "Always fails",
  parameters: z.object({ city: z.string() }),
  execute: (): string => {
    throw new Error("tool exploded");
  },
});

const report = (value: unknown) => console.log(JSON.stringify(value));
const QUESTION = "weather in Paris?";

async function main(scenario: string): Promise<void> {
  // Built BEFORE instrument(): the adapter must not depend on construction order.
  const early = agent({ llm: new ScriptedLLM(), tools: [getWeather] });
  report({ instrumented: await failproofai.instrument("llamaindex") });

  switch (scenario) {
    case "workflow": {
      const out = await agent({ llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "named": {
      const out = await agent({ name: "weather_bot", llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "early": {
      const out = await early.run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "stream": {
      let events = 0;
      for await (const _ of agent({ llm: new ScriptedLLM(), tools: [getWeather] }).runStream(QUESTION)) events += 1;
      report({ events });
      break;
    }
    case "legacy": {
      const out = await new LLMAgent({ llm: new ScriptedLLM(), tools: [getWeather] }).chat({ message: QUESTION });
      report({ answer: String(out.message.content) });
      break;
    }
    case "model": {
      const out = await new ScriptedLLM([{ text: "hello", usage: { prompt_tokens: 3, completion_tokens: 1 } }]).chat({
        messages: [{ role: "user", content: "hi" }],
      });
      report({ answer: out.message.content });
      break;
    }
    case "scope": {
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, () =>
          agent({ llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION),
        ),
      );
      break;
    }
    case "tool-error": {
      const turns = weatherTurns();
      turns[0]!.tool = { name: "broken", input: { city: "Paris" }, id: "call_1" };
      const out = await agent({ llm: new ScriptedLLM(turns), tools: [broken] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "handoff": {
      const triage = agent({
        name: "triage",
        description: "Routes questions",
        llm: new ScriptedLLM([
          {
            tool: { name: "handOff", input: { toAgent: "forecaster", reason: "weather question" }, id: "call_h" },
            usage: { prompt_tokens: 8, completion_tokens: 4 },
          },
        ]),
        tools: [getWeather],
        canHandoffTo: ["forecaster"],
      });
      const forecaster = agent({
        name: "forecaster",
        description: "Knows the weather",
        llm: new ScriptedLLM(),
        tools: [getWeather],
      });
      const out = await multiAgent({ agents: [triage, forecaster], rootAgent: triage }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "uninstrument": {
      // One recorded run, then nothing: the second workflow and the legacy agent
      // run after uninstrument() and must leave no trace.
      await agent({ llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION);
      report({ removed: failproofai.uninstrument() });
      await agent({ llm: new ScriptedLLM(), tools: [getWeather] }).run(QUESTION);
      await new LLMAgent({ llm: new ScriptedLLM(), tools: [getWeather] }).chat({ message: QUESTION });
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "workflow").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
