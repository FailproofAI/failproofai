/**
 * Mastra (`@mastra/core`).
 *
 * ## Where it attaches
 *
 * `Agent.prototype.generate` / `.stream` (and the `…VNext` variants newer
 * versions added alongside them), plus `createTool`. These are class prototype
 * methods and a module-level factory on a CommonJS-compatible build, so they
 * are patchable — unlike the AI SDK's ES-module function exports.
 *
 * Every `generate`/`stream` variant present is patched, not just the ones this
 * file was written against. Mastra renamed its primary entry point once
 * already (`generate` -> `generateVNext`), and an adapter that patched only the
 * old name would keep installing cleanly and record nothing — the failure that
 * is invisible until somebody asks why the dashboard is empty.
 *
 * `createTool` is wrapped rather than `Tool.prototype.execute` because a
 * Mastra tool's `execute` lives on the instance (the factory closes over the
 * caller's function), so there is no prototype to reach. Tools created BEFORE
 * `instrument()` ran are therefore not covered; `wrapTool` is exported for
 * those.
 */

import { randomUUID } from "node:crypto";

import { importModule } from "../node-require.js";
import { agent as agentScope } from "../scopes.js";
import * as compat from "./compat.js";
import * as core from "./core.js";
import type { Adapter } from "./core.js";

const NAME = "mastra";
const PACKAGE = "@mastra/core";

let tracker: core.RunTracker | null = null;
let patcher: core.Patcher | null = null;

function ensureTracker(options: Record<string, unknown> = {}): core.RunTracker {
  tracker ??= new core.RunTracker(NAME, {
    baseFields: core.frameworkFields(NAME, PACKAGE),
    fieldLimit: typeof options.captureLimit === "number" ? options.captureLimit : undefined,
  });
  return tracker;
}

function errorOf(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message, stack: error.stack };
  }
  return { type: typeof error, message: String(error) };
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function agentLabel(instance: unknown): string {
  const value = instance as { name?: unknown; id?: unknown };
  const raw = typeof value?.name === "string" ? value.name : value?.id;
  return core.normalizeAgentId(raw, "mastra-agent");
}

/**
 * Pull whatever this Mastra version calls the messages out of the call.
 *
 * `generate(messages, options)` takes a string, a string array, or a message
 * array, and the `…VNext` signatures accept the same union. Normalising here
 * means the schema always sees `[{role, content}]`.
 */
function messagesOf(input: unknown): Array<Record<string, unknown>> | undefined {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return undefined;
  return input.map((item) =>
    typeof item === "string"
      ? { role: "user", content: item }
      : ((item ?? {}) as Record<string, unknown>),
  );
}

function usageOf(result: unknown): { inputTokens?: number; outputTokens?: number } {
  const usage = (result as { usage?: Record<string, unknown> })?.usage;
  if (!usage) return {};
  return {
    inputTokens: asInt(usage.inputTokens ?? usage.promptTokens),
    outputTokens: asInt(usage.outputTokens ?? usage.completionTokens),
  };
}

interface CallContext {
  runId: string;
  label: string;
  started: number;
}

function patchAgentMethod(
  prototype: object,
  method: string,
  streaming: boolean,
): boolean {
  const original = (prototype as Record<string, unknown>)[method];
  if (typeof original !== "function") return false;
  const t = ensureTracker();

  const wrapped = core.wrapCallable(
    original as (...args: never[]) => unknown,
    {
      before(this: unknown, input: unknown, options?: unknown): CallContext {
        const runId = randomUUID();
        const label = agentLabel(this);
        t.startAgent(runId, {
          agentId: label,
          ...core.fwFields({
            run_id: runId,
            method,
            streaming: streaming || undefined,
            thread_id: (options as { threadId?: unknown } | undefined)?.threadId,
            resource_id: (options as { resourceId?: unknown } | undefined)?.resourceId,
          }),
        });
        t.emit("modelRequest", `${runId}:model`, {
          parentKey: runId,
          messages: messagesOf(input),
          requestId: runId,
          ...core.fwFields({ run_id: runId, method }),
        });
        return { runId, label, started: Date.now() };
      },
      after(ctx, result) {
        const call = ctx as CallContext | undefined;
        if (!call) return;
        const usage = usageOf(result);
        t.emit("modelResponse", `${call.runId}:model`, {
          parentKey: call.runId,
          stopReason: (result as { finishReason?: string })?.finishReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          // A stream's text is not available yet at return time, and the object
          // is the caller's to consume — reading it here would drain it. The
          // model events still carry the usage a non-streaming call reports.
          content: streaming ? undefined : (result as { text?: unknown })?.text,
          role: "assistant",
          requestId: call.runId,
          ...core.fwFields({ duration_ms: core.ms(Date.now() - call.started) }),
        });
        t.endAgent(call.runId, {
          outcome: "success",
          ...core.fwFields({ duration_ms: core.ms(Date.now() - call.started) }),
        });
      },
      onError(ctx, error) {
        const call = ctx as CallContext | undefined;
        if (!call) return;
        const detail = errorOf(error);
        t.emit("error", call.runId, {
          errorType: detail.type,
          message: detail.message,
          traceback: detail.stack,
        });
        t.endAgent(call.runId, { outcome: "failed" });
      },
    },
    NAME,
  );

  return patcher!.patch(prototype, method, wrapped);
}

/**
 * Wrap one Mastra tool's `execute` so its call and result are recorded.
 *
 * Exported because `createTool` patching only covers tools built after
 * `instrument()` ran — a module that created its tools at import time, above
 * the `instrument()` call, needs this.
 */
export function wrapTool<T extends { id?: string; execute?: (...args: never[]) => unknown }>(
  tool: T,
): T {
  const execute = tool.execute;
  if (typeof execute !== "function" || core.isWrapped(execute)) return tool;
  const t = ensureTracker();
  const toolName = typeof tool.id === "string" && tool.id ? tool.id : "tool";

  const wrapped = core.wrapCallable(
    execute,
    {
      before(context: unknown): string {
        const toolCallId =
          (context as { toolCallId?: string } | undefined)?.toolCallId ?? randomUUID();
        const input = (context as { context?: unknown; input?: unknown } | undefined) ?? {};
        t.emit("toolUse", toolCallId, {
          toolName,
          toolCallId,
          input: ((input.context ?? input.input)) ?? undefined,
        });
        return toolCallId;
      },
      after(ctx, output) {
        t.emit("toolResult", ctx, { toolName, toolCallId: String(ctx), output });
      },
      onError(ctx, error) {
        const detail = errorOf(error);
        t.emit("toolResult", ctx, {
          toolName,
          toolCallId: String(ctx),
          error: `${detail.type}: ${detail.message}`,
        });
      },
    },
    NAME,
  );
  // A new object rather than a mutation: a Mastra tool may be frozen, and
  // assigning to a frozen object fails silently in sloppy mode.
  return { ...tool, execute: wrapped };
}

/**
 * Run `body` inside an agent span named for a Mastra workflow.
 *
 * Workflow steps are plain functions Mastra calls directly, with no prototype
 * to patch, so a workflow is instrumented by wrapping its run rather than
 * automatically. One line at the call site buys the whole step tree, because
 * everything a step does inside it — agent calls, tools — resolves its
 * identity from the ambient scope.
 */
export function workflow<T>(workflowName: string, body: () => T): T {
  return agentScope(core.normalizeAgentId(workflowName, "workflow"), { fw_kind: "workflow" }, body);
}

export const adapter: Adapter = {
  name: NAME,

  async install(options: Record<string, unknown> = {}): Promise<void> {
    compat.checkVersion(NAME, PACKAGE, {
      minimum: "0.10.0",
      below: "2.0.0",
      reason: "the Agent.generate/stream signatures below are the 0.10+ shape",
    });
    ensureTracker(options);
    patcher = new core.Patcher();

    const agentModule = (await compat.requireModule(
      "@mastra/core/agent",
      "npm install @mastra/core",
    )) as { Agent?: (new (...args: never[]) => object) & { prototype: object } };
    const Agent = agentModule.Agent;
    if (typeof Agent !== "function") {
      throw new Error("@mastra/core/agent does not export Agent");
    }

    let patched = 0;
    for (const [method, streaming] of [
      ["generate", false],
      ["generateVNext", false],
      ["generateLegacy", false],
      ["stream", true],
      ["streamVNext", true],
      ["streamLegacy", true],
    ] as const) {
      if (patchAgentMethod(Agent.prototype, method, streaming)) patched += 1;
    }
    if (patched === 0) {
      throw new Error(
        "could not patch any Agent generate/stream method — this build of @mastra/core " +
          "exposes none of them under a writable name.",
      );
    }

    // Tools are optional: a Mastra app with no tools is ordinary, and a missing
    // `createTool` must not cost the agent instrumentation above.
    const toolsModule = (await importModule("@mastra/core/tools").catch(() => null)) as {
      createTool?: (...args: never[]) => unknown;
    } | null;
    if (toolsModule && typeof toolsModule.createTool === "function") {
      const original = toolsModule.createTool;
      patcher.patch(toolsModule, "createTool", function failproofaiCreateTool(
        ...args: never[]
      ): unknown {
        const tool = original(...args);
        return typeof tool === "object" && tool !== null
          ? wrapTool(tool as { id?: string; execute?: (...a: never[]) => unknown })
          : tool;
      });
    }
  },

  uninstall(): void {
    patcher?.restoreAll();
    patcher = null;
    tracker?.closeOpenAgents();
    tracker?.reset();
    tracker = null;
  },
};
