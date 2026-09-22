/**
 * LlamaIndex.TS (`llamaindex` / `@llamaindex/core`).
 *
 * ## Where it attaches
 *
 * `Settings.callbackManager`, LlamaIndex's own instrumentation bus. This is the
 * only adapter here that patches nothing at all: LlamaIndex publishes a typed
 * event surface and a `.on()` / `.off()` pair, so instrumenting is subscribing
 * and uninstrumenting is unsubscribing. Nothing this adapter does can change
 * what the library returns or throws, because it is never on the call path.
 *
 * Handlers receive a `CustomEvent`, so the payload is on `.detail` — with a
 * fallback to the event object itself, because older builds dispatched the
 * payload directly and a version that did would otherwise record events whose
 * every field is undefined.
 *
 * ## Correlation
 *
 * LlamaIndex pairs its own start/end events by an `id` on the payload. Where it
 * supplies one we use it; where it does not (`llm-tool-call` /
 * `llm-tool-result` identify the pair by the tool call object itself) we key on
 * the tool call's id. A pair that cannot be correlated is emitted anyway
 * without a duration rather than dropped — a tool call with no measured
 * latency is still a tool call.
 */

import { randomUUID } from "node:crypto";

import { logger } from "../logger.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "llamaindex";
const PACKAGES = ["llamaindex", "@llamaindex/core"] as const;

interface CallbackManagerLike {
  on: (event: string, handler: (payload: unknown) => void) => unknown;
  off?: (event: string, handler: (payload: unknown) => void) => unknown;
}

let tracker: core.RunTracker | null = null;
let manager: CallbackManagerLike | null = null;
const subscriptions: Array<[string, (payload: unknown) => void]> = [];
/** Tool call ids we opened a `tool_use` for, with the name the pair must carry. */
const openTools = new Map<string, string>();
/** Retriever/query run ids we opened a `tool_use` for. */
const openRuns = new Map<string, string>();

/**
 * A correlation id out of a payload field whose type the framework does not
 * promise.
 *
 * `String(value)` would turn an object into `[object Object]`, and every event
 * carrying one would then correlate with every other — one flat bucket that
 * looks like data and is not. A value that is not already an id gets a fresh
 * one instead, so the pair is merely unpaired rather than wrongly paired.
 */
function asId(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return randomUUID();
}

/** A tool error as text, without rendering an object as `[object Object]`. */
function describeToolError(result: { error?: unknown; output?: unknown } | undefined): string {
  for (const candidate of [result?.error, result?.output]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (candidate !== undefined && candidate !== null) {
      try {
        return JSON.stringify(candidate) ?? "tool reported an error";
      } catch {
        break;
      }
    }
  }
  return "tool reported an error";
}

function detail(event: unknown): Record<string, unknown> {
  const value = event as { detail?: unknown };
  const payload = value?.detail ?? event;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function messagesOf(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  return messages.map((message) => {
    const value = (message ?? {}) as Record<string, unknown>;
    return { role: value.role ?? "user", content: value.content };
  });
}

function usageOf(response: unknown): { inputTokens?: number; outputTokens?: number } {
  const raw = (response as { raw?: Record<string, unknown> })?.raw;
  const usage = (raw?.usage ?? (response as { usage?: unknown })?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return {};
  return {
    inputTokens: asInt(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens),
    outputTokens: asInt(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens),
  };
}

function toolCallOf(payload: Record<string, unknown>): {
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
} {
  const call = (payload.toolCall ?? payload) as Record<string, unknown>;
  const id = typeof call.id === "string" && call.id ? call.id : randomUUID();
  const name =
    (typeof call.name === "string" && call.name ? call.name : undefined) ??
    (typeof payload.name === "string" ? payload.name : undefined) ??
    "tool";
  const input = (call.input ?? call.args ?? call.parameters) as Record<string, unknown> | undefined;
  return { id, name, input };
}

function subscribe(event: string, handler: (payload: Record<string, unknown>) => void): void {
  const bound = core.safe(NAME, (raw: unknown) => {
    handler(detail(raw));
  });
  manager!.on(event, bound);
  subscriptions.push([event, bound]);
}

function install(options: Record<string, unknown>, settings: { callbackManager?: unknown }): void {
  const bus = settings.callbackManager as CallbackManagerLike | undefined;
  if (!bus || typeof bus.on !== "function") {
    throw new Error(
      "Settings.callbackManager is missing or has no `on` — this build of LlamaIndex does " +
        "not expose the instrumentation bus this adapter subscribes to.",
    );
  }
  manager = bus;
  const t = (tracker = new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGES[0]),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  }));

  if (typeof bus.off !== "function") {
    // Not fatal — subscribing is still the whole integration — but say so, or
    // an `uninstrument()` that silently leaves handlers attached looks like it
    // worked and keeps recording.
    compat.warn(
      "this build of LlamaIndex has no `callbackManager.off`, so uninstrument() cannot " +
        "detach the handlers. They will stay subscribed for the life of the process; the " +
        "adapter stops emitting, so no events are recorded after uninstrument().",
      `${NAME}:off`,
    );
  }

  subscribe("llm-start", (payload) => {
    const id = asId(payload.id);
    t.emit("modelRequest", id, {
      model: typeof payload.model === "string" ? payload.model : undefined,
      messages: messagesOf(payload),
      requestId: id,
      ...core.fwFields({ run_id: id }),
    });
  });

  subscribe("llm-end", (payload) => {
    const id = asId(payload.id);
    const response = payload.response as { message?: { content?: unknown } } | undefined;
    const usage = usageOf(response);
    t.emit("modelResponse", id, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      content: response?.message?.content,
      role: "assistant",
      requestId: id,
      ...core.fwFields({ run_id: id }),
    });
  });

  subscribe("llm-tool-call", (payload) => {
    const call = toolCallOf(payload);
    openTools.set(call.id, call.name);
    t.emit("toolUse", call.id, {
      toolName: call.name,
      toolCallId: call.id,
      input: call.input,
    });
  });

  subscribe("llm-tool-result", (payload) => {
    const call = toolCallOf(payload);
    const toolName = openTools.get(call.id) ?? call.name;
    openTools.delete(call.id);
    const result = payload.toolResult as
      | { output?: unknown; isError?: unknown; error?: unknown }
      | undefined;
    const failed = Boolean(result?.isError ?? result?.error);
    t.emit("toolResult", call.id, {
      toolName,
      toolCallId: call.id,
      output: failed ? undefined : result?.output,
      error: failed ? describeToolError(result) : undefined,
    });
  });

  subscribe("agent-start", (payload) => {
    const step = (payload.startStep ?? payload) as Record<string, unknown>;
    const id = asId(step.id, payload.id);
    t.startAgent(id, {
      agentId: core.normalizeAgentId(step.agentName ?? step.name, "llamaindex-agent"),
      ...core.fwFields({ run_id: id, input: step.input }),
    });
  });

  subscribe("agent-end", (payload) => {
    const step = (payload.endStep ?? payload) as Record<string, unknown>;
    const id = asId(step.id, payload.id);
    t.endAgent(id, { outcome: "success", ...core.fwFields({ output: step.output }) });
  });

  for (const [startEvent, endEvent, label] of [
    ["retrieve-start", "retrieve-end", "retrieve"],
    ["query-start", "query-end", "query"],
    ["synthesize-start", "synthesize-end", "synthesize"],
  ] as const) {
    subscribe(startEvent, (payload) => {
      const id = asId(payload.id);
      openRuns.set(id, label);
      t.emit("toolUse", id, {
        toolName: label,
        toolCallId: id,
        input: { query: payload.query },
        ...core.fwFields({ run_id: id, kind: label }),
      });
    });
    subscribe(endEvent, (payload) => {
      const id = asId(payload.id);
      if (!openRuns.delete(id)) return;
      const nodes = payload.nodes;
      t.emit("toolResult", id, {
        toolName: label,
        toolCallId: id,
        output: nodes ?? payload.response,
        ...core.fwFields({ node_count: Array.isArray(nodes) ? nodes.length : undefined }),
      });
    });
  }

  logger.debug(`llamaindex adapter subscribed to ${subscriptions.length} events`);
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    compat.checkVersion(NAME, PACKAGES[0], {
      minimum: "0.9.0",
      below: "1.0.0",
      reason: "the callbackManager event names below are the 0.9+ shape",
    });

    // Either package serves: an application on the umbrella `llamaindex` and
    // one on `@llamaindex/core` share the same `Settings` singleton, and a
    // build that split them still re-exports it.
    let settings: { callbackManager?: unknown } | null = null;
    let lastError: unknown = null;
    for (const pkg of PACKAGES) {
      try {
        const module = (await compat.requireModule(pkg, "npm install llamaindex")) as {
          Settings?: { callbackManager?: unknown };
        };
        if (module.Settings) {
          settings = module.Settings;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (settings === null) {
      throw new Error(
        "could not reach LlamaIndex's Settings singleton from either `llamaindex` or " +
          "`@llamaindex/core`. Install it with:  npm install llamaindex",
        { cause: lastError },
      );
    }
    install(options, settings);
  },

  uninstall(): void {
    const off = manager?.off;
    if (manager && typeof off === "function") {
      for (const [event, handler] of subscriptions) {
        try {
          off.call(manager, event, handler);
        } catch {
          // Detaching is best-effort; the tracker teardown below is what
          // actually stops events being recorded.
        }
      }
    }
    subscriptions.length = 0;
    manager = null;
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
    openTools.clear();
    openRuns.clear();
  },
};
