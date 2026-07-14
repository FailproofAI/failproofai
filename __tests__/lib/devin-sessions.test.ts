// @vitest-environment node
import { describe, it, expect } from "vitest";
import { devinRowsToLogEntries } from "@/lib/devin-sessions";
import { logEntriesToEvents } from "@/src/audit/cli-adapters/shared";

/** Parsed `chat_message` objects as they come off `message_nodes.chat_message`
 *  (OpenAI-style, verified live against devin v3000.1.27): assistant tool calls
 *  are flat `tool_calls[].{id, name, arguments}` where `arguments` is already an
 *  object, and results are separate `role:"tool"` rows keyed by `tool_call_id`.
 *  `_created_at` is the DB row's epoch-seconds timestamp injected by the loader. */
const msg = (o: Record<string, unknown>) => o;

describe("lib/devin-sessions: devinRowsToLogEntries", () => {
  it("pairs a tool result onto its tool_use by tool_call_id (flat name/arguments)", () => {
    const entries = devinRowsToLogEntries([
      msg({ role: "user", content: "run it", _created_at: 1_784_016_000 }),
      msg({
        role: "assistant",
        content: "ok",
        tool_calls: [{ id: "call_1", name: "exec", arguments: { command: "echo hi" }, index: 0, kind: "function" }],
        _created_at: 1_784_016_001,
      }),
      msg({ role: "tool", tool_call_id: "call_1", content: "hi\nExit code: 0", _created_at: 1_784_016_002 }),
    ]);
    const assistant = entries.find((e) => e.type === "assistant");
    const toolUse =
      assistant?.type === "assistant"
        ? assistant.message.content.find((b) => b.type === "tool_use")
        : undefined;
    expect(toolUse).toMatchObject({ type: "tool_use", name: "exec", input: { command: "echo hi" } });
    expect(toolUse && "result" in toolUse ? toolUse.result?.content : "").toContain("hi");
  });

  it("canonicalizes exec→Bash through logEntriesToEvents", () => {
    const entries = devinRowsToLogEntries([
      msg({ role: "assistant", tool_calls: [{ id: "c1", name: "exec", arguments: { command: "ls" } }], _created_at: 1_784_016_000 }),
    ]);
    const events = logEntriesToEvents(entries, { cli: "devin", sessionId: "s", transcriptPath: "devin-db://s", cwd: "" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: "Bash", rawToolName: "exec", toolInput: { command: "ls" } });
  });

  it("prefers metadata.created_at (ISO) over the injected _created_at row value", () => {
    const entries = devinRowsToLogEntries([
      msg({ role: "user", content: "hi", _created_at: 1_784_016_000, metadata: { created_at: "2026-07-14T07:59:58.000Z" } }),
    ]);
    expect(entries[0].timestamp).toBe("2026-07-14T07:59:58.000Z");
  });

  it("keeps system / unknown roles as system entries (never dropped)", () => {
    const entries = devinRowsToLogEntries([
      msg({ role: "system", content: "env info", _created_at: 1 }),
      msg({ role: "user", content: "hi", _created_at: 2 }),
    ]);
    expect(entries.some((e) => e.type === "system")).toBe(true);
    expect(entries.some((e) => e.type === "user")).toBe(true);
  });

  it("drops an assistant turn with empty content and no tool_calls", () => {
    const entries = devinRowsToLogEntries([
      msg({ role: "assistant", content: "", tool_calls: [], _created_at: 1 }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("returns [] for no rows", () => {
    expect(devinRowsToLogEntries([])).toHaveLength(0);
  });
});
