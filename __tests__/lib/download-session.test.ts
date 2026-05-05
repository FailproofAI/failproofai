// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

describe("lib/download-session: isValidSessionId", () => {
  let isValidSessionId: typeof import("@/lib/download-session").isValidSessionId;

  beforeEach(async () => {
    ({ isValidSessionId } = await import("@/lib/download-session"));
  });

  it("accepts UUIDs for non-opencode CLIs", () => {
    for (const cli of ["claude", "codex", "copilot", "cursor", "pi", "gemini"] as const) {
      expect(isValidSessionId(cli, VALID_UUID)).toBe(true);
      expect(isValidSessionId(cli, "ses_abc123")).toBe(false);
      expect(isValidSessionId(cli, "not-a-uuid")).toBe(false);
    }
  });

  it("accepts ses_* IDs for opencode and rejects UUIDs", () => {
    expect(isValidSessionId("opencode", "ses_21ad60d14ffewMeRRKMLdS7vOI")).toBe(true);
    expect(isValidSessionId("opencode", VALID_UUID)).toBe(false);
    expect(isValidSessionId("opencode", "ses_with-dash")).toBe(false);
  });
});

describe("lib/download-session: resolveDownloadSource", () => {
  let resolveDownloadSource: typeof import("@/lib/download-session").resolveDownloadSource;

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveDownloadSource } = await import("@/lib/download-session"));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/codex-sessions");
    vi.doUnmock("@/lib/copilot-sessions");
    vi.doUnmock("@/lib/cursor-sessions");
    vi.doUnmock("@/lib/pi-sessions");
    vi.doUnmock("@/lib/gemini-sessions");
    vi.doUnmock("@/lib/opencode-sessions");
  });

  it("throws RangeError on invalid session id", async () => {
    await expect(resolveDownloadSource("codex", "proj", "garbage")).rejects.toBeInstanceOf(RangeError);
    await expect(resolveDownloadSource("opencode", "proj", VALID_UUID)).rejects.toBeInstanceOf(RangeError);
  });

  it("Claude: resolves under the projects root via resolveSessionFilePath", async () => {
    const root = mkdtempSync(join(tmpdir(), "ffp-dl-claude-"));
    process.env.CLAUDE_PROJECTS_PATH = root;
    try {
      vi.resetModules();
      ({ resolveDownloadSource } = await import("@/lib/download-session"));
      const result = await resolveDownloadSource("claude", "proj", VALID_UUID);
      expect(result).toEqual({
        kind: "file",
        path: join(root, "proj", `${VALID_UUID}.jsonl`),
      });
    } finally {
      delete process.env.CLAUDE_PROJECTS_PATH;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Claude: rejects path-traversal project names with RangeError", async () => {
    const root = mkdtempSync(join(tmpdir(), "ffp-dl-claude-trav-"));
    process.env.CLAUDE_PROJECTS_PATH = root;
    try {
      vi.resetModules();
      ({ resolveDownloadSource } = await import("@/lib/download-session"));
      await expect(resolveDownloadSource("claude", "../etc", VALID_UUID)).rejects.toBeInstanceOf(RangeError);
    } finally {
      delete process.env.CLAUDE_PROJECTS_PATH;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["codex", "@/lib/codex-sessions", "findCodexTranscript"],
    ["copilot", "@/lib/copilot-sessions", "findCopilotTranscript"],
    ["cursor", "@/lib/cursor-sessions", "findCursorTranscript"],
    ["pi", "@/lib/pi-sessions", "findPiTranscript"],
    ["gemini", "@/lib/gemini-sessions", "findGeminiTranscript"],
  ] as const)(
    "%s: returns {kind:'file', path} when transcript is found",
    async (cli, modulePath, fnName) => {
      vi.doMock(modulePath, () => ({ [fnName]: () => "/tmp/fake.jsonl" }));
      vi.resetModules();
      const { resolveDownloadSource: rds } = await import("@/lib/download-session");
      const result = await rds(cli, "proj", VALID_UUID);
      expect(result).toEqual({ kind: "file", path: "/tmp/fake.jsonl" });
    },
  );

  it.each([
    ["codex", "@/lib/codex-sessions", "findCodexTranscript"],
    ["copilot", "@/lib/copilot-sessions", "findCopilotTranscript"],
    ["cursor", "@/lib/cursor-sessions", "findCursorTranscript"],
    ["pi", "@/lib/pi-sessions", "findPiTranscript"],
    ["gemini", "@/lib/gemini-sessions", "findGeminiTranscript"],
  ] as const)("%s: returns null when transcript is missing", async (cli, modulePath, fnName) => {
    vi.doMock(modulePath, () => ({ [fnName]: () => null }));
    vi.resetModules();
    const { resolveDownloadSource: rds } = await import("@/lib/download-session");
    const result = await rds(cli, "proj", VALID_UUID);
    expect(result).toBeNull();
  });

  it("OpenCode: emits a JSON document mirroring the SQLite session/message/part structure", async () => {
    const exportPayload = {
      session: { id: "ses_abc", project_id: "proj_1", slug: null, directory: "/tmp/p", title: "T", time_created: 1, time_updated: 2 },
      messages: [{ id: "m1", session_id: "ses_abc", time_created: 1, time_updated: 1, data: { role: "user" } }],
      parts: [{ id: "p1", message_id: "m1", session_id: "ses_abc", time_created: 1, time_updated: 1, data: { type: "text", text: "hi" } }],
    };
    vi.doMock("@/lib/opencode-sessions", () => ({
      getOpenCodeSessionExport: async () => exportPayload,
    }));
    vi.resetModules();
    const { resolveDownloadSource: rds } = await import("@/lib/download-session");
    const result = await rds("opencode", "proj", "ses_abc123");
    expect(result).toEqual({
      kind: "synthesized",
      body: JSON.stringify(exportPayload, null, 2) + "\n",
      contentType: "application/json",
      extension: "json",
    });
  });

  it("OpenCode: returns null when session is missing", async () => {
    vi.doMock("@/lib/opencode-sessions", () => ({
      getOpenCodeSessionExport: async () => null,
    }));
    vi.resetModules();
    const { resolveDownloadSource: rds } = await import("@/lib/download-session");
    const result = await rds("opencode", "proj", "ses_missing");
    expect(result).toBeNull();
  });
});

describe("lib/download-session: end-to-end fixture (codex)", () => {
  // Stage a real ~/.codex/sessions/.../<id>.jsonl under a tmp HOME and confirm
  // the dispatcher resolves to the file via the real findCodexTranscript().
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ffp-dl-fixture-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpHome };
    });
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpHome };
    });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("locates a codex transcript on disk and returns its path", async () => {
    const dir = join(tmpHome, ".codex", "sessions", "2026", "05", "05");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `rollout-2026-05-05T00-00-00-${VALID_UUID}.jsonl`);
    writeFileSync(filePath, '{"timestamp":"2026-05-05T00:00:00.000Z","type":"session_meta","payload":{}}\n');

    const { resolveDownloadSource: rds } = await import("@/lib/download-session");
    const result = await rds("codex", "ignored", VALID_UUID);
    expect(result).toEqual({ kind: "file", path: filePath });
  });
});
