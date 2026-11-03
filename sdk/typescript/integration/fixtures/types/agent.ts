/**
 * A consumer of every public entry point — TYPECHECKED ONLY, never run.
 *
 * `types.test.ts` compiles this file under every module/moduleResolution pair a
 * customer's tsconfig can plausibly carry, as `.ts`, `.mts` and `.cts`. Each
 * import must resolve to real declarations of the right module format, and the
 * `@ts-expect-error` lines prove the names arrived TYPED: an entry that silently
 * resolved to `any` would leave them unused, which is itself an error.
 */
import {
  agent,
  configure,
  flush,
  instrument,
  session,
  version,
  type AgentScope,
  type FrameworkName,
  type SessionScope,
} from "@failproofai/sdk";
import { adapter as aiAdapter, telemetry, wrapTool } from "@failproofai/sdk/ai";
import { adapter as mastraAdapter, workflow } from "@failproofai/sdk/mastra";
import { adapter as langchainAdapter, langchainHandler } from "@failproofai/sdk/langchain";
import { adapter as llamaindexAdapter } from "@failproofai/sdk/llamaindex";
import { EvalResult, Evaluator, Score } from "@failproofai/sdk/evaluator";
import { withFailproofai } from "@failproofai/sdk/next";
import * as sandboxWorker from "@failproofai/sdk/sandbox-worker";

configure({});
// @ts-expect-error configure takes an options object, not a number.
configure(42);

const span: AgentScope = agent.open("planner", { goal: "typecheck" });
const scope: SessionScope = session.open({ sessionId: "s-1" });
const disposers: Array<() => void> = [span.dispose.bind(span), scope.dispose.bind(scope)];
const answer: number = agent("planner", (identity) => identity.depth);
// @ts-expect-error agent() returns what its body returns.
const wrong: string = agent("planner", () => 1);

const frameworks: Promise<FrameworkName[]> = instrument();
const flushed: Promise<void> = flush();
const sdkVersion: string = version;

const adapterNames: string[] = [aiAdapter, mastraAdapter, langchainAdapter, llamaindexAdapter].map(
  (adapter) => adapter.name,
);
const handler: Record<string, unknown> = langchainHandler();
const settings = telemetry();
const tool = wrapTool("get_weather", { execute: (input: { city: string }) => `sunny in ${input.city}` });
const workflowResult: number = workflow("pipeline", () => 7);

const evaluator = new Evaluator({ name: "quality", version: "1" });
evaluator.eval("score", { version: "1" }, () => new EvalResult({ score: new Score(0.5) }));
// @ts-expect-error a Score's value is a number.
new Score("high");

const nextConfig = withFailproofai({ reactStrictMode: true });
const externals: string[] = nextConfig.serverExternalPackages;
const strict: boolean = nextConfig.reactStrictMode;
// @ts-expect-error the wrapped config keeps its own field types.
const notStrict: string = nextConfig.reactStrictMode;

export type SandboxWorker = typeof sandboxWorker;
export {
  adapterNames,
  answer,
  disposers,
  externals,
  notStrict,
  strict,
  flushed,
  frameworks,
  handler,
  sdkVersion,
  settings,
  tool,
  workflowResult,
  wrong,
};
