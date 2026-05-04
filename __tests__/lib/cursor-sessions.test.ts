// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

describe("lib/cursor-sessions: parseCursorLog", () => {
  let parseCursorLog: typeof import("@/lib/cursor-sessions").parseCursorLog;

  beforeEach(async () => {
    ({ parseCursorLog } = await import("@/lib/cursor-sessions"));
  });

  it("returns empty for empty input", async () => {
    const result = await parseCursorLog("");
    expect(result.entries).toEqual([]);
    expect(result.rawLines).toEqual([]);
    expect(result.cwd).toBeUndefined();
  });

  it("emits 'Session Started' for the first session.start, 'Session Resumed' on subsequent", async () => {
    const content = [
      line({
        type: "session.start",
        data: { context: { cwd: "/r1" } },
        timestamp: "2026-04-29T00:00:00.000Z",
      }),
      line({
        type: "session.start",
        data: { context: { cwd: "/r2" } },
        timestamp: "2026-04-29T00:00:01.000Z",
      }),
    ].join("\n");
    const { entries, cwd } = await parseCursorLog(content);
    const queueOps = entries.filter((e) => e.type === "queue-operation");
    expect(queueOps).toHaveLength(2);
    expect(queueOps[0]).toMatchObject({ label: "Session Started" });
    expect(queueOps[1]).toMatchObject({ label: "Session Resumed" });
    expect(cwd).toBe("/r1");
  });

  it("accepts the camelCase 'sessionStart' record-type variant", async () => {
    const content = line({
      type: "sessionStart",
      data: { workspace_roots: ["/from-roots"] },
      timestamp: "2026-04-29T00:00:00.000Z",
    });
    const { entries, cwd } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("queue-operation");
    // Falls back to workspace_roots[0] when context.cwd absent.
    expect(cwd).toBe("/from-roots");
  });

  it("renders user.message as a user entry", async () => {
    const content = line({
      type: "user.message",
      data: { content: "fix it" },
      timestamp: "2026-04-29T00:00:00.000Z",
    });
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    const u = entries[0];
    if (u.type !== "user") throw new Error("expected user");
    expect(u.message.content).toBe("fix it");
  });

  it("renders assistant.message as an assistant text entry", async () => {
    const content = line({
      type: "assistant.message",
      data: { content: "4" },
      timestamp: "2026-04-29T00:00:00.000Z",
    });
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    const a = entries[0];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "text") throw new Error("expected text block");
    expect(block.text).toBe("4");
  });

  it("pairs tool.execution_start with tool.execution_complete via toolCallId", async () => {
    const content = [
      line({
        type: "tool.execution_start",
        data: { toolCallId: "call_abc", toolName: "bash", arguments: { command: "ls" } },
        timestamp: "2026-04-29T00:00:00.000Z",
      }),
      line({
        type: "tool.execution_complete",
        data: {
          toolCallId: "call_abc",
          success: true,
          result: { content: "ok\n", detailedContent: "ok\n<exited 0>" },
          duration: 20,
        },
        timestamp: "2026-04-29T00:00:01.000Z",
      }),
    ].join("\n");
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    const a = entries[0];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "tool_use") throw new Error("expected tool_use");
    expect(block.name).toBe("bash");
    expect(block.input).toEqual({ command: "ls" });
    expect(block.result?.durationMs).toBe(20);
    expect(block.result?.content).toBe("ok\n<exited 0>");
  });

  it("accepts the camelCase tool variant via tool_use_id + tool_name + tool_input", async () => {
    const content = [
      line({
        type: "preToolUse",
        data: { tool_use_id: "tu_1", tool_name: "Bash", tool_input: { command: "echo" } },
        timestamp: "2026-04-29T00:00:00.000Z",
      }),
      line({
        type: "postToolUse",
        data: { tool_use_id: "tu_1", tool_output: "echo\n" },
        timestamp: "2026-04-29T00:00:00.250Z",
      }),
    ].join("\n");
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    const a = entries[0];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "tool_use") throw new Error("expected tool_use");
    expect(block.name).toBe("Bash");
    expect(block.input).toEqual({ command: "echo" });
    expect(block.result?.content).toBe("echo\n");
    // No duration field — falls back to timestamp diff.
    expect(block.result?.durationMs).toBe(250);
  });

  it("preserves unknown record types as system entries", async () => {
    const content = [
      line({
        type: "system.message",
        data: { content: "x" },
        timestamp: "2026-04-29T00:00:00.000Z",
      }),
      line({
        type: "future.unknown_event",
        data: {},
        timestamp: "2026-04-29T00:00:01.000Z",
      }),
    ].join("\n");
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.type === "system")).toBe(true);
  });

  it("orphan tool.execution_complete is preserved as system", async () => {
    const content = line({
      type: "tool.execution_complete",
      data: { toolCallId: "ghost", result: { content: "x" } },
      timestamp: "2026-04-29T00:00:00.000Z",
    });
    const { entries } = await parseCursorLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("system");
  });

  it("skips records with missing timestamp or invalid JSON", async () => {
    const content = [
      "not json",
      line({ type: "user.message", data: { content: "no ts" } }),
      line({ type: "user.message", data: { content: "valid" }, timestamp: "2026-04-29T00:00:00.000Z" }),
    ].join("\n");
    const { entries, rawLines } = await parseCursorLog(content);
    expect(rawLines).toHaveLength(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
  });
});

describe("lib/cursor-sessions: findCursorTranscript + getCursorSessionLog", () => {
  let originalHome: string | undefined;
  let originalCursorHome: string | undefined;
  let fakeHome: string;
  let findCursorTranscript: typeof import("@/lib/cursor-sessions").findCursorTranscript;
  let getCursorSessionLog: typeof import("@/lib/cursor-sessions").getCursorSessionLog;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalCursorHome = process.env.CURSOR_HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "cursor-sessions-"));
    process.env.HOME = fakeHome;
    delete process.env.CURSOR_HOME;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => fakeHome };
    });
    ({ findCursorTranscript, getCursorSessionLog } = await import("@/lib/cursor-sessions"));
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    if (originalCursorHome !== undefined) process.env.CURSOR_HOME = originalCursorHome;
    rmSync(fakeHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("returns null when ~/.cursor/<sub> does not exist", () => {
    expect(findCursorTranscript("nope")).toBeNull();
  });

  it("returns null for empty session id", () => {
    expect(findCursorTranscript("")).toBeNull();
  });

  it("rejects path-traversal session ids that would escape the session-state root", () => {
    expect(findCursorTranscript("../../etc")).toBeNull();
    expect(findCursorTranscript("..")).toBeNull();
    expect(findCursorTranscript("/absolute/path")).toBeNull();
  });

  it.each(["agent-sessions", "conversations", "sessions"])(
    "locates events.jsonl under ~/.cursor/%s/<id>/",
    (sub) => {
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const dir = join(fakeHome, ".cursor", sub, sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "");
      expect(findCursorTranscript(sessionId)).toBe(join(dir, "events.jsonl"));
    },
  );

  it("getCursorSessionLog parses the transcript and returns cwd from session.start", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const dir = join(fakeHome, ".cursor", "agent-sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    const event = JSON.stringify({
      type: "session.start",
      data: { context: { cwd: "/proj" } },
      timestamp: "2026-04-29T00:00:00.000Z",
    });
    writeFileSync(join(dir, "events.jsonl"), event);
    const result = await getCursorSessionLog(sessionId);
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/proj");
    expect(result!.filePath).toBe(join(dir, "events.jsonl"));
  });

  it("getCursorSessionLog returns null when no transcript file is present", async () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const dir = join(fakeHome, ".cursor", "agent-sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    // No events.jsonl, transcript.jsonl, or messages.jsonl — directory is empty.
    const result = await getCursorSessionLog(sessionId);
    expect(result).toBeNull();
  });

  it("getCursorSessionLog returns null when readFile fails for the resolved path", async () => {
    // events.jsonl is a directory — existsSync passes, readFile throws EISDIR.
    const sessionId = "66666666-6666-6666-6666-666666666666";
    const dir = join(fakeHome, ".cursor", "agent-sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "events.jsonl"));
    const result = await getCursorSessionLog(sessionId);
    expect(result).toBeNull();
  });

  it("honors CURSOR_HOME when set", async () => {
    const altHome = mkdtempSync(join(tmpdir(), "cursor-alt-home-"));
    try {
      process.env.CURSOR_HOME = altHome;
      vi.resetModules();
      const { findCursorTranscript: ft } = await import("@/lib/cursor-sessions");
      const sessionId = "77777777-7777-7777-7777-777777777777";
      const dir = join(altHome, "agent-sessions", sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "");
      expect(ft(sessionId)).toBe(join(dir, "events.jsonl"));
    } finally {
      delete process.env.CURSOR_HOME;
      rmSync(altHome, { recursive: true, force: true });
    }
  });

  // Cursor 2026-04+ layout: ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
  it("locates the new layout transcript at projects/<cwd>/agent-transcripts/<id>/<id>.jsonl", () => {
    const sessionId = "88888888-8888-8888-8888-888888888888";
    const dir = join(fakeHome, ".cursor", "projects", "home-u-repo", "agent-transcripts", sessionId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, "");
    expect(findCursorTranscript(sessionId)).toBe(file);
  });

  it("getCursorSessionLog parses a 2026-04+ transcript ({role, message: {content: [...]}})", async () => {
    const sessionId = "99999999-9999-9999-9999-999999999999";
    const dir = join(fakeHome, ".cursor", "projects", "home-u-repo", "agent-transcripts", sessionId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            { type: "text", text: "<timestamp>Mon, May 4</timestamp>\n<user_query>\nhello\n</user_query>" },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "world" }] },
      }),
    ].join("\n");
    writeFileSync(file, lines);
    const result = await getCursorSessionLog(sessionId);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(2);
    const u = result!.entries[0];
    if (u.type !== "user") throw new Error("expected user");
    // <user_query> wrapper should be stripped, leaving "hello".
    expect(u.message.content).toBe("hello");
    const a = result!.entries[1];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "text") throw new Error("expected text block");
    expect(block.text).toBe("world");
  });
});
