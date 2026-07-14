// @vitest-environment node
//
// Locks in the pure OpenClaw transcript parser + UUID-based transcript
// resolution. Line shapes mirror a real ~/.openclaw/agents/main/sessions/
// <uuid>.jsonl captured live from openclaw v2026.7.1: type-discriminated lines
// where `type:"message"` wraps {role, content}; assistant content is a list of
// {type:"text"} / {type:"toolCall", id, name, arguments}; results arrive as a
// {role:"toolResult", toolCallId, toolName, content, details} message.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openclawLinesToLogEntries,
  findOpenClawTranscript,
  listOpenClawTranscripts,
  OPENCLAW_SESSION_ID_RE,
} from "@/lib/openclaw-sessions";
import type { AssistantEntry } from "@/lib/log-entries";

const UUID = "f9e8516e-fed2-4e54-acbe-7a20aefc6cfa";

const LINES: Record<string, unknown>[] = [
  { type: "session", version: 3, id: UUID, timestamp: "2026-07-14T05:01:34.420Z", cwd: "/home/node/.openclaw/workspace" },
  { type: "model_change", id: "m1", timestamp: "2026-07-14T05:01:34.431Z", provider: "groq", modelId: "x" },
  { type: "custom", customType: "model-snapshot", data: {}, id: "c1", timestamp: "2026-07-14T05:01:34.527Z" },
  { type: "message", id: "u1", parentId: null, timestamp: "2026-07-14T05:10:20.000Z", message: { role: "user", content: "run echo probe" } },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-07-14T05:10:25.000Z",
    message: {
      role: "assistant",
      model: "llama-4-scout",
      content: [
        { type: "text", text: "Running it." },
        { type: "toolCall", id: "c5sf91qpf", name: "exec", arguments: { command: "echo probe-test-123" } },
      ],
    },
  },
  {
    type: "message",
    id: "t1",
    parentId: "a1",
    timestamp: "2026-07-14T05:10:26.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c5sf91qpf",
      toolName: "exec",
      content: [{ type: "text", text: "probe-test-123" }],
      details: { status: "completed", exitCode: 0, durationMs: 19 },
      isError: false,
    },
  },
];

describe("openclawLinesToLogEntries", () => {
  it("skips non-message metadata lines (session/model_change/custom)", () => {
    const entries = openclawLinesToLogEntries(LINES);
    // Only the user + assistant turns become entries (toolResult is folded in).
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
  });

  it("parses the user turn (string content)", () => {
    const entries = openclawLinesToLogEntries(LINES);
    const user = entries[0];
    expect(user.type).toBe("user");
    if (user.type === "user") expect(user.message.content).toBe("run echo probe");
  });

  it("parses assistant text + toolCall and pairs the toolResult by toolCallId", () => {
    const entries = openclawLinesToLogEntries(LINES);
    const asst = entries.find((e) => e.type === "assistant") as AssistantEntry;
    expect(asst.message.model).toBe("llama-4-scout");
    const [text, tool] = asst.message.content;
    expect(text).toEqual({ type: "text", text: "Running it." });
    expect(tool.type).toBe("tool_use");
    if (tool.type === "tool_use") {
      expect(tool.name).toBe("exec");
      expect(tool.input).toEqual({ command: "echo probe-test-123" });
      // Result folded in from the later toolResult message.
      expect(tool.result?.content).toBe("probe-test-123");
      expect(tool.result?.durationMs).toBe(19); // from details.durationMs
    }
  });

  it("is pure — no filesystem access, safe on empty input", () => {
    expect(openclawLinesToLogEntries([])).toEqual([]);
  });
});

describe("OpenClaw transcript resolution", () => {
  it("session-id regex accepts UUIDs and rejects traversal / non-UUID", () => {
    expect(OPENCLAW_SESSION_ID_RE.test(UUID)).toBe(true);
    expect(OPENCLAW_SESSION_ID_RE.test("../../etc/passwd")).toBe(false);
    expect(OPENCLAW_SESSION_ID_RE.test("agent:main:main")).toBe(false);
    expect(OPENCLAW_SESSION_ID_RE.test("")).toBe(false);
  });

  it("discovers transcripts under agents/<id>/sessions and skips trajectory files", () => {
    const home = mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const sessions = join(home, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${UUID}.jsonl`), LINES.map((l) => JSON.stringify(l)).join("\n"));
    // Heavy OTel trace + pointer must be ignored.
    writeFileSync(join(sessions, `${UUID}.trajectory.jsonl`), "{}\n");
    writeFileSync(join(sessions, `${UUID}.trajectory-path.json`), "{}\n");
    const prev = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = home;
    try {
      const found = listOpenClawTranscripts();
      expect(found.map((t) => t.sessionId)).toEqual([UUID]);
      expect(found[0].agentId).toBe("main");
      expect(findOpenClawTranscript(UUID)).toBe(join(sessions, `${UUID}.jsonl`));
      // Traversal id never resolves.
      expect(findOpenClawTranscript("../../etc/passwd")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
