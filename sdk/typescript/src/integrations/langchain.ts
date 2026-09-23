/**
 * LangChain.js and LangGraph.js.
 *
 * One adapter serves both: LangGraph runs on `@langchain/core`'s callback
 * manager, so a graph's nodes, tools and model calls all arrive through the
 * same handler surface. A LangGraph node is recognised by the
 * `langgraph_node` metadata LangGraph attaches to its chain runs, and becomes
 * its own agent span; an ordinary nested chain (an LCEL `RunnableSequence`, a
 * prompt template) does not, because a span per pipe operator is noise.
 *
 * ## Where it attaches
 *
 * `CallbackManager.configure` — the one function every runnable calls to build
 * the manager for an invocation. Patching it means a handler is attached to
 * every `invoke`/`stream`/`batch` in the process without the caller passing
 * `callbacks:` anywhere.
 *
 * There is no supported global-handler registry in LangChain.js (Python has
 * `register_configure_hook`; the JS package does not), so this is the only
 * placement that works without editing call sites. Both the async `configure`
 * and the newer `_configureSync` are patched when present, because different
 * `@langchain/core` versions route through different ones and a version that
 * used the other would silently record nothing.
 */

import { logger } from "../logger.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "langchain";
const PACKAGE = "@langchain/core";

interface Serialized {
  id?: unknown;
  name?: unknown;
  kwargs?: Record<string, unknown>;
}

interface CallbackManagerLike {
  handlers?: unknown[];
  addHandler?: (handler: unknown, inherit?: boolean) => void;
}

interface CallbackManagerCtor {
  new (): CallbackManagerLike;
  configure?: (...args: unknown[]) => unknown;
  _configureSync?: (...args: unknown[]) => unknown;
}

let tracker: core.RunTracker | null = null;
let patcher: core.Patcher | null = null;
let handler: Record<string, unknown> | null = null;
/** Run ids we opened an agent span for, so `handleChainEnd` closes only those. */
const agentRuns = new Set<string>();
/** Run ids we opened a `tool_use` for, with the tool name the pair must carry. */
const toolRuns = new Map<string, string>();

function name(serialized: Serialized | undefined, runName: string | undefined, fallback: string): string {
  if (typeof runName === "string" && runName) return runName;
  if (typeof serialized?.name === "string" && serialized.name) return serialized.name;
  const id = serialized?.id;
  if (Array.isArray(id) && id.length > 0) {
    const last = id[id.length - 1];
    if (typeof last === "string") return last;
  }
  return fallback;
}

function modelName(serialized: Serialized | undefined, extraParams: unknown): string | undefined {
  const invocation = (extraParams as { invocation_params?: Record<string, unknown> } | undefined)
    ?.invocation_params;
  for (const key of ["model", "model_name", "modelName", "model_id"]) {
    const value = invocation?.[key];
    if (typeof value === "string" && value) return value;
  }
  const kwargs = serialized?.kwargs;
  for (const key of ["model", "model_name", "modelName"]) {
    const value = kwargs?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** A LangChain `BaseMessage` as the `{role, content}` shape the schema expects. */
function messageToWire(message: unknown): Record<string, unknown> {
  const value = message as {
    _getType?: () => string;
    getType?: () => string;
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
  };
  let role: string | undefined;
  try {
    role = value.getType?.() ?? value._getType?.();
  } catch {
    role = undefined;
  }
  if (!role && typeof value.role === "string") role = value.role;
  const wire: Record<string, unknown> = { role: role ?? "user", content: value.content };
  if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
    wire.tool_calls = value.tool_calls;
  }
  return wire;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Token counts, from whichever of the three places this version puts them.
 *
 * `llmOutput.tokenUsage` is the classic location; `usage_metadata` on the
 * generated message is where every current chat model reports it; the OpenAI
 * provider additionally surfaces `estimatedTokenUsage`. Reading only one of
 * them is how an adapter ends up with an empty token column for half the
 * providers in the ecosystem, at 200 OK, with nothing logged.
 */
function usageOf(output: unknown): Usage {
  const result = output as {
    llmOutput?: Record<string, unknown>;
    generations?: unknown[][];
  };
  const asInt = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

  for (const source of [result?.llmOutput?.tokenUsage, result?.llmOutput?.estimatedTokenUsage]) {
    const usage = source as Record<string, unknown> | undefined;
    if (usage) {
      const input = asInt(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens);
      const output_ = asInt(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens);
      if (input !== undefined || output_ !== undefined) {
        return { inputTokens: input, outputTokens: output_ };
      }
    }
  }
  const generation = result?.generations?.[0]?.[0] as { message?: Record<string, unknown> } | undefined;
  const metadata = generation?.message?.usage_metadata as Record<string, unknown> | undefined;
  if (metadata) {
    return {
      inputTokens: asInt(metadata.input_tokens),
      outputTokens: asInt(metadata.output_tokens),
    };
  }
  return {};
}

function contentOf(output: unknown): unknown {
  const generations = (output as { generations?: unknown[][] })?.generations;
  if (!Array.isArray(generations)) return undefined;
  const flat = generations.flat().map((generation) => {
    const value = generation as { text?: unknown; message?: { content?: unknown } };
    return value.message?.content ?? value.text;
  });
  return flat.length === 1 ? flat[0] : flat;
}

function stopReasonOf(output: unknown): string | undefined {
  const generation = (output as { generations?: unknown[][] })?.generations?.[0]?.[0] as
    | { generationInfo?: Record<string, unknown>; message?: { response_metadata?: Record<string, unknown> } }
    | undefined;
  for (const source of [generation?.generationInfo, generation?.message?.response_metadata]) {
    for (const key of ["finish_reason", "finishReason", "stop_reason", "stopReason"]) {
      const value = source?.[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}

function errorOf(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message, stack: error.stack };
  }
  return { type: typeof error, message: String(error) };
}

function base(): Record<string, unknown> {
  return core.frameworkFields(NAME, PACKAGE);
}

function buildHandler(): Record<string, unknown> {
  const t = tracker!;
  const wrap = <Args extends unknown[]>(fn: (...args: Args) => void): ((...args: Args) => void) =>
    core.safe(NAME, fn);

  return {
    name: "failproofai",
    // LangChain checks these flags before dispatching; leaving them at their
    // defaults means a streaming run delivers nothing but a final result.
    awaitHandlers: false,
    ignoreLLM: false,
    ignoreChain: false,
    ignoreAgent: false,
    ignoreRetriever: false,
    ignoreCustomEvent: false,

    handleChainStart: wrap(function handleChainStart(
      serialized: Serialized,
      inputs: unknown,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runType?: string,
      runName?: string,
    ) {
      const node = metadata?.langgraph_node;
      const isRoot = parentRunId === undefined || parentRunId === null;
      const label = typeof node === "string" && node ? node : name(serialized, runName, "chain");

      // A span per LCEL pipe operator is noise, and `agent_id` is a
      // LowCardinality facet — so only the run that IS the invocation (a root
      // chain) and a LangGraph node become agents. Everything else records its
      // parent link so its children can still find the agent above them.
      if (!isRoot && typeof node !== "string") {
        t.link(runId, parentRunId);
        return;
      }
      agentRuns.add(runId);
      t.startAgent(runId, {
        agentId: label,
        parentKey: parentRunId,
        ...core.fwFields({
          run_id: runId,
          parent_run_id: parentRunId,
          run_type: runType,
          node: typeof node === "string" ? node : undefined,
          tags: tags?.length ? tags : undefined,
          inputs,
        }),
      });
    }),

    handleChainEnd: wrap(function handleChainEnd(outputs: unknown, runId: string) {
      if (!agentRuns.delete(runId)) return;
      t.endAgent(runId, { outcome: "success", ...core.fwFields({ outputs }) });
    }),

    handleChainError: wrap(function handleChainError(error: unknown, runId: string) {
      if (!agentRuns.delete(runId)) return;
      const detail = errorOf(error);
      t.emit("error", runId, {
        errorType: detail.type,
        message: detail.message,
        traceback: detail.stack,
      });
      // `error` strictly before `agent_end`: the dashboard closes the span at
      // `agent_end` and anything after it is attributed to nothing.
      t.endAgent(runId, { outcome: "failed" });
    }),

    handleLLMStart: wrap(function handleLLMStart(
      serialized: Serialized,
      prompts: string[],
      runId: string,
      parentRunId?: string,
      extraParams?: unknown,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string,
    ) {
      t.emit("modelRequest", runId, {
        parentKey: parentRunId,
        model: modelName(serialized, extraParams),
        messages: prompts.map((prompt) => ({ role: "user", content: prompt })),
        requestId: runId,
        ...core.fwFields({
          run_id: runId,
          parent_run_id: parentRunId,
          name: name(serialized, runName, "llm"),
          tags: tags?.length ? tags : undefined,
          node: metadata?.langgraph_node,
        }),
      });
    }),

    handleChatModelStart: wrap(function handleChatModelStart(
      serialized: Serialized,
      messages: unknown[][],
      runId: string,
      parentRunId?: string,
      extraParams?: unknown,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string,
    ) {
      t.emit("modelRequest", runId, {
        parentKey: parentRunId,
        model: modelName(serialized, extraParams),
        messages: (messages[0] ?? []).map(messageToWire),
        requestId: runId,
        ...core.fwFields({
          run_id: runId,
          parent_run_id: parentRunId,
          name: name(serialized, runName, "chat_model"),
          tags: tags?.length ? tags : undefined,
          node: metadata?.langgraph_node,
        }),
      });
    }),

    handleLLMEnd: wrap(function handleLLMEnd(output: unknown, runId: string, parentRunId?: string) {
      const usage = usageOf(output);
      t.emit("modelResponse", runId, {
        parentKey: parentRunId,
        stopReason: stopReasonOf(output),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        content: contentOf(output),
        role: "assistant",
        requestId: runId,
        ...core.fwFields({ run_id: runId }),
      });
    }),

    handleLLMError: wrap(function handleLLMError(error: unknown, runId: string, parentRunId?: string) {
      const detail = errorOf(error);
      t.emit("error", runId, {
        parentKey: parentRunId,
        errorType: detail.type,
        message: detail.message,
        traceback: detail.stack,
        ...core.fwFields({ run_id: runId, stage: "model" }),
      });
    }),

    handleToolStart: wrap(function handleToolStart(
      serialized: Serialized,
      input: string,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string,
    ) {
      const toolName = name(serialized, runName, "tool");
      toolRuns.set(runId, toolName);
      t.emit("toolUse", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        input: { input },
        ...core.fwFields({
          run_id: runId,
          parent_run_id: parentRunId,
          tags: tags?.length ? tags : undefined,
          node: metadata?.langgraph_node,
        }),
      });
    }),

    handleToolEnd: wrap(function handleToolEnd(output: unknown, runId: string, parentRunId?: string) {
      const toolName = toolRuns.get(runId);
      if (toolName === undefined) return;
      toolRuns.delete(runId);
      t.emit("toolResult", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        output,
      });
    }),

    handleToolError: wrap(function handleToolError(error: unknown, runId: string, parentRunId?: string) {
      const toolName = toolRuns.get(runId);
      if (toolName === undefined) return;
      toolRuns.delete(runId);
      const detail = errorOf(error);
      // A tool failure is recorded on the leaf, not as a run-level `error`:
      // one the agent loop catches is not a run failure, and one that
      // propagates is reported exactly once by the enclosing chain.
      t.emit("toolResult", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        error: `${detail.type}: ${detail.message}`,
      });
    }),

    handleRetrieverStart: wrap(function handleRetrieverStart(
      serialized: Serialized,
      query: string,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string,
    ) {
      const toolName = name(serialized, runName, "retriever");
      toolRuns.set(runId, toolName);
      t.emit("toolUse", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        input: { query },
        ...core.fwFields({
          run_id: runId,
          kind: "retriever",
          tags: tags?.length ? tags : undefined,
          node: metadata?.langgraph_node,
        }),
      });
    }),

    handleRetrieverEnd: wrap(function handleRetrieverEnd(
      documents: unknown[],
      runId: string,
      parentRunId?: string,
    ) {
      const toolName = toolRuns.get(runId);
      if (toolName === undefined) return;
      toolRuns.delete(runId);
      t.emit("toolResult", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        output: documents,
        ...core.fwFields({ document_count: Array.isArray(documents) ? documents.length : undefined }),
      });
    }),

    handleRetrieverError: wrap(function handleRetrieverError(
      error: unknown,
      runId: string,
      parentRunId?: string,
    ) {
      const toolName = toolRuns.get(runId);
      if (toolName === undefined) return;
      toolRuns.delete(runId);
      const detail = errorOf(error);
      t.emit("toolResult", runId, {
        parentKey: parentRunId,
        toolName,
        toolCallId: runId,
        error: `${detail.type}: ${detail.message}`,
      });
    }),

    handleCustomEvent: wrap(function handleCustomEvent(
      eventName: string,
      data: unknown,
      runId: string,
    ) {
      t.emit("hookTriggered", runId, {
        hookName: eventName,
        hookId: `${runId}:${eventName}`,
        triggerEvent: "custom_event",
        input: data,
      });
      t.emit("hookCompleted", runId, {
        hookName: eventName,
        hookId: `${runId}:${eventName}`,
        outcome: "success",
      });
    }),
  };
}

/**
 * Attach our handler to a manager `configure` just built.
 *
 * Idempotent by identity: LangChain calls `configure` for every invocation and
 * a child manager may inherit the parent's handler list, so a blind
 * `addHandler` would attach the same handler several times and emit each event
 * once per attachment.
 */
function attach(manager: unknown): unknown {
  const value = manager as CallbackManagerLike | undefined | null;
  if (!value || typeof value.addHandler !== "function") return manager;
  if (Array.isArray(value.handlers) && value.handlers.includes(handler)) return manager;
  value.addHandler(handler, true);
  return manager;
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    // Every loaded copy: the ES-module and CommonJS builds of @langchain/core
    // are two different CallbackManager classes. See `requireModuleCopies`.
    const managers = (
      (await compat.requireModuleCopies(
        "@langchain/core/callbacks/manager",
        "npm install @langchain/core",
      )) as Array<{ CallbackManager?: CallbackManagerCtor }>
    ).map((module) => module.CallbackManager);
    if (managers.some((CallbackManager) => typeof CallbackManager !== "function")) {
      throw new Error("@langchain/core/callbacks/manager does not export CallbackManager");
    }

    compat.checkVersion(NAME, PACKAGE, {
      minimum: "0.3.0",
      below: "2.0.0",
      reason: "the handler signatures below are the 0.3+ shape",
    });

    const captureLimit = options.captureLimit;
    tracker = new core.RunTracker(NAME, {
      baseFields: base(),
      fieldLimit: typeof captureLimit === "number" ? captureLimit : undefined,
    });
    handler = buildHandler();
    patcher = new core.Patcher();

    // Both entry points, and at least one must take. A version that routed
    // through the other would install cleanly and record nothing — the single
    // most expensive failure an adapter can have, because everything looks fine.
    let patched = 0;
    for (const CallbackManager of managers as CallbackManagerCtor[])
    for (const method of ["configure", "_configureSync"] as const) {
      const original = CallbackManager[method];
      if (typeof original !== "function") continue;
      if (
        !compat.probe(NAME, `CallbackManager.${method}`, () =>
          Object.getOwnPropertyDescriptor(CallbackManager, method)?.writable !== false,
        )
      ) {
        continue;
      }
      const replacement = function failproofaiConfigure(this: unknown, ...args: unknown[]): unknown {
        const built = (original).apply(this, args);
        // `configure` returns undefined when there is nothing to configure, and
        // that is the ordinary case for an un-traced process — which is exactly
        // the process we are here to trace. Build one.
        if (built === undefined || built === null) {
          try {
            return attach(new CallbackManager());
          } catch {
            return built;
          }
        }
        if (typeof (built as PromiseLike<unknown>)?.then === "function") {
          return (built as PromiseLike<unknown>).then((manager) =>
            manager === undefined || manager === null ? attach(new CallbackManager()) : attach(manager),
          );
        }
        return attach(built);
      };
      if (patcher.patch(CallbackManager, method, replacement)) patched += 1;
    }

    if (patched === 0) {
      throw new Error(
        "could not patch CallbackManager.configure — this build of @langchain/core exposes " +
          "neither a writable `configure` nor `_configureSync`. Pass the handler explicitly " +
          "instead: `chain.invoke(input, { callbacks: [failproofai.langchainHandler()] })`.",
      );
    }
    logger.debug(`langchain adapter attached to ${patched} callback-manager entry point(s)`);
  },

  uninstall(): void {
    patcher?.restoreAll();
    patcher = null;
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
    handler = null;
    agentRuns.clear();
    toolRuns.clear();
  },
};

/**
 * The raw handler, for a caller who would rather pass it explicitly than have
 * `CallbackManager.configure` patched:
 *
 *     await chain.invoke(input, { callbacks: [failproofai.langchainHandler()] });
 *
 * Also the documented fallback when `install()` reports it could not patch.
 * Requires `instrument("langchain")` to have run, because the handler needs the
 * tracker that `install()` builds.
 */
export function langchainHandler(): Record<string, unknown> {
  if (handler === null) {
    throw new Error(
      "langchainHandler() needs the adapter installed first: " +
        "`await failproofai.instrument('langchain')`.",
    );
  }
  return handler;
}
