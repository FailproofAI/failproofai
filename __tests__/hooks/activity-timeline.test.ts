import { describe, it, expect } from "vitest";
import { bucketActivity, peakTotal, DEFAULT_BUCKETS } from "../../src/hooks/activity-timeline";
import type { HookActivityEntry } from "../../src/hooks/hook-activity-store";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const entry = (timestamp: number, decision: "allow" | "deny" | "instruct" = "allow"): HookActivityEntry =>
  ({ timestamp, decision, eventType: "PreToolUse", toolName: "Bash", policyName: null, reason: null, durationMs: 1 }) as HookActivityEntry;

describe("bucketActivity", () => {
  it("emits a bucket for the whole window, including empty ones", () => {
    // Dropping empties would compress a quiet period and draw a line implying
    // continuous activity across a gap. A zero is data.
    const buckets = bucketActivity([entry(NOW - HOUR)], { now: NOW });
    expect(buckets).toHaveLength(DEFAULT_BUCKETS);
    expect(buckets.filter((b) => b.total === 0)).toHaveLength(DEFAULT_BUCKETS - 1);
  });

  it("places events in the right bucket and counts decisions separately", () => {
    const buckets = bucketActivity(
      [
        entry(NOW - 30 * 60_000, "deny"),
        entry(NOW - 30 * 60_000, "allow"),
        entry(NOW - 30 * 60_000, "instruct"),
      ],
      { now: NOW },
    );
    const last = buckets[buckets.length - 1];
    expect(last.total).toBe(3);
    expect(last.deny).toBe(1);
    expect(last.instruct).toBe(1);
  });

  it("keeps an event landing exactly on `now` instead of dropping it", () => {
    // Naive flooring indexes one past the end here, silently losing the newest
    // event — the one most worth seeing.
    const buckets = bucketActivity([entry(NOW, "deny")], { now: NOW });
    expect(buckets[buckets.length - 1].deny).toBe(1);
  });

  it("excludes anything outside the window in either direction", () => {
    const buckets = bucketActivity(
      [entry(NOW - 48 * HOUR), entry(NOW + HOUR)],
      { now: NOW },
    );
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(0);
  });

  it("ignores entries with a missing or non-finite timestamp", () => {
    const buckets = bucketActivity(
      [{ decision: "deny" } as HookActivityEntry, entry(Number.NaN, "deny")],
      { now: NOW },
    );
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(0);
  });

  it("honours a custom window and bucket count", () => {
    const buckets = bucketActivity([entry(NOW - 5 * 60_000)], { now: NOW, windowMs: HOUR, buckets: 6 });
    expect(buckets).toHaveLength(6);
    expect(buckets[5].total).toBe(1);
  });

  it("returns at least one bucket even if asked for zero", () => {
    expect(bucketActivity([], { now: NOW, buckets: 0 })).toHaveLength(1);
  });

  it("emits buckets in ascending time order", () => {
    const buckets = bucketActivity([], { now: NOW });
    const times = buckets.map((b) => b.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("peakTotal", () => {
  it("is the largest bucket total", () => {
    expect(peakTotal([{ t: 0, total: 3, deny: 0, instruct: 0 }, { t: 1, total: 9, deny: 0, instruct: 0 }])).toBe(9);
  });

  it("floors at 1 so an empty chart still has an axis to draw", () => {
    expect(peakTotal([])).toBe(1);
    expect(peakTotal([{ t: 0, total: 0, deny: 0, instruct: 0 }])).toBe(1);
  });
});
