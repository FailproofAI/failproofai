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

interface CacheEntry {
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
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.mtimeMs !== mtimeMs) return null;
    if (entry.sizeBytes !== sizeBytes) return null;
    if (entry.engineVersion !== getEngineVersion()) return null;
    if (entry.detectorVersion !== getDetectorVersion()) return null;
    return entry.result;
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
      mtimeMs,
      sizeBytes,
      engineVersion: getEngineVersion(),
      detectorVersion: getDetectorVersion(),
      result,
    };
    writeFileSync(cachePath, JSON.stringify(entry), "utf-8");
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
