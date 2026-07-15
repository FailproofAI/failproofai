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

async function tryNodeSqlite(dbPath: string): Promise<SqliteReader | null> {
  try {
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

async function trySqlJs(dbPath: string): Promise<SqliteReader | null> {
  try {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(readFileSync(dbPath));
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
