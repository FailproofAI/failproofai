// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantEntry, ContentBlock, ToolUseBlock } from "@/lib/log-entries";

const SAFE_UUID = "00000000-0000-4000-8000-000000000001";
const SECOND_UUID = "00000000-0000-4000-8000-000000000002";

function sessionRecord(id: string, cwd: string, ts = "2026-05-01T20:36:22.628Z"): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd });
}

function messageRecord(role: "user" | "assistant", text: string, ts = "2026-05-01T20:36:23.000Z"): string {
  return JSON.stringify({
    type: "message",
    id: "msg-" + Math.random().toString(36).slice(2, 10),
    timestamp: ts,
    message: { role, content: [{ type: "text", text }] },
  });
}

describe("lib/pi-sessions", () => {
  let originalHome: string | undefined;
  let originalSessionsDir: string | undefined;
  let fakeHome: string;
  let mod: typeof import("@/lib/pi-sessions");

  function writeSession(sessionId: string, cwd: string, additionalLines: string[] = []): string {
    const root = join(fakeHome, ".pi", "agent", "sessions");
    const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    const dir = join(root, encoded);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-05-01T20-36-22-628Z_${sessionId}.jsonl`);
    const lines = [sessionRecord(sessionId, cwd), ...additionalLines];
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalSessionsDir = process.env.PI_SESSIONS_DIR;
    fakeHome = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    process.env.HOME = fakeHome;
    delete process.env.PI_SESSIONS_DIR;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });
    mod = await import("@/lib/pi-sessions");
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalSessionsDir !== undefined) process.env.PI_SESSIONS_DIR = originalSessionsDir;
    else delete process.env.PI_SESSIONS_DIR;
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  describe("findPiTranscript", () => {
    it("finds the transcript by sessionId UUID across cwd subdirs", () => {
      const path = writeSession(SAFE_UUID, "/home/u/repo");
      expect(mod.findPiTranscript(SAFE_UUID)).toBe(path);
    });

    it("returns null when no matching session file exists", () => {
      writeSession(SAFE_UUID, "/home/u/repo");
      expect(mod.findPiTranscript(SECOND_UUID)).toBeNull();
    });

    it("returns null when sessions root doesn't exist", () => {
      expect(mod.findPiTranscript(SAFE_UUID)).toBeNull();
    });

    it("rejects sessionId with path traversal — `../foo`", () => {
      // No file written; the rejection happens regardless via the UUID regex.
      expect(mod.findPiTranscript("../foo")).toBeNull();
    });

    it("rejects sessionId `..`", () => {
      expect(mod.findPiTranscript("..")).toBeNull();
    });

    it("rejects absolute sessionId `/etc/passwd`", () => {
      expect(mod.findPiTranscript("/etc/passwd")).toBeNull();
    });

    it("rejects empty sessionId", () => {
      expect(mod.findPiTranscript("")).toBeNull();
    });

    it("accepts a valid UUID", () => {
      const path = writeSession(SAFE_UUID, "/home/u/repo");
      expect(mod.findPiTranscript(SAFE_UUID)).toBe(path);
    });
  });

  describe("getPiSessionLog", () => {
    it("parses session record into cwd + a Session-Started entry", async () => {
      writeSession(SAFE_UUID, "/home/u/repo");
      const result = await mod.getPiSessionLog(SAFE_UUID);
      expect(result).not.toBeNull();
      expect(result!.cwd).toBe("/home/u/repo");
      expect(result!.entries[0]?.type).toBe("queue-operation");
    });

    it("parses user.message records as user entries", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [messageRecord("user", "hello")]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const userEntries = result!.entries.filter((e) => e.type === "user");
      expect(userEntries).toHaveLength(1);
      // Type is `user` so message.content is a string for user messages.
      expect((userEntries[0] as { message: { content: string } }).message.content).toBe("hello");
    });

    it("parses assistant.message records as assistant entries with text content blocks", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [
        messageRecord("assistant", "I will help."),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const asst = result!.entries.find((e) => e.type === "assistant");
      expect(asst).toBeDefined();
    });

    it("ignores non-string text content via typeof guard", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [
        JSON.stringify({
          type: "message",
          id: "x",
          timestamp: "2026-05-01T20:36:23.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: { malicious: "object" } }],
          },
        }),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      // Non-string text is skipped → no user entry surfaces from this record.
      const userEntries = result!.entries.filter((e) => e.type === "user");
      expect(userEntries).toHaveLength(0);
    });

    it("preserves unknown record types as system entries (does not silently drop)", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [
        JSON.stringify({
          type: "model_change",
          id: "mc1",
          timestamp: "2026-05-01T20:36:23.000Z",
          provider: "openai",
          modelId: "gpt-5",
        }),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const systemEntries = result!.entries.filter((e) => e.type === "system");
      expect(systemEntries.length).toBeGreaterThan(0);
    });

    it("returns gracefully when JSONL has unparseable garbage as the only line", async () => {
      // Write a transcript file whose only line is invalid JSON. The parser
      // should skip it and produce an empty entries array, NOT throw.
      const root = join(fakeHome, ".pi", "agent", "sessions");
      const dir = join(root, "--home-u-broken--");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `2026-05-01T20-36-22-628Z_${SAFE_UUID}.jsonl`);
      writeFileSync(path, "{not json\n");
      const result = await mod.getPiSessionLog(SAFE_UUID);
      expect(result).not.toBeNull();
      expect(result!.entries).toEqual([]);
    });

    it("returns null for unsafe sessionIds (path-traversal)", async () => {
      expect(await mod.getPiSessionLog("../foo")).toBeNull();
    });

    it("returns null when transcript file doesn't exist", async () => {
      expect(await mod.getPiSessionLog(SAFE_UUID)).toBeNull();
    });

    it("entries are sorted by timestamp ascending", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [
        messageRecord("user", "second", "2026-05-01T20:37:00.000Z"),
        messageRecord("assistant", "first", "2026-05-01T20:36:30.000Z"),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      expect(result!.entries[0].timestampMs).toBeLessThanOrEqual(result!.entries[1].timestampMs);
    });
  });

  describe("readPiTranscriptSync", () => {
    it("returns content for a valid sessionId", () => {
      writeSession(SAFE_UUID, "/home/u/repo");
      const text = mod.readPiTranscriptSync(SAFE_UUID);
      expect(text).toContain('"type":"session"');
    });

    it("returns null for unknown sessionId", () => {
      expect(mod.readPiTranscriptSync(SAFE_UUID)).toBeNull();
    });

    it("returns null for path-traversal attempts", () => {
      expect(mod.readPiTranscriptSync("../etc/passwd")).toBeNull();
    });
  });

  // Record shapes below are verbatim from a live pi capture (0.73.1 and
  // 0.83.0, driven against a real provider). Before this, `toolCall` blocks
  // fell through to the generic "system" branch, so every tool event pi
  // emitted was dropped — the parser looked correct because nothing asserted
  // on a tool-using transcript.
  describe("tool calls", () => {
    const CALL_A = "toolu_bdrk_01AWG5F1T6gf9BGKRb2h21bP";
    const CALL_B = "toolu_bdrk_01QoT5TiSRRs8mfJzcMSMPAe";

    function assistantContent(entries: Array<{ type: string }>): ContentBlock[] {
      const assistant = entries.find((e) => e.type === "assistant") as AssistantEntry | undefined;
      expect(assistant).toBeDefined();
      return assistant!.message.content;
    }


    function toolCallRecord(ts: string): string {
      return JSON.stringify({
        type: "message",
        id: "81470a2e",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: CALL_A, name: "bash", arguments: { command: "ls -la /tmp/probe-pi" } },
            { type: "toolCall", id: CALL_B, name: "read", arguments: { path: "/tmp/probe-pi/README.md" } },
          ],
          stopReason: "toolUse",
        },
      });
    }

    function toolResultRecord(callId: string, toolName: string, text: string, ts: string): string {
      return JSON.stringify({
        type: "message",
        id: "fe29ac29",
        parentId: "81470a2e",
        timestamp: ts,
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName,
          content: [{ type: "text", text }],
          isError: false,
          timestamp: Date.parse(ts),
        },
      });
    }

    it("parses toolCall blocks into tool_use blocks with their arguments", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [toolCallRecord("2026-05-01T20:36:30.000Z")]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const tools = assistantContent(result!.entries).filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ id: CALL_A, name: "bash", input: { command: "ls -la /tmp/probe-pi" } });
      expect(tools[1]).toMatchObject({ id: CALL_B, name: "read", input: { path: "/tmp/probe-pi/README.md" } });
    });

    it("attaches a toolResult to its call by id, not by position", async () => {
      // Results deliberately out of call order: pairing by position would put
      // the `read` output on the `bash` call and neither would be detectably
      // wrong from the shape alone.
      writeSession(SAFE_UUID, "/home/u/repo", [
        toolCallRecord("2026-05-01T20:36:30.000Z"),
        toolResultRecord(CALL_B, "read", "# Probe Pi", "2026-05-01T20:36:31.000Z"),
        toolResultRecord(CALL_A, "bash", "total 144", "2026-05-01T20:36:32.000Z"),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const tools = assistantContent(result!.entries).filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      expect(tools.find((t) => t.id === CALL_A)!.result!.content).toBe("total 144");
      expect(tools.find((t) => t.id === CALL_B)!.result!.content).toBe("# Probe Pi");
    });

    it("derives a duration from the call/result gap, since pi records none", async () => {
      writeSession(SAFE_UUID, "/home/u/repo", [
        toolCallRecord("2026-05-01T20:36:30.000Z"),
        toolResultRecord(CALL_A, "bash", "total 144", "2026-05-01T20:36:32.500Z"),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const tool = assistantContent(result!.entries).find(
        (b): b is ToolUseBlock => b.type === "tool_use" && b.id === CALL_A,
      );
      expect(tool!.result!.durationMs).toBe(2500);
    });

    it("keeps an orphan toolResult as a system entry rather than dropping it", async () => {
      // A result whose call is not in this file (truncated, or a resumed
      // session split across files) must still be preserved.
      writeSession(SAFE_UUID, "/home/u/repo", [
        toolResultRecord("toolu_never_seen", "bash", "orphaned", "2026-05-01T20:36:31.000Z"),
      ]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const system = result!.entries.filter((e) => e.type === "system");
      expect(system).toHaveLength(1);
    });

    it("handles 0.83.0's mixed text+toolCall assistant content", async () => {
      // 0.73.1 emitted ["toolCall","toolCall"]; 0.83.0 adds leading prose.
      // Assistant content must not be assumed homogeneous.
      const mixed = JSON.stringify({
        type: "message",
        id: "abc",
        timestamp: "2026-05-01T20:36:30.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look at that." },
            { type: "toolCall", id: CALL_A, name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "toolUse",
        },
      });
      writeSession(SAFE_UUID, "/home/u/repo", [mixed]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const content = assistantContent(result!.entries);
      expect(content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    });

    it("gives a toolCall with no id a synthetic one so it still renders", async () => {
      const noId = JSON.stringify({
        type: "message",
        id: "abc",
        timestamp: "2026-05-01T20:36:30.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
      });
      writeSession(SAFE_UUID, "/home/u/repo", [noId]);
      const result = await mod.getPiSessionLog(SAFE_UUID);
      const content = assistantContent(result!.entries);
      expect(content[0].type).toBe("tool_use");
      expect((content[0] as ToolUseBlock).id).toBeTruthy();
    });
  });
});
