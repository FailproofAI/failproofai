// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before importing the module under test so the
// mocks are in place when execFileSync is captured.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("@/lib/runtime-cache", () => ({
  runtimeCache: vi.fn(<T extends (...args: unknown[]) => unknown>(fn: T) => fn),
}));

vi.mock("@/lib/format-date", () => ({
  formatDate: vi.fn((d: Date) => d.toISOString()),
}));

vi.mock("@/lib/logger", () => ({
  logWarn: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  getOpenCodeProjects,
  getOpenCodeSessionsForCwd,
  getOpenCodeSessionsByEncodedName,
} from "@/lib/opencode-projects";

const mockExec = vi.mocked(execFileSync);

beforeEach(() => {
  mockExec.mockReset();
});

/** Set up the mock so successive calls return canned JSON arrays. */
function mockDb(rowsBySql: Array<unknown[]>) {
  mockExec.mockImplementation(() => {
    const next = rowsBySql.shift();
    return JSON.stringify(next ?? []);
  });
}

describe("getOpenCodeProjects", () => {
  it("returns [] when the opencode binary is missing on PATH", async () => {
    mockExec.mockImplementation(() => {
      const e = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw e;
    });
    expect(await getOpenCodeProjects()).toEqual([]);
  });

  it("returns [] when both queries return empty arrays", async () => {
    mockDb([[], []]);
    expect(await getOpenCodeProjects()).toEqual([]);
  });

  it("groups sessions by project_id and produces one ProjectFolder per project", async () => {
    mockDb([
      [
        { id: "ses_A", project_id: "p1", slug: "a", directory: "/repo", title: "A", time_created: 100, time_updated: 100 },
        { id: "ses_B", project_id: "p1", slug: "b", directory: "/repo", title: "B", time_created: 200, time_updated: 200 },
        { id: "ses_C", project_id: "p2", slug: "c", directory: "/other", title: "C", time_created: 50, time_updated: 50 },
      ],
      [
        { id: "p1", worktree: "/repo", vcs: "git", name: null, time_created: 100, time_updated: 200 },
        { id: "p2", worktree: "/other", vcs: null, name: "Other Project", time_created: 50, time_updated: 50 },
      ],
    ]);
    const projects = await getOpenCodeProjects();
    expect(projects).toHaveLength(2);
    // Newest first — p1 has time_updated=200, p2 has 50.
    expect(projects[0].name).toBe("repo"); // basename(/repo) — name was null
    expect(projects[0].path).toBe("/repo");
    expect(projects[0].cli).toEqual(["opencode"]);
    expect(projects[0].lastModified.getTime()).toBe(200);
    expect(projects[1].name).toBe("Other Project");
    expect(projects[1].lastModified.getTime()).toBe(50);
  });

  it("includes a project that has no sessions yet (project row only)", async () => {
    mockDb([
      [], // no sessions
      [
        { id: "p1", worktree: "/repo", vcs: "git", name: "Empty Project", time_created: 10, time_updated: 10 },
      ],
    ]);
    const projects = await getOpenCodeProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Empty Project");
    expect(projects[0].lastModified.getTime()).toBe(10);
  });

  it("groups sessions even when the project row is missing (defensive)", async () => {
    mockDb([
      [
        { id: "ses_A", project_id: "p1", slug: "a", directory: "/repo", title: "A", time_created: 100, time_updated: 100 },
      ],
      [], // no project rows
    ]);
    const projects = await getOpenCodeProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/repo");
  });

  it("returns [] gracefully on malformed JSON output", async () => {
    mockExec.mockImplementation(() => "not json");
    expect(await getOpenCodeProjects()).toEqual([]);
  });

  it("returns [] gracefully on non-array JSON output", async () => {
    mockExec.mockImplementation(() => '{"oops": true}');
    expect(await getOpenCodeProjects()).toEqual([]);
  });

  it("uses execFileSync (avoiding shell injection via SQL string)", async () => {
    mockDb([[], []]);
    await getOpenCodeProjects();
    expect(mockExec).toHaveBeenCalled();
    const firstCall = mockExec.mock.calls[0];
    expect(firstCall[0]).toBe("opencode");
    expect(firstCall[1]).toContain("db");
    expect(firstCall[1]).toContain("--format");
    expect(firstCall[1]).toContain("json");
    // Options object must include a positive timeout to avoid hanging on a stuck binary.
    const opts = firstCall[2] as { timeout?: number };
    expect(opts.timeout).toBeGreaterThan(0);
  });
});

describe("getOpenCodeSessionsForCwd", () => {
  it("returns sessions whose directory matches the requested cwd", async () => {
    mockDb([
      [
        { id: "ses_A", project_id: "p1", slug: "a", directory: "/repo", title: "A", time_created: 100, time_updated: 100 },
        { id: "ses_B", project_id: "p2", slug: "b", directory: "/other", title: "B", time_created: 200, time_updated: 200 },
      ],
    ]);
    const sessions = await getOpenCodeSessionsForCwd("/repo");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("ses_A");
    expect(sessions[0].cli).toBe("opencode");
    expect(sessions[0].name).toBe("A"); // title preferred over slug
    expect(sessions[0].path).toBe("opencode://ses_A");
  });

  it("returns [] when no sessions live under that cwd", async () => {
    mockDb([
      [
        { id: "ses_A", project_id: "p1", slug: "a", directory: "/somewhere-else", title: "A", time_created: 100, time_updated: 100 },
      ],
    ]);
    const sessions = await getOpenCodeSessionsForCwd("/repo");
    expect(sessions).toEqual([]);
  });

  it("returns [] when the binary is missing", async () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(await getOpenCodeSessionsForCwd("/repo")).toEqual([]);
  });
});

describe("getOpenCodeSessionsByEncodedName", () => {
  it("looks up sessions by encoded folder name and returns the canonical cwd", async () => {
    // getOpenCodeSessionsByEncodedName reads projects first, then sessions.
    mockDb([
      // projects
      [
        { id: "p1", worktree: "/home/u/repo", vcs: "git", name: null, time_created: 100, time_updated: 100 },
        { id: "p2", worktree: "/home/u/other", vcs: null, name: null, time_created: 50, time_updated: 50 },
      ],
      // sessions
      [
        { id: "ses_A", project_id: "p1", slug: "a", directory: "/home/u/repo", title: "A", time_created: 100, time_updated: 100 },
        { id: "ses_B", project_id: "p2", slug: "b", directory: "/home/u/other", title: "B", time_created: 200, time_updated: 200 },
      ],
    ]);
    // encodeFolderName("/home/u/repo") → "-home-u-repo"
    const result = await getOpenCodeSessionsByEncodedName("-home-u-repo");
    expect(result.cwd).toBe("/home/u/repo");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("ses_A");
  });

  it("returns {cwd:null, sessions:[]} when no project matches the encoded name", async () => {
    mockDb([
      [{ id: "p1", worktree: "/repo", vcs: "git", name: null, time_created: 100, time_updated: 100 }],
      [],
    ]);
    const result = await getOpenCodeSessionsByEncodedName("-nonexistent-path");
    expect(result.cwd).toBeNull();
    expect(result.sessions).toEqual([]);
  });

  it("returns {cwd:null, sessions:[]} when binary is missing", async () => {
    mockExec.mockImplementation(() => { throw new Error("ENOENT"); });
    const result = await getOpenCodeSessionsByEncodedName("-anything");
    expect(result.cwd).toBeNull();
    expect(result.sessions).toEqual([]);
  });
});
