// @vitest-environment node
/**
 * `lib/opencode-db.ts` against a REAL SQLite file.
 *
 * The modules above it are tested on canned rows, which is right for grouping
 * and translation logic — but it means nothing here checks that the file is
 * actually readable. That gap is exactly where the change this replaced would
 * hide: reading nothing, very quickly, is indistinguishable from reading
 * everything if every test stubs the reader.
 *
 * Written with the same reader the code under test uses only for ASSERTIONS —
 * the fixture itself is built by `node:sqlite` directly, so a bug in the shared
 * reader cannot make these pass by cancelling itself out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let dbPath: string;

/** Build a fixture that looks like opencode's schema, or skip if this Node
 *  cannot write one (node:sqlite landed in 22.5). */
async function seed(): Promise<boolean> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT, project_id TEXT, slug TEXT, directory TEXT,
                            title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT, worktree TEXT, vcs TEXT, name TEXT,
                            time_created INTEGER, time_updated INTEGER);
      INSERT INTO project VALUES ('p1', '/home/u/repo', 'git', NULL, 1, 2);
      INSERT INTO session VALUES ('ses_A', 'p1', 'a', '/home/u/repo', 'A', 10, 20);
      INSERT INTO session VALUES ('ses_B', 'p1', 'b', '/home/u/repo', 'B', 30, 40);
    `);
    db.close();
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-oc-db-"));
  dbPath = join(dir, "opencode.db");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("reading opencode's database directly", () => {
  it("reads rows from a real file", async () => {
    if (!(await seed())) return; // node:sqlite unavailable
    vi.stubEnv("OPENCODE_DB_PATH", dbPath);
    const { queryOpenCodeDb } = await import("@/lib/opencode-db");
    const rows = await queryOpenCodeDb<{ id: string }>("SELECT id FROM session ORDER BY id");
    expect(rows?.map((r) => r.id)).toEqual(["ses_A", "ses_B"]);
  });

  it("binds parameters instead of interpolating them", async () => {
    if (!(await seed())) return;
    vi.stubEnv("OPENCODE_DB_PATH", dbPath);
    const { queryOpenCodeDb } = await import("@/lib/opencode-db");
    // A value that would end the statement if it were pasted into the SQL.
    const rows = await queryOpenCodeDb<{ id: string }>(
      "SELECT id FROM session WHERE id = ?",
      ["ses_A'; DROP TABLE session; --"],
    );
    expect(rows).toEqual([]);
    // The table is still there, which pasting would not have left true.
    const after = await queryOpenCodeDb<{ id: string }>("SELECT id FROM session");
    expect(after).toHaveLength(2);
  });

  it("serves several queries from ONE open", async () => {
    // The whole point of the change: three related reads used to be three
    // processes at ~1.5s each.
    if (!(await seed())) return;
    vi.stubEnv("OPENCODE_DB_PATH", dbPath);
    const { withOpenCodeDb } = await import("@/lib/opencode-db");
    const out = await withOpenCodeDb((db) => ({
      sessions: db.query<{ id: string }>("SELECT id FROM session"),
      projects: db.query<{ worktree: string }>("SELECT worktree FROM project"),
    }));
    expect(out?.sessions).toHaveLength(2);
    expect(out?.projects?.[0].worktree).toBe("/home/u/repo");
  });

  it("returns null rather than throwing when the file is not there", async () => {
    vi.stubEnv("OPENCODE_DB_PATH", join(dir, "absent.db"));
    const { queryOpenCodeDb, withOpenCodeDb } = await import("@/lib/opencode-db");
    expect(await queryOpenCodeDb("SELECT 1")).toBeNull();
    expect(await withOpenCodeDb((db) => db.query("SELECT 1"))).toBeNull();
  });

  it("returns null on a query error, leaving callers to degrade", async () => {
    if (!(await seed())) return;
    vi.stubEnv("OPENCODE_DB_PATH", dbPath);
    const { queryOpenCodeDb } = await import("@/lib/opencode-db");
    expect(await queryOpenCodeDb("SELECT * FROM table_that_is_not_there")).toBeNull();
  });

  it("honours OPENCODE_HOME for the directory", async () => {
    if (!(await seed())) return;
    vi.stubEnv("OPENCODE_HOME", dir);
    const { opencodeDbPath } = await import("@/lib/opencode-db");
    expect(opencodeDbPath()).toBe(dbPath);
  });
});
