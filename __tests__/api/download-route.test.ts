// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

function makeRequest(cli: string | null): NextRequest {
  const qs = cli ? `?cli=${cli}` : "";
  return new NextRequest(`http://localhost/api/download/proj/${VALID_UUID}${qs}`);
}

function makeParams(project = "proj", session = VALID_UUID) {
  return Promise.resolve({ project, session });
}

describe("api/download/[project]/[session] route", () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ffp-dl-route-"));
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECTS_PATH = join(tmpHome, ".claude", "projects");
    mkdirSync(process.env.CLAUDE_PROJECTS_PATH, { recursive: true });
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
    if (originalHome) process.env.HOME = originalHome;
    delete process.env.CLAUDE_PROJECTS_PATH;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.doUnmock("@/lib/codex-sessions");
    vi.doUnmock("@/lib/opencode-sessions");
    vi.doUnmock("node:os");
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("returns 400 for unknown cli", async () => {
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const res = await GET(makeRequest("bogus"), { params: makeParams() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Unknown cli");
  });

  it("returns 400 for malformed sessionId", async () => {
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const req = new NextRequest(`http://localhost/api/download/proj/garbage?cli=codex`);
    const res = await GET(req, { params: makeParams("proj", "garbage") });
    expect(res.status).toBe(400);
  });

  it("returns 404 when external CLI loader can't locate the session", async () => {
    vi.doMock("@/lib/codex-sessions", () => ({ findCodexTranscript: () => null }));
    vi.resetModules();
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const res = await GET(makeRequest("codex"), { params: makeParams() });
    expect(res.status).toBe(404);
  });

  it("streams a real on-disk codex transcript with correct headers", async () => {
    const dir = join(tmpHome, ".codex", "sessions", "2026", "05", "05");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `rollout-${VALID_UUID}.jsonl`);
    const content = '{"type":"session_meta","payload":{}}\n{"type":"event_msg","payload":{}}\n';
    writeFileSync(filePath, content);

    vi.resetModules();
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const res = await GET(makeRequest("codex"), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="${VALID_UUID}.jsonl"`);
    const body = await res.text();
    expect(body).toBe(content);
  });

  it("returns a JSON document for opencode sessions, with session/message/part tables preserved", async () => {
    const exportPayload = {
      session: { id: "ses_abc", project_id: "proj_1", slug: null, directory: "/tmp/p", title: "T", time_created: 1, time_updated: 2 },
      messages: [{ id: "m1", session_id: "ses_abc", time_created: 1, time_updated: 1, data: { role: "assistant" } }],
      parts: [{ id: "p1", message_id: "m1", session_id: "ses_abc", time_created: 1, time_updated: 1, data: { type: "text", text: "hi" } }],
    };
    vi.doMock("@/lib/opencode-sessions", () => ({
      getOpenCodeSessionExport: async () => exportPayload,
    }));
    vi.resetModules();
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const sessionId = "ses_abc123";
    const req = new NextRequest(`http://localhost/api/download/proj/${sessionId}?cli=opencode`);
    const res = await GET(req, { params: makeParams("proj", sessionId) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="${sessionId}.json"`);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(exportPayload);
  });

  it("defaults to claude when ?cli is omitted (back-compat)", async () => {
    const projectsPath = process.env.CLAUDE_PROJECTS_PATH!;
    const projectDir = join(projectsPath, "proj");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, `${VALID_UUID}.jsonl`);
    writeFileSync(filePath, '{"hello":"world"}\n');

    vi.resetModules();
    const { GET } = await import("@/app/api/download/[project]/[session]/route");
    const res = await GET(makeRequest(null), { params: makeParams() });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('{"hello":"world"}\n');
  });
});
