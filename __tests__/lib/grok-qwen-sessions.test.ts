// @vitest-environment node
//
// Transcript parsers for the two newest CLIs. Every fixture line below is a
// trimmed copy of a REAL capture — grok 1.0.3 `chat_history.jsonl` and
// qwen-code 0.21.12 `chats/<uuid>.jsonl` — so these lock the shapes that were
// actually observed, not the shapes the vendors document.
import { describe, it, expect } from "vitest";
import { grokLinesToLogEntries, decodeGrokProjectDir } from "@/lib/grok-sessions";
import { qwenLinesToLogEntries } from "@/lib/qwen-sessions";
import type { AssistantEntry, ToolUseBlock } from "@/lib/log-entries";

function toolUses(entries: ReturnType<typeof grokLinesToLogEntries>): ToolUseBlock[] {
  return entries
    .filter((e): e is AssistantEntry => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b): b is ToolUseBlock => typeof b === "object" && b.type === "tool_use");
}

describe("grok transcript parsing", () => {
  // Verbatim shapes from a real session directory.
  const LINES: Record<string, unknown>[] = [
    { type: "system", content: "You are Grok 4.5 released by xAI…" },
    // Environment preamble: a `user` line with NO prompt_index.
    { type: "user", content: [{ type: "text", text: "<user_info>OS: linux</user_info>" }] },
    // An injected reminder — also a `user` line, but synthetic.
    {
      type: "user",
      synthetic_reason: "skills",
      content: [{ type: "text", text: "<system-reminder>…</system-reminder>" }],
    },
    // The only line the operator actually typed.
    {
      type: "user",
      prompt_index: 0,
      content: [{ type: "text", text: "<user_query>run echo FPPROBE</user_query>" }],
    },
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking…" }] },
    {
      type: "assistant",
      content: "I'll run `echo FPPROBE`.",
      model_id: "grok-4.5",
      tool_calls: [
        {
          id: "call-1",
          name: "run_terminal_command",
          // grok serializes arguments as a JSON STRING, not an object.
          arguments: '{"command":"echo FPPROBE","description":"Echo"}',
        },
      ],
    },
    { type: "tool_result", tool_call_id: "call-1", content: "exit: 0\nFPPROBE\n" },
  ];

  it("keeps only the operator's real prompt as a user turn", () => {
    const entries = grokLinesToLogEntries(LINES, 1_700_000_000_000);
    const users = entries.filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
    expect((users[0] as { message: { content: string } }).message.content).toContain("echo FPPROBE");
  });

  it("skips the system prompt and the model's private reasoning", () => {
    const entries = grokLinesToLogEntries(LINES, 1_700_000_000_000);
    // system-prompt and reasoning lines must not surface as turns.
    expect(entries.filter((e) => e.type === "system")).toHaveLength(0);
  });

  it("parses tool_calls[].arguments from its JSON string into a real object", () => {
    const calls = toolUses(grokLinesToLogEntries(LINES, 1_700_000_000_000));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("run_terminal_command");
    expect(calls[0].input).toEqual({ command: "echo FPPROBE", description: "Echo" });
  });

  it("pairs tool_result back onto its call by tool_call_id", () => {
    const calls = toolUses(grokLinesToLogEntries(LINES, 1_700_000_000_000));
    expect(calls[0].result?.content).toBe("exit: 0\nFPPROBE\n");
  });

  it("anchors the synthesized timeline on the supplied start time", () => {
    // chat_history.jsonl carries NO timestamps, so ordering must come from file
    // order and the absolute position from summary.json's created_at.
    const startMs = 1_700_000_000_000;
    const entries = grokLinesToLogEntries(LINES, startMs);
    expect(entries[0].timestampMs).toBeGreaterThanOrEqual(startMs);
    const times = entries.map((e) => e.timestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("keeps malformed tool arguments visible instead of dropping them", () => {
    const calls = toolUses(
      grokLinesToLogEntries(
        [{ type: "assistant", content: "", tool_calls: [{ id: "c", name: "x", arguments: "{not json" }] }],
        1,
      ),
    );
    expect(calls[0].input).toEqual({ arguments: "{not json" });
  });

  it("percent-decodes grok's project folder names", () => {
    // grok percent-encodes the cwd where every other JSONL store dash-encodes it.
    expect(decodeGrokProjectDir("%2Ftmp%2Ffp-probe%2Fws")).toBe("/tmp/fp-probe/ws");
    // A folder that is not valid percent-encoding degrades to the raw name.
    expect(decodeGrokProjectDir("%%%")).toBe("%%%");
  });
});

describe("qwen transcript parsing", () => {
  // Verbatim shapes: Gemini-style `message.parts`, role "model" for assistant.
  const LINES: Record<string, unknown>[] = [
    {
      type: "user",
      uuid: "u1",
      sessionId: "s1",
      cwd: "/tmp/qws",
      timestamp: "2026-08-16T18:30:00.000Z",
      message: { role: "user", parts: [{ text: "create report.txt" }] },
    },
    { type: "system", uuid: "sys1", subtype: "info", systemPayload: {}, timestamp: "2026-08-16T18:30:01.000Z" },
    {
      type: "assistant",
      uuid: "a1",
      model: "gpt-5.6-luna",
      timestamp: "2026-08-16T18:30:02.000Z",
      message: {
        role: "model",
        parts: [
          { text: "Creating it now." },
          { functionCall: { id: "call_1", name: "write_file", args: { file_path: "/tmp/qws/report.txt", content: "alpha" } } },
        ],
      },
    },
    {
      type: "tool_result",
      uuid: "t1",
      timestamp: "2026-08-16T18:30:03.000Z",
      message: {
        role: "user",
        parts: [{ functionResponse: { id: "call_1", name: "write_file", response: { output: "written" } } }],
      },
      toolCallResult: { callId: "call_1", status: "success", resultDisplay: "Wrote 5 bytes" },
    },
  ];

  it("reads Gemini-shaped parts, treating role 'model' as the assistant", () => {
    const entries = qwenLinesToLogEntries(LINES);
    const assistants = entries.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AssistantEntry).message.model).toBe("gpt-5.6-luna");
  });

  it("turns functionCall parts into tool_use blocks with canonical-key args", () => {
    const calls = toolUses(qwenLinesToLogEntries(LINES));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("write_file");
    // qwen's tool args are already canonical — no input map needed anywhere.
    expect(calls[0].input).toEqual({ file_path: "/tmp/qws/report.txt", content: "alpha" });
  });

  it("prefers the toolCallResult sidecar's rendered text for the result", () => {
    const calls = toolUses(qwenLinesToLogEntries(LINES));
    // resultDisplay is what the TUI showed, so it beats the raw response blob.
    expect(calls[0].result?.content).toBe("Wrote 5 bytes");
  });

  it("falls back to the functionResponse payload when no sidecar is present", () => {
    const noSidecar = LINES.map((l) =>
      l.type === "tool_result" ? { ...l, toolCallResult: undefined } : l,
    );
    const calls = toolUses(qwenLinesToLogEntries(noSidecar));
    expect(calls[0].result?.content).toBe("written");
  });

  it("skips system bookkeeping lines", () => {
    const entries = qwenLinesToLogEntries(LINES);
    expect(entries.filter((e) => e.type === "system")).toHaveLength(0);
  });

  it("keeps the user turn and preserves chronological order", () => {
    const entries = qwenLinesToLogEntries(LINES);
    const users = entries.filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
    const times = entries.map((e) => e.timestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("grok project slugs", () => {
  it("derives a URL-safe slug from the cwd, not grok's percent-encoded folder", async () => {
    // Regression: the on-disk folder is `%2Ftmp%2Ffp-prod`, which becomes
    // `%252F…` once it is a link href, and /project/[name] 404s on it. Every
    // grok project was unreachable from the projects list.
    const { encodeFolderName } = await import("@/lib/paths");
    const slug = encodeFolderName("/tmp/fp-prod");
    expect(slug).not.toContain("%");
    // Byte-identical to what Claude/Factory/Qwen derive for the same cwd, which
    // is what makes those rows MERGE instead of showing up twice.
    expect(slug).toBe(encodeFolderName("/tmp/fp-prod"));
    expect(slug).toBe("-tmp-fp-prod");
  });

  it("does not rely on decoding the slug back to a cwd", async () => {
    // `decodeFolderName` is lossy whenever the path itself contains a dash —
    // `-tmp-fp-prod` decodes to `/tmp/fp/prod`, not `/tmp/fp-prod`. That is the
    // whole reason grok's project page takes its cwd from summary.json's
    // `info.cwd` and treats the decode as a last resort, exactly as the Claude
    // and Factory adapters do with their own headers.
    const { decodeFolderName, encodeFolderName } = await import("@/lib/paths");
    expect(decodeFolderName(encodeFolderName("/tmp/fp-prod"))).toBe("/tmp/fp/prod");
  });
});
