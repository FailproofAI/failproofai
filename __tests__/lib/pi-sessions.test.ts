// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});
