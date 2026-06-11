/**
 * Per-transcript audit-result cache.
 *
 * Stored at `~/.failproofai/cache/audit/<sha1(transcriptPath)>.json` with
 * mode 0600. Keyed by (mtime, size, engineVersion, detectorVersion) so the
 * cache invalidates automatically when either the transcript or the policy /
 * detector code changes.
 *
 * Skipped for transcripts whose `sizeBytes === 0` (currently: OpenCode, whose
 * sessions live in a SQLite DB rather than a file with a stable mtime).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_POLICIES } from "../hooks/builtin-policies";
import { AUDIT_DETECTORS } from "./detectors";
import type { TranscriptAuditResult } from "./types";

let cachedEngineVersion: string | null = null;
let cachedDetectorVersion: string | null = null;

/** Hash of every builtin policy's name + function body. Changes when policy
 *  code changes, invalidating downstream caches. */
function getEngineVersion(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  const blob = BUILTIN_POLICIES
    .map((p) => `${p.name}|${p.fn.toString()}`)
    .sort()
    .join("\n");
  cachedEngineVersion = createHash("sha1").update(blob).digest("hex").slice(0, 16);
  return cachedEngineVersion;
}

/** Same for audit detectors. */
function getDetectorVersion(): string {
  if (cachedDetectorVersion) return cachedDetectorVersion;
  const blob = AUDIT_DETECTORS
    .map((d) => `${d.name}|${d.detect.toString()}`)
    .sort()
    .join("\n");
  cachedDetectorVersion = createHash("sha1").update(blob).digest("hex").slice(0, 16);
  return cachedDetectorVersion;
}

function getCachePathFor(transcriptPath: string): string {
  const root = join(homedir(), ".failproofai", "cache", "audit");
  const key = createHash("sha1").update(transcriptPath).digest("hex");
  return join(root, `${key}.json`);
}

/**
 * Bump whenever the on-disk shape of a cached transcript entry changes in
 * a way the reader can't tolerate (added required field, renamed key,
 * swapped result version). Entries written with a different
 * `schemaVersion` are rejected.
 *
 * v2: `TranscriptAuditResult` gained `cwd` and `eventsScanned` fields
 * (surfaced up to `AuditResult.projectsScanned` / `eventsScanned`).
 * Pre-PR cache entries lack them; on upgrade the aggregator would have
 * silently rendered them as `cwd: undefined` (dropped from
 * `projectsScanned`) and `eventsScanned: 0`. Rejecting v1 forces a
 * re-scan so the new fields are populated correctly.
 *
 * v3: `CacheEntry` gained `cachedAt` to support the 7-day TTL below. v2
 * entries lack the field; without a bump the age check would treat
 * `cachedAt: undefined` as `NaN` (passes the `<= TTL` comparison
 * accidentally on some paths) so we reject them outright and force a
 * re-scan.
 */
export const CACHE_SCHEMA_VERSION = 3;

/** Hard expiry: a cached transcript result is rejected on read once it's
 *  this old. Keeps the audit pipeline honest about long-lived results that
 *  may no longer reflect current detector intent even if the transcript
 *  bytes and policy hashes haven't changed. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

interface CacheEntry {
  /** Bumped whenever the on-disk shape changes incompatibly. */
  schemaVersion: number;
  /** ms since epoch when the entry was written. Drives the 7-day TTL. */
  cachedAt: number;
  mtimeMs: number;
  sizeBytes: number;
  engineVersion: string;
  detectorVersion: string;
  result: TranscriptAuditResult;
}

export function readCachedTranscriptResult(
  transcriptPath: string,
  mtimeMs: number,
  sizeBytes: number,
): TranscriptAuditResult | null {
  if (sizeBytes === 0) return null; // OpenCode and other DB-backed sources
  const cachePath = getCachePathFor(transcriptPath);
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    if (entry.mtimeMs !== mtimeMs) return null;
    if (entry.sizeBytes !== sizeBytes) return null;
    if (entry.engineVersion !== getEngineVersion()) return null;
    if (entry.detectorVersion !== getDetectorVersion()) return null;
    // Number.isFinite (not typeof) so a malformed JSON `Infinity` /
    // `NaN` is rejected — those would otherwise bypass the TTL check
    // and pin a stale entry as valid forever.
    if (!Number.isFinite(entry.cachedAt) || Date.now() - (entry.cachedAt as number) > CACHE_TTL_MS) return null;
    return entry.result ?? null;
  } catch {
    return null;
  }
}

export function writeCachedTranscriptResult(
  transcriptPath: string,
  mtimeMs: number,
  sizeBytes: number,
  result: TranscriptAuditResult,
): void {
  if (sizeBytes === 0) return;
  const cachePath = getCachePathFor(transcriptPath);
  try {
    mkdirSync(join(homedir(), ".failproofai", "cache", "audit"), { recursive: true });
    const entry: CacheEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: Date.now(),
      mtimeMs,
      sizeBytes,
      engineVersion: getEngineVersion(),
      detectorVersion: getDetectorVersion(),
      result,
    };
    // Set 0o600 at file-creation time so there's no window where the file
    // exists with the umask default (typically 0o644). The chmodSync below is
    // a belt-and-suspenders pass for the case where the file already existed.
    writeFileSync(cachePath, JSON.stringify(entry), { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(cachePath, 0o600); } catch { /* best-effort on POSIX */ }
  } catch {
    // Cache writes are best-effort — never let a cache error kill the audit.
  }
}

/** Test helper: reset memoized version hashes (so they recompute after a
 *  detector or policy is monkey-patched in a test). */
export function _resetVersionCache(): void {
  cachedEngineVersion = null;
  cachedDetectorVersion = null;
}
