// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseHermesExport } from "@/lib/hermes-sessions";
import { logEntriesToEvents } from "@/src/audit/cli-adapters/shared";

/**
 * Build the OpenAI-shape export doc Hermes emits. Assistant tool calls live in
 * `tool_calls[].function` (with `arguments` as a JSON string) and results are
 * separate `role:"tool"` messages keyed by `tool_call_id` (verified live).
 */
const doc = (messages: Record<string, unknown>[], meta: Record<string, unknown> = {}) =>
  JSON.stringify({ ...meta, messages });

describe("lib/hermes-sessions: parseHermesExport", () => {
  it("pairs a tool result back onto the originating tool_use by tool_call_id", () => {
    const content = doc([
      { role: "user", content: "read the file", timestamp: "2026-07-09T10:00:00Z" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path": "/x/y.rs"}' },
          },
        ],
        timestamp: "2026-07-09T10:00:01Z",
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        tool_name: "read_file",
        content: '{"content": "line1\\nline2"}',
        timestamp: "2026-07-09T10:00:02Z",
      },
    ]);

    const { entries } = parseHermesExport(content);
    // user + assistant (text + tool_use)
    const assistant = entries.find((e) => e.type === "assistant");
    expect(assistant).toBeDefined();
    const toolUse = assistant!.type === "assistant"
      ? assistant!.message.content.find((b) => b.type === "tool_use")
      : undefined;
    expect(toolUse).toMatchObject({
      type: "tool_use",
      name: "read_file",
      input: { path: "/x/y.rs" },
    });
    // The tool result was attached inline (not emitted as a separate entry).
    expect(toolUse && "result" in toolUse ? toolUse.result?.content : "").toContain("line1");
  });

  it("parses tool_calls given as an array (arguments already an object)", () => {
    const content = doc([
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "terminal", arguments: { command: "ls" } } }],
        timestamp: 1_752_000_000,
      },
    ]);
    const { entries } = parseHermesExport(content);
    const events = logEntriesToEvents(entries, {
      cli: "hermes",
      sessionId: "s",
      transcriptPath: "hermes://s",
      cwd: "",
    });
    expect(events).toHaveLength(1);
    // terminal → Bash via HERMES_TOOL_MAP; input preserved.
    expect(events[0]).toMatchObject({ toolName: "Bash", rawToolName: "terminal", toolInput: { command: "ls" } });
  });

  it("skips session_meta / unknown roles as system entries (never dropped)", () => {
    const content = doc([
      { role: "session_meta", content: "", timestamp: "2026-07-09T10:00:00Z" },
      { role: "user", content: "hi", timestamp: "2026-07-09T10:00:01Z" },
    ]);
    const { entries } = parseHermesExport(content);
    expect(entries.some((e) => e.type === "system")).toBe(true);
    expect(entries.some((e) => e.type === "user")).toBe(true);
  });

  it("returns no tool events for an empty session", () => {
    expect(parseHermesExport(doc([])).entries).toHaveLength(0);
    expect(parseHermesExport("").entries).toHaveLength(0);
  });

  it("handles an assistant row carrying BOTH text and tool_calls", () => {
    const content = doc([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [{ id: "c1", function: { name: "web_search", arguments: '{"q":"x"}' } }],
        timestamp: "2026-07-09T10:00:00Z",
      },
    ]);
    const { entries } = parseHermesExport(content);
    const assistant = entries.find((e) => e.type === "assistant");
    expect(assistant?.type).toBe("assistant");
    if (assistant?.type === "assistant") {
      expect(assistant.message.content.some((b) => b.type === "text")).toBe(true);
      expect(assistant.message.content.some((b) => b.type === "tool_use")).toBe(true);
    }
  });

  it("tolerates JSONL (one message object per line) as well as a doc", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "a", timestamp: "2026-07-09T10:00:00Z" }),
      JSON.stringify({ role: "assistant", content: "b", timestamp: "2026-07-09T10:00:01Z" }),
    ].join("\n");
    const { entries } = parseHermesExport(jsonl);
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
  });

  it("surfaces cwd from the export metadata when present", () => {
    const content = doc([{ role: "user", content: "x", timestamp: "2026-07-09T10:00:00Z" }], {
      cwd: "/home/failproofai/proj",
    });
    expect(parseHermesExport(content).cwd).toBe("/home/failproofai/proj");
  });
});
