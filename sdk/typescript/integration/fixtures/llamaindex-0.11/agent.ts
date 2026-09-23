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
import { RetrieverQueryEngine, type QueryBundle } from "@llamaindex/core/query-engine";
import { getResponseSynthesizer } from "@llamaindex/core/response-synthesizers";
import { BaseRetriever } from "@llamaindex/core/retriever";
import { TextNode, type NodeWithScore } from "@llamaindex/core/schema";
import { extractText } from "@llamaindex/core/utils";
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

// ---------------------------------------------------------------------------
// One object built once and shared by concurrent requests — the way a server
// holds its query engine or agent. Everything below is stateless per call, so
// two calls in flight at once cannot disturb each other: whatever the trace
// mixes up is the adapter's doing.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));
/** The city a request is about. Paris is the SLOW request, so Rome starts and ends inside it. */
const cityIn = (text: string): "Paris" | "Rome" => (text.includes("Rome") ? "Rome" : "Paris");
const delay = (city: string) => sleep(city === "Paris" ? 40 : 5);
/** Per-city usage, so a model_response carries which request it answered. */
const USAGE = { Paris: { prompt_tokens: 11, completion_tokens: 2 }, Rome: { prompt_tokens: 21, completion_tokens: 3 } };

/** A model that answers from its input alone: a tool call first, then the answer. */
class EchoLLM extends ToolCallLLM {
  supportToolCall = true;
  metadata: LLMMetadata = {
    model: "echo-1",
    temperature: 0,
    topP: 1,
    contextWindow: 4096,
    tokenizer: undefined,
    structuredOutput: false,
  };

  chat(params: LLMChatParamsStreaming<object, Options>): Promise<AsyncIterable<ChatResponseChunk<Options>>>;
  chat(params: LLMChatParamsNonStreaming<object, Options>): Promise<ChatResponse<Options>>;
  @wrapEventCaller
  @wrapLLMEvent
  async chat(
    params: LLMChatParamsStreaming<object, Options> | LLMChatParamsNonStreaming<object, Options>,
  ): Promise<AsyncIterable<ChatResponseChunk<Options>> | ChatResponse<Options>> {
    const city = cityIn(params.messages.map((m) => textOf(m.content)).join("\n"));
    await delay(city);
    const answered = params.messages.some((m) => m.options !== undefined && "toolResult" in m.options);
    const call = params.tools?.length && !answered ? { name: "get_weather", input: { city }, id: `call_${city}` } : null;
    const options: Options = call ? { toolCall: [call] } : {};
    const text = call ? "" : `It is sunny in ${city}.`;
    const usage = USAGE[city];
    if (params.stream) {
      return (async function* (): AsyncGenerator<ChatResponseChunk<Options>> {
        yield { delta: text, raw: { choices: [{ delta: {} }] }, options };
        await delay(city);
        yield { delta: "", raw: { choices: [], usage }, options: {} };
      })();
    }
    const message: ChatMessage<Options> = { role: "assistant", content: text, options };
    return { message, raw: { choices: [{ finish_reason: call ? "tool_calls" : "stop" }], usage } };
  }
}

/** A retriever with no index and no embeddings: one note about the question. */
class NotesRetriever extends BaseRetriever {
  // BaseRetriever's constructor is protected; a subclass's is public.
  constructor() {
    super();
  }

  async _retrieve(params: QueryBundle): Promise<NodeWithScore[]> {
    const question = extractText(params.query);
    await delay(cityIn(question));
    return [{ node: new TextNode({ text: `notes on ${question}` }), score: 1 }];
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
  // Shared objects, also built at startup, before instrument().
  const sharedEngine = new RetrieverQueryEngine(
    new NotesRetriever(),
    getResponseSynthesizer("compact", { llm: new EchoLLM() }),
  );
  const sharedLegacy = new LLMAgent({ llm: new EchoLLM(), tools: [getWeather] });
  const sharedAgent = agent({ llm: new EchoLLM(), tools: [getWeather] });
  report({ instrumented: await failproofai.instrument("llamaindex") });
  const QUESTIONS = ["weather in Paris?", "weather in Rome?"];

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
    case "shared-query": {
      const answers = await Promise.all(QUESTIONS.map((query) => sharedEngine.query({ query })));
      report({ answers: answers.map((a) => a.message.content) });
      break;
    }
    case "shared-legacy": {
      const answers = await Promise.all(QUESTIONS.map((message) => sharedLegacy.chat({ message })));
      report({ answers: answers.map((a) => String(a.message.content)) });
      break;
    }
    case "shared-workflow": {
      const answers = await Promise.all(QUESTIONS.map((question) => sharedAgent.run(question)));
      report({ answers: answers.map((a) => a.data.result) });
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
