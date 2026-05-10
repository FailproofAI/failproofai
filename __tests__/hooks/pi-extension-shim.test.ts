/**
 * Tests for the pi-extension shim — focused on session-id resolution.
 *
 * Pi (verified empirically against pi-coding-agent v0.71.1) does NOT
 * populate `event.sessionId` on any event. The shim recovers the
 * sessionId by scanning the on-disk transcript at
 * `~/.pi/agent/sessions/<encodedCwd>/<isoTimestamp>_<uuid>.jsonl` and
 * caches the result.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CapturedCall {
  payload: Record<string, unknown>;
  args: string[];
}

interface PiExtensionApi {
  on(event: string, handler: (event: unknown) => unknown): void;
}

const captured: CapturedCall[] = [];

/** Per-event stdout reply queue for the spawnSync mock. Tests that need
 *  to simulate a binary deny set `mockSpawnReplyByEvent[<eventName>]`
 *  to a JSON string before invoking the matching handler. Any event not
 *  in the map gets the default empty stdout. */
const mockSpawnReplyByEvent: Record<string, string | undefined> = {};

function eventNameFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--hook");
  return i >= 0 ? args[i + 1] : undefined;
}

vi.mock("node:child_process", () => ({
  spawnSync: (_cmd: string, args: string[], opts: { input?: string }) => {
    captured.push({ args: args ?? [], payload: JSON.parse(opts?.input ?? "{}") });
    const evt = eventNameFromArgs(args ?? []);
    const stdout = (evt && mockSpawnReplyByEvent[evt]) ?? "";
    return { pid: 0, output: [], status: 0, signal: null, stderr: "", stdout };
  },
}));

function piEncodeCwd(cwd: string): string {
  return `--${cwd.replace(/^\/+/, "").replace(/\//g, "-")}--`;
}

describe("pi-extension shim — sessionId resolution via on-disk discovery", () => {
  let handlers: Record<string, (event: unknown) => unknown> = {};
  let bridge: (pi: PiExtensionApi) => void;
  let piRoot: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    captured.length = 0;
    for (const k of Object.keys(mockSpawnReplyByEvent)) delete mockSpawnReplyByEvent[k];
    handlers = {};
    piRoot = mkdtempSync(join(tmpdir(), "pi-shim-test-"));
    originalEnv = process.env.PI_SESSIONS_DIR;
    process.env.PI_SESSIONS_DIR = piRoot;
    vi.resetModules();
    const mod = await import("../../pi-extension/index");
    bridge = mod.default;
    bridge({ on: (name, fn) => { handlers[name] = fn; } });
  });

  function writeSessionFile(cwd: string, sessionId: string, ts = "2026-05-04T20-00-00-000Z", mtime?: Date): void {
    const dir = join(piRoot, piEncodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ts}_${sessionId}.jsonl`);
    writeFileSync(file, "{}\n");
    if (mtime) utimesSync(file, mtime, mtime);
  }

  it("uses event-level sessionId when present", () => {
    writeSessionFile("/proj", "11111111-1111-1111-1111-111111111111");
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: { command: "ls" }, cwd: "/proj", sessionId: "explicit" });
    expect(captured.at(-1)?.payload.session_id).toBe("explicit");
  });

  it("discovers sessionId from the on-disk transcript when event omits it", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    writeSessionFile("/proj", sid);
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: { command: "ls" }, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
  });

  it("picks the newest file when multiple sessions exist for a cwd", () => {
    // Both files must be after PROCESS_START_MS (- 2s tolerance) to be
    // considered current; we still want one to be older than the other.
    const now = Date.now();
    writeSessionFile("/proj", "33333333-3333-3333-3333-333333333333", "2026-05-01T00-00-00-000Z", new Date(now));
    writeSessionFile("/proj", "44444444-4444-4444-4444-444444444444", "2026-05-04T20-00-00-000Z", new Date(now + 5_000));
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("returns undefined when no transcript exists yet", () => {
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/no-such-cwd" });
    expect(captured.at(-1)?.payload.session_id).toBeUndefined();
  });

  it("session_start, input, tool_result, agent_end, session_shutdown all resolve", () => {
    const sid = "55555555-5555-5555-5555-555555555555";
    writeSessionFile("/proj", sid);
    handlers.session_start({ type: "session_start", cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
    handlers.input({ type: "input", text: "hi", cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
    handlers.tool_result({ type: "tool_result", toolName: "bash", input: {}, content: [], isError: false, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
    handlers.session_shutdown({ type: "session_shutdown", reason: "quit", cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
  });

  it("clears the per-cwd cache on session_shutdown reason=new/resume/fork", () => {
    const sid1 = "11111111-1111-1111-1111-111111111111";
    const sid2 = "22222222-2222-2222-2222-222222222222";
    const now = Date.now();
    writeSessionFile("/proj", sid1, "2026-05-01T00-00-00-000Z", new Date(now));
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid1);
    // Pi shuts down with reason="new" — next event in same process should
    // re-discover (a newer file got added) instead of returning the cache.
    handlers.session_shutdown({ type: "session_shutdown", reason: "new", cwd: "/proj" });
    writeSessionFile("/proj", sid2, "2026-05-04T00-00-00-000Z", new Date(now + 10_000));
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid2);
  });

  it("does NOT clear the cache on session_shutdown reason=quit", () => {
    const sid = "33333333-3333-3333-3333-333333333333";
    writeSessionFile("/proj", sid);
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj" });
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
    handlers.session_shutdown({ type: "session_shutdown", reason: "quit", cwd: "/proj" });
    // After quit, the SessionEnd record itself uses the cached id (good).
    expect(captured.at(-1)?.payload.session_id).toBe(sid);
  });

  it("ignores stale pre-existing transcripts on cold start (CodeRabbit follow-up)", async () => {
    // Set up: transcript dir already has an OLD session file, mtime well
    // before this test's module-load time. The shim must NOT cache that
    // UUID — every event before the current session's file appears should
    // return undefined, and only the new file should populate the cache.
    const oldSid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const newSid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    // Old file: mtime ~1 hour before now (well past STALE_TOLERANCE_MS=2s).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    writeSessionFile("/cold-start-cwd", oldSid, "2026-05-01T00-00-00-000Z", oneHourAgo);

    // Re-import the shim so PROCESS_START_MS is "now" relative to the old file.
    vi.resetModules();
    const mod = await import("../../pi-extension/index");
    const handlers2: Record<string, (event: unknown) => unknown> = {};
    mod.default({ on: (name, fn) => { handlers2[name] = fn; } });
    captured.length = 0;

    handlers2.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/cold-start-cwd" });
    expect(captured.at(-1)?.payload.session_id).toBeUndefined();

    // Now Pi creates the current session's file (mtime "now").
    writeSessionFile("/cold-start-cwd", newSid, "2026-05-04T20-00-00-000Z", new Date());
    handlers2.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/cold-start-cwd" });
    expect(captured.at(-1)?.payload.session_id).toBe(newSid);
  });

  it("isolates caches per cwd — sessionId from /proj-A doesn't bleed into /proj-B", () => {
    const a = "44444444-4444-4444-4444-444444444444";
    const b = "55555555-5555-5555-5555-555555555555";
    writeSessionFile("/proj-A", a);
    writeSessionFile("/proj-B", b);
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj-A" });
    expect(captured.at(-1)?.payload.session_id).toBe(a);
    handlers.tool_call({ type: "tool_call", toolName: "bash", input: {}, cwd: "/proj-B" });
    expect(captured.at(-1)?.payload.session_id).toBe(b);
  });

  it("translates Pi `path` arg to Claude `file_path` for read tool", () => {
    // Regression for the same arg-key canonicalization gap that bit OpenCode:
    // Pi's read tool delivers `{ path }`, but block-env-files /
    // block-secrets-write only check `tool_input.file_path`. Without the
    // PI_TOOL_INPUT_MAP, those policies silently no-op on Pi.
    handlers.tool_call({ type: "tool_call", toolName: "read", input: { path: "/etc/passwd", offset: 0, limit: 100 }, cwd: "/proj" });
    const payload = captured.at(-1)?.payload as { tool_name: string; tool_input: Record<string, unknown> };
    expect(payload.tool_name).toBe("Read");
    // path → file_path; unmapped offset/limit pass through unchanged.
    expect(payload.tool_input).toEqual({ file_path: "/etc/passwd", offset: 0, limit: 100 });
  });

  it("translates Pi `path` arg for write tool", () => {
    handlers.tool_call({ type: "tool_call", toolName: "write", input: { path: "/proj/.env", content: "SECRET=1" }, cwd: "/proj" });
    const payload = captured.at(-1)?.payload as { tool_name: string; tool_input: Record<string, unknown> };
    expect(payload.tool_name).toBe("Write");
    expect(payload.tool_input).toEqual({ file_path: "/proj/.env", content: "SECRET=1" });
  });

  it("translates Pi `path` for edit tool top-level only — nested edits[] stays Pi-shape", () => {
    // Pi's edit tool: { path, edits: [{oldText, newText}, …] } — different
    // structurally from Claude's flat { file_path, old_string, new_string }.
    // We can only translate the top-level `path` key; the nested array stays
    // as-is because it isn't a flat key→key rename.
    const edits = [{ oldText: "a", newText: "b" }];
    handlers.tool_call({ type: "tool_call", toolName: "edit", input: { path: "/proj/x", edits }, cwd: "/proj" });
    const payload = captured.at(-1)?.payload as { tool_name: string; tool_input: Record<string, unknown> };
    expect(payload.tool_name).toBe("Edit");
    expect(payload.tool_input).toEqual({ file_path: "/proj/x", edits });
  });

  it("passes unknown-tool args through unchanged", () => {
    handlers.tool_call({ type: "tool_call", toolName: "mcp_github_create_issue", input: { title: "x", path: "/literal/key" }, cwd: "/proj" });
    const payload = captured.at(-1)?.payload as { tool_name: string; tool_input: Record<string, unknown> };
    // Unknown tools (MCP / extensions) keep their raw arg shape — we don't
    // rewrite keys we can't claim to understand.
    expect(payload.tool_input).toEqual({ title: "x", path: "/literal/key" });
  });

  it("tool_result also canonicalizes input args", () => {
    handlers.tool_result({ type: "tool_result", toolName: "write", input: { path: "/proj/x", content: "hi" }, content: [], isError: false, cwd: "/proj" });
    const payload = captured.at(-1)?.payload as { tool_name: string; tool_input: Record<string, unknown> };
    expect(payload.tool_name).toBe("Write");
    expect(payload.tool_input).toEqual({ file_path: "/proj/x", content: "hi" });
  });

  it("PI_TOOL_INPUT_MAP coverage parity with the inline shim map", async () => {
    // Drives every entry in the exported map through the shim to keep the
    // two copies in sync — same pattern as the OPENCODE_TOOL_INPUT_MAP test.
    const { PI_TOOL_INPUT_MAP } = await import("../../src/hooks/types");
    const rawByCanonical: Record<string, string> = { Read: "read", Write: "write", Edit: "edit" };
    for (const canonical of Object.keys(PI_TOOL_INPUT_MAP)) {
      const raw = rawByCanonical[canonical];
      const map = PI_TOOL_INPUT_MAP[canonical];
      const args: Record<string, unknown> = {};
      for (const camel of Object.keys(map)) args[camel] = `v_${camel}`;
      handlers.tool_call({ type: "tool_call", toolName: raw, input: args, cwd: "/proj" });
      const payload = captured.at(-1)?.payload as { tool_input: Record<string, unknown> };
      for (const camel of Object.keys(map)) {
        expect(payload.tool_input[map[camel]]).toBe(`v_${camel}`);
        expect(payload.tool_input[camel]).toBeUndefined();
      }
    }
  });

  // Cleanup
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = originalEnv;
    rmSync(piRoot, { recursive: true, force: true });
  });
});

/**
 * Pi cannot veto `agent_end` directly (Pi's AgentEndEvent has no Result type).
 * The shim captures any deny reason and re-injects it as a `systemPrompt`
 * suffix on the next `before_agent_start`. These tests cover that handoff.
 */
describe("pi-extension shim — agent_end → before_agent_start stop-block handoff", () => {
  let handlers: Record<string, (event: unknown) => unknown> = {};
  let piRoot: string;
  let originalEnv: string | undefined;
  const SID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  beforeEach(async () => {
    captured.length = 0;
    for (const k of Object.keys(mockSpawnReplyByEvent)) delete mockSpawnReplyByEvent[k];
    handlers = {};
    piRoot = mkdtempSync(join(tmpdir(), "pi-shim-handoff-"));
    originalEnv = process.env.PI_SESSIONS_DIR;
    process.env.PI_SESSIONS_DIR = piRoot;
    // Seed a transcript so resolveSessionId returns a stable id.
    const dir = join(piRoot, piEncodeCwd("/proj"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-05-09T00-00-00-000Z_${SID}.jsonl`), "{}\n");
    vi.resetModules();
    const mod = await import("../../pi-extension/index");
    mod.default({ on: (name, fn) => { handlers[name] = fn; } });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = originalEnv;
    rmSync(piRoot, { recursive: true, force: true });
  });

  it("agent_end deny is captured and drained on next before_agent_start as a systemPrompt suffix", () => {
    mockSpawnReplyByEvent["agent_end"] = JSON.stringify({
      permission: "deny",
      reason: "MANDATORY ACTION REQUIRED from failproofai (policy: require-commit-before-stop): commit now.",
    });
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    // No reply value from agent_end (Pi cannot veto stop).
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "next prompt",
      systemPrompt: "BASE",
      cwd: "/proj",
    }) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toBe(
      "BASE\n\nMANDATORY ACTION REQUIRED from failproofai (policy: require-commit-before-stop): commit now.",
    );
  });

  it("before_agent_start with no pending block returns undefined", () => {
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: "BASE",
      cwd: "/proj",
    });
    expect(result).toBeUndefined();
  });

  it("the stop-block is one-shot: a second before_agent_start in the same session does not re-fire", () => {
    mockSpawnReplyByEvent["agent_end"] = JSON.stringify({ permission: "deny", reason: "X" });
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    const first = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "B", cwd: "/proj" }) as { systemPrompt?: string };
    expect(first?.systemPrompt).toBe("B\n\nX");
    const second = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "B", cwd: "/proj" });
    expect(second).toBeUndefined();
  });

  it("session_shutdown clears the pending stop-block (quit reason too, not just new/resume/fork)", () => {
    mockSpawnReplyByEvent["agent_end"] = JSON.stringify({ permission: "deny", reason: "X" });
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    handlers.session_shutdown({ type: "session_shutdown", reason: "quit", cwd: "/proj" });
    // Even though `quit` retains the cached sessionId, the pending block must
    // be dropped so a future before_agent_start (e.g. in the next session
    // started in this process) doesn't inherit a stale gate.
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      systemPrompt: "B",
      cwd: "/proj",
    });
    expect(result).toBeUndefined();
  });

  it("agent_end with allow stdout (empty reason) does NOT set a pending block", () => {
    // Default mock returns empty stdout → callPolicy returns {block:false}.
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      systemPrompt: "B",
      cwd: "/proj",
    });
    expect(result).toBeUndefined();
  });

  it("before_agent_start without a resolvable sessionId is a no-op", () => {
    // Use a cwd that has no on-disk transcript — sessionId discovery returns
    // undefined and the handler must early-return without throwing.
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      systemPrompt: "B",
      cwd: "/no-such-cwd",
    });
    expect(result).toBeUndefined();
  });

  it("before_agent_start with no systemPrompt in the event still injects (uses empty base)", () => {
    mockSpawnReplyByEvent["agent_end"] = JSON.stringify({ permission: "deny", reason: "Y" });
    handlers.agent_end({ type: "agent_end", cwd: "/proj" });
    const result = handlers.before_agent_start({
      type: "before_agent_start",
      cwd: "/proj",
    }) as { systemPrompt?: string };
    expect(result?.systemPrompt).toBe("\n\nY");
  });
});

import { afterEach } from "vitest";
