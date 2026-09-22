import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agent, session } from "../src/scopes.js";
import { setLogger } from "../src/logger.js";
import * as core from "../src/integrations/core.js";
import { parseVersion } from "../src/integrations/compat.js";
import { activeFrameworks, available, instrument, uninstrument } from "../src/integrations/index.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
  core.setStrict(false);
  core.resetFailures();
});
afterEach(async () => {
  uninstrument();
  await spool.cleanup();
  core.setStrict(null);
  setLogger(null);
});

describe("failure policy", () => {
  it("swallows a throwing hook and degrades the call site after repeated failures", () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const boom = (): never => {
      throw new Error("hook is broken");
    };
    const wrapped = core.safe("test", boom);
    for (let i = 0; i < 3; i += 1) expect(() => wrapped()).not.toThrow();
    // A broken adapter costs one log line, not 40% of the process.
    expect(core.isDegraded("test.boom")).toBe(true);
  });

  it("catches a REJECTED PROMISE, not just a synchronous throw", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // Half of every framework's callback surface is async. A bare try/catch
    // sees nothing when the body rejects; the rejection lands as an unhandled
    // rejection, which Node terminates the process for.
    const wrapped = core.safe("test", async () => {
      throw new Error("async hook is broken");
    });
    await expect(wrapped()).resolves.toBeUndefined();
  });

  it("re-throws under FAILPROOFAI_SDK_STRICT", () => {
    core.setStrict(true);
    const wrapped = core.safe("test", () => {
      throw new Error("visible");
    });
    expect(() => wrapped()).toThrow("visible");
  });
});

describe("wrapCallable", () => {
  it("returns the original value and re-throws the original error, identity intact", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const failure = new Error("from the framework");
    const throwing = core.wrapCallable(
      () => {
        throw failure;
      },
      {
        before: () => {
          throw new Error("before is broken");
        },
        after: () => {
          throw new Error("after is broken");
        },
        onError: () => {
          throw new Error("onError is broken");
        },
      },
    );
    // Every one of our hooks throws, and the caller still sees exactly theirs.
    expect(() => throwing()).toThrow(failure);

    const resolving = core.wrapCallable(async () => "value", {
      after: () => {
        throw new Error("after is broken");
      },
    });
    await expect(resolving()).resolves.toBe("value");
  });

  it("settles our hooks on the PROMISE, not on the call", async () => {
    const seen: string[] = [];
    const wrapped = core.wrapCallable(async () => "v", {
      after: () => seen.push("after"),
    });
    const pending = wrapped();
    expect(seen).toEqual([]);
    await pending;
    expect(seen).toEqual(["after"]);
  });
});

describe("Patcher", () => {
  it("restores exactly what it replaced", () => {
    const target = { method: (): string => "original" };
    const original = target.method;
    const patcher = new core.Patcher();
    patcher.patch(target, "method", () => "patched");
    expect(target.method()).toBe("patched");
    patcher.restoreAll();
    expect(target.method).toBe(original);
  });

  it("leaves a third party's patch alone rather than deleting it", () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const target = { method: (): string => "original" };
    const patcher = new core.Patcher();
    patcher.patch(target, "method", () => "ours");
    const theirs = (): string => "theirs";
    target.method = theirs;
    patcher.restoreAll();
    // Restoring here would delete their patch. Two instrumentation libraries
    // un-patching each other is how both silently stop recording.
    expect(target.method).toBe(theirs);
  });

  it("reports rather than pretends when a target refuses assignment", () => {
    const frozen = Object.freeze({ method: (): string => "original" });
    const patcher = new core.Patcher();
    expect(patcher.patch(frozen, "method", () => "ours")).toBe(false);
    expect(patcher.size).toBe(0);
  });
});

describe("payload discipline", () => {
  it("truncates a long string and says so", () => {
    const out = core.payload({ fw_prompt: "x".repeat(20_000) });
    expect((out.fw_prompt as string).length).toBeLessThanOrEqual(core.FIELD_LIMIT);
    expect(out.fw_truncated).toBe(true);
  });

  it("keeps the SMALL fields when the budget runs out, not the first ones", () => {
    // The adapters put the big payload before the metadata, so insertion order
    // would drop `fw_run_id` — the field that says which run the payload
    // belongs to — and keep the oversized blob.
    const out = core.payload({
      fw_inputs: "x".repeat(core.EVENT_BUDGET * 2),
      fw_run_id: "run-1",
      fw_node: "retrieve",
    });
    expect(out.fw_run_id).toBe("run-1");
    expect(out.fw_node).toBe("retrieve");
    expect(out.fw_truncated).toBe(true);
  });

  it("caps list and depth growth", () => {
    const deep = core.truncate({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
    expect(JSON.stringify(deep)).not.toContain('"g"');
    const wide = core.truncate(Array.from({ length: 300 }, (_, i) => i)) as unknown[];
    expect(wide.length).toBeLessThanOrEqual(101);
    expect(String(wide.at(-1))).toContain("more items truncated");
  });

  it("renders a class instance as data rather than as a repr string", () => {
    class Weather {
      constructor(
        readonly city: string,
        readonly celsius: number,
      ) {}
    }
    expect(core.truncate(new Weather("Faro", 21))).toEqual({ city: "Faro", celsius: 21 });
  });

  it("does not run a throwing getter into the caller's face", () => {
    const hostile = {
      get boom(): never {
        throw new Error("lazy attribute");
      },
    };
    expect(() => core.truncate(hostile)).not.toThrow();
  });
});

describe("extras namespacing", () => {
  it("prefixes fw_ and drops nullish values", () => {
    expect(core.fwFields({ run_id: "r", node: "n", tags: null, missing: undefined })).toEqual({
      fw_run_id: "r",
      fw_node: "n",
    });
  });

  it("leaves the deliberate top-level names alone", () => {
    expect(core.fwFields({ duration_ms: 12, usage: { a: 1 }, request_id: "r" })).toEqual({
      duration_ms: 12,
      usage: { a: 1 },
      request_id: "r",
    });
  });

  it("refuses an extra that would overwrite a declared field", () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // The schema merges extras LAST, so this would silently change a promoted
    // column and every test would still pass.
    expect(core.guardExtras({ tool_name: "hijacked", fw_ok: 1 })).toEqual({ fw_ok: 1 });
    core.setStrict(true);
    expect(() => core.guardExtras({ outcome: "hijacked" })).toThrow(/would overwrite/);
  });
});

describe("agent id normalization", () => {
  it("replaces a bare id, which would poison a LowCardinality facet", () => {
    expect(core.normalizeAgentId("3f9a1c2b-0000-4000-8000-000000000000")).toBe("main");
    expect(core.normalizeAgentId("a".repeat(32))).toBe("main");
  });

  it("strips a per-run id from a readable prefix rather than discarding the name", () => {
    expect(core.normalizeAgentId("agent-3f9a1c2b-0000-4000-8000-000000000000")).toBe("agent");
    expect(core.normalizeAgentId("crew_" + "a".repeat(32))).toBe("crew");
  });

  it("leaves an ordinary name untouched, separators and all", () => {
    expect(core.normalizeAgentId("node_a_b")).toBe("node_a_b");
    expect(core.normalizeAgentId("agent-v2")).toBe("agent-v2");
    expect(core.normalizeAgentId("step-3")).toBe("step-3");
  });

  it("bounds the length and falls back on nothing", () => {
    expect(core.normalizeAgentId("x".repeat(200)).length).toBe(64);
    expect(core.normalizeAgentId(null)).toBe("main");
    expect(core.normalizeAgentId("   ")).toBe("main");
  });
});

describe("RunTracker", () => {
  it("emits against a framework's own run ids", async () => {
    const tracker = new core.RunTracker("test");
    tracker.startAgent("run-1", { agentId: "planner", sessionId: "s1", goal: "g" });
    tracker.emit("toolUse", "tool-1", {
      parentKey: "run-1",
      toolName: "search",
      toolCallId: "tool-1",
    });
    tracker.endAgent("run-1", { outcome: "success" });

    const events = await flushed(spool);
    expect(events.map((event) => event.type)).toEqual(["agent_start", "tool_use", "agent_end"]);
    expect(events.every((event) => event.session_id === "s1")).toBe(true);
    expect(events[1]!.agent_id).toBe("planner");
  });

  it("walks the parent chain more than one hop", async () => {
    const tracker = new core.RunTracker("test");
    tracker.startAgent("root", { agentId: "planner", sessionId: "s1" });
    // An intermediate framework run is a link, not a span.
    tracker.link("middle", "root");
    tracker.emit("toolUse", "leaf", { parentKey: "middle", toolName: "t", toolCallId: "leaf" });
    const toolUse = (await flushed(spool)).find((event) => event.type === "tool_use")!;
    expect(toolUse.agent_id).toBe("planner");
  });

  it("joins a hand-written scope, producing ONE tree rather than two", async () => {
    const tracker = new core.RunTracker("test");
    await agent("planner", { sessionId: "s1" }, () => {
      tracker.startAgent("run-1", { agentId: "retriever" });
    });
    const starts = (await flushed(spool)).filter((event) => event.type === "agent_start");
    const nested = starts.find((event) => event.agent_id === "retriever")!;
    expect(nested.session_id).toBe("s1");
    expect(nested.parent_id).toBe("planner");
  });

  it("does NOT claim a parent inside a bare session, which would render as a forever-ongoing span", async () => {
    const tracker = new core.RunTracker("test");
    await session({ sessionId: "s1" }, () => {
      tracker.startAgent("run-1", { agentId: "retriever" });
    });
    const start = (await flushed(spool)).find((event) => event.type === "agent_start")!;
    expect(start.parent_id).toBeUndefined();
  });

  it("drops an unresolvable event with ONE warning rather than inventing a session", async () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    const tracker = new core.RunTracker("test");
    tracker.emit("toolUse", "orphan", { toolName: "t", toolCallId: "orphan" });
    tracker.emit("toolUse", "orphan2", { toolName: "t", toolCallId: "orphan2" });
    // A synthesized session id splits one run into many.
    expect(await flushed(spool)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("closes what it opened, so a dead session does not render as ongoing forever", async () => {
    const tracker = new core.RunTracker("test");
    tracker.startAgent("a", { agentId: "one", sessionId: "s1" });
    tracker.startAgent("b", { agentId: "two", sessionId: "s1" });
    tracker.closeOpenAgents();
    const ends = (await flushed(spool)).filter((event) => event.type === "agent_end");
    expect(ends.map((event) => event.agent_id)).toEqual(["two", "one"]);
    expect(ends.every((event) => event.outcome === "cancelled")).toBe(true);
  });

  it("evicts oldest-first rather than growing unboundedly", () => {
    const tracker = new core.RunTracker("test", { maxOpen: 4 });
    for (let i = 0; i < 20; i += 1) {
      tracker.startAgent(`run-${i}`, { agentId: "a", sessionId: "s1" });
    }
    expect(tracker.openAgents().length).toBeLessThanOrEqual(4);
  });

  it("truncates the declared fields as well as the extras, under ONE truncation flag", async () => {
    const tracker = new core.RunTracker("test", { fieldLimit: 64 });
    tracker.startAgent("run-1", { agentId: "a", sessionId: "s1" });
    tracker.emit("toolResult", "t1", {
      parentKey: "run-1",
      toolName: "search",
      toolCallId: "t1",
      output: "y".repeat(500),
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect((result.output as string).length).toBeLessThanOrEqual(64 + "…[truncated]".length);
    // `fw_truncated` has to mean "this event lost data" — `output` is cut on
    // essentially every real tool loop, and it is the field an operator filters
    // on to find where.
    expect(result.fw_truncated).toBe(true);
  });
});

describe("the registry", () => {
  it("lists the frameworks it can instrument", () => {
    expect(available()).toEqual(["ai", "langchain", "llamaindex", "mastra"]);
  });

  it("throws on an unknown name, listing the valid ones", async () => {
    // A typo that silently records nothing is the worst outcome available.
    await expect(instrument("langchian")).rejects.toThrow(/unknown framework/);
  });

  it("accepts the spellings people actually type", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // LangGraph is served by the LangChain adapter; neither is installed here,
    // so the install fails and is skipped — which is itself the contract.
    await expect(instrument("langgraph")).resolves.toEqual([]);
    expect(activeFrameworks()).toEqual([]);
  });

  it("does not throw when a framework is absent — it logs and moves on", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await expect(instrument("mastra")).resolves.toEqual([]);
  });

  it("uninstrumenting an unknown name is a no-op, not a throw", () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(uninstrument("nonsense")).toEqual([]);
  });
});

describe("version parsing", () => {
  it("reads the leading numeric components only", () => {
    expect(parseVersion("1.5.2")).toEqual([1, 5, 2]);
    expect(parseVersion("2.0.0-beta.1")).toEqual([2, 0, 0]);
    expect(parseVersion("0.14.23+build")).toEqual([0, 14, 23]);
    expect(parseVersion("next")).toEqual([]);
  });
});

describe("duration rounding", () => {
  it("returns a whole non-negative integer, because the server drops anything else", () => {
    expect(core.ms(12.7)).toBe(13);
    expect(core.ms(-5)).toBe(0);
    expect(Number.isInteger(core.ms(0.4))).toBe(true);
  });
});
