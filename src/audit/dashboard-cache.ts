/**
 * Whole-result cache for the Next.js dashboard's `/audit` page.
 *
 * Stored at `~/.failproofai/audit-dashboard.json` with mode 0600. Single
 * slot — a new run with different params overwrites the previous entry.
 * Read by `app/actions/get-audit-result.ts` (server action) and written by
 * `app/api/audit/run/route.ts` on successful run completion.
 *
 * Separate from the per-transcript cache at `~/.failproofai/cache/audit/`
 * (see `src/audit/cache.ts`): that one makes re-running fast; this one
 * makes navigating back to /audit instant without re-running.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeJsonAtomically } from "../../lib/atomic-write";
import type { AuditResult, RunAuditOptions } from "./types";

const DEFAULT_MAX_AGE_MINUTES = 30;

/** Hard expiry: the dashboard cache is rejected on read once it's this old.
 *  Matches the per-transcript TTL in `cache.ts` so the whole audit surface
 *  has a consistent 7-day freshness window — past that, `/audit` falls
 *  through to its empty state and nudges the user to re-audit. */
const DASHBOARD_CACHE_TTL_MINUTES = 7 * 24 * 60;

/**
 * Bump whenever the on-disk shape of a cached entry changes in a way the
 * reader can't tolerate (added required field, renamed key, swapped result
 * version). Entries written with a different `schemaVersion` are rejected
 * — better an empty state than rendering against the wrong shape.
 *
 * v2: AuditResult.version bumped 1→2 (added `projectsScanned`,
 * `eventsScanned`, `enabledBuiltinNames`). Renderers defaulted missing
 * fields silently, which masked a stale cache as "0 tool calls scanned"
 * instead of triggering the empty-state recovery. Rejecting v1 entries
 * forces a re-run.
 */
export const DASHBOARD_CACHE_SCHEMA_VERSION = 2;

export interface DashboardCacheEntry {
  /** Bumped whenever the cache shape changes incompatibly. */
  schemaVersion: number;
  /** ISO timestamp the cache was written at. */
  cachedAt: string;
  /** The exact RunAuditOptions the cached result was produced with. */
  params: RunAuditOptions;
  /** The full `AuditResult` from `runAudit()`. */
  result: AuditResult;
}

function getCachePath(): string {
  return join(homedir(), ".failproofai", "audit-dashboard.json");
}

/** Read the cache file. Returns null on missing/corrupt/unreadable file —
 *  callers treat "no cache" as the empty state. */
export function readDashboardCache(): DashboardCacheEntry | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as DashboardCacheEntry;
    // `typeof null === "object"`, so explicit null checks are required for
    // params and result — otherwise a corrupt cache like `{"params": null}`
    // would slip through and crash downstream readers.
    if (
      !entry
      || typeof entry !== "object"
      || typeof entry.cachedAt !== "string"
      || !entry.params
      || typeof entry.params !== "object"
      || !entry.result
      || typeof entry.result !== "object"
    ) {
      return null;
    }
    // Reject anything written by an older code version with a different
    // shape. The dashboard treats null as the "no cached result" empty
    // state, which is the safer fallback when we can't trust the bytes.
    if (entry.schemaVersion !== DASHBOARD_CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (isCacheStale(entry.cachedAt, DASHBOARD_CACHE_TTL_MINUTES)) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/** Write the cache file atomically via the shared `writeJsonAtomically`
 *  helper. Returns `true` on success and `false` if the write threw (disk
 *  full, permissions, …) — never throwing into the run path. The temp-file
 *  dance protects concurrent readers (e.g. the 1s status poll firing while a
 *  fresh run writes a multi-hundred-KB AuditResult) from observing a torn JSON
 *  file. The fire-and-forget run route relies on this boolean to surface a
 *  persistence failure: the cache is the only channel by which a detached
 *  run's result reaches the dashboard, so a silently dropped write would
 *  otherwise look like a successful run that serves stale data. */
export function writeDashboardCache(params: RunAuditOptions, result: AuditResult): boolean {
  try {
    const entry: DashboardCacheEntry = {
      schemaVersion: DASHBOARD_CACHE_SCHEMA_VERSION,
      cachedAt: new Date().toISOString(),
      params,
      result,
    };
    writeJsonAtomically(getCachePath(), entry);
    return true;
  } catch {
    // Best-effort: never throw into the run path. The caller decides how to
    // treat a failed persist (the run route reports it as a run error).
    return false;
  }
}

/** True when the cache is older than `maxAgeMinutes` (default 30). The
 *  dashboard doesn't auto-refresh on stale cache — staleness only drives
 *  the "Re-run" affordance hint. */
export function isCacheStale(cachedAt: string, maxAgeMinutes: number = DEFAULT_MAX_AGE_MINUTES): boolean {
  const cachedMs = new Date(cachedAt).getTime();
  if (Number.isNaN(cachedMs)) return true;
  const ageMs = Date.now() - cachedMs;
  return ageMs > maxAgeMinutes * 60_000;
}

/**
 * Read just the `cachedAt` timestamp from the dashboard cache file,
 * **bypassing** the TTL check. Used by the empty-state path to tell apart
 * "no audit has ever run" from "your last audit aged out". A non-null
 * return whose age exceeds `DASHBOARD_CACHE_TTL_MINUTES` means the cache
 * was rejected by `readDashboardCache()` for being expired (rather than
 * missing or schema-incompatible).
 */
export function readDashboardCacheMeta(): { cachedAt: string } | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as Partial<DashboardCacheEntry>;
    // Require schema-version match + a parseable ISO timestamp before
    // surfacing the entry as "this user's audit aged out". A
    // schema-incompatible entry is structurally indistinguishable from
    // "no audit has ever run", so it should fall through to the
    // first-run empty copy, not the expired banner.
    if (
      !entry
      || entry.schemaVersion !== DASHBOARD_CACHE_SCHEMA_VERSION
      || typeof entry.cachedAt !== "string"
      || Number.isNaN(new Date(entry.cachedAt).getTime())
    ) return null;
    return { cachedAt: entry.cachedAt };
  } catch {
    return null;
  }
}
