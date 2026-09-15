/**
 * Reusable read-only SQLite access for audit adapters of SQLite-backed agents.
 *
 * Tiered so we read LIVE data (including the write-ahead log) wherever possible,
 * and still run anywhere:
 *   1. `node:sqlite` — a real connection that reads main DB + WAL together, so
 *      brand-new rows are visible immediately. Built into Node ≥ 22.5 (no native
 *      module, no flag on recent 22.x). Preferred.
 *   2. `sql.js` (pure-JS/asm) — portable fallback for older Node. Builds a
 *      consistent in-memory snapshot from the main DB plus committed WAL
 *      frames, so live rows are visible on Node 20 too. No native module —
 *      survives `npm install --ignore-scripts`.
 *
 * Either way: read-only, and `null` on any failure (fail-open, so an absent or
 * locked DB makes the audit skip that agent rather than crash).
 *
 * NOTE: opencode and every CLI that already ships keep their existing CLI
 * shell-out — this layer is only for new SQLite integrations.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-asm.js";

export interface SqliteReader {
  /** Run a parameterized read-only query; returns rows as plain objects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

export interface SqliteReaderOptions {
  /** Exercise the Node-20-compatible reader even when `node:sqlite` exists. */
  forcePortable?: boolean;
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

// ── Tier 2: sql.js (portable, WAL-aware snapshot) ──

let sqlPromise: Promise<SqlJsStatic> | null = null;
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

interface FileVersion {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fileVersion(path: string): FileVersion {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function sqlitePageSize(db: Uint8Array): number | null {
  if (db.length < 100) return null;
  if (Buffer.from(db.subarray(0, 16)).toString("binary") !== "SQLite format 3\0") return null;
  const encoded = (db[16] << 8) | db[17];
  const pageSize = encoded === 1 ? 65_536 : encoded;
  return pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0
    ? pageSize
    : null;
}

function walChecksum(
  bytes: Uint8Array,
  offset: number,
  length: number,
  bigEndian: boolean,
  initial: readonly [number, number] = [0, 0],
): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [sum1, sum2] = initial;
  for (let cursor = offset; cursor < offset + length; cursor += 8) {
    const first = view.getUint32(cursor, !bigEndian);
    const second = view.getUint32(cursor + 4, !bigEndian);
    sum1 = (sum1 + first + sum2) >>> 0;
    sum2 = (sum2 + second + sum1) >>> 0;
  }
  return [sum1, sum2];
}

/** Overlay every valid frame through the WAL's last committed transaction. */
function applyCommittedWal(db: Uint8Array, wal: Uint8Array): Uint8Array {
  const pageSize = sqlitePageSize(db);
  if (pageSize === null || wal.length < 32) return db;

  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return db;
  if (view.getUint32(4, false) !== 3_007_000) return db;
  if (view.getUint32(8, false) !== pageSize) return db;

  const checksumBigEndian = (magic & 1) === 1;
  let checksum = walChecksum(wal, 0, 24, checksumBigEndian);
  if (view.getUint32(24, false) !== checksum[0] || view.getUint32(28, false) !== checksum[1]) {
    return db;
  }

  const salt1 = view.getUint32(16, false);
  const salt2 = view.getUint32(20, false);
  const frameSize = 24 + pageSize;
  const frameCount = Math.floor((wal.length - 32) / frameSize);
  let lastCommit = -1;
  let committedPages = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const offset = 32 + index * frameSize;
    const pageNumber = view.getUint32(offset, false);
    if (
      pageNumber === 0 ||
      view.getUint32(offset + 8, false) !== salt1 ||
      view.getUint32(offset + 12, false) !== salt2
    ) {
      break;
    }
    checksum = walChecksum(wal, offset, 8, checksumBigEndian, checksum);
    checksum = walChecksum(wal, offset + 24, pageSize, checksumBigEndian, checksum);
    if (
      view.getUint32(offset + 16, false) !== checksum[0] ||
      view.getUint32(offset + 20, false) !== checksum[1]
    ) {
      break;
    }
    const databasePages = view.getUint32(offset + 4, false);
    if (databasePages > 0) {
      lastCommit = index;
      committedPages = databasePages;
    }
  }

  if (lastCommit < 0 || committedPages === 0) return db;
  const targetSize = committedPages * pageSize;
  // A corrupt WAL must not be allowed to request an unbounded allocation.
  if (!Number.isSafeInteger(targetSize) || targetSize > db.length + frameCount * pageSize) {
    return db;
  }

  const snapshot = new Uint8Array(targetSize);
  snapshot.set(db.subarray(0, targetSize));
  for (let index = 0; index <= lastCommit; index += 1) {
    const offset = 32 + index * frameSize;
    const pageNumber = view.getUint32(offset, false);
    const destination = (pageNumber - 1) * pageSize;
    // An earlier transaction in the same WAL may have grown the database and
    // a later committed transaction may have truncated it again. Frames above
    // the final committed page count are valid history, but not part of the
    // snapshot sql.js should open.
    if (destination >= targetSize) continue;
    snapshot.set(wal.subarray(offset + 24, offset + frameSize), destination);
  }
  return snapshot;
}

/**
 * Read the main file before the WAL and verify that no checkpoint changed the
 * main file in between. WAL appends are safe: only complete committed frames
 * present in the bytes we read are applied. A checkpoint/reset changes the
 * main file, which makes us retry instead of combining different generations.
 */
function readPortableSnapshot(dbPath: string): Uint8Array {
  const walPath = `${dbPath}-wal`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = fileVersion(dbPath);
    const main = readFileSync(dbPath);
    const afterMain = fileVersion(dbPath);
    if (!sameVersion(before, afterMain)) continue;

    let wal: Uint8Array | null = null;
    try {
      wal = readFileSync(walPath);
    } catch (error) {
      // A missing WAL is an ordinary checkpointed database.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const afterWal = fileVersion(dbPath);
    if (!sameVersion(before, afterWal)) continue;
    return wal ? applyCommittedWal(main, wal) : main;
  }
  throw new Error(`SQLite database changed while reading: ${dbPath}`);
}

async function trySqlJs(dbPath: string): Promise<SqliteReader | null> {
  try {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(readPortableSnapshot(dbPath));
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
export async function openSqliteReadonly(
  dbPath: string,
  options: SqliteReaderOptions = {},
): Promise<SqliteReader | null> {
  if (!existsSync(dbPath)) return null;
  if (!options.forcePortable) {
    const native = await tryNodeSqlite(dbPath);
    if (native) return native;
  }
  return trySqlJs(dbPath);
}
