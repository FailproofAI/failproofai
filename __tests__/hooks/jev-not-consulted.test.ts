// @vitest-environment node
/**
 * Calls Jev was not consulted on.
 *
 * When a hard policy denies, the two-tier combine rules abort Jev and record
 * `{ evaluator: "jev", jevMode }` and no other Jev field. `evaluator: "jev"`
 * there means "the two-tier path ran", not "Jev answered", so no surface may
 * count or describe such a call as one Jev answered: not `jev status`, not the
 * dashboard, not PostHog, not the collector (see the Rust half in
 * crates/fpai-collect/tests/hooks_jev.rs, which reads the golden file this
 * test keeps in step with the store).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JEV_NOT_CONSULTED_FACT,
  describeJevActivity,
  jevOutcome,
  type JevActivityFields,
} from "../../src/hooks/jev-activity";
import { computeJevStats, formatJevStats } from "../../src/hooks/semantic/jev-stats";
import { jevTelemetryProperties } from "../../src/hooks/hook-telemetry";
import { _resetForTest, persistHookActivity, type HookActivityEntry } from "../../src/hooks/hook-activity-store";
import { JEV_NOT_CONSULTED_ROWS } from "../fixtures/jev-not-consulted-rows";

const GOLDEN = join(
  __dirname,
  "..",
  "..",
  "crates",
  "fpai-collect",
  "tests",
  "fixtures",
  "hook-activity-jev-not-consulted.jsonl",
);

const NOW = 10_000_000;

function row(overrides: Partial<HookActivityEntry> = {}): HookActivityEntry {
  return {
    timestamp: NOW - 1_000,
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 3,
    ...overrides,
  };
}

/** Exactly what the combine rules record for a hard deny: Jev aborted, never read. */
const notConsulted = (mode: "shadow" | "enforce" = "enforce", ts = NOW - 1_000) =>
  row({
    timestamp: ts,
    decision: "deny",
    policyName: "block-sudo",
    reason: "sudo commands are blocked",
    evaluator: "jev",
    jevMode: mode,
  });
const answered = (latency: number, extra: Partial<HookActivityEntry> = {}) =>
  row({ evaluator: "jev", jevDecision: "allow", jevLatencyMs: latency, jevModel: "jev-1.13.0", jevMode: "enforce", ...extra });
const timedOut = () => row({ evaluator: "jev-fallback", jevFallbackReason: "timeout", jevLatencyMs: 1_500, jevMode: "enforce" });

describe("jevOutcome", () => {
  it("classifies the combine rules' not-consulted row as not consulted", () => {
    expect(jevOutcome(notConsulted("enforce"))).toBe("not-consulted");
    expect(jevOutcome(notConsulted("shadow"))).toBe("not-consulted");
    expect(jevOutcome({ evaluator: "jev" })).toBe("not-consulted");
    for (const r of JEV_NOT_CONSULTED_ROWS) expect(jevOutcome(r)).toBe("not-consulted");
  });

  it("classifies answers and fallbacks", () => {
    expect(jevOutcome(answered(30))).toBe("answered");
    expect(jevOutcome(timedOut())).toBe("fallback");
    expect(jevOutcome(row())).toBeNull();
    expect(jevOutcome({ jevDecision: "deny" })).toBeNull();
  });

  it("counts a row as answered when it carries anything only an answer produces", () => {
    const only: JevActivityFields[] = [
      { jevDecision: "deny" },
      { jevCleared: [] },
      { jevCleared: ["block-env-files"] },
      { jevLatencyMs: 12 },
      { jevModel: "jev-1.13.0" },
    ];
    for (const fields of only) {
      expect(jevOutcome({ evaluator: "jev", jevMode: "enforce", ...fields }), JSON.stringify(fields)).toBe("answered");
    }
    // A verdict this build cannot read, next to a model id: still an answer.
    expect(jevOutcome({ evaluator: "jev", jevDecision: "perhaps" as never, jevModel: "jev-1.13.0" })).toBe("answered");
  });
});

describe("jev status stats", () => {
  it("does not count a call Jev was not consulted on as answered, nor dilute the fallback rate with it", () => {
    // 8 hard denies (Jev aborted), 1 real answer, 1 timeout.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => notConsulted("enforce", NOW - 1_000 - i)),
      answered(40),
      timedOut(),
    ];
    const s = computeJevStats(rows, { now: NOW, windowMs: 60_000 });
    expect(s.total).toBe(2);
    expect(s.answered).toBe(1);
    expect(s.fallbacks).toBe(1);
    expect(s.notConsulted).toBe(8);
    expect(s.fallbackRate).toBeCloseTo(0.5);
    expect(s.answered + s.fallbacks).toBe(s.total);
    expect(s.decisions.allow + s.decisions.instruct + s.decisions.deny).toBe(s.answered);
    expect(s.modes).toEqual({ shadow: 0, enforce: 2 });
    expect(s.latencyP50Ms).toBe(40);
  });

  it("prints the not-consulted calls on a line of their own", () => {
    const s = computeJevStats([notConsulted(), notConsulted(), answered(40), timedOut()], { now: NOW, windowMs: 3_600_000 });
    expect(formatJevStats(s)).toBe(
      [
        "Activity (last 1h): 2 evaluations",
        "  Answered:     1 (allow 1, instruct 0, deny 0)",
        "  Fell back:    1 (50.0%) — timeout 1",
        "  Not asked:    2 (a hard policy denied first)",
        "  Latency:      p50 40 ms, p95 40 ms",
      ].join("\n"),
    );
  });

  it("reports no evaluations when every Jev row was a hard deny", () => {
    const s = computeJevStats([notConsulted(), notConsulted("shadow")], { now: NOW, windowMs: 3_600_000 });
    expect(s.total).toBe(0);
    expect(s.answered).toBe(0);
    expect(s.fallbackRate).toBe(0);
    expect(s.notConsulted).toBe(2);
    expect(formatJevStats(s)).toBe(
      ["Activity (last 1h): no Jev evaluations recorded.", "  Not asked:    2 (a hard policy denied first)"].join("\n"),
    );
  });
});

describe("the dashboard summary", () => {
  it("says Jev was not consulted, rather than an empty summary", () => {
    for (const mode of ["enforce", "shadow"] as const) {
      expect(describeJevActivity(notConsulted(mode))).toEqual([JEV_NOT_CONSULTED_FACT]);
    }
  });

  it("never returns an empty list for a Jev row", () => {
    // An empty list renders as a bare "Semantic review:" label.
    const rows: JevActivityFields[] = [
      { evaluator: "jev" },
      { evaluator: "jev", jevDecision: "perhaps" as never, jevCleared: "x" as never, jevLatencyMs: Number.NaN, jevModel: "a b" },
      { evaluator: "jev", jevCleared: [] },
      { evaluator: "jev-fallback" },
    ];
    for (const r of rows) {
      const facts = describeJevActivity(r);
      expect(facts, JSON.stringify(r)).not.toBeNull();
      expect(facts!.length, JSON.stringify(r)).toBeGreaterThan(0);
    }
  });
});

describe("PostHog properties", () => {
  it("mark the call not consulted and claim no answer", () => {
    expect(jevTelemetryProperties(notConsulted("enforce"))).toEqual({
      jev_evaluator: "jev",
      jev_mode: "enforce",
      jev_outcome: "not-consulted",
    });
  });
});

describe("the collector's not-consulted golden rows", () => {
  it("are exactly what the store writes for the combine rules' not-consulted shape", () => {
    // crates/fpai-collect/tests/hooks_jev.rs reads this file. If the store's
    // output changes, regenerate it from __tests__/fixtures/jev-not-consulted-rows.ts
    // (persist each row, copy current.jsonl) and re-run the Rust tests.
    const dir = mkdtempSync(join(tmpdir(), "jev-golden-nc-"));
    try {
      _resetForTest(dir);
      for (const r of JEV_NOT_CONSULTED_ROWS) persistHookActivity(r);
      const written = readFileSync(join(dir, "current.jsonl"), "utf-8");
      expect(written).toBe(readFileSync(GOLDEN, "utf-8"));
      // Nothing is added on the way to disk: still the bare shape.
      for (const line of written.trim().split("\n")) {
        const keys = Object.keys(JSON.parse(line)).filter((k) => k === "evaluator" || k.startsWith("jev"));
        expect(keys.sort()).toEqual(["evaluator", "jevMode"]);
      }
    } finally {
      _resetForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
