// @vitest-environment node
//
// Unit tests for the PURE Goose message parser (gooseRowsToLogEntries) and the
// timestamp coercion helper. Uses content_json shapes captured live from goose
// v1.43.0 (sessions.db, schema_version 15): typed-block arrays with `text`,
// `toolRequest`, and `toolResponse` blocks; tool RESULTS arrive in role:"user"
// rows and must attach to the matching earlier tool_use by id.
import { describe, it, expect } from "vitest";
import {
  gooseRowsToLogEntries,
  gooseTimestampToMs,
  GOOSE_SESSION_ID_RE,
  type GooseMessageRow,
} from "@/lib/goose-sessions";

function row(role: string, blocks: unknown[], ts: number): GooseMessageRow {
  return { role, content_json: JSON.stringify(blocks), created_timestamp: ts };
}

const T0 = 1_784_000_000_000; // > 1e12 → treated as epoch ms

describe("gooseTimestampToMs", () => {
  it("passes epoch-ms through and scales epoch-seconds to ms", () => {
    expect(gooseTimestampToMs(T0)).toBe(T0);
    expect(gooseTimestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("parses SQLite CURRENT_TIMESTAMP strings as UTC", () => {
    // "YYYY-MM-DD HH:MM:SS" has no zone; must be read as UTC, not local.
    expect(gooseTimestampToMs("2026-07-14 16:01:00")).toBe(Date.parse("2026-07-14T16:01:00Z"));
  });

  it("returns a finite number for unparseable input (fallback to now)", () => {
    expect(Number.isFinite(gooseTimestampToMs("not-a-date"))).toBe(true);
    expect(Number.isFinite(gooseTimestampToMs(null))).toBe(true);
  });
});

describe("GOOSE_SESSION_ID_RE", () => {
  it("matches date-prefixed counters and rejects UUIDs / traversal", () => {
    expect(GOOSE_SESSION_ID_RE.test("20260714_3")).toBe(true);
    expect(GOOSE_SESSION_ID_RE.test("20260714_12")).toBe(true);
    expect(GOOSE_SESSION_ID_RE.test("not-a-session")).toBe(false);
    expect(GOOSE_SESSION_ID_RE.test("../etc/passwd")).toBe(false);
  });
});

describe("gooseRowsToLogEntries", () => {
  const rows: GooseMessageRow[] = [
    row("user", [{ type: "text", text: "Run the shell command: echo AUDIT" }], T0),
    row(
      "assistant",
      [
        {
          type: "toolRequest",
          id: "call_1",
          toolCall: { status: "success", value: { name: "shell", arguments: { command: "echo AUDIT" } } },
          _meta: { goose_extension: "developer" },
        },
      ],
      T0 + 1000,
    ),
    row(
      "user",
      [
        {
          type: "toolResponse",
          id: "call_1",
          toolResult: {
            status: "success",
            value: { content: [{ type: "text", text: "AUDIT" }], structuredContent: { stdout: "AUDIT" }, isError: false },
          },
        },
      ],
      T0 + 2000,
    ),
    row("assistant", [{ type: "text", text: "The command printed AUDIT" }], T0 + 3000),
  ];

  it("produces user + assistant(tool) + assistant(text) entries (tool-result row adds none)", () => {
    const entries = gooseRowsToLogEntries(rows);
    // 4 rows, but the pure tool-result row attaches to the tool_use rather than
    // producing its own entry → 3 entries.
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("user");
    expect(entries[1].type).toBe("assistant");
    expect(entries[2].type).toBe("assistant");
  });

  it("keeps the raw goose tool name (canonicalization happens downstream)", () => {
    const entries = gooseRowsToLogEntries(rows);
    const asst = entries[1] as unknown as { message: { content: Array<Record<string, unknown>> } };
    const toolUse = asst.message.content.find((b) => b.type === "tool_use") as
      | { name: string; input: Record<string, unknown>; result?: { content: string } }
      | undefined;
    expect(toolUse).toBeDefined();
    expect(toolUse?.name).toBe("shell"); // NOT "Bash" — logEntriesToEvents maps it later
    expect((toolUse?.input as { command?: string }).command).toBe("echo AUDIT");
  });

  it("pairs a toolResponse (in a role:user row) with its earlier toolRequest by id", () => {
    const entries = gooseRowsToLogEntries(rows);
    const asst = entries[1] as unknown as { message: { content: Array<Record<string, unknown>> } };
    const toolUse = asst.message.content.find((b) => b.type === "tool_use") as
      | { result?: { content: string } }
      | undefined;
    expect(toolUse?.result?.content).toBe("AUDIT");
  });

  it("carries the user text through", () => {
    const entries = gooseRowsToLogEntries(rows);
    const user = entries[0] as unknown as { message: { content: string } };
    expect(user.message.content).toBe("Run the shell command: echo AUDIT");
  });

  it("skips rows with empty / non-array content_json without crashing", () => {
    const bad: GooseMessageRow[] = [
      { role: "user", content_json: null, created_timestamp: T0 },
      { role: "assistant", content_json: "not json", created_timestamp: T0 },
      { role: "assistant", content_json: JSON.stringify({ not: "array" }), created_timestamp: T0 },
    ];
    expect(gooseRowsToLogEntries(bad)).toHaveLength(0);
  });

  it("does not crash on an orphan toolResponse (no matching request)", () => {
    const orphan: GooseMessageRow[] = [
      row("user", [{ type: "toolResponse", id: "missing", toolResult: { value: { content: [] } } }], T0),
    ];
    expect(() => gooseRowsToLogEntries(orphan)).not.toThrow();
  });
});
