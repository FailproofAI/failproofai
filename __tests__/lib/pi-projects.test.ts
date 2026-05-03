// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Compose a Pi-shaped JSONL session file's first record.
 * The real Pi format is `{type: "session", version, id, timestamp, cwd}` —
 * the parser only requires `type` and `cwd` to surface the project.
 */
function sessionRecord(id: string, cwd: string, ts = "2026-05-01T20:36:22.628Z"): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd });
}

describe("lib/pi-projects", () => {
  let originalHome: string | undefined;
  let originalSessionsDir: string | undefined;
  let fakeHome: string;
  let getPiProjects: typeof import("@/lib/pi-projects").getPiProjects;
  let getPiSessionsForCwd: typeof import("@/lib/pi-projects").getPiSessionsForCwd;
  let getPiSessionsByEncodedName: typeof import("@/lib/pi-projects").getPiSessionsByEncodedName;

  /**
   * Write a synthetic Pi session file. Encodes cwd into the per-cwd dir name
   * (Pi's `--foo-bar--` scheme) and uses the canonical `<ts>_<uuid>.jsonl`
   * filename pattern.
   */
  function writeSession(
    sessionId: string,
    cwd: string,
    opts?: {
      additionalLines?: string[];
      mtime?: Date;
      filename?: string;
      sessionRoot?: string;
    },
  ): string {
    const root = opts?.sessionRoot ?? join(fakeHome, ".pi", "agent", "sessions");
    // Pi's encoding: replace `/` with `-`, wrap in `--…--`.
    const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    const dir = join(root, encoded);
    mkdirSync(dir, { recursive: true });
    const fname = opts?.filename ?? `2026-05-01T20-36-22-628Z_${sessionId}.jsonl`;
    const path = join(dir, fname);
    const lines = [sessionRecord(sessionId, cwd), ...(opts?.additionalLines ?? [])];
    writeFileSync(path, lines.join("\n") + "\n");
    if (opts?.mtime) utimesSync(path, opts.mtime, opts.mtime);
    return path;
  }

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalSessionsDir = process.env.PI_SESSIONS_DIR;
    fakeHome = mkdtempSync(join(tmpdir(), "pi-projects-"));
    process.env.HOME = fakeHome;
    delete process.env.PI_SESSIONS_DIR;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => fakeHome };
    });
    const mod = await import("@/lib/pi-projects");
    getPiProjects = mod.getPiProjects;
    getPiSessionsForCwd = mod.getPiSessionsForCwd;
    getPiSessionsByEncodedName = mod.getPiSessionsByEncodedName;
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

  it("returns [] when ~/.pi/agent/sessions doesn't exist", async () => {
    expect(await getPiProjects()).toEqual([]);
  });

  it("returns [] when sessions root exists but is empty", async () => {
    mkdirSync(join(fakeHome, ".pi", "agent", "sessions"), { recursive: true });
    expect(await getPiProjects()).toEqual([]);
  });

  it("surfaces a single Pi project when one session file exists", async () => {
    writeSession(
      "00000000-0000-4000-8000-000000000001",
      "/home/u/repo",
      { mtime: new Date("2026-05-01T00:00:00Z") },
    );
    const projects = await getPiProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/u/repo");
    expect(projects[0].cli).toEqual(["pi"]);
    // Encoded folder name uses failproofai's slash → dash convention.
    expect(projects[0].name).toBe("-home-u-repo");
  });

  it("uses the cwd from the JSONL first record (NOT the dir name encoding)", async () => {
    // The dir-name encoding is lossy when a real path contains `-`. Verify
    // that getPiProjects pulls the canonical cwd from the record text, not
    // from decoding the directory name.
    writeSession(
      "00000000-0000-4000-8000-000000000001",
      "/home/u/has-dashes-here",
      { mtime: new Date("2026-05-01T00:00:00Z") },
    );
    const projects = await getPiProjects();
    expect(projects[0].path).toBe("/home/u/has-dashes-here");
  });

  it("groups multiple sessions under the same cwd into one project row", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/repo", {
      mtime: new Date("2026-05-01T00:00:00Z"),
      filename: "2026-05-01T00-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl",
    });
    writeSession("00000000-0000-4000-8000-000000000002", "/home/u/repo", {
      mtime: new Date("2026-05-02T00:00:00Z"),
      filename: "2026-05-02T00-00-00-000Z_00000000-0000-4000-8000-000000000002.jsonl",
    });
    const projects = await getPiProjects();
    expect(projects).toHaveLength(1);
    // Newest mtime wins for the project's lastModified.
    expect(projects[0].lastModified.toISOString()).toBe("2026-05-02T00:00:00.000Z");
  });

  it("surfaces multiple cwds as separate projects", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/repoA");
    writeSession("00000000-0000-4000-8000-000000000002", "/home/u/repoB");
    const projects = await getPiProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.path).sort()).toEqual(["/home/u/repoA", "/home/u/repoB"]);
  });

  it("sorts by lastModified desc", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/old", {
      mtime: new Date("2024-01-01T00:00:00Z"),
    });
    writeSession("00000000-0000-4000-8000-000000000002", "/home/u/new", {
      mtime: new Date("2026-05-01T00:00:00Z"),
    });
    const projects = await getPiProjects();
    expect(projects[0].path).toBe("/home/u/new");
    expect(projects[1].path).toBe("/home/u/old");
  });

  it("ignores files that don't match the Pi session-file naming pattern", async () => {
    const root = join(fakeHome, ".pi", "agent", "sessions");
    const dir = join(root, "--home-u-repo--");
    mkdirSync(dir, { recursive: true });
    // Stray non-jsonl file
    writeFileSync(join(dir, "README"), "junk");
    // Wrong filename pattern
    writeFileSync(join(dir, "no-uuid-here.jsonl"), sessionRecord("x", "/home/u/repo"));
    expect(await getPiProjects()).toEqual([]);
  });

  it("skips sessions whose first record is corrupt JSON", async () => {
    const root = join(fakeHome, ".pi", "agent", "sessions");
    const dir = join(root, "--home-u-broken--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-05-01T00-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl"),
      "{not json\n",
    );
    expect(await getPiProjects()).toEqual([]);
  });

  it("skips sessions whose first record is the wrong type", async () => {
    const root = join(fakeHome, ".pi", "agent", "sessions");
    const dir = join(root, "--home-u-wrong--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-05-01T00-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl"),
      JSON.stringify({ type: "model_change", id: "x" }) + "\n",
    );
    expect(await getPiProjects()).toEqual([]);
  });

  it("getPiSessionsForCwd returns sessions only for the matching cwd", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/repoA");
    writeSession("00000000-0000-4000-8000-000000000002", "/home/u/repoB");
    const sessions = await getPiSessionsForCwd("/home/u/repoA");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("getPiSessionsByEncodedName matches by encoded cwd round-trip", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/has-dashes");
    // failproofai's encodeFolderName(`/home/u/has-dashes`) → `-home-u-has-dashes`
    const result = await getPiSessionsByEncodedName("-home-u-has-dashes");
    expect(result.cwd).toBe("/home/u/has-dashes");
    expect(result.sessions).toHaveLength(1);
  });

  it("getPiSessionsByEncodedName returns null cwd when no match", async () => {
    writeSession("00000000-0000-4000-8000-000000000001", "/home/u/repo");
    const result = await getPiSessionsByEncodedName("-different-path");
    expect(result.cwd).toBeNull();
    expect(result.sessions).toEqual([]);
  });

  it("PI_SESSIONS_DIR env var overrides the default sessions root", async () => {
    const overrideRoot = mkdtempSync(join(tmpdir(), "pi-override-"));
    try {
      process.env.PI_SESSIONS_DIR = overrideRoot;
      // Re-import after env mutation so getPiSessionsRoot picks up the change.
      vi.resetModules();
      const mod = await import("@/lib/pi-projects");
      writeSession("00000000-0000-4000-8000-000000000099", "/home/u/under-override", {
        sessionRoot: overrideRoot,
      });
      const projects = await mod.getPiProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe("/home/u/under-override");
    } finally {
      rmSync(overrideRoot, { recursive: true, force: true });
    }
  });
});
