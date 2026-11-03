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
import { agent, createWorkflow, multiAgent, workflowEvent } from "@llamaindex/workflow";
import {
  BaseEmbedding,
  CondenseQuestionChatEngine,
  ContextChatEngine,
  Document,
  FunctionTool,
  LLMAgent,
  QueryEngineTool,
  Settings,
  SimpleChatEngine,
  VectorStoreIndex,
  tool,
} from "llamaindex";
import { z } from "zod";

type Options = ToolCallLLMMessageOptions;

/** One scripted turn: either a tool call or a final answer, with its usage. */
interface Turn {
  tool?: { name: string; input: Record<string, unknown>; id: string };
  /** Several tool calls in ONE assistant message (parallel tool calling). */
  tools?: Array<{ name: string; input: Record<string, unknown>; id: string }>;
  text?: string;
  /** The provider fails: before answering, or (streaming) after the first chunk. */
  fail?: string;
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
    const calls = turn.tools ?? (turn.tool ? [turn.tool] : []);
    const options: Options = calls.length > 0 ? { toolCall: calls } : {};
    const message: ChatMessage<Options> = { role: "assistant", content: turn.text ?? "", options };
    if (params.stream) {
      // OpenAI's stream shape: content chunks, then a content-less chunk whose
      // `raw` carries the usage (what `stream_options.include_usage` sends).
      return (async function* (): AsyncGenerator<ChatResponseChunk<Options>> {
        yield { delta: turn.text ?? "", raw: { choices: [{ delta: {} }] }, options };
        if (turn.fail) throw new Error(turn.fail);
        yield { delta: "", raw: { choices: [], usage: turn.usage }, options: {} };
      })();
    }
    if (turn.fail) throw new Error(turn.fail);
    return { message, raw: { choices: [{ finish_reason: calls.length > 0 ? "tool_calls" : "stop" }], usage: turn.usage } };
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

// ---------------------------------------------------------------------------
// The coverage sweep: every commonly used LlamaIndex.TS surface, offline.
// ---------------------------------------------------------------------------

/**
 * An embedding model with no network: one dimension per city, so a question
 * about Paris retrieves the Paris note and nothing else.
 */
const CITIES = ["Paris", "Rome", "Oslo", "Lima", "Cairo", "Delhi", "Tokyo", "Quito", "Accra", "Hanoi"] as const;
class FakeEmbedding extends BaseEmbedding {
  // BaseEmbedding's constructor is protected; a subclass's is public.
  constructor() {
    super();
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    return [...CITIES.map((city) => (text.includes(city) ? 1 : 0)), 0.01];
  }
}

const HISTORY: ChatMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

/** Every city's note, indexed with the fake embedding model. */
const cityIndex = () =>
  VectorStoreIndex.fromDocuments(CITIES.map((city) => new Document({ text: `${city} is sunny.`, id_: `doc-${city}` })));

/** The city a question is about. */
const cityOf = (text: string): string => {
  const hits = CITIES.filter((city) => text.includes(city));
  return hits[hits.length - 1] ?? "Paris";
};

/**
 * `EchoLLM` for ten requests: answers from its input alone (a tool call, then
 * the answer), with a per-city delay and per-city usage so every event says
 * which request it belongs to.
 */
class CityLLM extends ToolCallLLM {
  supportToolCall = true;
  metadata: LLMMetadata = {
    model: "city-1",
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
    const city = cityOf(params.messages.map((m) => textOf(m.content)).join("\n"));
    const n = CITIES.indexOf(city as (typeof CITIES)[number]);
    await sleep(((n * 7) % 5) * 6);
    const answered = params.messages.some((m) => m.options !== undefined && "toolResult" in m.options);
    const call = params.tools?.length && !answered ? { name: "get_weather", input: { city }, id: `call_${city}` } : null;
    const options: Options = call ? { toolCall: [call] } : {};
    const text = call ? "" : `It is sunny in ${city}.`;
    const usage = { prompt_tokens: 100 + n, completion_tokens: n };
    if (params.stream) {
      return (async function* (): AsyncGenerator<ChatResponseChunk<Options>> {
        yield { delta: text, raw: { choices: [{ delta: {} }] }, options };
        await sleep(((n * 3) % 4) * 5);
        yield { delta: "", raw: { choices: [], usage }, options: {} };
      })();
    }
    const message: ChatMessage<Options> = { role: "assistant", content: text, options };
    return { message, raw: { choices: [{ finish_reason: call ? "tool_calls" : "stop" }], usage } };
  }
}

const say = (text: string, prompt = 5, completion = 2): Turn => ({
  text,
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

/** Drain whatever a streaming chat or query returned. */
async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let chunks = 0;
  for await (const _ of stream) chunks += 1;
  return chunks;
}

const lookup = FunctionTool.from(({ city }: { city: string }) => `sunny in ${city}`, {
  name: "lookup_weather",
  description: "Current weather for a city",
  parameters: z.object({ city: z.string() }),
});

const getTime = tool({
  name: "get_time",
  description: "Current time in a city",
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `noon in ${city}`,
});

/** A plain `createWorkflow()` workflow with two steps; the second asks the model. */
function plainWorkflow(llm: ScriptedLLM) {
  const start = workflowEvent<string>({ debugLabel: "start" });
  const researched = workflowEvent<string>({ debugLabel: "researched" });
  const stop = workflowEvent<string>({ debugLabel: "stop" });
  const workflow = createWorkflow();
  // Named functions: a step's name is its handler's name. `...args` because the
  // floor's runtime calls `handler(event)` and later ones `handler(context, event)`.
  workflow.handle([start], async function research(...args: unknown[]) {
    const event = args[args.length - 1] as { data: string };
    await sleep(1);
    return researched.with(`notes on ${event.data}`);
  });
  workflow.handle([researched], async function answer(...args: unknown[]) {
    const event = args[args.length - 1] as { data: string };
    const response = await llm.chat({ messages: [{ role: "user", content: event.data }] });
    return stop.with(String(response.message.content));
  });
  return { workflow, start, stop };
}

async function runPlainWorkflow(llm: ScriptedLLM, input: string): Promise<string> {
  const { workflow, start, stop } = plainWorkflow(llm);
  const { stream, sendEvent } = workflow.createContext();
  sendEvent(start.with(input));
  const events = await stream.until(stop).toArray();
  return String((events.at(-1) as { data: unknown }).data);
}

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
  // Adapter options, for the cases that exercise one (`embeddings: true`).
  const options = JSON.parse(process.env.FAILPROOFAI_IT_OPTIONS ?? "{}") as Record<string, unknown>;
  report({ instrumented: await failproofai.instrument("llamaindex", options) });
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
    // -- chat engines --------------------------------------------------------
    case "chat-simple": {
      const engine = new SimpleChatEngine({ llm: new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]) });
      const out = await engine.chat({ message: QUESTION, chatHistory: HISTORY });
      report({ answer: out.message.content });
      break;
    }
    case "chat-simple-stream": {
      const engine = new SimpleChatEngine({ llm: new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]) });
      report({ chunks: await drain(await engine.chat({ message: QUESTION, chatHistory: HISTORY, stream: true })) });
      break;
    }
    case "chat-context":
    case "chat-context-stream": {
      Settings.embedModel = new FakeEmbedding();
      const index = await cityIndex();
      // The floor's chat memory reads Settings.llm even when a chatModel is given.
      const llm = new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]);
      Settings.llm = llm;
      const engine = new ContextChatEngine({
        retriever: index.asRetriever({ similarityTopK: 1 }),
        chatModel: llm,
        chatHistory: HISTORY,
      });
      if (scenario === "chat-context") {
        report({ answer: (await engine.chat({ message: QUESTION })).message.content });
      } else {
        report({ chunks: await drain(await engine.chat({ message: QUESTION, stream: true })) });
      }
      break;
    }
    case "chat-condense":
    case "chat-condense-stream": {
      Settings.embedModel = new FakeEmbedding();
      // CondenseQuestionChatEngine takes its model from Settings, and so does
      // the query engine's synthesizer: first the condensed question, then the answer.
      Settings.llm = new ScriptedLLM([say("What is the weather in Paris?", 6, 3), say("It is sunny in Paris.", 9, 4)]);
      const index = await cityIndex();
      const engine = new CondenseQuestionChatEngine({
        queryEngine: index.asQueryEngine({ similarityTopK: 1 }),
        chatHistory: HISTORY,
      });
      if (scenario === "chat-condense") {
        report({ answer: (await engine.chat({ message: QUESTION })).message.content });
      } else {
        report({ chunks: await drain(await engine.chat({ message: QUESTION, stream: true })) });
      }
      break;
    }
    // -- retrieval and indexes -----------------------------------------------
    case "index-build": {
      Settings.embedModel = new FakeEmbedding();
      const index = await cityIndex();
      report({ built: typeof index.asRetriever });
      break;
    }
    case "retriever": {
      Settings.embedModel = new FakeEmbedding();
      const index = await cityIndex();
      const nodes = await index.asRetriever({ similarityTopK: 1 }).retrieve({ query: QUESTION });
      report({ nodes: nodes.map((n) => n.node.id_) });
      break;
    }
    case "index-query":
    case "index-query-stream": {
      Settings.embedModel = new FakeEmbedding();
      Settings.llm = new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]);
      const engine = (await cityIndex()).asQueryEngine({ similarityTopK: 1 });
      if (scenario === "index-query") {
        report({ answer: (await engine.query({ query: QUESTION })).message.content });
      } else {
        report({ chunks: await drain(await engine.query({ query: QUESTION, stream: true })) });
      }
      break;
    }
    // -- plain workflows -----------------------------------------------------
    case "custom-workflow": {
      report({ answer: await runPlainWorkflow(new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]), QUESTION) });
      break;
    }
    case "custom-workflow-scoped": {
      const answer = await failproofai.agent("forecast_flow", { goal: QUESTION }, () =>
        runPlainWorkflow(new ScriptedLLM([say("It is sunny in Paris.", 9, 4)]), QUESTION),
      );
      report({ answer });
      break;
    }
    // -- agents --------------------------------------------------------------
    case "handoff3": {
      const handOff = (to: string, id: string): Turn => ({
        tool: { name: "handOff", input: { toAgent: to, reason: "next" }, id },
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      });
      const triage = agent({
        name: "triage",
        description: "Routes questions",
        llm: new ScriptedLLM([handOff("researcher", "call_h1")]),
        tools: [getWeather],
        canHandoffTo: ["researcher"],
      });
      const researcher = agent({
        name: "researcher",
        description: "Finds facts",
        llm: new ScriptedLLM([handOff("forecaster", "call_h2")]),
        tools: [getWeather],
        canHandoffTo: ["forecaster"],
      });
      const forecaster = agent({
        name: "forecaster",
        description: "Knows the weather",
        llm: new ScriptedLLM(),
        tools: [getWeather],
      });
      const out = await multiAgent({ agents: [triage, researcher, forecaster], rootAgent: triage }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "structured": {
      const llm = new ScriptedLLM([
        say("It is sunny in Paris.", 9, 4),
        {
          tool: { name: "format_output", input: { city: "Paris", sky: "sunny" }, id: "call_s" },
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        },
      ]);
      // `responseFormat` arrived in @llamaindex/workflow after the floor, so it
      // is passed untyped: the floor's types (and runtime) ignore it.
      const params = { responseFormat: z.object({ city: z.string(), sky: z.string() }) } as Record<string, unknown>;
      const out = await agent({ llm, tools: [getWeather] }).run(QUESTION, params as never);
      report({ answer: out.data.result, object: (out.data as { object?: unknown }).object });
      break;
    }
    // -- tool variants -------------------------------------------------------
    case "function-tool": {
      const turns = weatherTurns();
      turns[0]!.tool = { name: "lookup_weather", input: { city: "Paris" }, id: "call_1" };
      const out = await agent({ llm: new ScriptedLLM(turns), tools: [lookup] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "query-engine-tool": {
      Settings.embedModel = new FakeEmbedding();
      // The query engine's synthesizer answers from Settings.llm, the agent from its own.
      Settings.llm = new ScriptedLLM([say("Paris is sunny.", 7, 3)]);
      const notes = new QueryEngineTool({
        queryEngine: (await cityIndex()).asQueryEngine({ similarityTopK: 1 }),
        metadata: { name: "city_notes", description: "Notes about cities" },
      });
      const turns = weatherTurns();
      turns[0]!.tool = { name: "city_notes", input: { query: "Paris" }, id: "call_1" };
      const out = await agent({ llm: new ScriptedLLM(turns), tools: [notes] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "parallel-tools": {
      const turns = weatherTurns();
      turns[0]!.tool = undefined;
      turns[0]!.tools = [
        { name: "get_weather", input: { city: "Paris" }, id: "call_1" },
        { name: "get_time", input: { city: "Paris" }, id: "call_2" },
      ];
      const out = await agent({ llm: new ScriptedLLM(turns), tools: [getWeather, getTime] }).run(QUESTION);
      report({ answer: out.data.result });
      break;
    }
    case "stream-error": {
      // LlamaIndex's workflow runtime lets a provider error that happens
      // mid-stream escape as an UNHANDLED rejection (reproducible without the
      // SDK), and `run()` never settles. A server survives that with a handler;
      // so does this case, and the run must still close as failed.
      const unhandled: string[] = [];
      process.on("unhandledRejection", (error) => unhandled.push(String(error)));
      const turns: Turn[] = [
        { text: "It is", fail: "provider dropped the stream", usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ];
      const running = agent({ llm: new ScriptedLLM(turns), tools: [getWeather] }).run(QUESTION);
      const settled = await Promise.race([
        running.then(
          () => "resolved",
          (error: unknown) => `rejected: ${String(error)}`,
        ),
        sleep(300).then(() => "pending"),
      ]);
      report({ settled, unhandled });
      break;
    }
    // -- concurrency ---------------------------------------------------------
    case "concurrent-agents": {
      const shared = agent({ llm: new CityLLM(), tools: [getWeather] });
      const answers = await Promise.all(CITIES.map((city) => shared.run(`weather in ${city}?`)));
      report({ answers: answers.map((a) => a.data.result) });
      break;
    }
    case "concurrent-queries": {
      Settings.embedModel = new FakeEmbedding();
      // The synthesizer answers from Settings.llm: one model object shared by all ten.
      Settings.llm = new CityLLM();
      const engine = (await cityIndex()).asQueryEngine({ similarityTopK: 1 });
      const answers = await Promise.all(CITIES.map((city) => engine.query({ query: `weather in ${city}?` })));
      report({ answers: answers.map((a) => a.message.content) });
      break;
    }
    case "concurrent-chats": {
      Settings.embedModel = new FakeEmbedding();
      const llm = new CityLLM();
      Settings.llm = llm;
      const engine = new ContextChatEngine({
        retriever: (await cityIndex()).asRetriever({ similarityTopK: 1 }),
        chatModel: llm,
      });
      // Per-call history: a shared engine's own memory would mix the requests'
      // messages in the FRAMEWORK, which is not what this case is about.
      const answers = await Promise.all(
        CITIES.map((city) => engine.chat({ message: `weather in ${city}?`, chatHistory: [] })),
      );
      report({ answers: answers.map((a) => a.message.content) });
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
