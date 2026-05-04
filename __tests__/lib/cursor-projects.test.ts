// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const metaJson = (cwd: string): string => JSON.stringify({ cwd });
const metaYaml = (cwd: string): string => `cwd: ${cwd}\n`;

describe("lib/cursor-projects", () => {
  let originalHome: string | undefined;
  let originalCursorHome: string | undefined;
  let fakeHome: string;
  let getCursorProjects: typeof import("@/lib/cursor-projects").getCursorProjects;
  let getCursorSessionsForCwd: typeof import("@/lib/cursor-projects").getCursorSessionsForCwd;
  let getCursorSessionsByEncodedName: typeof import("@/lib/cursor-projects").getCursorSessionsByEncodedName;

  /**
   * Write a synthetic cursor session under one of the candidate subdirectories
   * (`agent-sessions/`, `conversations/`, `sessions/`). `metaName` lets the
   * caller swap between meta.json / session.json / workspace.yaml so we cover
   * each fallback the scanner probes.
   */
  function writeSession(
    sessionId: string,
    cwd: string,
    opts?: {
      sub?: "agent-sessions" | "conversations" | "sessions";
      metaName?: "meta.json" | "session.json" | "workspace.json" | "workspace.yaml";
      events?: string;
      eventsName?: "events.jsonl" | "transcript.jsonl" | "messages.jsonl";
      metaMtime?: Date;
      eventsMtime?: Date;
    },
  ) {
    const sub = opts?.sub ?? "agent-sessions";
    const metaName = opts?.metaName ?? "meta.json";
    const dir = join(fakeHome, ".cursor", sub, sessionId);
    mkdirSync(dir, { recursive: true });
    const meta = join(dir, metaName);
    writeFileSync(meta, metaName.endsWith(".yaml") ? metaYaml(cwd) : metaJson(cwd));
    if (opts?.metaMtime) utimesSync(meta, opts.metaMtime, opts.metaMtime);
    if (opts?.events !== undefined) {
      const eventsName = opts?.eventsName ?? "events.jsonl";
      const ej = join(dir, eventsName);
      writeFileSync(ej, opts.events);
      if (opts?.eventsMtime) utimesSync(ej, opts.eventsMtime, opts.eventsMtime);
    }
    return dir;
  }

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalCursorHome = process.env.CURSOR_HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "cursor-projects-"));
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
    ({ getCursorProjects, getCursorSessionsForCwd, getCursorSessionsByEncodedName } = await import(
      "@/lib/cursor-projects"
    ));
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    if (originalCursorHome !== undefined) process.env.CURSOR_HOME = originalCursorHome;
    rmSync(fakeHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("returns [] when ~/.cursor/<sub> does not exist", async () => {
    const result = await getCursorProjects();
    expect(result).toEqual([]);
  });

  it("groups sessions by cwd into one ProjectFolder each", async () => {
    writeSession("11111111-1111-1111-1111-111111111111", "/home/u/proj-a", { events: "{}\n" });
    writeSession("22222222-2222-2222-2222-222222222222", "/home/u/proj-a", { events: "{}\n" });

    const result = await getCursorProjects();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("-home-u-proj-a");
    expect(result[0].path).toBe("/home/u/proj-a");
    expect(result[0].cli).toEqual(["cursor"]);
    expect(result[0].isDirectory).toBe(true);
  });

  it.each(["agent-sessions", "conversations", "sessions"] as const)(
    "scans the %s subdirectory",
    async (sub) => {
      writeSession("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/home/u/from-" + sub, {
        sub,
        events: "{}\n",
      });
      const result = await getCursorProjects();
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/home/u/from-" + sub);
    },
  );

  it.each(["meta.json", "session.json", "workspace.json", "workspace.yaml"] as const)(
    "reads cwd from %s",
    async (metaName) => {
      writeSession("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/home/u/from-" + metaName, {
        metaName,
        events: "{}\n",
      });
      const result = await getCursorProjects();
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/home/u/from-" + metaName);
    },
  );

  it.each(["events.jsonl", "transcript.jsonl", "messages.jsonl"] as const)(
    "accepts %s as the transcript file",
    async (eventsName) => {
      writeSession("cccccccc-cccc-cccc-cccc-cccccccccccc", "/home/u/proj", {
        events: "{}\n",
        eventsName,
      });
      const result = await getCursorProjects();
      expect(result).toHaveLength(1);
    },
  );

  it("returns one entry per distinct cwd, sorted newest-first", async () => {
    const old = new Date("2024-01-01T00:00:00Z");
    const recent = new Date("2026-06-15T00:00:00Z");
    writeSession("dddddddd-dddd-dddd-dddd-dddddddddddd", "/home/u/old", {
      events: "{}\n",
      metaMtime: old,
      eventsMtime: old,
    });
    writeSession("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "/home/u/new", {
      events: "{}\n",
      metaMtime: recent,
      eventsMtime: recent,
    });

    const result = await getCursorProjects();
    expect(result.map((p) => p.path)).toEqual(["/home/u/new", "/home/u/old"]);
  });

  it("skips sessions that have metadata but no transcript file", async () => {
    // Session with meta.json only — should not show up in /projects (would
    // click through to an empty session list otherwise).
    writeSession("ffffffff-ffff-ffff-ffff-ffffffffffff", "/home/u/empty");
    const result = await getCursorProjects();
    expect(result).toEqual([]);
  });

  it("getCursorSessionsForCwd returns matching sessions", async () => {
    writeSession("11112222-3333-4444-5555-666677778888", "/home/u/proj", { events: "{}\n" });
    writeSession("aaaabbbb-cccc-dddd-eeee-ffff00001111", "/home/u/other", { events: "{}\n" });
    const matches = await getCursorSessionsForCwd("/home/u/proj");
    expect(matches).toHaveLength(1);
    expect(matches[0].sessionId).toBe("11112222-3333-4444-5555-666677778888");
    expect(matches[0].cli).toBe("cursor");
  });

  it("getCursorSessionsByEncodedName recovers cwd via re-encoding", async () => {
    writeSession("12121212-1212-1212-1212-121212121212", "/home/u/proj-with-dash", { events: "{}\n" });
    const slug = "-home-u-proj-with-dash";
    const result = await getCursorSessionsByEncodedName(slug);
    expect(result.cwd).toBe("/home/u/proj-with-dash");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].cli).toBe("cursor");
  });

  it("returns {cwd: null, sessions: []} for an unknown slug", async () => {
    const result = await getCursorSessionsByEncodedName("-nonexistent");
    expect(result.cwd).toBeNull();
    expect(result.sessions).toEqual([]);
  });

  // Cursor 2026-04+ layout: ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
  it("discovers projects via the new ~/.cursor/projects/<cwd>/agent-transcripts/<id>/<id>.jsonl layout", async () => {
    const sessionId = "f2f0e429-c3f7-4089-a191-bc0a62bd7af8";
    const dir = join(fakeHome, ".cursor", "projects", "home-u-repo", "agent-transcripts", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hi" }] } }));
    const projects = await getCursorProjects();
    expect(projects).toHaveLength(1);
    // decodeFolderName("home-u-repo") = "/home/u/repo"
    expect(projects[0].path).toBe("/home/u/repo");
    expect(projects[0].cli).toEqual(["cursor"]);

    // The URL slug is `encodeFolderName(cwd)` — leading dash for absolute paths
    // — even though Cursor's on-disk dir name (`home-u-repo`) drops the leading
    // slash. The session viewer/projects merger always keys on our encoding.
    const sessions = await getCursorSessionsByEncodedName("-home-u-repo");
    expect(sessions.cwd).toBe("/home/u/repo");
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].sessionId).toBe(sessionId);
  });

  it("honors CURSOR_HOME when set", async () => {
    const altHome = mkdtempSync(join(tmpdir(), "cursor-alt-home-"));
    try {
      process.env.CURSOR_HOME = altHome;
      vi.resetModules();
      const { getCursorProjects: getCP } = await import("@/lib/cursor-projects");
      const dir = join(altHome, "agent-sessions", "abcd1234-abcd-1234-abcd-1234abcd1234");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: "/from/alt-home" }));
      writeFileSync(join(dir, "events.jsonl"), "{}\n");
      const result = await getCP();
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/from/alt-home");
    } finally {
      delete process.env.CURSOR_HOME;
      rmSync(altHome, { recursive: true, force: true });
    }
  });
});
