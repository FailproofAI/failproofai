import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventNamespace } from "../src/events.js";
import { agent, session } from "../src/scopes.js";
import { runtime } from "../src/runtime.js";
import { setLogger } from "../src/logger.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
});

afterEach(async () => {
  await spool.cleanup();
  setLogger(null);
});

const event = (): EventNamespace => runtime.event;

describe("identity resolution", () => {
  it("resolves sessionId and agentId from the enclosing scope", async () => {
    await session({ sessionId: "s1" }, async () => {
      await agent("planner", async () => {
        event().toolUse({ toolName: "t", toolCallId: "c1" });
      });
    });
    const events = await flushed(spool);
    const toolUse = events.find((e) => e.type === "tool_use")!;
    expect(toolUse.session_id).toBe("s1");
    expect(toolUse.agent_id).toBe("planner");
  });

  it("falls back to 'main' for agentId but never invents a sessionId", async () => {
    await session({ sessionId: "s1" }, () => {
      event().toolUse({ toolName: "t", toolCallId: "c1" });
    });
    expect((await flushed(spool))[0]!.agent_id).toBe("main");
  });

  it("throws, naming the fix, when nothing is bound", () => {
    expect(() => event().toolUse({ toolName: "t", toolCallId: "c1" })).toThrow(
      /sessionId is required and nothing is bound/,
    );
  });

  it("refuses an empty sessionId, which the server would accept and silently merge", () => {
    expect(() => event().toolUse({ sessionId: "  ", toolName: "t", toolCallId: "c" })).toThrow(
      /must not be empty/,
    );
  });

  it("refuses a non-string sessionId, which the server skips at 200 OK", () => {
    expect(() =>
      event().toolUse({ sessionId: 42 as unknown as string, toolName: "t", toolCallId: "c" }),
    ).toThrow(TypeError);
  });
});

describe("reserved and promoted fields", () => {
  it("refuses a reserved name as a custom field", () => {
    expect(() =>
      event().toolUse({ sessionId: "s", toolName: "t", toolCallId: "c", type: "nope" }),
    ).toThrow(/Reserved field names/);
  });

  it("reports the reserved-field fault before the identity fault", () => {
    // Both are true here. The reserved name reads identically from anywhere, so
    // it is the more useful of the two to hear.
    expect(() => event().toolUse({ toolName: "t", toolCallId: "c", timestamp: "x" })).toThrow(
      /Reserved field names/,
    );
  });

  it("drops a nullish promoted extra with a warning rather than NULLing the column", async () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    event().agentStart({ sessionId: "s", model: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("model was passed as null"));
    const [emitted] = await flushed(spool);
    expect("model" in emitted!).toBe(false);
  });

  it("refuses a non-integer token count, which the server stores as NULL", () => {
    expect(() => event().modelResponse({ sessionId: "s", inputTokens: 1.5 })).toThrow(TypeError);
    expect(() => event().modelResponse({ sessionId: "s", outputTokens: -1 })).toThrow(RangeError);
    expect(() => event().modelResponse({ sessionId: "s", inputTokens: 2 ** 32 })).toThrow(RangeError);
  });

  it("refuses a non-string promoted extra", () => {
    expect(() =>
      event().agentStart({ sessionId: "s", tool_name: 7 as unknown as string }),
    ).toThrow(TypeError);
  });
});

describe("duration pairing", () => {
  it("computes duration_ms from the matching start event", async () => {
    event().toolUse({ sessionId: "s", toolName: "t", toolCallId: "c1" });
    await new Promise((resolve) => setTimeout(resolve, 12));
    event().toolResult({ sessionId: "s", toolName: "t", toolCallId: "c1" });
    const result = (await flushed(spool)).find((e) => e.type === "tool_result")!;
    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms as number).toBeGreaterThanOrEqual(10);
  });

  it("refuses a caller-supplied duration_ms on every paired event", () => {
    const cases: Array<() => void> = [
      () => event().toolResult({ sessionId: "s", toolName: "t", toolCallId: "c", duration_ms: 1 }),
      () => event().agentResume({ sessionId: "s", pauseId: "p", duration_ms: 1 }),
      () => event().hookCompleted({ sessionId: "s", hookName: "h", hookId: "h", duration_ms: 1 }),
      () => event().humanInput({ sessionId: "s", inputId: "i", duration_ms: 1 }),
    ];
    for (const run of cases) expect(run).toThrow(/auto-computed/);
  });

  it("keys the pair by kind AND session, so a shared step id cannot cross-pair", async () => {
    // A tool call and a hook sharing an id is not exotic — both are frequently
    // the harness's own step id.
    event().toolUse({ sessionId: "s", toolName: "t", toolCallId: "step-1" });
    event().hookCompleted({ sessionId: "s", hookName: "h", hookId: "step-1" });
    event().toolResult({ sessionId: "s", toolName: "t", toolCallId: "step-1" });

    const events = await flushed(spool);
    const hook = events.find((e) => e.type === "hook_completed")!;
    const tool = events.find((e) => e.type === "tool_result")!;
    // The hook never opened, so it has no duration; the tool's survived.
    expect("duration_ms" in hook).toBe(false);
    expect(typeof tool.duration_ms).toBe("number");
  });

  it("does not key the pair by agent, so a tool opened and closed under different agents still pairs", async () => {
    event().toolUse({ sessionId: "s", agentId: "planner", toolName: "t", toolCallId: "c1" });
    event().toolResult({ sessionId: "s", agentId: "worker", toolName: "t", toolCallId: "c1" });
    const result = (await flushed(spool)).find((e) => e.type === "tool_result")!;
    expect(typeof result.duration_ms).toBe("number");
  });

  it("separates identical step ids in different sessions", async () => {
    event().toolUse({ sessionId: "a", toolName: "t", toolCallId: "step" });
    event().toolUse({ sessionId: "b", toolName: "t", toolCallId: "step" });
    event().toolResult({ sessionId: "a", toolName: "t", toolCallId: "step" });
    const result = (await flushed(spool)).find((e) => e.type === "tool_result")!;
    expect(result.session_id).toBe("a");
    expect(typeof result.duration_ms).toBe("number");
  });
});

describe("timestamps", () => {
  it("formats with six fractional digits, matching the Python SDK and the ingest parser", async () => {
    event().agentStart({ sessionId: "s" });
    const [emitted] = await flushed(spool);
    expect(emitted!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("orders a burst inside one millisecond: every timestamp strictly after the last", async () => {
    // A fast agent emits model_response, tool_use, tool_result and the next
    // model_request inside one millisecond. With the last three digits always
    // 000 they all carried the same timestamp, and the dashboard — which sorts
    // on it — showed tool_result before its tool_use.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T15:55:44.134Z"));
      event().toolUse({ sessionId: "s", toolName: "t", toolCallId: "c1" });
      event().toolResult({ sessionId: "s", toolName: "t", toolCallId: "c1" });
      event().modelRequest({ sessionId: "s" });
      event().agentEnd({ sessionId: "s" });
    } finally {
      vi.useRealTimers();
    }
    const stamps = (await flushed(spool)).map((e) => e.timestamp as string);
    expect(stamps).toHaveLength(4);
    for (const stamp of stamps) expect(stamp.startsWith("2026-09-23T15:55:44.134")).toBe(true);
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(4);
  });

  it("re-anchors to the wall clock when it steps back, rather than freezing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T16:00:00.000Z"));
      event().agentStart({ sessionId: "s" });
      vi.setSystemTime(new Date("2026-09-23T15:00:00.000Z")); // NTP stepped back an hour
      event().agentEnd({ sessionId: "s" });
    } finally {
      vi.useRealTimers();
    }
    const [, end] = await flushed(spool);
    expect((end!.timestamp as string).startsWith("2026-09-23T15:00:00.000")).toBe(true);
  });
});
