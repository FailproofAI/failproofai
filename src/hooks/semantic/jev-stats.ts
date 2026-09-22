/**
 * Aggregate Jev activity for `failproofai jev status`: how often Jev fell back
 * and why, how fast it answered, and which reviewable policies it cleared.
 *
 * Computed from the hook activity store (the same rows the dashboard's
 * activity tab lists), over a trailing window. Nothing here is persisted: the
 * store is the record and these numbers are re-derived on demand, so they can
 * never drift from it.
 *
 * T1's CLI calls {@link jevStats} and may print it with {@link formatJevStats}.
 */
import { getHookActivityEntriesSince, type HookActivityEntry } from "../hook-activity-store";
import { jevOutcome, sanitizeJevActivity } from "../jev-activity";

export interface JevStats {
  windowMs: number;
  /**
   * Gate evaluations in the window that Jev was consulted on: it answered, or
   * it was asked and fell back. A call a hard policy denied before Jev's
   * answer was read says nothing about Jev, so it is not counted here (nor in
   * the fallback rate) but in {@link JevStats.notConsulted}.
   */
  total: number;
  /** Share of `total` recorded as `jev-fallback`, 0..1. */
  fallbackRate: number;
  fallbackReasons: Record<string, number>;
  /** Over calls Jev answered (`evaluator: "jev"`); a fallback's latency is the time it took to give up. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /**
   * Reviewable policies Jev cleared, by name — enforce mode only, where a
   * clear changed the outcome. Shadow mode's would-be clears are in
   * {@link JevStats.shadowClearsByPolicy}.
   */
  clearsByPolicy: Record<string, number>;
  // The fields below are optional in the TYPE only so that a caller written
  // against the original seven-field contract still type-checks; everything
  // this module returns carries all of them (see JevStatsDetail).
  /** Epoch ms the window opened. */
  since?: number;
  /** Calls Jev answered. `answered + fallbacks === total`. */
  answered?: number;
  fallbacks?: number;
  /**
   * Calls on a configured machine where a hard policy denied first, so Jev was
   * aborted and never consulted. Outside `total`.
   */
  notConsulted?: number;
  /**
   * Jev's own verdict on the calls it answered, before combining with the
   * regex results. Sums to `answered` except for a row whose verdict another
   * build wrote in a shape this one cannot read.
   */
  decisions?: { allow: number; instruct: number; deny: number };
  /** Consulted calls (`total`) per rollout mode; a row written without a mode is counted in neither. */
  modes?: { shadow: number; enforce: number };
  /** What Jev would have cleared in shadow mode, where the regex result was enforced instead. */
  shadowClearsByPolicy?: Record<string, number>;
  /** Model ids that answered, by count. */
  models?: Record<string, number>;
}

/** {@link JevStats} with every field present — what this module actually returns. */
export type JevStatsDetail = Required<JevStats>;

export const DEFAULT_JEV_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The longest window `jev status` accepts. The store is never pruned, so this bounds the read. */
export const MAX_JEV_STATS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const WINDOW_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a `--window` value for `failproofai jev status`: a positive whole
 * number of minutes, hours or days (`30m`, `24h`, `7d`), at most
 * {@link MAX_JEV_STATS_WINDOW_MS}. Null for anything else, so the CLI can say
 * what it accepts instead of guessing.
 */
export function parseJevStatsWindow(input: string): number | null {
  const m = /^\s*(\d{1,5})\s*([mhd])\s*$/i.exec(input);
  if (!m) return null;
  const ms = Number(m[1]) * WINDOW_UNIT_MS[m[2].toLowerCase()];
  return ms > 0 && ms <= MAX_JEV_STATS_WINDOW_MS ? ms : null;
}

/** Nearest-rank percentile of an ascending array; null when empty. */
export function percentile(sortedAsc: ReadonlyArray<number>, p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1];
}

/**
 * Counts by name. A Map rather than an object literal: the names come off disk,
 * and `constructor`, `toString` or `__proto__` must count like any other name
 * instead of hitting `Object.prototype`.
 */
class Counter {
  private readonly counts = new Map<string, number>();
  bump(k: string): void {
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  /** A plain object with an own property per name — `__proto__` included. */
  toRecord(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

/**
 * The stats for `entries` that fall in `[since, now]`. Pure; {@link jevStats}
 * feeds it from the store. Rows without a Jev evaluator (Jev not configured,
 * a non-gate event, a paused session) are not part of any number here, and a
 * call Jev was not consulted on (a hard deny decided first) is counted only in
 * `notConsulted`.
 */
export function computeJevStats(
  entries: ReadonlyArray<HookActivityEntry>,
  opts: { windowMs?: number; now?: number } = {},
): JevStatsDetail {
  const windowMs = opts.windowMs ?? DEFAULT_JEV_STATS_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const since = now - windowMs;
  const stats: JevStatsDetail = {
    windowMs,
    total: 0,
    fallbackRate: 0,
    fallbackReasons: {},
    latencyP50Ms: null,
    latencyP95Ms: null,
    clearsByPolicy: {},
    since,
    answered: 0,
    fallbacks: 0,
    notConsulted: 0,
    decisions: { allow: 0, instruct: 0, deny: 0 },
    modes: { shadow: 0, enforce: 0 },
    shadowClearsByPolicy: {},
    models: {},
  };
  const latencies: number[] = [];
  const fallbackReasons = new Counter();
  const clearsByPolicy = new Counter();
  const shadowClearsByPolicy = new Counter();
  const models = new Counter();

  for (const raw of entries) {
    if (typeof raw.timestamp !== "number" || raw.timestamp < since || raw.timestamp > now) continue;
    // Rows are sanitized on write, but this also reads rows another build wrote.
    const e = sanitizeJevActivity(raw);
    const outcome = jevOutcome(e);
    if (outcome === null) continue;
    if (outcome === "not-consulted") {
      stats.notConsulted += 1;
      continue;
    }
    stats.total += 1;
    if (e.jevMode) stats.modes[e.jevMode] += 1;

    if (outcome === "fallback") {
      stats.fallbacks += 1;
      fallbackReasons.bump(e.jevFallbackReason ?? "unknown");
      continue;
    }

    stats.answered += 1;
    if (e.jevDecision) stats.decisions[e.jevDecision] += 1;
    if (e.jevLatencyMs !== undefined) latencies.push(e.jevLatencyMs);
    if (e.jevModel) models.bump(e.jevModel);
    const clears = e.jevMode === "shadow" ? shadowClearsByPolicy : clearsByPolicy;
    for (const name of e.jevCleared ?? []) clears.bump(name);
  }

  stats.fallbackReasons = fallbackReasons.toRecord();
  stats.clearsByPolicy = clearsByPolicy.toRecord();
  stats.shadowClearsByPolicy = shadowClearsByPolicy.toRecord();
  stats.models = models.toRecord();
  stats.fallbackRate = stats.total > 0 ? stats.fallbacks / stats.total : 0;
  latencies.sort((a, b) => a - b);
  stats.latencyP50Ms = percentile(latencies, 50);
  stats.latencyP95Ms = percentile(latencies, 95);
  return stats;
}

/**
 * Jev stats over the trailing window (default 24 h), read from the hook
 * activity store. Never throws: an unreadable store reads as no activity.
 */
export async function jevStats(opts: { windowMs?: number; now?: number } = {}): Promise<JevStatsDetail> {
  const windowMs = opts.windowMs ?? DEFAULT_JEV_STATS_WINDOW_MS;
  const now = opts.now ?? Date.now();
  let entries: HookActivityEntry[] = [];
  try {
    entries = getHookActivityEntriesSince(now - windowMs);
  } catch {
    entries = [];
  }
  return computeJevStats(entries, { windowMs, now });
}

function formatWindow(ms: number): string {
  const h = ms / 3_600_000;
  if (Number.isInteger(h) && h >= 1) return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `${m}m` : `${Math.round(ms / 1000)}s`;
}

function topCounts(m: Record<string, number>, limit = 5): string {
  const rows = Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, limit).map(([k, n]) => `${k} ${n}`);
  if (rows.length > limit) shown.push(`+${rows.length - limit} more`);
  return shown.join(", ");
}

/**
 * The stats section of `failproofai jev status`, as plain lines (no colour, no
 * trailing newline). Names policies and reason codes only — the store holds no
 * command or prompt text for it to print.
 */
export function formatJevStats(s: JevStats): string {
  const win = formatWindow(s.windowMs);
  const notConsulted = s.notConsulted ?? 0;
  const notAsked = `  Not asked:    ${notConsulted} (a hard policy denied first)`;
  if (s.total === 0) {
    const none = `Activity (last ${win}): no Jev evaluations recorded.`;
    return notConsulted > 0 ? [none, notAsked].join("\n") : none;
  }
  const fallbacks = s.fallbacks ?? Object.values(s.fallbackReasons).reduce((a, b) => a + b, 0);
  const answered = s.answered ?? s.total - fallbacks;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [`Activity (last ${win}): ${s.total} evaluation${s.total === 1 ? "" : "s"}`];
  const d = s.decisions;
  lines.push(
    `  Answered:     ${answered}` +
      (answered > 0 && d ? ` (allow ${d.allow}, instruct ${d.instruct}, deny ${d.deny})` : ""),
  );
  lines.push(
    `  Fell back:    ${fallbacks} (${pct(s.fallbackRate)})` +
      (fallbacks > 0 ? ` — ${topCounts(s.fallbackReasons)}` : ""),
  );
  if (notConsulted > 0) lines.push(notAsked);
  if (s.latencyP50Ms !== null) lines.push(`  Latency:      p50 ${s.latencyP50Ms} ms, p95 ${s.latencyP95Ms} ms`);
  if (Object.keys(s.clearsByPolicy).length > 0) lines.push(`  Cleared:      ${topCounts(s.clearsByPolicy)}`);
  if (s.shadowClearsByPolicy && Object.keys(s.shadowClearsByPolicy).length > 0) {
    lines.push(`  Would clear:  ${topCounts(s.shadowClearsByPolicy)} (shadow mode)`);
  }
  if (s.modes && s.modes.shadow > 0 && s.modes.enforce > 0) {
    lines.push(`  Modes:        enforce ${s.modes.enforce}, shadow ${s.modes.shadow}`);
  }
  return lines.join("\n");
}
