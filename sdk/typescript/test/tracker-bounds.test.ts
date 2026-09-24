import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runExitClosers } from "../src/exit.js";
import * as core from "../src/integrations/core.js";
import { runtime } from "../src/runtime.js";
import { PAUSED_SESSION_TTL_MS, _stats, adapter, langchainHandler } from "../src/integrations/langchain.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * What a LONG-RUNNING process keeps in memory, and what that does to events.
 *
 * Every other adapter test runs a handful of runs and looks at the trace. These
 * run tens of thousands, because the failures here only exist at volume: a
 * table that is never pruned on normal completion fills to its cap, and a
 * FIFO cap then evicts the entries of runs that are still LIVE — a model call
 * that has been running for ten seconds on a busy server loses its
 * `model_response`, with one warning, while every test with three runs in it
 * passes.
 */

type Handler = Record<string, (...args: unknown[]) => unknown>;

let spool: Spool;
let h: Handler;

beforeEach(() => {
  spool = useSpool();
  core.resetFailures();
  h = langchainHandler() as Handler;
});
afterEach(async () => {
  vi.useRealTimers();
  adapter.uninstall();
  await spool.cleanup();
});

const start = (id: string, parent: string | undefined, name: string, meta: Record<string, unknown> = {}, tags: string[] = []) =>
  h.handleChainStart!({ name }, {}, id, parent, tags, meta, undefined, name);
const end = (id: string) => h.handleChainEnd!({}, id);

/** One ordinary request: a graph root and one node, both completed. */
async function request(i: number): Promise<void> {
  await start(`r${i}`, undefined, "g", { failproofai_sdk_session_id: `S${i}` });
  await start(`c${i}`, `r${i}`, "n", { langgraph_node: "n", langgraph_checkpoint_ns: `n:${i}` }, ["graph:step:1"]);
  await end(`c${i}`);
  await end(`r${i}`);
}

describe("RunTracker", () => {
  it("forgets a link once the run it belongs to has closed", () => {
    const tracker = new core.RunTracker("t");
    tracker.startAgent("root", { agentId: "a", sessionId: "s" });
    tracker.emit("toolUse", "tool", { parentKey: "root", toolName: "x", toolCallId: "1" });
    expect(tracker.stats().links).toBe(1);
    tracker.emit("toolResult", "tool", { toolName: "x", toolCallId: "1" });
    expect(tracker.stats().links).toBe(0);
    tracker.endAgent("root");
    expect(tracker.stats()).toEqual({ runs: 0, links: 0 });
  });

  it("answers isOpen without copying every open agent", () => {
    const tracker = new core.RunTracker("t");
    tracker.startAgent("root", { agentId: "a", sessionId: "s" });
    expect(tracker.isOpen("root")).toBe(true);
    expect(tracker.isOpen("other")).toBe(false);
    tracker.forget("root");
    expect(tracker.isOpen("root")).toBe(false);
  });

  it("closes open agents at exit, but leaves one paused on a human for its resumer", async () => {
    // A LangGraph interrupt or a suspended Mastra workflow is resumed by
    // whichever process takes the answer; ending it here would end a run that
    // is not over. Everything else a dying process holds is abandoned.
    const tracker = new core.RunTracker("t");
    tracker.startAgent("busy", { agentId: "busy", sessionId: "s1" });
    tracker.startAgent("waiting", { agentId: "waiting", sessionId: "s2" });
    tracker.emit("agentPause", "waiting", { pauseId: "p1" });
    tracker.startAgent("resumed", { agentId: "resumed", sessionId: "s3" });
    tracker.emit("agentPause", "resumed", { pauseId: "p2" });
    tracker.emit("agentResume", "resumed", { pauseId: "p2" });
    tracker.closeAtExit();
    const ends = (await flushed(spool)).filter((e) => e.type === "agent_end");
    expect(ends.map((e) => [e.agent_id, e.outcome])).toEqual([
      ["resumed", "failed"],
      ["busy", "failed"],
    ]);
    expect(tracker.isOpen("waiting")).toBe(true);
  });

  it("closes an adapter's open tool, hook and model call at exit, then its agent with an error", async () => {
    // Live on LangGraph, Mastra, LlamaIndex and the AI SDK: SIGTERM mid-tool
    // closed the agent and left the tool_use, the node's hook_triggered and
    // the model_request open — spans the dashboard shows as running forever.
    const tracker = new core.RunTracker("t");
    tracker.startAgent("root", { agentId: "svc", sessionId: "exit-s" });
    tracker.emit("hookTriggered", "node", { parentKey: "root", hookName: "tools", hookId: "h1" });
    tracker.emit("modelRequest", "llm", { parentKey: "root", requestId: "r1", model: "m" });
    tracker.emit("toolUse", "tool", { parentKey: "node", toolName: "slow", toolCallId: "c1" });
    tracker.emit("toolUse", "done", { parentKey: "node", toolName: "fast", toolCallId: "c0" });
    tracker.emit("toolResult", "done", { toolName: "fast", toolCallId: "c0" });
    runExitClosers(143); // both phases, as the writer's exit hook runs them
    // This session only: the exit closes whatever else this test process left open too.
    const events = (await flushed(spool)).filter((e) => e.session_id === "exit-s").slice(6); // start, hook, model, two tool_use, one tool_result
    expect(events.map((e) => [e.type, e.tool_call_id ?? e.hook_id ?? e.request_id ?? null])).toEqual([
      ["tool_result", "c1"],
      ["model_response", "r1"],
      ["hook_completed", "h1"],
      ["error", null],
      ["agent_end", null],
    ]);
    expect(events[0]!.error).toMatch(/^ProcessExit: the process exited \(code 143\)/);
    expect(events[1]!.stop_reason).toBe("error");
    expect(events[2]!.outcome).toBe("failed");
    expect(events[3]!.error_type).toBe("ProcessExit");
    expect(events[4]!.outcome).toBe("failed");
  });
});

describe("langchain under load", () => {
  it("keeps a long-running model call attributable while thousands of runs complete", async () => {
    await start("rootA", undefined, "graph", { failproofai_sdk_session_id: "A" });
    await start("nodeA", "rootA", "agent", { langgraph_node: "agent", langgraph_checkpoint_ns: "agent:1" }, ["graph:step:1"]);
    await h.handleChatModelStart!({ name: "ChatX" }, [[]], "modelA", "nodeA", {}, [], { langgraph_node: "agent" }, "ChatX");

    for (let i = 0; i < 12_000; i++) {
      await request(i);
      // A real server yields to the writer's flush timer constantly; this tight
      // loop never does, and would otherwise hit the writer's OWN queue cap.
      if (i % 1_000 === 0) await runtime.writer.flushNow();
    }

    await h.handleLLMEnd!(
      { generations: [[{ text: "hi", message: { content: "hi", usage_metadata: { input_tokens: 3, output_tokens: 1 } } }]] },
      "modelA",
    );
    await end("nodeA");
    await end("rootA");

    const types = (await flushed(spool)).filter((e) => e.session_id === "A").map((e) => e.type);
    expect(types).toEqual([
      "agent_start",
      "hook_triggered",
      "model_request",
      "model_response",
      "hook_completed",
      "agent_end",
    ]);
  });

  it("holds nothing for a request once it has completed", async () => {
    for (let i = 0; i < 5_000; i++) await request(i);
    expect(_stats()).toEqual({ runs: 0, sessions: 0, tracker: { runs: 0, links: 0 } });
  });

  // A resume arriving here after the TTL takes the cross-worker path, which the
  // integration suite proves with two real processes (`remote-resume`).
  it("forgets a paused run after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const interrupt = (id: string) =>
      Object.assign(new Error("interrupt"), { name: "GraphInterrupt", is_bubble_up: true, interrupts: [{ id, value: "approve?" }] });

    // Paused here, resumed (if ever) by another worker — the ordinary shape.
    for (let i = 0; i < 50; i++) {
      await start(`p${i}`, undefined, "g", { thread_id: `t${i}` });
      await start(`pn${i}`, `p${i}`, "ask", { langgraph_node: "ask", langgraph_checkpoint_ns: `ask:${i}` }, ["graph:step:1"]);
      await h.handleChainError!(interrupt(`i${i}`), `pn${i}`);
      await h.handleChainError!(interrupt(`i${i}`), `p${i}`);
    }
    expect(_stats().tracker.runs).toBe(50);

    vi.setSystemTime(Date.now() + PAUSED_SESSION_TTL_MS + 1);
    await request(0);
    expect(_stats()).toEqual({ runs: 0, sessions: 0, tracker: { runs: 0, links: 0 } });
  });

  it("never lets paused runs crowd live ones out of the tracker", async () => {
    const interrupt = (id: string) =>
      Object.assign(new Error("interrupt"), { name: "GraphInterrupt", is_bubble_up: true, interrupts: [{ id, value: "approve?" }] });
    for (let i = 0; i < 3_000; i++) {
      await start(`p${i}`, undefined, "g", { thread_id: `t${i}` });
      await start(`pn${i}`, `p${i}`, "ask", { langgraph_node: "ask", langgraph_checkpoint_ns: `ask:${i}` }, ["graph:step:1"]);
      await h.handleChainError!(interrupt(`i${i}`), `pn${i}`);
      await h.handleChainError!(interrupt(`i${i}`), `p${i}`);
    }
    // Bounded by the session cap, not by the tracker's — the tracker's room is
    // for runs that are still executing.
    expect(_stats().tracker.runs).toBeLessThanOrEqual(1_000);
    expect(_stats().sessions).toBeLessThanOrEqual(1_000);
  });
});
