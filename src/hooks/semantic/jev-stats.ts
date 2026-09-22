/**
 * Aggregate Jev activity for `failproofai jev status`: how often Jev fell back
 * and why, how fast it answered, and which reviewable policies it cleared.
 *
 * T0 stub: empty stats. T8 implements it over the hook activity store; T1's
 * CLI only calls it.
 */
export interface JevStats {
  windowMs: number;
  /** Gate evaluations in the window where a Jev config was present. */
  total: number;
  /** Share of `total` recorded as `jev-fallback`, 0..1. */
  fallbackRate: number;
  fallbackReasons: Record<string, number>;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  clearsByPolicy: Record<string, number>;
}

export const DEFAULT_JEV_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function jevStats(opts: { windowMs?: number } = {}): Promise<JevStats> {
  return {
    windowMs: opts.windowMs ?? DEFAULT_JEV_STATS_WINDOW_MS,
    total: 0,
    fallbackRate: 0,
    fallbackReasons: {},
    latencyP50Ms: null,
    latencyP95Ms: null,
    clearsByPolicy: {},
  };
}
