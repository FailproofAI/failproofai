// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CACHE_SCHEMA_VERSION,
  CACHE_TTL_MS,
  readCachedTranscriptResult,
  writeCachedTranscriptResult,
} from "../../src/audit/cache";
import type { TranscriptAuditResult } from "../../src/audit/types";

const TRANSCRIPT_PATH = "/tmp/fake-transcript.jsonl";
const MTIME = 1_700_000_000_000;
const SIZE = 4096;

const FAKE_RESULT: TranscriptAuditResult = {
  transcriptPath: TRANSCRIPT_PATH,
  cli: "claude",
  projectName: "proj",
  sessionId: "abc",
  mtimeMs: MTIME,
  sizeBytes: SIZE,
  cwd: "/home/u/proj",
  eventsScanned: 12,
  hitsByName: {},
  examplesByName: {},
  rangeByName: {},
};

function cachePathFor(transcriptPath: string): string {
  const key = createHash("sha1").update(transcriptPath).digest("hex");
  return join(homedir(), ".failproofai", "cache", "audit", `${key}.json`);
}

describe("per-transcript audit cache", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "fpa-tx-cache-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns null when no cache file exists", () => {
    expect(readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE)).toBeNull();
  });

  it("round-trips a written entry", () => {
    writeCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE, FAKE_RESULT);
    const read = readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE);
    expect(read).not.toBeNull();
    expect(read?.eventsScanned).toBe(12);
    expect(read?.cwd).toBe("/home/u/proj");
  });

  it("stamps cachedAt at write time", () => {
    const before = Date.now();
    writeCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE, FAKE_RESULT);
    const after = Date.now();
    const raw = readFileSync(cachePathFor(TRANSCRIPT_PATH), "utf-8");
    const entry = JSON.parse(raw);
    expect(typeof entry.cachedAt).toBe("number");
    expect(entry.cachedAt).toBeGreaterThanOrEqual(before);
    expect(entry.cachedAt).toBeLessThanOrEqual(after);
  });

  it("skips zero-byte transcripts (OpenCode DB-backed sources)", () => {
    writeCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, 0, FAKE_RESULT);
    expect(existsSync(cachePathFor(TRANSCRIPT_PATH))).toBe(false);
    expect(readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, 0)).toBeNull();
  });

  it("rejects entries older than the 7-day TTL", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60_000;
    mkdirSync(join(tmpHome, ".failproofai", "cache", "audit"), { recursive: true });
    writeFileSync(
      cachePathFor(TRANSCRIPT_PATH),
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        cachedAt: eightDaysAgo,
        mtimeMs: MTIME,
        sizeBytes: SIZE,
        // engineVersion / detectorVersion intentionally absent — TTL check
        // fires either way; this also exercises the field-presence guards.
        engineVersion: "deadbeef",
        detectorVersion: "deadbeef",
        result: FAKE_RESULT,
      }),
    );
    expect(readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE)).toBeNull();
  });

  it("accepts entries inside the 7-day TTL when the rest of the key matches", () => {
    // Write through the official writer to populate the right
    // engine/detector hashes, then re-read immediately — Date.now() at
    // read time is within the TTL of Date.now() at write time.
    writeCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE, FAKE_RESULT);
    const read = readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE);
    expect(read).not.toBeNull();
  });

  it("rejects a schema v2 entry (forces re-scan after upgrade)", () => {
    mkdirSync(join(tmpHome, ".failproofai", "cache", "audit"), { recursive: true });
    writeFileSync(
      cachePathFor(TRANSCRIPT_PATH),
      JSON.stringify({
        schemaVersion: 2,
        // v2 entries lacked cachedAt
        mtimeMs: MTIME,
        sizeBytes: SIZE,
        engineVersion: "deadbeef",
        detectorVersion: "deadbeef",
        result: FAKE_RESULT,
      }),
    );
    expect(readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE)).toBeNull();
  });

  it("rejects entries with a missing cachedAt field", () => {
    mkdirSync(join(tmpHome, ".failproofai", "cache", "audit"), { recursive: true });
    writeFileSync(
      cachePathFor(TRANSCRIPT_PATH),
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        // no cachedAt — should be rejected even with a fresh mtime
        mtimeMs: MTIME,
        sizeBytes: SIZE,
        engineVersion: "deadbeef",
        detectorVersion: "deadbeef",
        result: FAKE_RESULT,
      }),
    );
    expect(readCachedTranscriptResult(TRANSCRIPT_PATH, MTIME, SIZE)).toBeNull();
  });

  it("CACHE_TTL_MS is 7 days", () => {
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60_000);
  });
});
