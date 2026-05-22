// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

describe("lib/codex-sessions: parseCodexLog", () => {
  let parseCodexLog: typeof import("@/lib/codex-sessions").parseCodexLog;

  beforeEach(async () => {
    ({ parseCodexLog } = await import("@/lib/codex-sessions"));
  });

  it("maps a session_meta record to a system entry and surfaces cwd", async () => {
    const content = line({
      timestamp: "2026-04-28T23:35:20.265Z",
      type: "session_meta",
      payload: { id: "abc", cwd: "/home/u/proj", originator: "codex-tui" },
    });
    const result = await parseCodexLog(content);
    expect(result.cwd).toBe("/home/u/proj");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
  });

  it("emits 'Session Started' for the first task_started, 'Session Resumed' after", async () => {
    const content = [
      line({ timestamp: "2026-04-28T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      line({ timestamp: "2026-04-28T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
    ].join("\n");
    const { entries } = await parseCodexLog(content);
    const queueOps = entries.filter((e) => e.type === "queue-operation");
    expect(queueOps).toHaveLength(2);
    expect(queueOps[0]).toMatchObject({ label: "Session Started" });
    expect(queueOps[1]).toMatchObject({ label: "Session Resumed" });
  });

  it("renders user, developer, and assistant message records", async () => {
    const content = [
      line({
        timestamp: "2026-04-28T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      }),
      line({
        timestamp: "2026-04-28T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "system instructions" }],
        },
      }),
      line({
        timestamp: "2026-04-28T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi back" }],
        },
      }),
    ].join("\n");
    const { entries } = await parseCodexLog(content);
    const types = entries.map((e) => e.type);
    expect(types).toEqual(["user", "user", "assistant"]);
    const u1 = entries[0];
    if (u1.type !== "user") throw new Error("expected user");
    expect(u1.message.content).toBe("hello");
    const u2 = entries[1];
    if (u2.type !== "user") throw new Error("expected user");
    expect(u2.message.content).toBe("[developer] system instructions");
    const a = entries[2];
    if (a.type !== "assistant") throw new Error("expected assistant");
    expect(a.message.content[0]).toMatchObject({ type: "text", text: "hi back" });
  });

  it("pairs function_call with exec_command_end via call_id and computes durationMs", async () => {
    const content = [
      line({
        timestamp: "2026-04-28T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
          call_id: "call_X",
        },
      }),
      line({
        timestamp: "2026-04-28T00:00:00.500Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "call_X",
          aggregated_output: "file1\nfile2\n",
          duration: { secs: 0, nanos: 250_000_000 },
        },
      }),
    ].join("\n");
    const { entries } = await parseCodexLog(content);
    const a = entries.find((e) => e.type === "assistant");
    if (!a || a.type !== "assistant") throw new Error("expected assistant entry");
    const tu = a.message.content[0];
    expect(tu).toMatchObject({ type: "tool_use", name: "exec_command", id: "call_X", input: { cmd: "ls" } });
    if (tu.type !== "tool_use") throw new Error("expected tool_use");
    expect(tu.result?.content).toBe("file1\nfile2\n");
    expect(tu.result?.durationMs).toBe(250);
  });

  it("attaches function_call_output to the matching tool_use", async () => {
    const content = [
      line({
        timestamp: "2026-04-28T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "search",
          arguments: '{"q":"foo"}',
          call_id: "call_Y",
        },
      }),
      line({
        timestamp: "2026-04-28T00:00:00.100Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_Y", output: "result text" },
      }),
    ].join("\n");
    const { entries } = await parseCodexLog(content);
    const a = entries.find((e) => e.type === "assistant");
    if (!a || a.type !== "assistant") throw new Error("expected assistant entry");
    const tu = a.message.content[0];
    if (tu.type !== "tool_use") throw new Error("expected tool_use");
    expect(tu.result?.content).toBe("result text");
    expect(tu.result?.durationMs).toBe(100);
  });

  it("dedupes event_msg user_message and agent_message (already covered by response_item)", async () => {
    const content = [
      line({
        timestamp: "2026-04-28T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ask" }] },
      }),
      line({
        timestamp: "2026-04-28T00:00:00.001Z",
        type: "event_msg",
        payload: { type: "user_message", message: "ask" },
      }),
      line({
        timestamp: "2026-04-28T00:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ans" }] },
      }),
      line({
        timestamp: "2026-04-28T00:00:01.001Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "ans" },
      }),
    ].join("\n");
    const { entries } = await parseCodexLog(content);
    expect(entries.filter((e) => e.type === "user")).toHaveLength(1);
    expect(entries.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  it("falls back to a system entry for unknown record types", async () => {
    const content = line({
      timestamp: "2026-04-28T00:00:00.000Z",
      type: "turn_context",
      payload: { approval_policy: "never" },
    });
    const { entries } = await parseCodexLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("system");
  });

  it("skips malformed JSON lines without crashing", async () => {
    const content = [
      "not json",
      line({
        timestamp: "2026-04-28T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
      }),
    ].join("\n");
    const { entries, rawLines } = await parseCodexLog(content);
    expect(entries).toHaveLength(1);
    expect(rawLines).toHaveLength(1);
  });
});

describe("lib/codex-sessions: findCodexTranscript", () => {
  let originalHome: string | undefined;
  let fakeHome: string;
  let findCodexTranscript: typeof import("@/lib/codex-sessions").findCodexTranscript;
  let getCacheFilePath: typeof import("@/lib/codex-sessions")._getCacheFilePath;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    process.env.HOME = fakeHome;
    // Re-mock os.homedir() since lib/codex-sessions imports it once at module load
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });
    const mod = await import("@/lib/codex-sessions");
    findCodexTranscript = mod.findCodexTranscript;
    getCacheFilePath = mod._getCacheFilePath;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  it("returns null when no transcript exists for the sessionId", () => {
    const result = findCodexTranscript("missing-session");
    expect(result).toBeNull();
  });

  it("locates a transcript via today's date directory", () => {
    const sid = "019dd672-aaaa-7a30-8671-deadbeefcafe";
    const today = new Date();
    const y = String(today.getUTCFullYear());
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const d = String(today.getUTCDate()).padStart(2, "0");
    const dir = join(fakeHome, ".codex", "sessions", y, m, d);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${sid}.jsonl`);
    writeFileSync(file, "{}\n");

    const result = findCodexTranscript(sid);
    expect(result).toBe(file);
  });

  it("writes discovered transcript paths through the cache file", () => {
    const sid = "019dd672-cache-7a30-8671-deadbeefcafe";
    const today = new Date();
    const y = String(today.getUTCFullYear());
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const d = String(today.getUTCDate()).padStart(2, "0");
    const dir = join(fakeHome, ".codex", "sessions", y, m, d);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${sid}.jsonl`);
    writeFileSync(file, "{}\n");

    expect(findCodexTranscript(sid)).toBe(file);

    const cachePath = getCacheFilePath();
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ [sid]: file });
    expect(existsSync(`${cachePath}.${process.pid}.tmp`)).toBe(false);
    expect(readdirSync(dirname(cachePath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("locates a transcript via full tree scan when not in today/yesterday", () => {
    const sid = "019dd672-bbbb-7a30-8671-deadbeefcafe";
    const dir = join(fakeHome, ".codex", "sessions", "2024", "01", "15");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${sid}.jsonl`);
    writeFileSync(file, "{}\n");

    const result = findCodexTranscript(sid);
    expect(result).toBe(file);
  });
});

// Imports at the bottom for the test helpers above; primary imports happen
// dynamically inside beforeEach to support the `homedir` mock for the
// findCodexTranscript suite.
import "@/lib/codex-sessions";
