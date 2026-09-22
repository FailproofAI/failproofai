// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_JEV_STATS_WINDOW_MS,
  computeJevStats,
  formatJevStats,
  jevStats,
  percentile,
  type JevStats,
} from "../../../src/hooks/semantic/jev-stats";
import { _resetForTest, persistHookActivity, type HookActivityEntry } from "../../../src/hooks/hook-activity-store";

// Real wall-clock time, not a fixed instant: the store names rotated pages by
// Date.now(), and the windowed read relies on page names and entry timestamps
// sharing one clock.
const NOW = Date.now();
const HOUR = 3_600_000;

function row(overrides: Partial<HookActivityEntry> = {}): HookActivityEntry {
  return {
    timestamp: NOW - HOUR,
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 40,
    ...overrides,
  };
}

const answered = (latency: number, extra: Partial<HookActivityEntry> = {}) =>
  row({ evaluator: "jev", jevDecision: "allow", jevLatencyMs: latency, jevMode: "enforce", jevModel: "jev-1.13.0", ...extra });
const fellBack = (reason: string, extra: Partial<HookActivityEntry> = {}) =>
  row({ evaluator: "jev-fallback", jevFallbackReason: reason, jevLatencyMs: 1_500, jevMode: "enforce", ...extra });

describe("percentile (nearest rank)", () => {
  it("is null for no samples", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("picks the nearest-rank sample", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});

describe("computeJevStats", () => {
  it("is empty when nothing in the window involved Jev", () => {
    const s = computeJevStats([row(), row({ decision: "deny", policyName: "block-sudo" })], { now: NOW });
    expect(s).toMatchObject({
      windowMs: DEFAULT_JEV_STATS_WINDOW_MS,
      total: 0,
      fallbackRate: 0,
      fallbackReasons: {},
      latencyP50Ms: null,
      latencyP95Ms: null,
      clearsByPolicy: {},
      answered: 0,
      fallbacks: 0,
    });
  });

  it("computes the fallback rate and reasons", () => {
    const s = computeJevStats(
      [answered(30), answered(40), answered(50), fellBack("timeout"), fellBack("http-429"), fellBack("timeout"), row()],
      { now: NOW },
    );
    expect(s.total).toBe(6);
    expect(s.answered).toBe(3);
    expect(s.fallbacks).toBe(3);
    expect(s.fallbackRate).toBeCloseTo(0.5);
    expect(s.fallbackReasons).toEqual({ timeout: 2, "http-429": 1 });
  });

  it("reports latency p50/p95 over answered calls only", () => {
    // A fallback's latency is the time spent giving up (the timeout), not how
    // fast Jev answers; it must not drag the percentiles.
    const rows = [...Array.from({ length: 20 }, (_, i) => answered((i + 1) * 10)), fellBack("timeout")];
    const s = computeJevStats(rows, { now: NOW });
    expect(s.latencyP50Ms).toBe(100);
    expect(s.latencyP95Ms).toBe(190);
  });

  it("counts clears per policy, separating shadow-mode would-be clears", () => {
    const s = computeJevStats(
      [
        answered(30, { jevCleared: ["block-read-outside-cwd"] }),
        answered(30, { jevCleared: ["block-read-outside-cwd", "protect-env-vars"] }),
        answered(30, { jevCleared: [] }),
        answered(30, { jevMode: "shadow", jevCleared: ["block-env-files"] }),
      ],
      { now: NOW },
    );
    expect(s.clearsByPolicy).toEqual({ "block-read-outside-cwd": 2, "protect-env-vars": 1 });
    expect(s.shadowClearsByPolicy).toEqual({ "block-env-files": 1 });
    expect(s.modes).toEqual({ shadow: 1, enforce: 3 });
  });

  it("tallies Jev's own verdicts and the models that answered", () => {
    const s = computeJevStats(
      [
        answered(30),
        answered(30, { jevDecision: "instruct" }),
        answered(30, { jevDecision: "deny", jevModel: "typesafe/jev" }),
      ],
      { now: NOW },
    );
    expect(s.decisions).toEqual({ allow: 1, instruct: 1, deny: 1 });
    expect(s.models).toEqual({ "jev-1.13.0": 2, "typesafe/jev": 1 });
  });

  it("counts only rows inside the window", () => {
    const s = computeJevStats(
      [
        answered(10, { timestamp: NOW - 2 * HOUR }),
        answered(20, { timestamp: NOW - 30 * HOUR }),
        fellBack("timeout", { timestamp: NOW + HOUR }),
      ],
      { now: NOW, windowMs: 24 * HOUR },
    );
    expect(s.total).toBe(1);
    expect(s.since).toBe(NOW - 24 * HOUR);
    expect(s.latencyP50Ms).toBe(10);
  });

  it("re-validates rows written by another build", () => {
    const s = computeJevStats(
      [fellBack("error: something with a command in it"), row({ evaluator: "weird" as never })],
      { now: NOW },
    );
    expect(s.total).toBe(1);
    expect(s.fallbackReasons).toEqual({ error: 1 });
  });

  it("names a fallback with no reason `unknown`", () => {
    const s = computeJevStats([row({ evaluator: "jev-fallback" })], { now: NOW });
    expect(s.fallbackReasons).toEqual({ unknown: 1 });
  });
});

describe("jevStats (from the activity store)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "jev-stats-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns the T0 contract fields, zeroed, for an empty store", async () => {
    const s = await jevStats({ now: NOW });
    expect(s).toMatchObject({
      windowMs: DEFAULT_JEV_STATS_WINDOW_MS,
      total: 0,
      fallbackRate: 0,
      fallbackReasons: {},
      latencyP50Ms: null,
      latencyP95Ms: null,
      clearsByPolicy: {},
    });
  });

  it("reads persisted rows over the window, across page rotation", async () => {
    // 30 rows: more than a page (25), so the read spans a rotation.
    for (let i = 0; i < 27; i++) persistHookActivity(answered(10 + i, { timestamp: NOW - HOUR + i }));
    persistHookActivity(fellBack("timeout", { timestamp: NOW - HOUR + 100 }));
    persistHookActivity(answered(5, { timestamp: NOW - 48 * HOUR, jevCleared: ["block-env-files"] }));
    persistHookActivity(row({ timestamp: NOW - 10 }));

    const s = await jevStats({ now: NOW, windowMs: 24 * HOUR });
    expect(s.total).toBe(28);
    expect(s.answered).toBe(27);
    expect(s.fallbackReasons).toEqual({ timeout: 1 });
    expect(s.fallbackRate).toBeCloseTo(1 / 28);
    expect(s.clearsByPolicy).toEqual({});
    expect(s.latencyP50Ms).toBe(23);
  });

  it("honours a custom window", async () => {
    persistHookActivity(answered(10, { timestamp: NOW - 10 * 60_000 }));
    persistHookActivity(answered(10, { timestamp: NOW - 2 * HOUR }));
    expect((await jevStats({ now: NOW, windowMs: HOUR })).total).toBe(1);
    expect((await jevStats({ now: NOW, windowMs: 3 * HOUR })).total).toBe(2);
  });
});

describe("formatJevStats", () => {
  it("says so when there is nothing to report", () => {
    expect(formatJevStats(computeJevStats([], { now: NOW }))).toBe(
      "Activity (last 1d): no Jev evaluations recorded.",
    );
  });

  it("prints counts, reasons, latency and clears", () => {
    const s = computeJevStats(
      [
        answered(30, { jevCleared: ["block-read-outside-cwd"] }),
        answered(50, { jevDecision: "deny" }),
        fellBack("timeout"),
        answered(40, { jevMode: "shadow", jevCleared: ["block-env-files"] }),
      ],
      { now: NOW, windowMs: 6 * HOUR },
    );
    expect(formatJevStats(s)).toBe(
      [
        "Activity (last 6h): 4 evaluations",
        "  Answered:     3 (allow 2, instruct 0, deny 1)",
        "  Fell back:    1 (25.0%) — timeout 1",
        "  Latency:      p50 40 ms, p95 50 ms",
        "  Cleared:      block-read-outside-cwd 1",
        "  Would clear:  block-env-files 1 (shadow mode)",
        "  Modes:        enforce 3, shadow 1",
      ].join("\n"),
    );
  });

  it("accepts a stats object carrying only the original seven fields", () => {
    const minimal: JevStats = {
      windowMs: HOUR,
      total: 4,
      fallbackRate: 0.25,
      fallbackReasons: { "http-429": 1 },
      latencyP50Ms: 38,
      latencyP95Ms: 210,
      clearsByPolicy: { "protect-env-vars": 2 },
    };
    expect(formatJevStats(minimal)).toBe(
      [
        "Activity (last 1h): 4 evaluations",
        "  Answered:     3",
        "  Fell back:    1 (25.0%) — http-429 1",
        "  Latency:      p50 38 ms, p95 210 ms",
        "  Cleared:      protect-env-vars 2",
      ].join("\n"),
    );
  });

  it("never prints command or prompt text: the stats hold none", () => {
    const secret = ["curl", "-d", "@payroll.csv"].join(" ");
    const s = computeJevStats([fellBack(`error: ${secret}`), answered(10, { jevCleared: [secret] })], { now: NOW });
    const out = formatJevStats(s) + JSON.stringify(s);
    expect(out).not.toContain("payroll");
    expect(out).not.toContain("curl");
  });
});
