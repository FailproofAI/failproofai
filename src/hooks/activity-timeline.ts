/**
 * Time-bucketed enforcement activity for the dashboard's timeline chart.
 *
 * Kept pure and free of React so the bucketing — the part with edge cases — is
 * unit-testable on its own. The stats bar already answers "how much, in total";
 * this answers the question totals structurally cannot: *when*.
 */
import type { HookActivityEntry } from "./hook-activity-store";

export interface ActivityBucket {
  /** Bucket start, epoch ms. */
  t: number;
  total: number;
  deny: number;
  instruct: number;
}

export interface BucketOptions {
  now?: number;
  /** How far back to cover. Default 24h. */
  windowMs?: number;
  /** How many buckets to split the window into. Default 24. */
  buckets?: number;
}

export const DEFAULT_WINDOW_MS = 24 * 3_600_000;
export const DEFAULT_BUCKETS = 24;

/**
 * Buckets are emitted for the WHOLE window, including empty ones.
 *
 * Dropping empty buckets would silently compress quiet periods and draw a line
 * that implies continuous activity across a gap where there was none — the
 * chart would read as "steady" over an outage. A zero is data.
 */
export function bucketActivity(entries: HookActivityEntry[], opts: BucketOptions = {}): ActivityBucket[] {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const count = Math.max(1, Math.floor(opts.buckets ?? DEFAULT_BUCKETS));
  const size = windowMs / count;
  const start = now - windowMs;

  const out: ActivityBucket[] = Array.from({ length: count }, (_, i) => ({
    t: Math.round(start + i * size),
    total: 0,
    deny: 0,
    instruct: 0,
  }));

  for (const entry of entries) {
    const ts = entry.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (ts < start || ts > now) continue;
    // Math.min guards the exact-`now` entry, which would otherwise index one
    // past the end and be dropped — the newest event is the one most worth
    // seeing.
    const index = Math.min(count - 1, Math.floor((ts - start) / size));
    const bucket = out[index];
    bucket.total += 1;
    if (entry.decision === "deny") bucket.deny += 1;
    else if (entry.decision === "instruct") bucket.instruct += 1;
  }

  return out;
}

/** Peak total across buckets — the y-scale, floored at 1 so an empty chart still draws an axis. */
export function peakTotal(buckets: ActivityBucket[]): number {
  return Math.max(1, ...buckets.map((b) => b.total));
}
