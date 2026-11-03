// Two copies of @langchain/core in one process. Run as `node agent.{mjs,cjs} <case>`.
//
// The app is on @langchain/core 1.2.12 + LangGraph.js 1.4.17. Its provider,
// `lc-weather-provider` (vendor/), pins @langchain/core 0.3.80 as a hard
// dependency — the way @langchain/community and many third-party integrations
// did — so npm cannot dedupe it and nests the second core at
// node_modules/lc-weather-provider/node_modules/@langchain/core. Everything the
// provider exports is built on THAT copy: its own Runnable, its own
// CallbackManager, which `instrument()` resolving from the app never sees.
//
// `<case>` runs under `instrument()`; `handler:<case>` passes
// `callbacks: [langchainHandler()]` instead and never instruments.
import * as failproofai from "@failproofai/sdk";
import { langchainHandler } from "@failproofai/sdk/langchain";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatWeather, WeatherRetriever, forecast, weatherTool } from "lc-weather-provider";
import { z } from "zod";

const getWeather = tool(async ({ city }: { city: string }) => `sunny in ${city}`, {
  name: "get_weather",
  description: "Current weather for a city",
  schema: z.object({ city: z.string() }),
});

/** The app's graph (app core), whose model node calls the PROVIDER's model (nested core). */
function buildGraph() {
  const model = new ChatWeather({});
  // No config threaded through, as customers write it: the model finds its
  // parent run through the AsyncLocalStorage both copies share on globalThis.
  const callModel = async (state: typeof MessagesAnnotation.State) => ({
    messages: [(await model.invoke(state.messages)) as unknown as AIMessage],
  });
  const route = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return last.tool_calls?.length ? "tools" : END;
  };
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode([getWeather]))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ name: "weather_graph" });
}

const CASES: Record<string, (config: RunnableConfig) => Promise<unknown>> = {
  // Roots created by the NESTED copy: nothing of the app's core is involved.
  "nested-model": (config) => new ChatWeather({}).invoke([new HumanMessage("hi")], config).then((m) => m.tool_calls?.length),
  "nested-tool": (config) => weatherTool.invoke("Rome", config),
  "nested-retriever": (config) => new WeatherRetriever({}).invoke("Paris", config).then((docs) => docs.length),
  "nested-runnable": (config) => forecast.invoke("Rome", config),
  // The nested copy's runs as CHILDREN of the app copy's.
  "app-chain": (config) =>
    ChatPromptTemplate.fromMessages([["human", "{q}"]])
      .pipe(new ChatWeather({}) as never)
      .pipe(new StringOutputParser())
      .invoke({ q: "weather?" }, config),
  "app-graph": (config) =>
    buildGraph()
      .invoke({ messages: [new HumanMessage("weather?")] }, config)
      .then((out) => out.messages.at(-1)?.content),
  // An app-copy runnable wrapping a provider model call with NO config
  // threaded through — the child finds its parent only through the shared
  // AsyncLocalStorage, which both copies read from `globalThis`.
  "app-lambda": (config) =>
    RunnableLambda.from(async (q: string) => (await new ChatWeather({}).invoke(q)).tool_calls?.length)
      .withConfig({ runName: "outer" })
      .invoke("weather?", config),
};

/**
 * `<case>`: under `instrument()`. `handler:<case>`: `callbacks:
 * [langchainHandler()]` and no instrument. `both:<case>`: the two together.
 * `uninstrument:<case>`: instrument, uninstrument, then run.
 */
async function main(scenario: string): Promise<void> {
  const [mode, name] = scenario.includes(":") ? scenario.split(":", 2) : ["instrument", scenario];
  const run = CASES[name!];
  if (run === undefined) throw new Error(`unknown scenario ${scenario}`);
  if (mode !== "handler") console.log(JSON.stringify({ instrumented: await failproofai.instrument("langchain") }));
  if (mode === "uninstrument") console.log(JSON.stringify({ removed: failproofai.uninstrument() }));
  const explicit = mode === "handler" || mode === "both";
  console.log(JSON.stringify({ out: await run(explicit ? { callbacks: [langchainHandler() as never] } : {}) }));
  await failproofai.flush();
}

main(process.argv[2] ?? "nested-model").catch((error: unknown) => {
  console.error("FATAL", error);
  process.exit(1);
});
