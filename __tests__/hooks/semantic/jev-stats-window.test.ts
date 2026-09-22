// @vitest-environment node
/**
 * The window `jevStats()` / `computeJevStats()` really use.
 *
 * `parseJevStatsWindow` bounds what the CLI accepts, but both functions are
 * library calls too. A window that is not a positive finite number used to be
 * taken as given — NaN printed "Activity (last NaNs)" and read every page of
 * the store (the early stop compares against NaN), Infinity read the whole
 * store — and a custom window was only ever checked through the row count,
 * which the windowed store read gets right on its own.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_JEV_STATS_WINDOW_MS,
  MAX_JEV_STATS_WINDOW_MS,
  clampJevStatsWindow,
  computeJevStats,
  formatJevStats,
  jevStats,
} from "../../../src/hooks/semantic/jev-stats";
import { _resetForTest, persistHookActivity, type HookActivityEntry } from "../../../src/hooks/hook-activity-store";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function answered(timestamp: number): HookActivityEntry {
  return {
    timestamp,
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 40,
    evaluator: "jev",
    jevDecision: "allow",
    jevLatencyMs: 30,
    jevMode: "enforce",
    jevModel: "jev-1.13.0",
  };
}

describe("clampJevStatsWindow", () => {
  it("falls back to the default for a window that is not a positive number", () => {
    for (const w of [NaN, -Infinity, 0, -1, -HOUR, undefined, "1h", null]) {
      expect(clampJevStatsWindow(w), String(w)).toBe(DEFAULT_JEV_STATS_WINDOW_MS);
    }
  });

  it("keeps a window in range and caps a longer one", () => {
    expect(clampJevStatsWindow(HOUR)).toBe(HOUR);
    expect(clampJevStatsWindow(MAX_JEV_STATS_WINDOW_MS)).toBe(MAX_JEV_STATS_WINDOW_MS);
    expect(clampJevStatsWindow(MAX_JEV_STATS_WINDOW_MS + 1)).toBe(MAX_JEV_STATS_WINDOW_MS);
    expect(clampJevStatsWindow(Number.MAX_VALUE)).toBe(MAX_JEV_STATS_WINDOW_MS);
    expect(clampJevStatsWindow(Infinity)).toBe(MAX_JEV_STATS_WINDOW_MS);
  });
});

describe("computeJevStats window", () => {
  const rows = [answered(NOW - HOUR), answered(NOW - 30 * DAY), answered(NOW - 100 * DAY)];

  it("a nonsense window reports and counts the default one", () => {
    for (const windowMs of [NaN, 0, -1]) {
      const s = computeJevStats(rows, { now: NOW, windowMs });
      expect(s.windowMs, String(windowMs)).toBe(DEFAULT_JEV_STATS_WINDOW_MS);
      expect(s.since).toBe(NOW - DEFAULT_JEV_STATS_WINDOW_MS);
      expect(s.total).toBe(1);
      expect(formatJevStats(s).startsWith("Activity (last 1d): 1 evaluation")).toBe(true);
    }
  });

  it("an infinite window is capped at 90 days", () => {
    const s = computeJevStats(rows, { now: NOW, windowMs: Infinity });
    expect(s.windowMs).toBe(MAX_JEV_STATS_WINDOW_MS);
    expect(s.since).toBe(NOW - MAX_JEV_STATS_WINDOW_MS);
    expect(s.total).toBe(2);
    expect(formatJevStats(s).startsWith("Activity (last 90d): 2 evaluations")).toBe(true);
  });

  it("a non-finite now is the current time", () => {
    const s = computeJevStats([answered(Date.now() - HOUR)], { now: NaN });
    expect(Number.isFinite(s.since)).toBe(true);
    expect(s.total).toBe(1);
  });
});

describe("jevStats window", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "jev-stats-window-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reports the custom window it was given, not the default", async () => {
    persistHookActivity(answered(NOW - 10 * 60_000));
    persistHookActivity(answered(NOW - 2 * HOUR));
    const s = await jevStats({ now: NOW, windowMs: HOUR });
    expect(s.total).toBe(1);
    expect(s.windowMs).toBe(HOUR);
    expect(s.since).toBe(NOW - HOUR);
    expect(formatJevStats(s).startsWith("Activity (last 1h): 1 evaluation")).toBe(true);
  });

  it("a nonsense window reads and reports the default one", async () => {
    persistHookActivity(answered(NOW - HOUR));
    persistHookActivity(answered(NOW - 2 * DAY));
    for (const windowMs of [NaN, -1]) {
      const s = await jevStats({ now: NOW, windowMs });
      expect(s.windowMs, String(windowMs)).toBe(DEFAULT_JEV_STATS_WINDOW_MS);
      expect(s.total).toBe(1);
      expect(formatJevStats(s).startsWith("Activity (last 1d)")).toBe(true);
    }
  });

  it("an infinite window reads at most 90 days", async () => {
    persistHookActivity(answered(NOW - 100 * DAY));
    persistHookActivity(answered(NOW - HOUR));
    const s = await jevStats({ now: NOW, windowMs: Infinity });
    expect(s.windowMs).toBe(MAX_JEV_STATS_WINDOW_MS);
    expect(s.total).toBe(1);
  });
});
