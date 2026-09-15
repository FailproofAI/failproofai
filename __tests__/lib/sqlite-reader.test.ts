import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteReadonly } from "../../lib/sqlite-reader";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

function pageSizeOf(database: Uint8Array): number {
  const encoded = (database[16] << 8) | database[17];
  return encoded === 1 ? 65_536 : encoded;
}

function checksum(
  bytes: Uint8Array,
  offset: number,
  length: number,
  initial: readonly [number, number] = [0, 0],
): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [sum1, sum2] = initial;
  for (let cursor = offset; cursor < offset + length; cursor += 8) {
    sum1 = (sum1 + view.getUint32(cursor, true) + sum2) >>> 0;
    sum2 = (sum2 + view.getUint32(cursor + 4, true) + sum1) >>> 0;
  }
  return [sum1, sum2];
}

/** Make a minimal WAL containing the pages changed between two sql.js exports. */
function syntheticWal(base: Uint8Array, updated: Uint8Array): Uint8Array {
  const pageSize = pageSizeOf(base);
  const pages = updated.length / pageSize;
  const changed: number[] = [];
  for (let page = 0; page < pages; page += 1) {
    const start = page * pageSize;
    const before = base.subarray(start, start + pageSize);
    const after = updated.subarray(start, start + pageSize);
    if (before.length !== after.length || before.some((byte, index) => byte !== after[index])) {
      changed.push(page + 1);
    }
  }

  const frameSize = 24 + pageSize;
  const wal = new Uint8Array(32 + changed.length * frameSize);
  writeUint32(wal, 0, 0x377f0682);
  writeUint32(wal, 4, 3_007_000);
  writeUint32(wal, 8, pageSize);
  writeUint32(wal, 16, 0x12345678);
  writeUint32(wal, 20, 0x90abcdef);
  let rollingChecksum = checksum(wal, 0, 24);
  writeUint32(wal, 24, rollingChecksum[0]);
  writeUint32(wal, 28, rollingChecksum[1]);

  changed.forEach((pageNumber, index) => {
    const frame = 32 + index * frameSize;
    writeUint32(wal, frame, pageNumber);
    writeUint32(wal, frame + 4, index === changed.length - 1 ? pages : 0);
    writeUint32(wal, frame + 8, 0x12345678);
    writeUint32(wal, frame + 12, 0x90abcdef);
    const pageStart = (pageNumber - 1) * pageSize;
    wal.set(updated.subarray(pageStart, pageStart + pageSize), frame + 24);
    rollingChecksum = checksum(wal, frame, 8, rollingChecksum);
    rollingChecksum = checksum(wal, frame + 24, pageSize, rollingChecksum);
    writeUint32(wal, frame + 16, rollingChecksum[0]);
    writeUint32(wal, frame + 20, rollingChecksum[1]);
  });
  return wal;
}

describe("portable SQLite reader", () => {
  it("reads committed live rows from a WAL without node:sqlite", async () => {
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    database.run("CREATE TABLE events(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    database.run("INSERT INTO events(body) VALUES (?)", ["checkpointed"]);
    const base = database.export();
    database.run("INSERT INTO events(body) VALUES (?)", ["live in WAL"]);
    const updated = database.export();
    database.close();

    const directory = mkdtempSync(join(tmpdir(), "fpai-sqlite-reader-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "agent.sqlite");
    writeFileSync(path, base);
    writeFileSync(`${path}-wal`, syntheticWal(base, updated));

    const reader = await openSqliteReadonly(path, { forcePortable: true });
    expect(reader).not.toBeNull();
    try {
      expect(reader?.query<{ body: string }>("SELECT body FROM events ORDER BY id")).toEqual([
        { body: "checkpointed" },
        { body: "live in WAL" },
      ]);
    } finally {
      reader?.close();
    }
  });
});
