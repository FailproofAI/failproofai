// @vitest-environment node
/**
 * Node's SQLite warning must never reach the terminal.
 *
 * Not a cosmetic concern. `startProgress()` in `src/audit/cli.ts` redraws its
 * four stage lines by moving the cursor up a FIXED number of rows, so anything
 * else printed mid-run pushes the cursor down and the next redraw repaints the
 * block lower — leaving the top of the previous frame stranded above it. The
 * warning is two lines, printed on first use of `node:sqlite`, which lands it
 * squarely inside the block. Every stage appeared twice and the audit looked
 * like it had run twice.
 *
 * There is no defensive fix in the renderer (erasing to end of screen leaves
 * the stranded lines, which are ABOVE the cursor), so the fix is to keep the
 * terminal quiet — and this is the guard on that.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteReadonly } from "@/lib/sqlite-reader";

let dir: string;
let dbPath: string;
let original: typeof process.emitWarning;

beforeEach(async () => {
  original = process.emitWarning;
  dir = mkdtempSync(join(tmpdir(), "fp-warn-"));
  dbPath = join(dir, "s.db");
  const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE t (a TEXT);");
  db.run("INSERT INTO t VALUES ('x')");
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
});

afterEach(() => {
  process.emitWarning = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("the SQLite experimental warning", () => {
  it("never reaches the terminal when a database is opened", async () => {
    const seen: string[] = [];
    // Stand in for Node's own emitter so the assertion is about what WOULD be
    // printed, not about capturing stderr from another process.
    process.emitWarning = ((w: unknown) => {
      seen.push(typeof w === "string" ? w : String((w as Error)?.message ?? ""));
    }) as typeof process.emitWarning;

    const reader = await openSqliteReadonly(dbPath);
    expect(reader).not.toBeNull();
    reader!.query("SELECT * FROM t");
    reader!.close?.();

    // Re-emit through whatever the module installed, to prove the filter is in
    // place rather than that Node simply did not warn on this run.
    process.emitWarning("SQLite is an experimental feature and might change at any time");
    expect(seen.filter((m) => m.includes("SQLite is an experimental feature"))).toEqual([]);
  });

  it("still lets every other warning through", async () => {
    // A blanket silence would hide deprecations and real problems, in a tool
    // that installs into other people's machines.
    const seen: string[] = [];
    process.emitWarning = ((w: unknown) => {
      seen.push(typeof w === "string" ? w : String((w as Error)?.message ?? ""));
    }) as typeof process.emitWarning;

    const reader = await openSqliteReadonly(dbPath);
    reader?.close?.();

    process.emitWarning("something that actually matters");
    process.emitWarning(new Error("a real deprecation"));
    expect(seen).toContain("something that actually matters");
    expect(seen).toContain("a real deprecation");
  });
});
