// @vitest-environment node
import { describe, it, expect } from "vitest";
import { hermesRowsToLogEntries } from "@/lib/hermes-sessions";
import { logEntriesToEvents } from "@/src/audit/cli-adapters/shared";

/** Message rows as they come off the `messages` table: `tool_calls` is a JSON
 *  string column, results are separate `role:"tool"` rows keyed by
 *  `tool_call_id` (OpenAI shape, verified live). */
const row = (o: Record<string, unknown>) => o;

describe("lib/hermes-sessions: hermesRowsToLogEntries", () => {
  it("pairs a tool result onto its tool_use by tool_call_id (tool_calls as JSON string)", () => {
    const entries = hermesRowsToLogEntries([
      row({ role: "user", content: "read it", timestamp: 1_752_000_000 }),
      row({
        role: "assistant",
        content: "ok",
        tool_calls: JSON.stringify([
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/x.rs"}' } },
        ]),
        timestamp: 1_752_000_001,
      }),
      row({ role: "tool", tool_call_id: "call_1", tool_name: "read_file", content: '{"content":"L1\\nL2"}', timestamp: 1_752_000_002 }),
    ]);
    const assistant = entries.find((e) => e.type === "assistant");
    const toolUse =
      assistant?.type === "assistant"
        ? assistant.message.content.find((b) => b.type === "tool_use")
        : undefined;
    expect(toolUse).toMatchObject({ type: "tool_use", name: "read_file", input: { path: "/x.rs" } });
    expect(toolUse && "result" in toolUse ? toolUse.result?.content : "").toContain("L1");
  });

  it("canonicalizes terminal→Bash through logEntriesToEvents (tool_calls as array)", () => {
    const entries = hermesRowsToLogEntries([
      row({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "terminal", arguments: { command: "ls" } } }], timestamp: 1_752_000_000 }),
    ]);
    const events = logEntriesToEvents(entries, { cli: "hermes", sessionId: "s", transcriptPath: "hermes://s", cwd: "" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: "Bash", rawToolName: "terminal", toolInput: { command: "ls" } });
  });

  it("keeps session_meta / unknown roles as system entries (never dropped)", () => {
    const entries = hermesRowsToLogEntries([
      row({ role: "session_meta", content: "", timestamp: 1 }),
      row({ role: "user", content: "hi", timestamp: 2 }),
    ]);
    expect(entries.some((e) => e.type === "system")).toBe(true);
    expect(entries.some((e) => e.type === "user")).toBe(true);
  });

  it("returns [] for no rows", () => {
    expect(hermesRowsToLogEntries([])).toHaveLength(0);
  });

  it("handles an assistant row carrying BOTH text and tool_calls", () => {
    const entries = hermesRowsToLogEntries([
      row({ role: "assistant", content: "let me check", tool_calls: [{ id: "c1", function: { name: "web_search", arguments: '{"q":"x"}' } }], timestamp: 1 }),
    ]);
    const a = entries.find((e) => e.type === "assistant");
    expect(a?.type).toBe("assistant");
    if (a?.type === "assistant") {
      expect(a.message.content.some((b) => b.type === "text")).toBe(true);
      expect(a.message.content.some((b) => b.type === "tool_use")).toBe(true);
    }
  });
});
