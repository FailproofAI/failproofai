import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogger } from "../src/logger.js";
import * as core from "../src/integrations/core.js";
import { _internals, adapter } from "../src/integrations/mastra.js";
import { agent as agentScope, session } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The Mastra surfaces beyond a bare `generate()` / `stream()` — memory
 * threads, agent networks, processor tripwires, workflow suspend/resume —
 * against hand-written stand-ins for `@mastra/core` shaped like the real
 * call sequences (the module loader is the only thing mocked).
 * `integration/mastra.test.ts` proves each against real 0.x and 1.x releases.
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

const {
  conversationOf,
  isRoutingAgent,
  suspendedStepsOf,
  resumeTargetOf,
  humanText,
} = _internals;

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

class FakeModel {
  modelId = "fake-model";
  constructor(private usage: [number, number] = [3, 4]) {}
  async doGenerate(): Promise<unknown> {
    return {
      content: [{ type: "text", text: "sunny" }],
      finishReason: "stop",
      usage: { inputTokens: this.usage[0], outputTokens: this.usage[1] },
    };
  }
}

interface StreamOptions {
  onFinish?: (result: unknown) => unknown;
  onError?: (error: unknown) => unknown;
  onAbort?: (event: unknown) => unknown;
}

/**
 * A stream's output the way Mastra's is: consuming it calls `onFinish` unless
 * a processor blocked it, and then finishes — which only `_waitUntilFinished()`
 * reports.
 */
class FakeOutput {
  tripwire: unknown = undefined;
  private finished: () => void = () => undefined;
  private readonly done = new Promise<void>((resolve) => (this.finished = resolve));
  constructor(private readonly options: StreamOptions = {}) {}
  _waitUntilFinished(): Promise<void> {
    return this.done;
  }
  consume(): void {
    if (!this.tripwire) this.options.onFinish?.({ finishReason: "stop" });
    this.finished();
  }
}

class FakeAgent {
  model: FakeModel;
  /** What `__runInputProcessors` reports, in the 0.x or 1.x shape. */
  guard: Record<string, unknown> = {};
  /** Runs inside the agent's own call, before its model step. */
  inside: (() => Promise<unknown>) | null = null;
  /** What each generate() / network() call was handed. */
  calls: unknown[][] = [];
  constructor(
    public name: string,
    public id: string = name,
    usage?: [number, number],
  ) {
    this.model = new FakeModel(usage);
  }

  resolveModelConfig(): FakeModel {
    return this.model;
  }

  convertTools(): Record<string, unknown> {
    return {};
  }

  __runInputProcessors(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.guard);
  }

  async generate(prompt: string, options?: unknown): Promise<unknown> {
    this.calls.push([prompt, options]);
    await this.inside?.();
    const model = await this.resolveModelConfig();
    await model.doGenerate();
    return { text: "sunny", finishReason: "stop" };
  }

  /** A stream whose input processors ran first; a blocked one never calls the model. */
  async stream(_prompt: string, options: StreamOptions = {}): Promise<FakeOutput> {
    const guard = await this.__runInputProcessors();
    const output = new FakeOutput(options);
    if (guard.tripwire || guard.tripwireTriggered) {
      output.tripwire = guard.tripwire ?? true;
      return output;
    }
    const model = await this.resolveModelConfig();
    await model.doGenerate();
    return output;
  }

  /**
   * `agent.network()` as Mastra runs it: a fresh `routing-agent` on this
   * agent's model decides, a sub-agent runs, the router judges it complete,
   * and the stream settles its `status` by itself.
   */
  async network(prompt: string, options?: unknown): Promise<{ status: Promise<string> }> {
    this.calls.push([prompt, options]);
    const route = (): FakeAgent => {
      const router = new FakeAgent("Routing Agent", "routing-agent");
      router.model = this.model;
      return router;
    };
    let settle!: (status: string) => void;
    let fail!: (error: unknown) => void;
    const status = new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void (async () => {
      await route().generate("route");
      if (this.name === "broken") {
        fail(new Error("network exploded"));
        return;
      }
      await new FakeAgent("helper", "helper", [11, 7]).generate("weather");
      await route().generate("complete?");
      settle("success");
    })();
    return { status };
  }
}

class FakeEngine {
  static inner: ((runId: string) => Promise<void>) | null = null;
  async executeStep(params: { step: { id: string }; executionContext: { runId: string } }): Promise<unknown> {
    if (params.step.id === "agent" && FakeEngine.inner) await FakeEngine.inner(params.executionContext.runId);
    return { result: { status: params.step.id === "approve-wait" ? "suspended" : "success", output: { ok: true } } };
  }
}

/** A workflow run whose `_start` / `_resume` resolve with the given results. */
class FakeRun {
  workflowId = "approval-flow";
  resumedWith: unknown[] = [];
  constructor(
    public runId: string,
    private results: unknown[],
    private startSteps: string[] = ["city", "approve-wait"],
  ) {}

  private async next(steps: string[]): Promise<unknown> {
    const engine = new FakeEngine();
    for (const id of steps) await engine.executeStep({ step: { id }, executionContext: { runId: this.runId } });
    return this.results.shift();
  }

  _start(): Promise<unknown> {
    return this.next(this.startSteps);
  }

  _resume(params: unknown): Promise<unknown> {
    this.resumedWith.push(params);
    return this.next(["approve", "done"]);
  }
}

const suspended = (...ids: string[]): Record<string, unknown> => ({
  status: "suspended",
  suspended: ids.map((id) => [id]),
  steps: Object.fromEntries(ids.map((id) => [id, { status: "suspended", suspendPayload: { prompt: `Approve ${id}?` } }])),
});

// ---------------------------------------------------------------------------

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
  FakeEngine.inner = null;
  modules.agent = [{ Agent: FakeAgent }];
  modules.workflows = [{ Run: FakeRun, DefaultExecutionEngine: FakeEngine }];
});
afterEach(async () => {
  adapter.uninstall();
  await spool.cleanup();
  setLogger(null);
});

const shape = (events: Array<Record<string, unknown>>): string[] =>
  events.map((e) => `${String(e.agent_id)} ${String(e.type)}`);

describe("readers", () => {
  it("reads a memory thread and resource in both majors' shapes", () => {
    expect(conversationOf({ memory: { thread: "t-1", resource: "u-1" } })).toEqual({ thread: "t-1", resource: "u-1" });
    expect(conversationOf({ memory: { thread: { id: "t-2", title: "x" }, resource: "u-1" } })).toEqual({
      thread: "t-2",
      resource: "u-1",
    });
    // 0.x's deprecated top-level options.
    expect(conversationOf({ threadId: "t-3", resourceId: "u-3" })).toEqual({ thread: "t-3", resource: "u-3" });
    expect(conversationOf({ memory: { thread: "" } })).toEqual({ thread: undefined, resource: undefined });
    expect(conversationOf(undefined)).toEqual({ thread: undefined, resource: undefined });
  });

  it("recognises a network's router by its id or name, and nothing else", () => {
    expect(isRoutingAgent({ id: "routing-agent", name: "Routing Agent" })).toBe(true);
    expect(isRoutingAgent({ name: "routing-agent" })).toBe(true);
    expect(isRoutingAgent({ id: "router", name: "Router" })).toBe(false);
  });

  it("reads which steps a suspended result waits on, and what each asked", () => {
    expect(suspendedStepsOf(suspended("approve"))).toEqual([{ path: "approve", payload: { prompt: "Approve approve?" } }]);
    // A step inside a nested workflow: the path, with the outer step's payload.
    expect(
      suspendedStepsOf({ suspended: [["inner", "approve"]], suspendPayload: { inner: { prompt: "nested?" } } }),
    ).toEqual([{ path: "inner.approve", payload: { prompt: "nested?" } }]);
    // No `suspended` list: the steps' own status.
    expect(suspendedStepsOf({ steps: { a: { status: "success" }, b: { status: "suspended", suspendPayload: 1 } } })).toEqual([
      { path: "b", payload: 1 },
    ]);
    expect(suspendedStepsOf(undefined)).toEqual([]);
  });

  it("reads the step a resume names, in every form Mastra accepts", () => {
    expect(resumeTargetOf({ step: "approve", resumeData: { ok: true } })).toEqual({ path: "approve", answer: { ok: true } });
    expect(resumeTargetOf({ step: { id: "approve" } }).path).toBe("approve");
    expect(resumeTargetOf({ step: ["inner", { id: "approve" }] }).path).toBe("inner.approve");
    expect(resumeTargetOf({ resumeData: 1 })).toEqual({ path: undefined, answer: 1 });
  });

  it("renders what a human read or wrote as text", () => {
    expect(humanText("yes")).toBe("yes");
    expect(humanText({ prompt: "Approve?", extra: 1 })).toBe("Approve?");
    expect(humanText({ approved: true })).toBe('{"approved":true}');
    expect(humanText(undefined)).toBeUndefined();
  });
});

describe("memory threads", () => {
  it("makes a root run's memory thread its session", async () => {
    await adapter.install({});
    const agent = new FakeAgent("weather-agent");
    await agent.generate("Paris", { memory: { thread: "thread-42", resource: "user-7" } });
    await agent.generate("Rome", { threadId: "thread-42", resourceId: "user-7" });
    const events = await flushed(spool);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["thread-42"]));
    const starts = events.filter((e) => e.type === "agent_start");
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(start).toMatchObject({ fw_thread_id: "thread-42", fw_resource_id: "user-7" });
  });

  it("lets an enclosing scope win over the thread, and nests a threaded sub-run", async () => {
    await adapter.install({});
    await session({ sessionId: "req-1" }, () =>
      new FakeAgent("weather-agent").generate("Paris", { memory: { thread: "thread-42", resource: "u" } }),
    );
    await agentScope("planner", {}, () =>
      new FakeAgent("weather-agent").generate("Paris", { memory: { thread: "thread-43", resource: "u" } }),
    );
    const events = await flushed(spool);
    expect(events.filter((e) => e.session_id === "thread-42" || e.session_id === "thread-43")).toEqual([]);
    const starts = events.filter((e) => e.type === "agent_start" && e.agent_id === "weather-agent");
    expect(starts.map((e) => [e.session_id === "req-1", e.parent_id, e.fw_thread_id])).toEqual([
      [true, undefined, "thread-42"],
      [false, "planner", "thread-43"],
    ]);
  });
});

describe("processor tripwires", () => {
  for (const [label, guard] of [
    ["1.x", { tripwire: { reason: "blocked", processorId: "guard" } }],
    ["0.x", { tripwireTriggered: true, tripwireReason: "blocked" }],
  ] as const) {
    it(`closes a stream an input processor blocks, rejected (${label})`, async () => {
      await adapter.install({});
      const agent = new FakeAgent("weather-agent");
      agent.guard = guard;
      const run = await agent.stream("Paris", {});
      run.consume();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const events = await flushed(spool);
      expect(shape(events)).toEqual(["weather-agent agent_start", "weather-agent agent_end"]);
      expect(events[1]!.outcome).toBe("rejected");
      expect(_internals.openSpans().agents).toBe(0);
    });
  }

  it("closes a blocked stream from its finish when nothing reports the block earlier", async () => {
    await adapter.install({});
    const agent = new FakeAgent("weather-agent");
    const run = await agent.stream("Paris", {});
    // Blocked later, on the output stream: no callback, only the finish.
    run.tripwire = { reason: "answer blocked" };
    run.consume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await flushed(spool);
    expect(events.filter((e) => e.type === "agent_end").map((e) => e.outcome)).toEqual(["rejected"]);
  });

  it("closes an unblocked stream once, from its callback", async () => {
    await adapter.install({});
    const run = await new FakeAgent("weather-agent").stream("Paris", {});
    run.consume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await flushed(spool);
    expect(events.filter((e) => e.type === "agent_end").map((e) => e.outcome)).toEqual(["success"]);
  });
});

describe("agent networks", () => {
  it("records a network as one agent whose router steps are its own", async () => {
    await adapter.install({});
    const planner = new FakeAgent("planner", "planner", [50, 10]);
    const stream = await planner.network("Weather?", { memory: { thread: "thread-net", resource: "u" } });
    await stream.status;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "planner agent_start",
      "planner model_request",
      "planner model_response",
      "helper agent_start",
      "helper model_request",
      "helper model_response",
      "helper agent_end",
      "planner model_request",
      "planner model_response",
      "planner agent_end",
    ]);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["thread-net"]));
    expect(events[0]).toMatchObject({ fw_method: "network" });
    expect(events[3]).toMatchObject({ parent_id: "planner" });
    expect(events.at(-1)).toMatchObject({ outcome: "success" });
    expect(_internals.openSpans().agents).toBe(0);
  });

  it("closes a network whose stream fails, failed", async () => {
    await adapter.install({});
    const stream = await new FakeAgent("broken").network("Weather?");
    await expect(stream.status).rejects.toThrow("network exploded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await flushed(spool);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", agent_id: "broken", outcome: "failed" });
  });

  it("records a routing-agent called outside any network as an agent like any other", async () => {
    await adapter.install({});
    await new FakeAgent("Routing Agent", "routing-agent").generate("hi");
    const events = await flushed(spool);
    expect(shape(events)).toEqual([
      "Routing Agent agent_start",
      "Routing Agent model_request",
      "Routing Agent model_response",
      "Routing Agent agent_end",
    ]);
  });
});

describe("workflow suspend / resume", () => {
  it("pauses on suspend and continues the same span on resume", async () => {
    await adapter.install({});
    const run = new FakeRun("run-1", [suspended("approve"), { status: "success" }]);
    await run._start();
    expect(_internals.pausedRuns()).toBe(1);
    await run._resume({ step: "approve", resumeData: { approved: true } });
    expect(_internals.pausedRuns()).toBe(0);

    const events = await flushed(spool);
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "hook_triggered",
      "hook_completed",
      "hook_triggered",
      "hook_completed",
      "human_wait",
      "agent_pause",
      "agent_resume",
      "human_input",
      "hook_triggered",
      "hook_completed",
      "hook_triggered",
      "hook_completed",
      "agent_end",
    ]);
    // A root run's session is its run id: what its resume is sure to share.
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["run-1"]));
    const wait = events.find((e) => e.type === "human_wait")!;
    expect(wait).toMatchObject({ input_id: "run-1:approve", prompt: "Approve approve?", reason: "mastra_suspend" });
    expect(events.find((e) => e.type === "agent_pause")).toMatchObject({ pause_id: "run-1:approve" });
    expect(events.find((e) => e.type === "agent_resume")).toMatchObject({ pause_id: "run-1:approve" });
    expect(events.find((e) => e.type === "human_input")).toMatchObject({
      input_id: "run-1:approve",
      response: '{"approved":true}',
    });
    expect(events.at(-1)).toMatchObject({ type: "agent_end", outcome: "success" });
    expect(_internals.openSpans().agents).toBe(0);
  });

  it("pauses again only for steps newly suspended, and resumes only the step named", async () => {
    await adapter.install({});
    const run = new FakeRun("run-2", [suspended("a", "b"), suspended("b"), { status: "success" }]);
    await run._start();
    await run._resume({ step: "a", resumeData: "yes" });
    await run._resume({ step: "b", resumeData: "no" });
    const events = await flushed(spool);
    const pick = (type: string): unknown[] => events.filter((e) => e.type === type).map((e) => e.input_id ?? e.pause_id);
    expect(pick("human_wait")).toEqual(["run-2:a", "run-2:b"]);
    expect(pick("agent_resume")).toEqual(["run-2:a", "run-2:b"]);
    expect(events.filter((e) => e.type === "human_input").map((e) => e.response)).toEqual(["yes", "no"]);
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
  });

  it("closes a pause opened by another process under the same ids", async () => {
    await adapter.install({});
    await new FakeRun("run-3", [suspended("approve")])._start();
    // This process forgets it — as a different worker would never have seen it.
    adapter.uninstall();
    await adapter.install({});
    await new FakeRun("run-3", [{ status: "success" }])._resume({ step: "approve", resumeData: { approved: true } });

    const events = await flushed(spool);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["run-3"]));
    const resumed = events.slice(events.findIndex((e) => e.fw_method === "resume"));
    expect(resumed.map((e) => e.type)).toEqual([
      "agent_start",
      "agent_resume",
      "human_input",
      "hook_triggered",
      "hook_completed",
      "hook_triggered",
      "hook_completed",
      "agent_end",
    ]);
    expect(resumed[1]).toMatchObject({ pause_id: "run-3:approve", fw_resumed_elsewhere: true });
    expect(resumed[2]).toMatchObject({ input_id: "run-3:approve", fw_resumed_elsewhere: true });
  });

  it("keeps a nested run's session: the run id is only a ROOT run's session", async () => {
    await adapter.install({});
    await session({ sessionId: "req-1" }, () => new FakeRun("run-4", [{ status: "success" }])._start());
    const events = await flushed(spool);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["req-1"]));
  });
});

describe("workflow steps", () => {
  it("records only the run's own steps, not those of an agent run handed its id", async () => {
    await adapter.install({});
    // An agent inside a step executes its loop as internal workflows whose
    // steps carry the SAME run id when the agent is handed it — as 0.x's
    // network does with its sub-agents. Those run in the agent's frame.
    FakeEngine.inner = async (runId: string) => {
      const helper = new FakeAgent("helper");
      helper.inside = () => new FakeEngine().executeStep({ step: { id: "llm-execution" }, executionContext: { runId } });
      await helper.generate("weather");
      await new FakeEngine().executeStep({ step: { id: "after-agent" }, executionContext: { runId } });
    };
    await new FakeRun("run-5", [{ status: "success" }], ["city", "agent"])._start();
    const events = await flushed(spool);
    expect(events.filter((e) => e.type === "hook_triggered").map((e) => e.hook_name)).toEqual([
      "city",
      "agent",
      "after-agent",
    ]);
    expect(events.filter((e) => e.agent_id === "helper").map((e) => e.type)).toEqual([
      "agent_start",
      "model_request",
      "model_response",
      "agent_end",
    ]);
  });
});
