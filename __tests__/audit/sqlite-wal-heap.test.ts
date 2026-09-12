// @vitest-environment node
/**
 * sql.js dies after 128 WAL-mode opens, and takes the rest of the run with it.
 *
 * `lib/sqlite-reader.ts` falls through to sql.js whenever `node:sqlite` is
 * absent — which is every bun process and every supported Node below 22.5, so
 * `engines.node: ">=20.9.0"` puts real users on this path.
 *
 * That build's heap is a FIXED 22,151,168-byte ArrayBuffer compiled with
 * ALLOW_MEMORY_GROWTH off, so growing it is `abort("OOM")`. Opening a
 * WAL-flagged image makes SQLite build a wal-index shared-memory region that
 * sql.js's MEMFS VFS never reclaims on close, and the 128th open exhausts the
 * heap — the same threshold for a 319 KB database and a 10 MB one, because the
 * leak is a fixed per-connection allocation rather than data.
 *
 * The abort is not confined to that open: `initSqlJs` memoizes one module for
 * the process, so afterwards EVERY `openSqliteReadonly` silently returns null.
 * A full audit opens ~150 databases (devin, goose and opencode each open theirs
 * once per session), so it crossed the line and then dropped whatever it had
 * not yet read — with `Aborted(OOM)` on stderr as the only symptom, and a run
 * that still reported success. Fixing it recovered 9 sessions on the machine
 * this was found on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FORCE TIER 2. `sqlite-reader` prefers `node:sqlite` and only falls through to
// sql.js when that import rejects — which is every bun process and every Node
// below 22.5, but NOT the Node this suite runs on. Without this mock the whole
// file is vacuously green: it passed identically with the fix reverted, because
// it never reached the code under test.
vi.mock("node:sqlite", () => {
  throw new Error("No such built-in module: node:sqlite");
});

import { openSqliteReadonly } from "@/lib/sqlite-reader";

let dir: string;
let dbPath: string;

// A minimal real SQLite file, built through sql.js itself and then flagged WAL
// in its header — which is exactly the shape the goose/opencode/devin
// databases arrive in on a live machine.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fp-wal-"));
  dbPath = join(dir, "sessions.db");

  // Same specifier the reader uses — `lib/sql-js-asm.d.ts` types this one; the
  // bare "sql.js" is untyped and fails `tsc --noEmit`, which gates CI.
  const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE sessions (id TEXT, body TEXT);");
  for (let i = 0; i < 50; i += 1) db.run("INSERT INTO sessions VALUES (?, ?)", [`s${i}`, "x".repeat(200)]);
  const bytes = Buffer.from(db.export());
  db.close();

  // Header bytes 18/19 are the file-format write/read versions. 2 = WAL.
  bytes[18] = 2;
  bytes[19] = 2;
  writeFileSync(dbPath, bytes);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("opening a WAL-mode database many times", () => {
  it("is what the audit actually does, and it must not exhaust the heap", async () => {
    // 150 is the measured open count of a full audit on a real machine; 128 is
    // where the unfixed build died. Anything at or above 129 proves the fix.
    const OPENS = 150;
    let lastRowCount = -1;

    for (let i = 0; i < OPENS; i += 1) {
      const reader = await openSqliteReadonly(dbPath);
      expect(reader, `open #${i + 1} returned null — sql.js is dead for this process`).not.toBeNull();
      const rows = reader!.query<{ id: string }>("SELECT id FROM sessions");
      // Not just "it opened": the silent failure mode returns a LIVE reader
      // whose queries come back empty, which is indistinguishable from a
      // machine with no sessions.
      expect(rows.length, `open #${i + 1} read no rows`).toBe(50);
      if (lastRowCount >= 0) expect(rows.length).toBe(lastRowCount);
      lastRowCount = rows.length;
      reader!.close?.();
    }
  }, 120_000);

  it("reads the same rows a rollback-journal image gives", async () => {
    // Clearing the WAL flag must not change what is read. sql.js never sees the
    // -wal sidecar either way, so the two are the same snapshot.
    const plain = join(dir, "plain.db");
    const bytes = readFileSync(dbPath);
    bytes[18] = 1;
    bytes[19] = 1;
    writeFileSync(plain, bytes);

    const a = await openSqliteReadonly(dbPath);
    const b = await openSqliteReadonly(plain);
    expect(a!.query("SELECT * FROM sessions")).toEqual(b!.query("SELECT * FROM sessions"));
    a!.close?.();
    b!.close?.();
  });

  it("leaves the file on disk untouched", async () => {
    // The flag is cleared on our own in-memory copy. Rewriting a user's real
    // session database to make our reader happy would be indefensible.
    const before = readFileSync(dbPath);
    const r = await openSqliteReadonly(dbPath);
    r!.query("SELECT 1");
    r!.close?.();
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readFileSync(dbPath)[18]).toBe(2); // still flagged WAL on disk
  });
});
