// LangChain.js / LangGraph.js consumer. Run as `node agent.{mjs,cjs} <case>`.
//
// Deliberately the shape a customer writes: import the framework, instrument,
// run. The scripted model makes it deterministic and offline — first call asks
// for the `get_weather` tool, the next one answers — and mirrors the Python
// SDK's golden trace for the same graph, which is what the assertions compare
// against.
//
// The SAME file is the agent of every `langchain-*` fixture (it is copied, not
// shared, because the harness transpiles each fixture's own `agent.ts` beside
// its own `node_modules`). Keep it to APIs present across the whole declared
// peer range, so a failure is always the adapter's and never the fixture's.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import * as failproofai from "@failproofai/sdk";
import { langchainHandler } from "@failproofai/sdk/langchain";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { Annotation, Command, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import { ToolNode, createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

class ScriptedModel extends BaseChatModel {
  calls = 0;
  private readonly fail: boolean;

  constructor(fields: BaseChatModelParams & { fail?: boolean } = {}) {
    super(fields);
    this.fail = fields.fail ?? false;
  }

  _llmType(): string {
    return "scripted";
  }

  // The script decides the tool calls; binding only has to hand back a model.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    if (this.fail) throw new Error("model exploded");
    const answered = messages.some((m) => m.getType() === "tool");
    const message = answered
      ? new AIMessage({
          content: "It is sunny in Paris.",
          usage_metadata: { input_tokens: 30, output_tokens: 7, total_tokens: 37 },
          response_metadata: { finish_reason: "stop" },
        })
      : new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" }, type: "tool_call" }],
          usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
          response_metadata: { finish_reason: "tool_calls" },
        });
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

/**
 * A model that streams, the way a real provider integration does: one chunk
 * per piece, each reported through `handleLLMNewToken`. Five chunks, the same
 * split the Python golden's `GenericFakeChatModel` makes of this sentence.
 */
class StreamingModel extends ScriptedModel {
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    for (const text of ["hello", " ", "there", " ", "friend"]) {
      const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
      yield chunk;
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
    }
  }
}

const getWeather = tool(async ({ city }: { city: string }) => `sunny in ${city}`, {
  name: "get_weather",
  description: "Current weather for a city",
  schema: z.object({ city: z.string() }),
});

// Same name, and it fails. `ToolNode` turns the throw into an error
// ToolMessage for the model, so the RUN carries on — the failure belongs to the
// tool call alone.
const brokenWeather = tool(
  async ({ city }: { city: string }): Promise<string> => {
    throw new Error(`no weather for ${city}`);
  },
  {
    name: "get_weather",
    description: "Current weather for a city",
    schema: z.object({ city: z.string() }),
  },
);

function buildGraph(model: ScriptedModel, tools = [getWeather]) {
  const callModel = async (state: typeof MessagesAnnotation.State) => ({
    messages: [await model.invoke(state.messages)],
  });
  const route = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return last.tool_calls?.length ? "tools" : END;
  };
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ name: "weather_graph" });
}

const Trail = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

/** plan -> approve (asks a human) -> act, checkpointed so it can be resumed. */
function buildHitlGraph(checkpointer = new MemorySaver()) {
  return new StateGraph(Trail)
    .addNode("plan", async () => ({ trail: ["plan"] }))
    .addNode("approve", async () => {
      const answer = interrupt({ prompt: "ship it?", options: ["yes", "no"] }) as string;
      return { trail: [`approve:${answer}`] };
    })
    .addNode("act", async () => ({ trail: ["act"] }))
    .addEdge(START, "plan")
    .addEdge("plan", "approve")
    .addEdge("approve", "act")
    .addEdge("act", END)
    .compile({ name: "hitl_graph", checkpointer });
}

/** A compiled graph used as a node of another one. */
function buildParentGraph() {
  const child = new StateGraph(Trail)
    .addNode("inner", async () => ({ trail: ["inner"] }))
    .addEdge(START, "inner")
    .addEdge("inner", END)
    .compile({ name: "child_graph" });
  return new StateGraph(Trail)
    .addNode("pre", async () => ({ trail: ["pre"] }))
    .addNode("child", child)
    .addEdge(START, "pre")
    .addEdge("pre", "child")
    .addEdge("child", END)
    .compile({ name: "parent_graph" });
}

/**
 * A `MemorySaver`'s contents as JSON, and back. The one piece of state two
 * processes share in a real deployment is the checkpointer; this stands in for
 * a database-backed one so the pause and the approval can happen in two
 * genuinely separate processes with nothing else in common.
 */
interface SaverState {
  storage: Record<string, unknown>;
  writes: Record<string, unknown>;
}
const encodeBytes = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? { __u8: Buffer.from(value).toString("base64") } : value;
const decodeBytes = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && typeof (value as { __u8?: unknown }).__u8 === "string"
    ? new Uint8Array(Buffer.from((value as { __u8: string }).__u8, "base64"))
    : value;

function saverState(saver: MemorySaver): SaverState {
  return saver as unknown as SaverState;
}

const question = { messages: [new HumanMessage("weather?")] };
const report = (value: unknown) => console.log(JSON.stringify(value));

/** `instrument()` options per case; every case not listed uses the defaults. */
const OPTIONS: Record<string, Record<string, unknown>> = {
  "include-chains": { includeChains: ["summarise"] },
  "session-option": { sessionId: "fixed-session" },
  "capture-off": { captureContent: false },
};

async function main(scenario: string): Promise<void> {
  if (scenario !== "handler") {
    report({ instrumented: await failproofai.instrument("langchain", OPTIONS[scenario] ?? {}) });
  }

  switch (scenario) {
    case "graph":
    case "session-option":
    case "capture-off": {
      const out = await buildGraph(new ScriptedModel()).invoke(question);
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "stream": {
      let chunks = 0;
      for await (const _ of await buildGraph(new ScriptedModel()).stream(question, { streamMode: "updates" })) {
        chunks += 1;
      }
      report({ chunks });
      break;
    }
    case "react": {
      const agent = createReactAgent({ llm: new ScriptedModel(), tools: [getWeather], name: "react_bot" });
      const out = await agent.invoke(question);
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "error": {
      try {
        await buildGraph(new ScriptedModel({ fail: true })).invoke({ messages: [new HumanMessage("x")] });
        report({ threw: false });
      } catch (error) {
        report({ threw: (error as Error).message });
      }
      break;
    }
    case "tool-error": {
      const out = await buildGraph(new ScriptedModel(), [brokenWeather]).invoke(question);
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "model": {
      const out = await new ScriptedModel().invoke([new HumanMessage("hi")]);
      report({ toolCalls: (out as AIMessage).tool_calls?.length });
      break;
    }
    case "tool": {
      report({ out: await getWeather.invoke({ city: "Rome" }) });
      break;
    }
    case "batch": {
      const out = await new ScriptedModel().batch([[new HumanMessage("a")], [new HumanMessage("b")]]);
      report({ batch: out.length });
      break;
    }
    case "stream-model": {
      let text = "";
      for await (const chunk of await new StreamingModel().stream([new HumanMessage("hi")])) {
        text += String(chunk.content);
      }
      report({ text });
      break;
    }
    case "include-chains": {
      const chain = RunnableLambda.from((x: string) => x)
        .pipe(RunnableLambda.from((x: string) => x.toUpperCase()).withConfig({ runName: "summarise" }))
        .withConfig({ runName: "pipeline" });
      report({ out: await chain.invoke("abc") });
      break;
    }
    case "metadata-session": {
      await buildGraph(new ScriptedModel()).invoke(question, {
        metadata: { failproofai_sdk_session_id: "meta-sid" },
      });
      break;
    }
    case "thread-session": {
      await buildGraph(new ScriptedModel()).invoke(question, { configurable: { thread_id: "thread-9" } });
      break;
    }
    case "hitl":
    case "hitl-uninstrument": {
      const graph = buildHitlGraph();
      const config = { configurable: { thread_id: "t-1" } };
      const first = await graph.invoke({ trail: [] }, config);
      report({ interrupted: "__interrupt__" in first });
      if (scenario === "hitl") {
        const done = await graph.invoke(new Command({ resume: "yes" }), config);
        report({ trail: done.trail });
      } else {
        report({ removed: failproofai.uninstrument() });
      }
      break;
    }
    case "remote-resume-pause": {
      // Process A: serve the request that interrupts, persist the checkpoint,
      // exit with the pause still open.
      const saver = new MemorySaver();
      // `durability: "sync"`: the default persists the checkpoint in the
      // background, and this process is about to exit.
      await buildHitlGraph(saver).invoke({ trail: [] }, { configurable: { thread_id: "t-1" }, durability: "sync" });
      // The two tables, not the saver: 1.x gives MemorySaver a `toJSON`.
      const { storage, writes } = saverState(saver);
      writeFileSync(process.argv[3]!, JSON.stringify({ storage, writes }, encodeBytes));
      break;
    }
    case "remote-resume": {
      // Process B: a different process, sharing only the checkpointer, takes
      // the human's answer.
      const file = `${process.argv[1]}.${process.pid}.checkpoint.json`;
      const child = spawnSync(process.execPath, [process.argv[1]!, "remote-resume-pause", file], {
        env: process.env,
        encoding: "utf8",
      });
      if (child.status !== 0) throw new Error(`the pausing process failed: ${child.stderr}`);
      const saver = new MemorySaver();
      const saved = JSON.parse(readFileSync(file, "utf8"), decodeBytes) as SaverState;
      rmSync(file, { force: true });
      Object.assign(saverState(saver).storage, saved.storage);
      Object.assign(saverState(saver).writes, saved.writes);
      const done = await buildHitlGraph(saver).invoke(new Command({ resume: "yes" }), {
        configurable: { thread_id: "t-1" },
      });
      report({ trail: done.trail });
      break;
    }
    case "abort": {
      // The caller gives up: the signal fires while a node is running.
      const controller = new AbortController();
      const graph = new StateGraph(Trail)
        .addNode("slow", async () => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { trail: ["slow"] };
        })
        .addEdge(START, "slow")
        .addEdge("slow", END)
        .compile({ name: "abort_graph" });
      try {
        await graph.invoke({ trail: [] }, { signal: controller.signal });
        report({ threw: false });
      } catch (error) {
        report({ threw: (error as Error).name });
      }
      // LangGraph.js 1.x never closes an aborted graph's own run; the adapter
      // does, once the run has been silent for its grace period. Outlive it.
      await new Promise((resolve) => setTimeout(resolve, 3_300));
      break;
    }
    case "subgraph": {
      const out = await buildParentGraph().invoke({ trail: [] });
      report({ trail: out.trail });
      break;
    }
    case "scope": {
      await failproofai.session({ sessionId: "req-1" }, () =>
        failproofai.agent("planner", { goal: "plan" }, () => buildGraph(new ScriptedModel()).invoke(question)),
      );
      break;
    }
    case "handler": {
      // No instrument(): the explicit handler is the patch-free path.
      const out = await buildGraph(new ScriptedModel()).invoke(question, {
        callbacks: [langchainHandler() as never],
      });
      report({ answer: out.messages.at(-1)?.content });
      break;
    }
    case "handler-and-instrument": {
      report({ instrumented: await failproofai.instrument("langchain") });
      await buildGraph(new ScriptedModel()).invoke(question, { callbacks: [langchainHandler() as never] });
      break;
    }
    case "uninstrument": {
      report({ removed: failproofai.uninstrument() });
      await buildGraph(new ScriptedModel()).invoke(question);
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  await failproofai.flush();
}

main(process.argv[2] ?? "graph").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
