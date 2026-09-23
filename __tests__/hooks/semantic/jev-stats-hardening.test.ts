// @vitest-environment node
/**
 * `jevStats()` against awkward stores: names that collide with
 * `Object.prototype`, and a history far longer than the window.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeJevStats, formatJevStats, jevStats } from "../../../src/hooks/semantic/jev-stats";
import {
  _resetForTest,
  getAllHookActivityEntries,
  ROTATION_CLOCK_SLACK_MS,
  type HookActivityEntry,
} from "../../../src/hooks/hook-activity-store";

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

const answered = (extra: Partial<HookActivityEntry> = {}) =>
  row({ evaluator: "jev", jevDecision: "allow", jevLatencyMs: 30, jevMode: "enforce", jevModel: "jev-1.13.0", ...extra });

describe("computeJevStats: names that collide with Object.prototype", () => {
  const PROTO_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

  it("counts them like any other name", () => {
    const s = computeJevStats(
      [
        answered({ jevCleared: PROTO_NAMES }),
        answered({ jevCleared: PROTO_NAMES }),
        answered({ jevMode: "shadow", jevCleared: PROTO_NAMES }),
        answered({ jevModel: "constructor" }),
      ],
      { now: NOW },
    );
    for (const name of PROTO_NAMES) {
      expect(Object.getOwnPropertyDescriptor(s.clearsByPolicy, name)?.value, name).toBe(2);
      expect(Object.getOwnPropertyDescriptor(s.shadowClearsByPolicy, name)?.value, name).toBe(1);
    }
    expect(Object.entries(s.clearsByPolicy).sort()).toEqual(PROTO_NAMES.map((n) => [n, 2]).sort());
    expect(Object.getOwnPropertyDescriptor(s.models, "constructor")?.value).toBe(1);
    // The counts are data, not a prototype: nothing inherited leaks in.
    expect(Object.getPrototypeOf(s.clearsByPolicy)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(s.clearsByPolicy))).toEqual(
      JSON.parse(JSON.stringify(Object.fromEntries(PROTO_NAMES.map((n) => [n, 2])))),
    );
  });

  it("prints them as counts, never as native code", () => {
    const s = computeJevStats(
      [
        answered({ jevCleared: ["toString", "constructor"] }),
        row({ evaluator: "jev-fallback", jevFallbackReason: "constructor" }),
      ],
      { now: NOW },
    );
    const out = formatJevStats(s) + JSON.stringify(s);
    expect(out).not.toContain("native code");
    expect(out).not.toContain("function");
    expect(formatJevStats(s)).toContain("  Cleared:      constructor 1, toString 1");
    // `constructor` is not a known reason code, so it was stored as `other`.
    expect(s.fallbackReasons).toEqual({ other: 1 });
  });
});

describe("jevStats: reads only the window, not the whole history", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "jev-stats-bounded-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("never opens a page rotated before the window", async () => {
    // A page named as rotated 30 days ago cannot hold anything in a 24 h
    // window, so jevStats must not read it. This one breaks that invariant on
    // purpose: it holds rows stamped INSIDE the window, so they are counted
    // if and only if the old page is read.
    const windowMs = 24 * HOUR;
    const rotatedAt = NOW - 30 * 24 * HOUR - ROTATION_CLOCK_SLACK_MS;
    const planted = [answered({ timestamp: NOW - 2 * HOUR }), answered({ timestamp: NOW - 3 * HOUR })];
    writeFileSync(join(testDir, `page-${rotatedAt}-0.jsonl`), planted.map((r) => JSON.stringify(r) + "\n").join(""));
    writeFileSync(join(testDir, "current.jsonl"), JSON.stringify(answered({ timestamp: NOW - HOUR })) + "\n");

    // Sanity: the rows are there, and a full read would count them.
    expect(getAllHookActivityEntries()).toHaveLength(3);
    expect(computeJevStats(getAllHookActivityEntries(), { now: NOW, windowMs }).total).toBe(3);

    const stats = await jevStats({ now: NOW, windowMs });
    expect(stats.total).toBe(1);
    expect(stats.answered).toBe(1);
  });
});
