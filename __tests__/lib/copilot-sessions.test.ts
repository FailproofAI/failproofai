// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

describe("lib/copilot-sessions: parseCopilotLog", () => {
  let parseCopilotLog: typeof import("@/lib/copilot-sessions").parseCopilotLog;

  beforeEach(async () => {
    ({ parseCopilotLog } = await import("@/lib/copilot-sessions"));
  });

  it("returns empty for empty input", async () => {
    const result = await parseCopilotLog("");
    expect(result.entries).toEqual([]);
    expect(result.rawLines).toEqual([]);
    expect(result.cwd).toBeUndefined();
  });

  it("emits 'Session Started' for the first session.start, 'Session Resumed' on subsequent", async () => {
    const content = [
      line({
        type: "session.start",
        data: { sessionId: "x", context: { cwd: "/r1" } },
        id: "a",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
      line({
        type: "session.start",
        data: { sessionId: "x", context: { cwd: "/r2" } },
        id: "b",
        timestamp: "2026-04-29T00:00:01.000Z",
        parentId: null,
      }),
    ].join("\n");
    const { entries, cwd } = await parseCopilotLog(content);
    const queueOps = entries.filter((e) => e.type === "queue-operation");
    expect(queueOps).toHaveLength(2);
    expect(queueOps[0]).toMatchObject({ label: "Session Started" });
    expect(queueOps[1]).toMatchObject({ label: "Session Resumed" });
    // First session.start's cwd wins
    expect(cwd).toBe("/r1");
  });

  it("renders user.message as a user entry with content", async () => {
    const content = line({
      type: "user.message",
      data: { content: "fix it", transformedContent: "<ts>...</ts> fix it" },
      id: "u1",
      timestamp: "2026-04-29T00:00:00.000Z",
      parentId: null,
    });
    const { entries } = await parseCopilotLog(content);
    expect(entries).toHaveLength(1);
    const u = entries[0];
    if (u.type !== "user") throw new Error("expected user");
    expect(u.message.content).toBe("fix it");
  });

  it("renders assistant.message as an assistant text entry", async () => {
    const content = line({
      type: "assistant.message",
      data: { messageId: "m1", content: "4", toolRequests: [] },
      id: "a1",
      timestamp: "2026-04-29T00:00:00.000Z",
      parentId: null,
    });
    const { entries } = await parseCopilotLog(content);
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
        data: {
          toolCallId: "call_abc",
          toolName: "bash",
          arguments: { command: "ls", description: "list files" },
        },
        id: "ts1",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
      line({
        type: "tool.execution_complete",
        data: {
          toolCallId: "call_abc",
          model: "gpt-5-mini",
          interactionId: "i1",
          success: true,
          result: { content: "46\n", detailedContent: "46\n<exited with exit code 0>" },
          toolTelemetry: { metrics: { commandTimeMs: 20 } },
        },
        id: "tc1",
        timestamp: "2026-04-29T00:00:01.000Z",
        parentId: null,
      }),
    ].join("\n");
    const { entries } = await parseCopilotLog(content);
    // tool.execution_start emits an assistant entry with a tool_use block.
    // tool.execution_complete is stitched onto that block, so no second entry.
    expect(entries).toHaveLength(1);
    const a = entries[0];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "tool_use") throw new Error("expected tool_use");
    expect(block.name).toBe("bash");
    expect(block.input).toEqual({ command: "ls", description: "list files" });
    // Telemetry-reported duration overrides the timestamp diff.
    expect(block.result?.durationMs).toBe(20);
    expect(block.result?.content).toBe("46\n<exited with exit code 0>");
  });

  it("keeps the real PostToolUse output when the completion record is only a summary", async () => {
    const content = [
      line({
        type: "tool.execution_start",
        data: {
          toolCallId: "call_secret",
          toolName: "bash",
          arguments: { command: "node generate.js" },
        },
        id: "ts1",
        timestamp: "2026-09-09T00:00:00.000Z",
        parentId: null,
      }),
      line({
        type: "hook.start",
        data: {
          hookInvocationId: "hook1",
          hookType: "postToolUse",
          input: {
            toolName: "bash",
            toolArgs: { command: "node generate.js" },
            toolResult: {
              textResultForLlm: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
              sessionLog: "same model-visible output",
            },
          },
        },
        id: "hs1",
        timestamp: "2026-09-09T00:00:00.500Z",
        parentId: null,
      }),
      line({
        type: "tool.execution_complete",
        data: {
          toolCallId: "call_secret",
          success: true,
          result: { content: "Command completed", detailedContent: "Command completed successfully" },
          toolTelemetry: { metrics: { commandTimeMs: 750 } },
        },
        id: "tc1",
        timestamp: "2026-09-09T00:00:01.000Z",
        parentId: null,
      }),
    ].join("\n");

    const { entries } = await parseCopilotLog(content);
    const assistant = entries.find((entry) => entry.type === "assistant");
    if (!assistant || assistant.type !== "assistant") throw new Error("expected assistant");
    const block = assistant.message.content[0];
    if (block.type !== "tool_use") throw new Error("expected tool_use");
    expect(block.result?.content).toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(block.result?.durationMs).toBe(750);
  });

  it("falls back to timestamp-diff durationMs when telemetry is absent", async () => {
    const content = [
      line({
        type: "tool.execution_start",
        data: { toolCallId: "c", toolName: "t", arguments: {} },
        id: "1",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
      line({
        type: "tool.execution_complete",
        data: {
          toolCallId: "c",
          success: true,
          result: { content: "ok" },
        },
        id: "2",
        timestamp: "2026-04-29T00:00:00.500Z",
        parentId: null,
      }),
    ].join("\n");
    const { entries } = await parseCopilotLog(content);
    const a = entries[0];
    if (a.type !== "assistant") throw new Error("expected assistant");
    const block = a.message.content[0];
    if (block.type !== "tool_use") throw new Error("expected tool_use");
    expect(block.result?.durationMs).toBe(500);
  });

  it("preserves system.message and unknown record types as system entries", async () => {
    const content = [
      line({
        type: "system.message",
        data: { role: "system", content: "you are copilot" },
        id: "s1",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
      line({
        type: "session.model_change",
        data: { newModel: "gpt-5-mini" },
        id: "s2",
        timestamp: "2026-04-29T00:00:01.000Z",
        parentId: null,
      }),
      line({
        type: "future.unknown_event",
        data: { foo: 1 },
        id: "s3",
        timestamp: "2026-04-29T00:00:02.000Z",
        parentId: null,
      }),
    ].join("\n");
    const { entries } = await parseCopilotLog(content);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.type === "system")).toBe(true);
  });

  it("orphan tool.execution_complete (no preceding start) is preserved as system", async () => {
    const content = line({
      type: "tool.execution_complete",
      data: { toolCallId: "ghost", success: true, result: { content: "x" } },
      id: "t",
      timestamp: "2026-04-29T00:00:00.000Z",
      parentId: null,
    });
    const { entries } = await parseCopilotLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("system");
  });

  it("skips records with missing timestamp or invalid JSON", async () => {
    const content = [
      "not json",
      line({ type: "user.message", data: { content: "no ts" }, id: "x", parentId: null }),
      line({
        type: "user.message",
        data: { content: "valid" },
        id: "y",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
    ].join("\n");
    const { entries, rawLines } = await parseCopilotLog(content);
    // First line: malformed JSON, fully skipped (not in rawLines either).
    // Second: valid JSON but no timestamp — added to rawLines, no entry emitted.
    // Third: full valid record.
    expect(rawLines).toHaveLength(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
  });
});

describe("lib/copilot-sessions: findCopilotTranscript + getCopilotSessionLog", () => {
  let originalHome: string | undefined;
  let originalCopilotHome: string | undefined;
  let fakeHome: string;
  let findCopilotTranscript: typeof import("@/lib/copilot-sessions").findCopilotTranscript;
  let findCopilotWorkspace: typeof import("@/lib/copilot-sessions").findCopilotWorkspace;
  let readCopilotWorkspaceCwd: typeof import("@/lib/copilot-sessions").readCopilotWorkspaceCwd;
  let getCopilotSessionLog: typeof import("@/lib/copilot-sessions").getCopilotSessionLog;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalCopilotHome = process.env.COPILOT_HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "copilot-sessions-"));
    process.env.HOME = fakeHome;
    delete process.env.COPILOT_HOME;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => fakeHome };
    });
    ({
      findCopilotTranscript,
      findCopilotWorkspace,
      readCopilotWorkspaceCwd,
      getCopilotSessionLog,
    } = await import("@/lib/copilot-sessions"));
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    if (originalCopilotHome !== undefined) process.env.COPILOT_HOME = originalCopilotHome;
    rmSync(fakeHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("returns null when ~/.copilot/session-state does not exist", () => {
    expect(findCopilotTranscript("nope")).toBeNull();
    expect(findCopilotWorkspace("nope")).toBeNull();
  });

  it("returns null for empty session id", () => {
    expect(findCopilotTranscript("")).toBeNull();
    expect(findCopilotWorkspace("")).toBeNull();
  });

  it("rejects path-traversal session ids that would escape session-state/", () => {
    // Even pre-creating a real file via a traversal target should not be
    // returned, because the resolver rejects the candidate before existsSync.
    const escape = "../../etc";
    expect(findCopilotTranscript(escape)).toBeNull();
    expect(findCopilotWorkspace(escape)).toBeNull();
    expect(findCopilotTranscript("..")).toBeNull();
    expect(findCopilotTranscript("/absolute/path")).toBeNull();
  });

  it("locates events.jsonl and workspace.yaml under ~/.copilot/session-state/<id>/", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");
    writeFileSync(join(dir, "workspace.yaml"), "id: x\ncwd: /home/u/proj\n");
    expect(findCopilotTranscript(sessionId)).toBe(join(dir, "events.jsonl"));
    expect(findCopilotWorkspace(sessionId)).toBe(join(dir, "workspace.yaml"));
    expect(readCopilotWorkspaceCwd(sessionId)).toBe("/home/u/proj");
  });

  it("readCopilotWorkspaceCwd handles quoted values", () => {
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.yaml"), 'cwd: "/home/u/with space"\nid: x\n');
    expect(readCopilotWorkspaceCwd(sessionId)).toBe("/home/u/with space");
  });

  it("getCopilotSessionLog parses events.jsonl and returns cwd from session.start", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    const event = JSON.stringify({
      type: "session.start",
      data: { sessionId, context: { cwd: "/proj" } },
      id: "e1",
      timestamp: "2026-04-29T00:00:00.000Z",
      parentId: null,
    });
    writeFileSync(join(dir, "events.jsonl"), event);
    const result = await getCopilotSessionLog(sessionId);
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/proj");
    expect(result!.filePath).toBe(join(dir, "events.jsonl"));
  });

  it("getCopilotSessionLog falls back to workspace.yaml cwd when events.jsonl lacks session.start", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({
        type: "user.message",
        data: { content: "hi" },
        id: "u",
        timestamp: "2026-04-29T00:00:00.000Z",
        parentId: null,
      }),
    );
    writeFileSync(join(dir, "workspace.yaml"), "id: x\ncwd: /from/yaml\n");
    const result = await getCopilotSessionLog(sessionId);
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/from/yaml");
  });

  it("getCopilotSessionLog returns null when events.jsonl is absent", async () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    // workspace.yaml exists but events.jsonl doesn't (typical for sessions
    // that haven't had any user interaction yet).
    writeFileSync(join(dir, "workspace.yaml"), "cwd: /no/transcript\n");
    const result = await getCopilotSessionLog(sessionId);
    expect(result).toBeNull();
  });

  it("getCopilotSessionLog returns null when readFile fails for the resolved path", async () => {
    // Simulate the file being unreadable between findCopilotTranscript()'s
    // existsSync check and the async readFile — by making `events.jsonl` a
    // directory, existsSync still returns true but readFile throws EISDIR.
    // The function must preserve its nullable contract instead of throwing.
    const sessionId = "66666666-6666-6666-6666-666666666666";
    const dir = join(fakeHome, ".copilot", "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "events.jsonl"));
    writeFileSync(join(dir, "workspace.yaml"), "cwd: /will/not/be/reached\n");
    const result = await getCopilotSessionLog(sessionId);
    expect(result).toBeNull();
  });
});
