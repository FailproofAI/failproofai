import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { current, propagate } from "../src/context.js";
import { agent, session, toolCall } from "../src/scopes.js";
import { flushed, useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

let spool: Spool;

beforeEach(() => {
  spool = useSpool();
});
afterEach(async () => {
  await spool.cleanup();
});

const typesOf = (events: Array<Record<string, unknown>>): string[] =>
  events.map((event) => String(event.type));

describe("session", () => {
  it("binds identity and emits nothing on its own", async () => {
    const id = await session(async (sessionId) => {
      expect(current().sessionId).toBe(sessionId);
      return sessionId;
    });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await flushed(spool)).toEqual([]);
  });

  it("inherits an already-bound session rather than splitting the run in two", async () => {
    await session({ sessionId: "outer" }, async () => {
      await session(async (inner) => {
        expect(inner).toBe("outer");
      });
    });
  });

  it("unbinds on the way out", async () => {
    await session({ sessionId: "s" }, () => undefined);
    expect(current().sessionId).toBeNull();
  });
});

describe("agent", () => {
  it("brackets the block with agent_start and agent_end", async () => {
    await agent("planner", { goal: "g" }, () => undefined);
    const events = await flushed(spool);
    expect(typesOf(events)).toEqual(["agent_start", "agent_end"]);
    expect(events[0]!.goal).toBe("g");
    expect(events[1]!.outcome).toBe("success");
  });

  it("emits error BEFORE agent_end, and marks the outcome 'failed' not 'failure'", async () => {
    await expect(
      agent("planner", async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow("boom");

    const events = await flushed(spool);
    expect(typesOf(events)).toEqual(["agent_start", "error", "agent_end"]);
    expect(events[1]!.error_type).toBe("TypeError");
    expect(events[1]!.message).toBe("boom");
    expect(typeof events[1]!.traceback).toBe("string");
    // The server only counts error|failed|timeout|rejected as a failure.
    expect(events[2]!.outcome).toBe("failed");
  });

  it("treats an AbortError as cancellation: no error event, outcome 'cancelled'", async () => {
    const abort = new Error("stopped");
    abort.name = "AbortError";
    await expect(
      agent("planner", async () => {
        throw abort;
      }),
    ).rejects.toThrow("stopped");

    const events = await flushed(spool);
    expect(typesOf(events)).toEqual(["agent_start", "agent_end"]);
    expect(events[1]!.outcome).toBe("cancelled");
  });

  it("nests, with parent_id taken from the enclosing agent", async () => {
    await agent("supervisor", async () => {
      await agent("worker", () => undefined);
    });
    const starts = (await flushed(spool)).filter((event) => event.type === "agent_start");
    expect(starts[0]!.parent_id).toBeUndefined();
    expect(starts[1]!.agent_id).toBe("worker");
    expect(starts[1]!.parent_id).toBe("supervisor");
  });

  it("does NOT inherit a parent across an explicit new session", async () => {
    // The span tree is keyed by session, so a cross-session parent would render
    // as a dangling reference or get grafted onto an unrelated agent.
    await agent("server", { sessionId: "boot" }, async () => {
      await agent("handler", { sessionId: "request-1" }, () => undefined);
    });
    const handler = (await flushed(spool)).find(
      (event) => event.type === "agent_start" && event.agent_id === "handler",
    )!;
    expect(handler.session_id).toBe("request-1");
    expect(handler.parent_id).toBeUndefined();
  });

  it("honours an explicit parentId of null as a forced root", async () => {
    await agent("outer", async () => {
      await agent("inner", { parentId: null }, () => undefined);
    });
    const inner = (await flushed(spool)).find(
      (event) => event.type === "agent_start" && event.agent_id === "inner",
    )!;
    expect(inner.parent_id).toBeUndefined();
  });

  it("stays synchronous for a synchronous body", () => {
    const value = agent("sync", () => 42);
    expect(value).toBe(42);
  });

  it("leaves no frame behind when agent_start itself throws", () => {
    expect(() => agent("bad", { type: "reserved" }, () => undefined)).toThrow(/Reserved field/);
    expect(current().sessionId).toBeNull();
    expect(current().depth).toBe(0);
  });
});

describe("toolCall", () => {
  it("records the body's resolved value as the output", async () => {
    await session({ sessionId: "s" }, async () => {
      const hits = await toolCall("search", { input: { q: "x" } }, async () => ["a", "b"]);
      expect(hits).toEqual(["a", "b"]);
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect(result.output).toEqual(["a", "b"]);
    expect(result.tool_name).toBe("search");
  });

  it("prefers an explicitly assigned output over the return value", async () => {
    await session({ sessionId: "s" }, async () => {
      await toolCall("search", async (call) => {
        call.output = { chosen: true };
        return "ignored";
      });
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect(result.output).toEqual({ chosen: true });
  });

  it("records a failure on the leaf and emits NO error event", async () => {
    await session({ sessionId: "s" }, async () => {
      await expect(
        toolCall("search", async () => {
          throw new RangeError("nope");
        }),
      ).rejects.toThrow("nope");
    });
    const events = await flushed(spool);
    expect(typesOf(events)).toEqual(["tool_use", "tool_result"]);
    expect(events[1]!.error).toBe("RangeError: nope");
  });

  it("closes a cancelled tool call with no error string", async () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    await session({ sessionId: "s" }, async () => {
      await expect(
        toolCall("search", async () => {
          throw abort;
        }),
      ).rejects.toThrow();
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect("error" in result).toBe(false);
  });

  it("resolves identity once, at entry, so a nested scope cannot move the result", async () => {
    await agent("outer", async () => {
      await toolCall("search", async () => {
        await agent("inner", () => undefined);
      });
    });
    const result = (await flushed(spool)).find((event) => event.type === "tool_result")!;
    expect(result.agent_id).toBe("outer");
  });
});

describe("using-style scopes", () => {
  it("emits the same events as the callback form", async () => {
    {
      using span = agent.open("planner", { goal: "g" });
      expect(span.agentId).toBe("planner");
      using call = toolCall.open("search", { input: { q: "x" } });
      call.call.output = "done";
    }
    const events = await flushed(spool);
    expect(typesOf(events)).toEqual(["agent_start", "tool_use", "tool_result", "agent_end"]);
    expect(events[2]!.output).toBe("done");
    expect(events[3]!.outcome).toBe("success");
    expect(current().sessionId).toBeNull();
  });

  it("records a failure the block caught, via fail()", async () => {
    {
      using span = agent.open("planner");
      span.fail(new Error("handled"));
    }
    const events = await flushed(spool);
    expect(events.at(-1)!.outcome).toBe("failed");
  });
});

describe("propagate", () => {
  it("carries identity into a callback invoked outside the scope", async () => {
    let stored: (() => void) | null = null;
    await session({ sessionId: "s1" }, async () => {
      await agent("planner", () => {
        stored = propagate(() => {
          expect(current().sessionId).toBe("s1");
          expect(current().agentId).toBe("planner");
        });
      });
    });
    expect(current().sessionId).toBeNull();
    stored!();
  });

  it("binds the same identity on every invocation, not the previous call's leftovers", async () => {
    const seen: Array<string | null> = [];
    const wrapped = await session({ sessionId: "s1" }, () =>
      propagate(() => {
        seen.push(current().sessionId);
      }),
    );
    wrapped();
    wrapped();
    expect(seen).toEqual(["s1", "s1"]);
  });
});

describe("concurrency", () => {
  it("keeps two concurrent runs on separate identities", async () => {
    await Promise.all([
      agent("a", { sessionId: "sa" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(current().sessionId).toBe("sa");
      }),
      agent("b", { sessionId: "sb" }, async () => {
        expect(current().sessionId).toBe("sb");
      }),
    ]);
    const starts = (await flushed(spool)).filter((event) => event.type === "agent_start");
    expect(new Set(starts.map((event) => event.session_id))).toEqual(new Set(["sa", "sb"]));
  });
});
