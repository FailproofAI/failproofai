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
import { BUILTIN_POLICIES } from "../hooks/builtin-policies";
import { AUDIT_DETECTORS } from "./detectors";
import type { TranscriptAuditResult } from "./types";
import { auditCacheDir } from "../hooks/fp-home";

let cachedEngineVersion: string | null = null;
let cachedDetectorVersion: string | null = null;

/**
 * Hash of every builtin policy's name and function body. Changes when policy
 * code changes, invalidating downstream caches.
 *
 * Nothing else is in it, and specifically not installed packs. The audit
 * evaluates the implementations compiled into this build and only those —
 * `replay.ts` iterates `BUILTIN_POLICIES` and never reads the installed packs —
 * so a pack cannot move an audit result, and keying on one meant every install
 * or removal cold-rescanned the entire history to reproduce the answers it
 * already had. The key it replaced folded packs in by `id|version|sha256`; the
 * rationale was that packs "change what a machine would have caught", which is
 * true of enforcement and was never true of this replay.
 *
 * **A machine with no packs hashes byte-identically to the old key**, because
 * that one contributed nothing for an empty pack set — not an empty line, not a
 * separator. So this change costs a rescan only to machines that had a pack
 * installed, and costs it exactly once.
 *
 * It is deliberately NOT the source text of anything loaded at runtime: the
 * loader rewrites a per-load temporary filename into every import specifier, so
 * hashing loaded source would change on every single run and cold-rescan the
 * whole history each time.
 */
function getEngineVersion(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  const builtinBlob = BUILTIN_POLICIES
    .map((p) => `${p.name}|${p.fn.toString()}`)
    .sort()
    .join("\n");
  // Packs are NOT in this key, and that is the whole point of the audit's design
  // rather than an omission.
  //
  // `replay.ts` evaluates `BUILTIN_POLICIES` and nothing else — it never reads
  // `readInstalledPacks()`, and third-party pack policies are never replayed. So
  // an installed pack cannot change an audit result, and folding its identity in
  // here invalidated every cached transcript on a change that provably produces
  // the same answers: a full rescan of thousands of transcripts to arrive back
  // where it started. That was survivable while packs were rare; policies ARE
  // packs now, so installing or removing one is routine.
  //
  // If audit is ever extended to evaluate what a pack would actually have
  // caught, this key has to carry pack identity again — and that change belongs
  // in the same commit as the one that makes it true.
  cachedEngineVersion = createHash("sha1").update(builtinBlob).digest("hex").slice(0, 16);
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

/** Exposed for `engine-version-packs.test.ts`, which pins the upgrade-cost
 *  guarantee: a machine with no packs must hash exactly as it did before packs
 *  existed. Nothing else should call this. */
export function getEngineVersionForTest(): string {
  return getEngineVersion();
}

function getCachePathFor(transcriptPath: string): string {
  const root = auditCacheDir();
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
 *  bytes and policy hashes haven't changed.
 *
 *  30 days, and it MUST stay clear of the scheduled-audit interval
 *  (`DEFAULT_AUDIT_INTERVAL_DAYS`, 7). It was 7 days — exactly equal — which
 *  meant a scheduled run at T+7d found every entry cached at T+0 already
 *  expired and cold-scanned the entire history: ~104 seconds and megabytes of
 *  rewrites, on every single run, for a lane whose whole point is to be cheap.
 *  The margin was one scan duration, so any suspend, missed tick, or deferral
 *  tipped all of it over at once.
 *
 *  Correctness does not rest on this number: `engineVersion` (a hash over every
 *  builtin's source) and `detectorVersion` already invalidate the cache the
 *  moment detection logic actually changes. The TTL only bounds staleness for
 *  changes those two cannot see, so it can be generous. */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60_000;

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
    mkdirSync(auditCacheDir(), { recursive: true });
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
