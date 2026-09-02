// @vitest-environment node
/**
 * Cline's transcript parser, against the real stored shape.
 *
 * The fixture is a trimmed transcription of an actual
 * `<id>.messages.json` read off this machine (cline v3.0.60): same roles, same
 * block types, same `call_…` id convention pairing `tool_use` with
 * `tool_result`. Cline already speaks Claude's content blocks, so the only real
 * work is that pairing — and NOT emitting a phantom user turn for the
 * `role:"user"` message that merely carries the results.
 */
import { describe, it, expect } from "vitest";
import { clineMessagesToLogEntries, clineTimestampToMs } from "@/lib/cline-sessions";
import type { AssistantEntry, UserEntry, ToolUseBlock } from "@/lib/log-entries";

const TS_MS = Date.parse("2026-09-01T09:01:11.792Z");

const MESSAGES = [
  { role: "user", content: "read data.txt and search it for alpha" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I will read the file first." },
      { type: "text", text: "Reading now." },
      { type: "tool_use", id: "call_aaa", name: "read_files", input: { files: [{ path: "data.txt" }] } },
      { type: "tool_use", id: "call_bbb", name: "search_codebase", input: { queries: ["alpha"] } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_aaa", name: "read_files", content: [{ text: "1 | alpha" }] },
      { type: "tool_result", tool_use_id: "call_bbb", name: "search_codebase", content: [{ text: "data.txt:1:alpha" }] },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Found alpha on line 1." }] },
];

describe("clineMessagesToLogEntries", () => {
  const entries = clineMessagesToLogEntries(MESSAGES, "1788253271772_bn188", TS_MS);

  it("does not emit a phantom user turn for the tool-result carrier", () => {
    // Cline puts tool results in a role:"user" message, Claude-style. Emitting
    // that as user prose would put a blank turn in the audit for every tool call.
    const users = entries.filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
    expect((users[0] as UserEntry).message.content).toBe("read data.txt and search it for alpha");
  });

  it("keeps thinking, text and tool_use blocks in order", () => {
    const a = entries.find((e) => e.type === "assistant") as AssistantEntry;
    expect(a.message.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  });

  it("pairs each tool_result back onto its tool_use by id", () => {
    const a = entries.find((e) => e.type === "assistant") as AssistantEntry;
    const tools = a.message.content.filter((b) => b.type === "tool_use") as ToolUseBlock[];
    expect(tools[0]).toMatchObject({ name: "read_files" });
    expect(tools[0].result?.content).toBe("1 | alpha");
    expect(tools[1]).toMatchObject({ name: "search_codebase" });
    expect(tools[1].result?.content).toBe("data.txt:1:alpha");
  });

  it("gives every entry the session timestamp — cline stores no per-message time", () => {
    // Documented limitation, asserted so it is visible rather than surprising.
    expect(new Set(entries.map((e) => e.timestampMs))).toEqual(new Set([TS_MS]));
  });

  it("drops an orphan tool_result instead of throwing", () => {
    const orphan = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_zzz", name: "read_files", content: [] }] },
    ];
    expect(clineMessagesToLogEntries(orphan, "s", TS_MS)).toEqual([]);
  });

  it("survives empty and malformed message lists", () => {
    expect(clineMessagesToLogEntries([], "s", TS_MS)).toEqual([]);
    expect(clineMessagesToLogEntries([{ role: "assistant" }], "s", TS_MS)).toEqual([]);
    expect(clineMessagesToLogEntries([{ role: "tool" }], "s", TS_MS)).toEqual([]);
  });

  it("flattens a tool_result whose content is a plain string", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "run_commands", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", name: "run_commands", content: "ok" }] },
    ];
    const out = clineMessagesToLogEntries(msgs, "s", TS_MS);
    const a = out.find((e) => e.type === "assistant") as AssistantEntry;
    expect((a.message.content[0] as ToolUseBlock).result?.content).toBe("ok");
  });
});

describe("clineTimestampToMs", () => {
  it("parses cline's ISO-8601 strings", () => {
    expect(clineTimestampToMs("2026-09-01T09:01:11.792Z")).toBe(TS_MS);
  });
  it("returns 0 for absent or unparseable values", () => {
    expect(clineTimestampToMs(null)).toBe(0);
    expect(clineTimestampToMs("nope")).toBe(0);
  });
});
