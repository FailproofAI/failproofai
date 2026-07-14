// @vitest-environment node
import { describe, it, expect } from "vitest";
import { devinRowsToLogEntries, devinActiveConversationPath } from "@/lib/devin-sessions";
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

describe("lib/devin-sessions: devinActiveConversationPath (forest de-dup)", () => {
  const node = (id: number, parent: number | null, text: string) => ({
    node_id: id,
    parent_node_id: parent,
    chat_message: JSON.stringify({ role: "user", content: text, message_id: `m${text}` }),
    created_at: id,
  });

  it("returns only the newest leaf's root→leaf path, dropping replayed branches", () => {
    // Mirrors the real Devin shape: an early branch (0→1→2) is replayed under a
    // later root (3→4→5) that ends at the newest leaf. Reading all nodes would
    // duplicate A/B; the active path is just the newest chain.
    const rows = [
      node(0, null, "A"),
      node(1, 0, "B"),
      node(2, 1, "C"), // dead branch leaf
      node(3, null, "A"), // replay root
      node(4, 3, "B"), // replay
      node(5, 4, "D"), // newest leaf
    ];
    const path = devinActiveConversationPath(rows).map((r) =>
      JSON.parse(r.chat_message!).content,
    );
    expect(path).toEqual(["A", "B", "D"]); // 5→4→3 reversed; branch 0-2 dropped
  });

  it("picks the branch to the max node_id when a parent has sibling children", () => {
    // node 5 and 6 both child of 4; the newest leaf (7, under 6) wins.
    const rows = [
      node(0, null, "root"),
      node(4, 0, "shared"),
      node(5, 4, "deadSibling"),
      node(6, 4, "liveSibling"),
      node(7, 6, "leaf"),
    ];
    const path = devinActiveConversationPath(rows).map((r) =>
      JSON.parse(r.chat_message!).content,
    );
    expect(path).toEqual(["root", "shared", "liveSibling", "leaf"]);
    expect(path).not.toContain("deadSibling");
  });

  it("handles a single linear chain unchanged and [] for no rows", () => {
    const rows = [node(0, null, "x"), node(1, 0, "y")];
    expect(devinActiveConversationPath(rows).map((r) => JSON.parse(r.chat_message!).content)).toEqual(["x", "y"]);
    expect(devinActiveConversationPath([])).toEqual([]);
  });
});
