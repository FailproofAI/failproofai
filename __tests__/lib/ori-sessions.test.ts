// @vitest-environment node
/**
 * ori's transcript parser, against the real serialized shape.
 *
 * The fixture below is a trimmed transcription of an actual
 * `ori_agent_loop_history.prompt` blob read out of a live
 * `~/.ori/global/.ori/state.sqlite` (ori 0.12.0+68f9a36) — same roles, same
 * block types, same `call-<uuid>` id convention pairing a `tool-call` with its
 * `tool-result`. `oriMessagesToLogEntries` is pure, so none of this needs a DB.
 */
import { describe, it, expect } from "vitest";
import { oriMessagesToLogEntries, oriTimestampToMs } from "@/lib/ori-sessions";
import type { AssistantEntry, UserEntry } from "@/lib/log-entries";

const TS_MS = Date.parse("2026-08-31T14:19:33.661Z");

const MESSAGES = [
  { role: "system", content: "# Ori Coding Agent\nYou are a coding agent…" },
  { role: "user", content: "read data.txt then search it for alpha" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Let me read the file first." },
      { type: "tool-call", id: "call-aaa", name: "read", params: { path: "data.txt" }, providerExecuted: false },
      { type: "tool-call", id: "call-bbb", name: "grep", params: { pattern: "alpha", path: "data.txt" }, providerExecuted: false },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", id: "call-aaa", name: "read", isFailure: false, result: [{ text: "alpha\nbeta\n", type: "input_text" }] },
      { type: "tool-result", id: "call-bbb", name: "grep", isFailure: false, result: [{ text: "data.txt:1:alpha", type: "input_text" }] },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Found alpha on line 1." }] },
];

describe("oriMessagesToLogEntries", () => {
  const entries = oriMessagesToLogEntries(MESSAGES, "sess-1", TS_MS);

  it("drops the system message — it is ori's static boilerplate, identical every session", () => {
    expect(entries.some((e) => e.type === "system")).toBe(false);
    expect(entries).toHaveLength(3); // user, assistant(tools), assistant(text)
  });

  it("keeps the user turn", () => {
    const user = entries[0] as UserEntry;
    expect(user.type).toBe("user");
    expect(user.message.content).toBe("read data.txt then search it for alpha");
  });

  it("maps reasoning → thinking and tool-call → tool_use", () => {
    const a = entries[1] as AssistantEntry;
    expect(a.type).toBe("assistant");
    const kinds = a.message.content.map((b) => b.type);
    expect(kinds).toEqual(["thinking", "tool_use", "tool_use"]);
  });

  it("pairs each tool-result back onto its tool-call by id", () => {
    const a = entries[1] as AssistantEntry;
    const tools = a.message.content.filter((b) => b.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "read", input: { path: "data.txt" } });
    expect(tools[0].result?.content).toBe("alpha\nbeta\n");
    expect(tools[1]).toMatchObject({ name: "grep" });
    expect(tools[1].result?.content).toBe("data.txt:1:alpha");
  });

  it("gives every entry the session timestamp — ori stores no per-message time", () => {
    // Documented limitation, asserted so it is visible rather than surprising.
    expect(new Set(entries.map((e) => e.timestampMs))).toEqual(new Set([TS_MS]));
  });

  it("drops a tool-result with no matching call instead of throwing", () => {
    const orphan = [{ role: "tool", content: [{ type: "tool-result", id: "call-zzz", name: "read", result: [] }] }];
    expect(oriMessagesToLogEntries(orphan, "s", TS_MS)).toEqual([]);
  });

  it("survives an empty or malformed message list", () => {
    expect(oriMessagesToLogEntries([], "s", TS_MS)).toEqual([]);
    expect(oriMessagesToLogEntries([{ role: "assistant" }], "s", TS_MS)).toEqual([]);
  });
});

describe("oriTimestampToMs", () => {
  it("parses ori's ISO-8601 strings", () => {
    expect(oriTimestampToMs("2026-08-31T14:19:33.661Z")).toBe(TS_MS);
  });
  it("returns 0 for absent or unparseable values", () => {
    expect(oriTimestampToMs(null)).toBe(0);
    expect(oriTimestampToMs("not a date")).toBe(0);
  });
});
