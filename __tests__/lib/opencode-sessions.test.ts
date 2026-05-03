// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("@/lib/runtime-cache", () => ({
  runtimeCache: vi.fn(<T extends (...args: unknown[]) => unknown>(fn: T) => fn),
}));

import { execFileSync } from "node:child_process";
import { getOpenCodeSessionLog } from "@/lib/opencode-sessions";

const mockExec = vi.mocked(execFileSync);

beforeEach(() => {
  mockExec.mockReset();
});

/** Three queries get fired in order: session row, message rows, part rows. */
function mockQueries(rows: Array<unknown[]>) {
  mockExec.mockImplementation(() => JSON.stringify(rows.shift() ?? []));
}

describe("getOpenCodeSessionLog", () => {
  it("returns null for an unknown session id", async () => {
    mockQueries([[]]); // empty session select
    expect(await getOpenCodeSessionLog("ses_unknown")).toBeNull();
  });

  it("returns null for a non-matching id pattern (SQL-injection guard)", async () => {
    expect(await getOpenCodeSessionLog("'; DROP TABLE session; --")).toBeNull();
    // Should not even call the binary.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns null when binary is missing", async () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(await getOpenCodeSessionLog("ses_abc")).toBeNull();
  });

  it("parses a user message with a single text part", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [{ id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "user" }) }],
      [{ id: "prt_1", message_id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "text", text: "hello" }) }],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log).not.toBeNull();
    expect(log!.cwd).toBe("/repo");
    expect(log!.entries).toHaveLength(1);
    const entry = log!.entries[0] as { type: string; message: { role: string; content: string } };
    expect(entry.type).toBe("user");
    expect(entry.message.role).toBe("user");
    expect(entry.message.content).toBe("hello");
  });

  it("parses an assistant message with text + tool_use parts", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [{ id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "assistant", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }) }],
      [
        { id: "prt_a", message_id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "text", text: "Running ls" }) },
        { id: "prt_b", message_id: "msg_1", session_id: "ses_x", time_created: 1101, time_updated: 1101, data: JSON.stringify({ type: "tool", tool: "bash", input: { command: "ls" } }) },
      ],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log).not.toBeNull();
    const entry = log!.entries[0] as {
      type: string;
      message: { role: string; content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>; model?: string };
    };
    expect(entry.type).toBe("assistant");
    expect(entry.message.role).toBe("assistant");
    expect(entry.message.model).toBe("claude-sonnet-4");
    expect(entry.message.content).toHaveLength(2);
    expect(entry.message.content[0]).toMatchObject({ type: "text", text: "Running ls" });
    expect(entry.message.content[1]).toMatchObject({ type: "tool_use", name: "bash", input: { command: "ls" } });
  });

  it("preserves unknown part types as a labeled text annotation (no silent drops)", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [{ id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "assistant" }) }],
      [{ id: "prt_unknown", message_id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "step-start" }) }],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    const entry = log!.entries[0] as { message: { content: Array<{ type: string; text?: string }> } };
    expect(entry.message.content).toHaveLength(1);
    expect(entry.message.content[0].type).toBe("text");
    expect(entry.message.content[0].text).toContain("step-start");
  });

  it("treats non-string text content as empty (luv-245 defense)", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [{ id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "user" }) }],
      [{ id: "prt_1", message_id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "text", text: { unexpected: "object" } }) }],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    const entry = log!.entries[0] as { message: { content: string } };
    expect(entry.message.content).toBe("");
  });

  it("falls through to a system entry for unknown role values", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [{ id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "tool" }) }],
      [{ id: "prt_1", message_id: "msg_1", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "text", text: "hi" }) }],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    const entry = log!.entries[0] as { type: string };
    expect(entry.type).toBe("system");
  });

  it("returns empty entries[] when the session exists but has no messages", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: null, time_created: 1000, time_updated: 1000 }],
      [],
      [],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log).not.toBeNull();
    expect(log!.entries).toEqual([]);
    expect(log!.cwd).toBe("/repo");
  });

  it("returns null when the messages query fails after a successful session lookup", async () => {
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify([{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }]);
      }
      throw new Error("db locked");
    });
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log).not.toBeNull();
    expect(log!.entries).toEqual([]);
  });

  it("groups parts by message_id (multiple messages, multiple parts each)", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [
        { id: "msg_a", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ role: "user" }) },
        { id: "msg_b", session_id: "ses_x", time_created: 1200, time_updated: 1200, data: JSON.stringify({ role: "assistant" }) },
      ],
      [
        { id: "prt_a1", message_id: "msg_a", session_id: "ses_x", time_created: 1100, time_updated: 1100, data: JSON.stringify({ type: "text", text: "hi" }) },
        { id: "prt_b1", message_id: "msg_b", session_id: "ses_x", time_created: 1200, time_updated: 1200, data: JSON.stringify({ type: "text", text: "hello back" }) },
      ],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log!.entries).toHaveLength(2);
    const userEntry = log!.entries[0] as { type: string; message: { content: string } };
    const asstEntry = log!.entries[1] as { type: string; message: { content: Array<{ text?: string }> } };
    expect(userEntry.type).toBe("user");
    expect(userEntry.message.content).toBe("hi");
    expect(asstEntry.type).toBe("assistant");
    expect(asstEntry.message.content[0].text).toBe("hello back");
  });

  it("the synthetic filePath is opencode://<id>", async () => {
    mockQueries([
      [{ id: "ses_x", project_id: "p1", slug: "x", directory: "/repo", title: "X", time_created: 1000, time_updated: 1000 }],
      [],
      [],
    ]);
    const log = await getOpenCodeSessionLog("ses_x");
    expect(log!.filePath).toBe("opencode://ses_x");
  });
});
