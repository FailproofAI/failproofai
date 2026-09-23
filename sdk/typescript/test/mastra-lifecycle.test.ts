import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogger } from "../src/logger.js";
import * as core from "../src/integrations/core.js";
import { _internals, adapter, wrapTool } from "../src/integrations/mastra.js";
import { session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The Mastra adapter's lifecycle: what `uninstrument()` stops, and what it
 * leaves behind.
 *
 * `instrument()` hands Mastra objects that outlive it — a model behind a
 * proxy, tools behind wrappers, a stream the caller is still reading — so
 * restoring the prototypes is not enough on its own. These run the adapter
 * against a hand-written stand-in for `@mastra/core` (the module loader is the
 * only thing mocked), so each case controls exactly when a model step or a
 * stream ends relative to the teardown. `integration/mastra.test.ts` proves
 * the same against real releases.
 */

const modules = vi.hoisted(() => ({ agent: [] as unknown[], workflows: [] as unknown[] }));

vi.mock("../src/integrations/compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/compat.js")>();
  return {
    ...actual,
    requireModuleCopies: async (specifier: string): Promise<unknown[]> =>
      specifier.endsWith("/agent") ? modules.agent : modules.workflows,
  };
});

// ---------------------------------------------------------------------------
// A stand-in for @mastra/core: the four prototype methods the adapter patches,
// driven the way Mastra drives them.
// ---------------------------------------------------------------------------

type Part = Record<string, unknown>;

/** A released-on-demand barrier, so a test decides when a stream moves on. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

class FakeModel {
  modelId = "fake-model";
  provider = "fake";
  fail = false;
  /** When set, a stream stops after its first part until this opens. */
  gate: Promise<void> | null = null;

  async doGenerate(): Promise<unknown> {
    if (this.fail) throw new Error("model exploded");
    return {
      content: [{ type: "text", text: "sunny" }],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 4 },
    };
  }

  async doStream(): Promise<unknown> {
    const parts: Part[] = [
      { type: "response-metadata", modelId: "fake-model" },
      { type: "text-delta", delta: "sunny" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 6 } },
    ];
    const gate = this.gate;
    let index = 0;
    return {
      stream: new ReadableStream<Part>({
        async pull(controller) {
          if (index === 1 && gate) await gate;
          if (index >= parts.length) {
            controller.close();
            return;
          }
          controller.enqueue(parts[index++]!);
        },
      }),
    };
  }
}

interface Resolved {
  model: FakeModel;
  tools: Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
}

interface StreamOptions {
  onFinish?: (result: unknown) => unknown;
  onError?: (error: unknown) => unknown;
  onAbort?: (event: unknown) => unknown;
}

class FakeAgent {
  name = "fake-agent";
  model = new FakeModel();
  toolFails = false;
  /** What the last run resolved — held on to, the way a reused agent does. */
  resolved: Resolved | null = null;
  /**
   * What the next run resolves to, when a test decides. Fields rather than
   * instance methods: an own `convertTools` would shadow the patched
   * prototype method, and the adapter would never see the run.
   */
  nextModel: FakeModel | null = null;
  nextTools: (() => Resolved["tools"]) | null = null;

  resolveModelConfig(): FakeModel {
    return this.nextModel ?? this.model;
  }

  convertTools(): Resolved["tools"] {
    if (this.nextTools) return this.nextTools();
    return {
      weather: {
        execute: async (input: unknown) => {
          if (this.toolFails) throw new Error("tool exploded");
          return { ...(input as object), forecast: "sunny" };
        },
      },
    };
  }

  private async resolve(): Promise<Resolved> {
    const model = await this.resolveModelConfig();
    const tools = await this.convertTools();
    this.resolved = { model, tools };
    return this.resolved;
  }

  async generate(prompt: string): Promise<unknown> {
    const { model, tools } = await this.resolve();
    await model.doGenerate();
    try {
      await tools.weather!.execute({ city: prompt }, { toolCallId: "call_1" });
    } catch {
      // Mastra hands a tool's failure to the model and carries on.
    }
    await model.doGenerate();
    return { text: "sunny", finishReason: "stop" };
  }

  /**
   * One streamed step. The returned reader is the step's own stream; the
   * caller ends the run with `finish()` / `abort()`, the way Mastra calls
   * `onFinish` / `onAbort` once the caller has consumed or cancelled it.
   */
  async stream(
    _prompt: string,
    options: StreamOptions = {},
  ): Promise<{ reader: ReadableStreamDefaultReader<Part>; finish: () => void; abort: () => Promise<void> }> {
    const { model } = await this.resolve();
    const { stream } = (await model.doStream()) as { stream: ReadableStream<Part> };
    const reader = stream.getReader();
    return {
      reader,
      finish: () => void options.onFinish?.({ finishReason: "stop" }),
      abort: async () => {
        await reader.cancel("caller went away");
        options.onAbort?.({});
      },
    };
  }
}

class FakeEngine {
  /** When set, a step called `wait` parks here until it opens. */
  static gate: { entered: () => void; wait: Promise<void> } | null = null;

  async executeStep(params: { step: { id: string }; executionContext: { runId: string } }): Promise<unknown> {
    if (params.step.id === "wait" && FakeEngine.gate) {
      FakeEngine.gate.entered();
      await FakeEngine.gate.wait;
    }
    if (params.step.id === "explode") throw new Error("step threw");
    return { result: { status: params.step.id === "fail" ? "failed" : "success", output: { ok: true }, error: "step failed" } };
  }
}

class FakeRun {
  workflowId = "fake-flow";
  constructor(
    public runId: string,
    private steps: string[],
  ) {}

  async _start(): Promise<unknown> {
    const engine = new FakeEngine();
    let status = "success";
    for (const id of this.steps) {
      const out = (await engine.executeStep({ step: { id }, executionContext: { runId: this.runId } })) as {
        result: { status: string };
      };
      if (out.result.status === "failed") status = "failed";
    }
    return { status };
  }
}

async function readAll(reader: ReadableStreamDefaultReader<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return parts;
    parts.push(chunk.value);
  }
}

/** Resolve once the adapter's observed stream is parked on the gate. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
  modules.agent = [{ Agent: FakeAgent }];
  modules.workflows = [{ Run: FakeRun, DefaultExecutionEngine: FakeEngine }];
});
afterEach(async () => {
  adapter.uninstall();
  await spool.cleanup();
  setLogger(null);
});

const types = (events: Array<Record<string, unknown>>): string[] => events.map((e) => String(e.type));

describe("uninstrument()", () => {
  it("turns the model proxy and tool wrappers a run already built into pass-throughs", async () => {
    await adapter.install({});
    const agent = new FakeAgent();
    await session({ sessionId: "s1" }, () => agent.generate("Paris"));
    const recorded = (await flushed(spool)).length;
    expect(recorded).toBe(8);

    adapter.uninstall();
    expect(_internals.isEnabled()).toBe(false);

    // What the agent held on to from its instrumented run, used afterwards —
    // inside a scope, so a stray event would have a session to land in.
    const { model, tools } = agent.resolved!;
    await session({ sessionId: "s1" }, async () => {
      await expect(model.doGenerate()).resolves.toMatchObject({ finishReason: "stop" });
      await expect(tools.weather!.execute({ city: "Rome" }, { toolCallId: "call_9" })).resolves.toEqual({
        city: "Rome",
        forecast: "sunny",
      });
      const { stream } = (await model.doStream()) as { stream: ReadableStream<Part> };
      expect(await readAll(stream.getReader())).toHaveLength(3);
      await agent.generate("Oslo");
    });
    expect((await flushed(spool)).length).toBe(recorded);
  });

  it("closes a stream in flight as cancelled and records nothing after it", async () => {
    await adapter.install({});
    const agent = new FakeAgent();
    const gate = barrier();
    agent.model.gate = gate.wait;

    await session({ sessionId: "s1" }, async () => {
      const run = await agent.stream("Paris", {});
      const first = await run.reader.read();
      expect(first.value).toMatchObject({ type: "response-metadata" });
      await settle();

      adapter.uninstall();
      const atTeardown = await flushed(spool);
      expect(types(atTeardown)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
      const response = atTeardown[2]!;
      expect(response.stop_reason).toBe("cancelled");
      expect(response.fw_incomplete).toBe(true);
      expect(atTeardown[3]!.outcome).toBe("cancelled");

      // The stream is the caller's: it still delivers everything.
      gate.open();
      expect(await readAll(run.reader)).toHaveLength(2);
      run.finish();
    });
    expect(types(await flushed(spool))).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(_internals.openSpans()).toEqual({ models: 0, tools: 0, steps: 0, workflowRuns: 0, agents: 0 });
  });

  it("closes an open tool call as incomplete", async () => {
    await adapter.install({});
    const gate = barrier();
    const entered = barrier();
    const agent = new FakeAgent();
    agent.nextTools = () => ({
      weather: {
        execute: async () => {
          entered.open();
          await gate.wait;
          return { forecast: "sunny" };
        },
      },
    });
    const pending = session({ sessionId: "s1" }, () => agent.generate("Paris"));
    await entered.wait;
    adapter.uninstall();
    gate.open();
    await pending;

    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "tool_use", "tool_result", "agent_end"]);
    expect(events[4]!.fw_incomplete).toBe(true);
    expect(events[4]!.tool_call_id).toBe("call_1");
    expect(events[5]!.outcome).toBe("cancelled");
  });

  it("closes an open workflow step as cancelled, and the run with it", async () => {
    await adapter.install({});
    const gate = barrier();
    const entered = barrier();
    FakeEngine.gate = { entered: entered.open, wait: gate.wait };
    try {
      const pending = new FakeRun("r1", ["a", "wait", "b"])._start();
      await entered.wait;
      adapter.uninstall();
      gate.open();
      await pending;
    } finally {
      FakeEngine.gate = null;
    }
    const events = await flushed(spool);
    expect(types(events)).toEqual([
      "agent_start",
      "hook_triggered",
      "hook_completed",
      "hook_triggered",
      "hook_completed",
      "agent_end",
    ]);
    expect(events[4]).toMatchObject({ hook_name: "wait", outcome: "cancelled", fw_incomplete: true });
    expect(events[5]!.outcome).toBe("cancelled");
    expect(_internals.openSpans()).toEqual({ models: 0, tools: 0, steps: 0, workflowRuns: 0, agents: 0 });
  });

  it("re-instruments cleanly: one recording, and the old run's objects stay silent", async () => {
    await adapter.install({});
    const old = new FakeAgent();
    await session({ sessionId: "s0" }, () => old.generate("Paris"));
    adapter.uninstall();
    await adapter.install({});
    expect(_internals.isEnabled()).toBe(true);

    const before = (await flushed(spool)).length;
    await session({ sessionId: "s1" }, async () => {
      await new FakeAgent().generate("Rome");
      // The first installation's proxy and wrapper, reused under the second.
      await old.resolved!.model.doGenerate();
      await old.resolved!.tools.weather!.execute({ city: "Oslo" }, { toolCallId: "call_2" });
    });
    const after = (await flushed(spool)).slice(before);
    expect(types(after)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "tool_use",
      "tool_result",
      "model_request",
      "model_response",
      "agent_end",
    ]);
    expect(new Set(after.map((e) => e.session_id))).toEqual(new Set(["s1"]));
  });

  it("re-wraps a model an agent resolved under an earlier installation", async () => {
    // A reused agent can hand the patched resolveModelConfig the proxy it
    // cached last time; that proxy belongs to a dead installation and would
    // pass everything through.
    await adapter.install({});
    const agent = new FakeAgent();
    await session({ sessionId: "s0" }, () => agent.generate("Paris"));
    adapter.uninstall();
    await adapter.install({});
    const cached = agent.resolved!;
    agent.nextModel = cached.model;
    agent.nextTools = () => cached.tools;

    const before = (await flushed(spool)).length;
    await session({ sessionId: "s1" }, () => agent.generate("Rome"));
    const after = (await flushed(spool)).slice(before);
    // Attributed to THIS run's agent, not to whatever scope happens to be open.
    expect(new Set(after.map((e) => e.agent_id))).toEqual(new Set(["fake-agent"]));
    expect(types(after)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "tool_use",
      "tool_result",
      "model_request",
      "model_response",
      "agent_end",
    ]);
  });

  it("honours instrument()'s options even when wrapTool() recorded first", async () => {
    const tool = wrapTool({ id: "early", execute: async () => "ok" });
    await tool.execute();
    await adapter.install({ captureLimit: 16 });
    await new FakeAgent().generate("x".repeat(500));
    const start = (await flushed(spool)).find((e) => e.type === "agent_start" && e.agent_id === "fake-agent")!;
    expect(String(start.goal).length).toBeLessThan(100);
  });

  it("leaves a hand-wrapped tool working on its own", async () => {
    await adapter.install({});
    adapter.uninstall();
    const tool = wrapTool({ id: "solo", execute: async () => "ok" });
    await expect(tool.execute()).resolves.toBe("ok");
    expect(types(await flushed(spool))).toEqual(["agent_start", "tool_use", "tool_result", "agent_end"]);
  });
});

describe("bookkeeping", () => {
  const empty = { models: 0, tools: 0, steps: 0, workflowRuns: 0, agents: 0 };

  it("forgets every model and tool call once the run ends — success, model failure, tool failure", async () => {
    await adapter.install({});
    await new FakeAgent().generate("Paris");
    expect(_internals.openSpans()).toEqual(empty);

    const failing = new FakeAgent();
    failing.model.fail = true;
    await expect(failing.generate("Paris")).rejects.toThrow("model exploded");
    expect(_internals.openSpans()).toEqual(empty);

    const broken = new FakeAgent();
    broken.toolFails = true;
    await broken.generate("Paris");
    expect(_internals.openSpans()).toEqual(empty);
  });

  it("forgets a streamed step whether it is consumed or cancelled", async () => {
    await adapter.install({});
    const consumed = await new FakeAgent().stream("Paris", {});
    await readAll(consumed.reader);
    consumed.finish();
    expect(_internals.openSpans()).toEqual(empty);

    const agent = new FakeAgent();
    const cancelled = await agent.stream("Paris", {});
    await cancelled.abort();
    expect(_internals.openSpans()).toEqual(empty);
    const events = await flushed(spool);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", outcome: "cancelled" });
  });

  it("holds a never-consumed stream open only until uninstrument(), which closes it", async () => {
    await adapter.install({});
    await new FakeAgent().stream("Paris", {});
    expect(_internals.openSpans()).toEqual({ ...empty, models: 1, agents: 1 });
    adapter.uninstall();
    expect(_internals.openSpans()).toEqual(empty);
    const events = await flushed(spool);
    expect(types(events)).toEqual(["agent_start", "model_request", "model_response", "agent_end"]);
    expect(events[3]!.outcome).toBe("cancelled");
  });

  it("forgets a workflow run and its steps however the run ends", async () => {
    await adapter.install({});
    await new FakeRun("r1", ["a", "b"])._start();
    expect(_internals.openSpans()).toEqual(empty);
    await new FakeRun("r2", ["a", "fail"])._start();
    expect(_internals.openSpans()).toEqual(empty);
    await expect(new FakeRun("r3", ["explode"])._start()).rejects.toThrow("step threw");
    expect(_internals.openSpans()).toEqual(empty);

    const events = await flushed(spool);
    expect(events.filter((e) => e.type === "agent_end").map((e) => e.outcome)).toEqual(["success", "failed", "failed"]);
  });
});
