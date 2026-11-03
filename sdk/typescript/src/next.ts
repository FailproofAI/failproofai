/**
 * Next.js support: `withFailproofai(nextConfig)`.
 *
 * ## Why this exists
 *
 * `next build` BUNDLES a server's dependencies into its own output by default,
 * and none of LangChain, Mastra or LlamaIndex is on Next's built-in external
 * list. `instrument()` attaches to the framework copy in `node_modules`; a
 * bundled app runs a different copy, so the adapter reports success and
 * records nothing. (The Vercel AI SDK is unaffected: ai 7 reads its telemetry
 * integrations from a global, and `telemetry()` is passed at the call site.)
 *
 * The cure Next documents for exactly this is `serverExternalPackages`: a
 * package listed there is loaded from `node_modules` at run time, so the copy
 * `instrument()` patched is the copy the routes run. This wrapper adds the
 * packages the adapters need, keeps everything the app already lists, and
 * records what it added so `instrument()` can tell a configured app from an
 * unconfigured one (see `nextExternalsGap` in `integrations/index.ts`).
 *
 *     // next.config.ts
 *     import { withFailproofai } from "@failproofai/sdk/next";
 *     export default withFailproofai({ ...yourConfig });
 *
 * `@failproofai/sdk` itself is on the list for a second reason: bundled, the
 * SDK would be compiled separately into `instrumentation.ts` and into each
 * route, so `instrument()` would configure one copy while the routes record
 * through another.
 *
 * This module runs where `next.config` runs — Node, at build and at server
 * start — and imports nothing, so it is safe to load from any config file.
 */

/**
 * Packages a Next.js server must load from `node_modules` for `instrument()` to
 * reach them. Listing one the app does not install is harmless: Next only
 * consults the list for imports that actually occur.
 */
export const NEXT_EXTERNAL_PACKAGES: readonly string[] = [
  "@failproofai/sdk",
  // LangChain / LangGraph: every run goes through @langchain/core's callback
  // manager, which is what the adapter patches. Listing core is sufficient —
  // a bundled `@langchain/langgraph` importing it still gets the external copy.
  "@langchain/core",
  "@langchain/langgraph",
  "langchain",
  // Mastra: Agent and the workflow engine are patched in @mastra/core.
  "@mastra/core",
  // LlamaIndex: the callback bus lives in @llamaindex/core, and the agent
  // workflow runtime that is patched lives in @llamaindex/workflow.
  "llamaindex",
  "@llamaindex/core",
  "@llamaindex/workflow",
  "@llamaindex/workflow-core",
];

/**
 * The environment variable `withFailproofai` sets when Next evaluates the
 * config: the comma-separated external list, so `instrument()` in the same
 * server process knows the app was configured. Set it yourself (to the
 * packages you listed, or to `1`) if you configure `serverExternalPackages` by
 * hand and want to silence the warning.
 */
export const NEXT_EXTERNALS_ENV = "FAILPROOFAI_NEXT_EXTERNALS";

type NextConfigObject = Record<string, unknown> & {
  serverExternalPackages?: string[];
  transpilePackages?: string[];
};

/** What `withFailproofai` guarantees about the config it returns. */
export interface WithFailproofaiExternals {
  serverExternalPackages: string[];
}

/**
 * Add the packages `instrument()` needs to `serverExternalPackages`.
 *
 * Accepts every form a `next.config` may export: an object, or a function of
 * `(phase, context)` returning one (sync or async). The result has the same
 * shape as the input. Packages the app lists in `transpilePackages` are left
 * out — Next rejects a package that is both — and `instrument()` will warn for
 * the framework instead, which is the honest outcome.
 */
export function withFailproofai<A extends unknown[], R>(
  config: (...args: A) => R,
): (...args: A) => R extends Promise<infer C> ? Promise<C & WithFailproofaiExternals> : R & WithFailproofaiExternals;
export function withFailproofai<C extends object>(config?: C): C & WithFailproofaiExternals;
export function withFailproofai(config?: unknown): unknown {
  if (typeof config === "function") {
    const wrapped = (...args: unknown[]): unknown => {
      const produced = (config as (...a: unknown[]) => unknown)(...args);
      return produced instanceof Promise
        ? produced.then((value) => apply(value as NextConfigObject))
        : apply(produced as NextConfigObject);
    };
    return wrapped;
  }
  return apply((config ?? {}) as NextConfigObject);
}

function apply(config: NextConfigObject): NextConfigObject {
  const existing = Array.isArray(config.serverExternalPackages) ? config.serverExternalPackages : [];
  const transpiled = new Set(Array.isArray(config.transpilePackages) ? config.transpilePackages : []);
  const merged = [...new Set([...existing, ...NEXT_EXTERNAL_PACKAGES.filter((p) => !transpiled.has(p))])];
  try {
    // Next evaluates the config inside the server process for `next start` and
    // `next dev`, before `instrumentation.ts` runs — so this reaches
    // `instrument()`. A standalone build does not evaluate it; there
    // `instrument()` reads the resolved config Next stores instead.
    process.env[NEXT_EXTERNALS_ENV] = merged.join(",");
  } catch {
    // An environment that forbids writing env vars loses only the marker.
  }
  return { ...config, serverExternalPackages: merged };
}
