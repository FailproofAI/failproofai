/**
 * Reusable read-only SQLite access for audit adapters of SQLite-backed agents.
 *
 * Tiered so we read LIVE data (including the write-ahead log) wherever possible,
 * and still run anywhere:
 *   1. `node:sqlite` — a real connection that reads main DB + WAL together, so
 *      brand-new rows are visible immediately. Built into Node ≥ 22.5 (no native
 *      module, no flag on recent 22.x). Preferred.
 *   2. `sql.js` (pure-JS/asm) — portable fallback for older Node. Reads the main
 *      DB file's bytes only, so it reflects a snapshot up to the last WAL
 *      checkpoint (very recent rows may lag). No native module — survives
 *      `npm install --ignore-scripts`.
 *
 * Either way: read-only, and `null` on any failure (fail-open, so an absent or
 * locked DB makes the audit skip that agent rather than crash).
 *
 * NOTE: opencode and every CLI that already ships keep their existing CLI
 * shell-out — this layer is only for new SQLite integrations.
 */
import { existsSync, readFileSync } from "node:fs";
import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-asm.js";

export interface SqliteReader {
  /** Run a parameterized read-only query; returns rows as plain objects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

// ── Tier 1: node:sqlite (WAL-aware, Node ≥ 22.5) ──

interface NodeSqliteStmt {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface NodeSqliteDb {
  prepare(sql: string): NodeSqliteStmt;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDb;
}

/**
 * Swallow Node's "SQLite is an experimental feature" warning, once.
 *
 * It is not information the user can act on — we chose `node:sqlite`
 * deliberately, and the alternative tier is a WASM build that leaks. But it is
 * emitted on first use, which lands it in the MIDDLE of whatever is on screen,
 * and the audit's progress display redraws itself by moving the cursor up a
 * fixed number of lines. Two unexpected lines of stderr push the cursor down
 * two rows, so the next redraw repaints the block two rows lower and strands
 * the top of the previous frame above it. The user sees every stage twice and
 * reasonably concludes the audit ran twice.
 *
 * Filtered by message rather than silenced wholesale: `process.emitWarning` is
 * how deprecations and real problems surface too, and a blanket
 * `NODE_NO_WARNINGS` in a tool that installs into other people's machines would
 * hide those as well.
 */
let warningPatched = false;
function silenceSqliteExperimentalWarning(): void {
  if (warningPatched) return;
  warningPatched = true;
  const original = process.emitWarning.bind(process);
  // The overloads differ across Node versions; the shape we care about is the
  // first argument, and everything else is passed straight through.
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : String((warning as Error)?.message ?? "");
    if (text.includes("SQLite is an experimental feature")) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

async function tryNodeSqlite(dbPath: string): Promise<SqliteReader | null> {
  try {
    // Before the import, not after: the warning fires on first use of the
    // module, which is this line.
    silenceSqliteExperimentalWarning();
    // Dynamic import: on Node < 22.5 this rejects and we fall through to sql.js.
    const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    return {
      query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
        const stmt = db.prepare(sql);
        return (params.length ? stmt.all(...params) : stmt.all()) as T[];
      },
      close() {
        db.close();
      },
    };
  } catch {
    return null;
  }
}

// ── Tier 2: sql.js (portable snapshot) ──

let sqlPromise: Promise<SqlJsStatic> | null = null;
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Clear the WAL flag on OUR OWN in-memory copy of the database image.
 *
 * Header bytes 18 and 19 are the file-format write and read versions; `2`
 * means WAL. sql.js never sees the `-wal` sidecar — it is handed the main
 * file's bytes and nothing else, which is exactly the snapshot caveat this
 * module already documents — so the flag buys us nothing, and it costs a great
 * deal: opening a WAL-flagged image makes SQLite build a wal-index
 * shared-memory region that sql.js's MEMFS-backed VFS never reclaims on
 * `close()` (close unlinks only the db file it created).
 *
 * The asm.js build's heap is a FIXED 22,151,168-byte ArrayBuffer with
 * ALLOW_MEMORY_GROWTH off, so `emscripten_resize_heap` is compiled to
 * `abort("OOM")`. Measured: the 128th WAL-mode open exhausts it — the same
 * threshold for a 319 KB database and a 10 MB one, because the leaked region
 * is a fixed per-connection allocation rather than data.
 *
 * And the abort is not confined to that open. `initSqlJs` memoizes one
 * process-wide module, so once it aborts every later `openSqliteReadonly`
 * silently returns null. A full audit opens ~150 databases — devin, goose and
 * opencode each open theirs once per SESSION — so it crossed 128 and then
 * dropped whatever it had not yet read, with no error anywhere. The
 * `Aborted(OOM)` lines on stderr were the only symptom, and they read as
 * harmless because the run still completed.
 *
 * Only under bun and Node < 22.5: tier 1 is `node:sqlite`, which bun does not
 * provide, and `engines.node` allows 20.9. Both fall through to here.
 */
function clearWalFlag(bytes: Buffer): Buffer {
  // Too short to carry a header, or not a SQLite image at all — hand it back
  // untouched and let sql.js produce its own error.
  if (bytes.length < 20) return bytes;
  if (bytes.toString("latin1", 0, 16) !== SQLITE_MAGIC) return bytes;
  if (bytes[18] === 1 && bytes[19] === 1) return bytes; // already rollback-journal
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

async function trySqlJs(dbPath: string): Promise<SqliteReader | null> {
  try {
    const SQL = await loadSqlJs();
    // `readFileSync` already returns a private copy, so mutating the two header
    // bytes cannot touch the file on disk.
    const db = new SQL.Database(clearWalFlag(readFileSync(dbPath)));
    return {
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
        const stmt = db.prepare(sql);
        try {
          if (params && params.length) stmt.bind(params);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      },
      close() {
        db.close();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Open a SQLite database file READ-ONLY. Prefers a WAL-aware `node:sqlite`
 * connection (live data), falls back to a `sql.js` snapshot. Returns `null` on
 * any failure. Always `close()` the reader when done.
 */
export async function openSqliteReadonly(dbPath: string): Promise<SqliteReader | null> {
  if (!existsSync(dbPath)) return null;
  return (await tryNodeSqlite(dbPath)) ?? (await trySqlJs(dbPath));
}
