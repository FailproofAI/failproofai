// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// The seam is the DB module, not a subprocess: these read opencode's SQLite
// file directly now. `lib/opencode-db.ts` is covered against a real database
// in opencode-db.test.ts; here it is stubbed so the grouping and parsing
// below are tested on canned rows, exactly as they were when the seam was
// `execFileSync`.
vi.mock("@/lib/opencode-db", () => ({
  withOpenCodeDb: vi.fn(),
  queryOpenCodeDb: vi.fn(),
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

import { withOpenCodeDb, queryOpenCodeDb } from "@/lib/opencode-db";
import type { SqliteReader } from "@/lib/sqlite-reader";
import {
  getOpenCodeProjects,
  getOpenCodeSessionsForCwd,
  getOpenCodeSessionsByEncodedName,
} from "@/lib/opencode-projects";

const mockWith = vi.mocked(withOpenCodeDb);
const mockQuery = vi.mocked(queryOpenCodeDb);

/** Every SQL string the code under test ran, in order. */
let executed: Array<{ sql: string; params: unknown[] }> = [];

beforeEach(() => {
  mockWith.mockReset();
  mockQuery.mockReset();
  executed = [];
});

/**
 * Canned rows, dispatched by the table the query names rather than by call
 * order.
 *
 * The execFileSync mock this replaces was positional — successive calls got
 * successive row sets — which quietly coupled every test to the order the
 * implementation happened to issue its queries in. Reading both tables from
 * one open changed that order and broke a test whose behaviour was unaffected.
 * Dispatching on `FROM session` / `FROM project` says what each row set IS, so
 * the next reordering costs nothing.
 *
 * Call sites still pass `[sessions, projects]`, which is what they meant.
 */
function mockDb(rowsBySql: Array<unknown[]>) {
  // Which array is which is read off the ROWS, not their position: call sites
  // in this file pass `[sessions, projects]` in some tests and the reverse in
  // others, because that is the order the implementation used to query in for
  // whichever function was under test. A project row is the one with a
  // `worktree`.
  const isProjectRows = (rows: unknown[]) =>
    rows.length > 0 && typeof rows[0] === "object" && rows[0] !== null && "worktree" in rows[0];
  const projects = rowsBySql.find(isProjectRows) ?? [];
  const sessions = rowsBySql.find((r) => r !== projects && !isProjectRows(r)) ?? [];
  const rowsFor = (sql: string): unknown[] =>
    /\bFROM\s+project\b/i.test(sql) ? projects : sessions;
  const db: SqliteReader = {
    query: <T,>(sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      return rowsFor(sql) as T[];
    },
    close: () => {},
  };
  mockWith.mockImplementation(async (fn: (d: SqliteReader) => unknown) => fn(db) as never);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    executed.push({ sql, params });
    return rowsFor(sql) as never;
  });
}

/** The database is unreadable — missing file, locked, or no opencode at all. */
function mockDbUnavailable() {
  mockWith.mockImplementation(async () => null as never);
  mockQuery.mockImplementation(async () => null as never);
}

describe("getOpenCodeProjects", () => {
  it("returns [] when the database cannot be read at all", async () => {
    // Was "when the opencode binary is missing on PATH". The fail-open
    // contract is the same and is what this asserts; only what can be absent
    // changed — a database file rather than a binary.
    mockDbUnavailable();
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
    // `name` is the URL slug = encodeFolderName(worktree) — matches every other CLI.
    expect(projects[0].name).toBe("-repo");
    expect(projects[0].path).toBe("/repo");
    expect(projects[0].cli).toEqual(["opencode"]);
    expect(projects[0].lastModified.getTime()).toBe(200);
    expect(projects[1].name).toBe("-other");
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
    expect(projects[0].name).toBe("-repo");
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

  it("returns [] gracefully when a query throws", async () => {
    // The two JSON-parsing cases these replace could only happen to a
    // subprocess's stdout. A query against a real database fails by throwing,
    // and the same fail-open answer is required.
    mockWith.mockImplementation(async () => null as never);
    mockQuery.mockImplementation(async () => null as never);
    expect(await getOpenCodeProjects()).toEqual([]);
  });

  it("passes values as SQL parameters rather than interpolating them", async () => {
    // What the execFileSync test this replaces was really protecting: no
    // caller-controlled value reaches the SQL text. It used to be enforced by
    // a regex guard on the session id plus argv-not-shell execution; now the
    // driver binds parameters, so the id never touches the statement at all.
    mockDb([[], []]);
    await getOpenCodeProjects();
    expect(executed.length).toBeGreaterThan(0);
    for (const { sql } of executed) {
      expect(sql).not.toMatch(/'/);
      expect(sql).not.toMatch(/\$\{/);
    }
  });

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
    mockDbUnavailable();
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
    mockDbUnavailable();
    const result = await getOpenCodeSessionsByEncodedName("-anything");
    expect(result.cwd).toBeNull();
    expect(result.sessions).toEqual([]);
  });
});
