// @vitest-environment node
/**
 * `getHookActivityEntriesSince` reads without the writers' lock, so a hook
 * process can rotate `current.jsonl` into a new page in the middle of the read.
 * No row may then come back twice: `jev status` counts rows, and a doubled page
 * of Jev answers would skew every number it prints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PAGE_SIZE,
  _resetForTest,
  _setSinceReadProbeForTest,
  getHookActivityEntriesSince,
  persistHookActivity,
  type HookActivityEntry,
} from "../../src/hooks/hook-activity-store";
import { computeJevStats } from "../../src/hooks/semantic/jev-stats";

const T0 = 1_785_740_000_000;

const row = (i: number): HookActivityEntry => ({
  timestamp: T0 + i,
  eventType: "PreToolUse",
  integration: "claude",
  toolName: "Bash",
  policyName: null,
  decision: "allow",
  reason: null,
  durationMs: 40,
  evaluator: "jev",
  jevDecision: "allow",
  jevLatencyMs: 30 + i,
  jevModel: "jev-1.13.0",
  jevMode: "enforce",
});

describe("getHookActivityEntriesSince across a rotation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hook-since-rot-"));
    _resetForTest(dir);
  });
  afterEach(() => {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Fill current.jsonl with `already` rows; the probe then writes enough to rotate it once. */
  function rotateDuring(phase: "before-current" | "after-current", already: number): number {
    for (let i = 0; i < already; i++) persistHookActivity(row(i));
    const extra = PAGE_SIZE - already + 1; // fills the page, and the next write rotates it
    let fired = false;
    _setSinceReadProbeForTest((p) => {
      if (p !== phase || fired) return;
      fired = true;
      for (let i = already; i < already + extra; i++) persistHookActivity(row(i));
    });
    return already + extra;
  }

  it("does not return the rows of a page rotated after current.jsonl was read twice", () => {
    rotateDuring("after-current", 10);
    const got = getHookActivityEntriesSince(T0);
    expect(readdirSync(dir).filter((f) => f.startsWith("page-"))).toHaveLength(1);

    const stamps = got.map((e) => e.timestamp);
    expect(new Set(stamps).size, "a row came back twice").toBe(stamps.length);
    // Every row of the rotated page is there once; the one row appended to the
    // fresh current.jsonl after it was read is simply not seen yet.
    expect([...stamps].sort((a, b) => a - b)).toEqual(Array.from({ length: PAGE_SIZE }, (_, i) => T0 + i));

    const s = computeJevStats(got, { now: T0 + 60_000, windowMs: 120_000 });
    expect(s.total).toBe(PAGE_SIZE);
    expect(s.answered).toBe(PAGE_SIZE);
  });

  it("keeps every row of a page rotated before current.jsonl was read", () => {
    const written = rotateDuring("before-current", 10);
    const stamps = getHookActivityEntriesSince(T0).map((e) => e.timestamp);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort((a, b) => a - b)).toEqual(Array.from({ length: written }, (_, i) => T0 + i));
  });

  it("leaves pages that existed before the read alone", () => {
    // Byte-identical rows in an old page and in current.jsonl cannot come from
    // one rotation; they are two writes and both count.
    const line = JSON.stringify(row(0)) + "\n";
    writeFileSync(join(dir, `page-${T0 + 1}-0.jsonl`), line);
    writeFileSync(join(dir, "current.jsonl"), line);
    expect(getHookActivityEntriesSince(T0)).toHaveLength(2);
  });
});
