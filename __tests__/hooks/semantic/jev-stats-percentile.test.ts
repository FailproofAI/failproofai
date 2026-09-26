// @vitest-environment node
/**
 * Nearest-rank percentiles round the rank UP. With a sample count where the
 * rank has a fractional part below .5, rounding to nearest would report a lower
 * tail latency than the data holds — exactly the regression a p95 must not hide.
 */
import { describe, it, expect } from "vitest";
import { computeJevStats, percentile } from "../../../src/hooks/semantic/jev-stats";
import type { HookActivityEntry } from "../../../src/hooks/hook-activity-store";

const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("percentile: nearest rank, rounded up", () => {
  it("takes the next rank when the exact rank falls below .5", () => {
    // 12 samples: p95 rank 11.4 → the 12th value, not the 11th.
    expect(percentile(oneTo(12), 95)).toBe(12);
    // 7 samples: p50 rank 3.5 → the 4th; p90 rank 6.3 → the 7th.
    expect(percentile(oneTo(7), 50)).toBe(4);
    expect(percentile(oneTo(7), 90)).toBe(7);
    // 21 samples: p95 rank 19.95 → the 20th.
    expect(percentile(oneTo(21), 95)).toBe(20);
  });

  it("feeds jev status the rounded-up rank", () => {
    const rows: HookActivityEntry[] = oneTo(12).map((ms, i) => ({
      timestamp: 1_000 + i,
      eventType: "PreToolUse",
      toolName: "Bash",
      policyName: null,
      decision: "allow",
      reason: null,
      durationMs: ms + 5,
      evaluator: "jev",
      jevDecision: "allow",
      jevLatencyMs: ms * 10,
      jevModel: "jev-1.13.0",
      jevMode: "enforce",
    }));
    const s = computeJevStats(rows, { now: 2_000, windowMs: 10_000 });
    expect(s.latencyP95Ms).toBe(120);
    expect(s.latencyP50Ms).toBe(60);
  });
});
