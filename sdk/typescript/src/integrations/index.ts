/**
 * Framework adapters: the registry behind `failproofai.instrument()`.
 *
 *     import * as failproofai from "@failproofai/sdk";
 *     await failproofai.instrument();          // every framework we can find
 *     await failproofai.instrument("langchain");  // exactly one
 *     failproofai.uninstrument();              // put everything back
 *
 * **This module imports no adapter until asked.** The registry maps a name to a
 * dynamic `import()` thunk, so `import "@failproofai/sdk"` never pulls in
 * LangChain.
 *
 * ## Detection is by RESOLVABILITY, and that is a real difference from Python
 *
 * The Python SDK detects by reading `sys.modules` — "is this framework already
 * imported in this process" — precisely so that auto-detection never imports a
 * framework the user is not using. Node exposes no equivalent for ESM: there is
 * no public view of the module registry, and `require.cache` only covers the
 * CommonJS half. So detection here asks whether the package **resolves**, which
 * is a weaker question: a framework that is installed but unused will be
 * imported and patched by a bare `instrument()`.
 *
 * That is cheap and side-effect-free for all four adapters (each patches a
 * class prototype or subscribes to a callback registry; none of them changes
 * behaviour on its own), but it is not free. A process that cares names its
 * framework: `instrument("langchain")` imports exactly one thing.
 *
 * ## Writing an adapter
 *
 * A module registered here must export a const named `adapter` implementing
 * `Adapter` from `./core.js`:
 *
 *     name: string
 *     install(options): Promise<void> | void
 *     uninstall(): void
 *
 * `install()` must save the **original attribute object** it replaces — use
 * `core.Patcher`, which also does the "somebody patched on top of us" check —
 * and `uninstall()` must restore that saved object. Never re-import to restore:
 * that hands back whatever the current value happens to be, which is how two
 * instrumentation libraries silently un-patch each other.
 *
 * Every callback an adapter hands to the framework goes through `core.safe`,
 * and every event goes through a `core.RunTracker`. Adapters own the
 * translation table and nothing else.
 */

import { logException, logger } from "../logger.js";
import { loadedModulePaths, resolveFrom } from "../node-require.js";
import * as compat from "./compat.js";
import type { Adapter } from "./core.js";
import * as core from "./core.js";

export type FrameworkName = "langchain" | "ai" | "mastra" | "llamaindex";

const REGISTRY: Record<FrameworkName, () => Promise<{ adapter: Adapter }>> = {
  langchain: () => import("./langchain.js"),
  ai: () => import("./ai.js"),
  mastra: () => import("./mastra.js"),
  llamaindex: () => import("./llamaindex.js"),
};

/**
 * Spellings people actually type. LangGraph is served by the LangChain adapter
 * because LangGraph.js runs on `@langchain/core`'s callback manager.
 */
const ALIASES: Record<string, FrameworkName> = {
  langgraph: "langchain",
  "@langchain/core": "langchain",
  langchainjs: "langchain",
  "aisdk": "ai",
  "ai-sdk": "ai",
  vercel: "ai",
  "vercelai": "ai",
  "@ai-sdk/provider": "ai",
  "@mastra/core": "mastra",
  "llama_index": "llamaindex",
  "llama-index": "llamaindex",
  "llamaindexts": "llamaindex",
};

/**
 * name -> the packages whose presence means "this framework is in use". Kept
 * here rather than read off the adapter so that detection imports nothing at
 * all, not even our own adapter module.
 */
const DETECT: Record<FrameworkName, readonly string[]> = {
  langchain: ["@langchain/core", "langchain", "@langchain/langgraph"],
  ai: ["ai"],
  mastra: ["@mastra/core"],
  llamaindex: ["llamaindex", "@llamaindex/core"],
};

const active = new Map<FrameworkName, Adapter>();

/** Every registry name that can be instrumented, aliases excluded. */
export function available(): FrameworkName[] {
  return (Object.keys(REGISTRY) as FrameworkName[]).sort();
}

/** Names currently instrumented. */
export function activeFrameworks(): FrameworkName[] {
  return [...active.keys()].sort();
}

function canonical(name: string): FrameworkName {
  const key = name.trim().toLowerCase().replaceAll(" ", "");
  const resolved = (ALIASES[key] ?? key) as FrameworkName;
  if (!(resolved in REGISTRY)) {
    const valid = [...new Set([...Object.keys(REGISTRY), ...Object.keys(ALIASES)])].sort().join(", ");
    throw new Error(
      `unknown framework ${JSON.stringify(name)}. Valid names are: ${valid}. ` +
        "(Call instrument() with no argument to auto-detect.)",
    );
  }
  return resolved;
}

function resolvable(pkg: string): boolean {
  if (resolveFrom(pkg) !== null) return true;
  // `require.cache` is the one authoritative "already loaded" signal Node gives
  // us, and it only covers CommonJS. Checking it costs nothing and turns a
  // false negative above — a package whose `exports` map hides its root — into
  // a true positive for CommonJS consumers.
  const marker = `node_modules/${pkg}/`;
  return loadedModulePaths().some((path) => path.replaceAll("\\", "/").includes(marker));
}

function detected(): FrameworkName[] {
  return available().filter((name) => DETECT[name].some((pkg) => resolvable(pkg)));
}

async function load(name: FrameworkName): Promise<Adapter> {
  const module = await REGISTRY[name]();
  const adapter = module.adapter;
  for (const method of ["install", "uninstall"] as const) {
    if (typeof adapter?.[method] !== "function") {
      throw new TypeError(
        `adapter ${JSON.stringify(name)} does not implement ${method}() — see ` +
          "integrations/core.ts's Adapter interface.",
      );
    }
  }
  return adapter;
}

export interface InstrumentOptions {
  /** Per-field truncation ceiling for this adapter's events. */
  captureLimit?: number;
  [option: string]: unknown;
}

/**
 * Install the adapters. Returns the names newly instrumented.
 *
 * With no argument, instruments every framework this process can resolve.
 * Instrumenting something already active is a no-op that returns `[]`, so
 * calling this from two code paths (or from a reloading dev server) cannot
 * double-record.
 *
 * An unknown name throws, listing the valid ones — a typo that silently records
 * nothing is the worst outcome available. An adapter whose `install()` throws
 * is logged and skipped; the others still install, because a broken LlamaIndex
 * should not cost you LangGraph. `FAILPROOFAI_SDK_STRICT=1` turns that skip
 * back into a throw.
 */
export async function instrument(
  framework?: string | null,
  options: InstrumentOptions = {},
): Promise<FrameworkName[]> {
  let names: FrameworkName[];
  if (framework === undefined || framework === null) {
    names = detected();
    if (names.length === 0) {
      // WARN, not debug. This fires only when somebody explicitly asked for
      // instrumentation and got none, and the result is a process that records
      // nothing at all with the adapter "installed" and the docs followed.
      logger.warn(
        "instrument() found no supported framework, so NOTHING was instrumented. " +
          "Install the framework you are using, or name one explicitly: " +
          available()
            .map((name) => `instrument(${JSON.stringify(name)})`)
            .join(", ") +
          ".",
      );
    }
  } else {
    names = [canonical(framework)];
  }

  const installed: FrameworkName[] = [];
  for (const name of names) {
    if (active.has(name)) continue;
    let adapter: Adapter | null = null;
    try {
      adapter = await load(name);
      await adapter.install(options);
    } catch (error) {
      // An install is NOT atomic, so a failure part-way through leaves global
      // state behind — a patched prototype, a registered listener. Catching
      // without rolling back would leave the adapter fully patched and never
      // recorded in `active`, so `activeFrameworks()` would deny it existed and
      // `uninstrument()` — which iterates `active` — could never undo it. It
      // would record for the life of the process and could not be removed.
      if (adapter !== null) {
        try {
          adapter.uninstall();
        } catch (rollbackError) {
          logger.debug(
            `rollback of a failed ${name} install did not complete cleanly: ${String(rollbackError)}`,
          );
        }
      }
      if (core.strict()) throw error;
      // `FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1` is documented as the supported
      // way to make a compat problem loud. Swallowing it here would give the
      // operator neither behaviour — not the throw the flag promises, and not
      // the best-effort instrumentation the warning text promises.
      if (error instanceof compat.FailproofAICompatError && compat.strictIntegrations()) {
        throw error;
      }
      logException(
        `could not instrument ${JSON.stringify(name)}; the rest of your process is ` +
          "unaffected and other adapters still installed. Set FAILPROOFAI_SDK_STRICT=1 to " +
          "throw instead.",
        error,
      );
      continue;
    }
    active.set(name, adapter);
    installed.push(name);
  }
  return installed;
}

/**
 * Reverse `instrument()`. Returns the names removed. Never throws.
 *
 * With no argument, removes everything. An unknown name, or a name that was
 * never instrumented, is a no-op — teardown that can fail is teardown people
 * stop calling.
 */
export function uninstrument(framework?: string | null): FrameworkName[] {
  let names: FrameworkName[];
  if (framework === undefined || framework === null) {
    names = [...active.keys()];
  } else {
    try {
      names = [canonical(framework)];
    } catch (error) {
      logger.warn(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  const removed: FrameworkName[] = [];
  for (const name of names) {
    const adapter = active.get(name);
    if (adapter === undefined) continue;
    active.delete(name);
    try {
      adapter.uninstall();
    } catch (error) {
      logException(
        `${JSON.stringify(name)} did not uninstall cleanly; it is no longer registered, ` +
          "but some patches may remain.",
        error,
      );
    }
    removed.push(name);
  }
  if (active.size === 0) {
    // Nothing is instrumented any more, so a later instrument() starts from a
    // clean slate rather than inheriting a degraded call site or a warning that
    // has "already been shown".
    core.resetFailures();
    compat.resetWarnings();
  }
  return removed;
}
