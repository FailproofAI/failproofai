// @vitest-environment node
/**
 * Calls Jev sent no request for.
 *
 * When no semantic policy applies to the call (TodoWrite, Task, Skill, …), the
 * evaluator compiles zero questions and answers `allow` without calling the
 * provider, and the two-tier path records
 * `{ evaluator: "jev", jevDecision: "allow", jevMode }` — a verdict with no
 * latency, model or cleared list (see __tests__/fixtures/jev-no-request-rows.ts).
 * Jev never saw such a call, so no surface may count or describe it as one Jev
 * answered: not `jev status` (it would dilute the fallback rate), not the
 * dashboard, not PostHog, not the collector (the Rust half is in
 * crates/fpai-collect/tests/hooks_jev.rs, which reads the golden file this test
 * keeps in step with the store).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JEV_NO_REQUEST_FACT,
  describeJevActivity,
  jevOutcome,
  type JevActivityFields,
} from "../../src/hooks/jev-activity";
import { computeJevStats, formatJevStats } from "../../src/hooks/semantic/jev-stats";
import { jevTelemetryProperties } from "../../src/hooks/hook-telemetry";
import { _resetForTest, persistHookActivity, type HookActivityEntry } from "../../src/hooks/hook-activity-store";
import { JEV_NO_REQUEST_ROWS } from "../fixtures/jev-no-request-rows";

const GOLDEN = join(
  __dirname,
  "..",
  "..",
  "crates",
  "fpai-collect",
  "tests",
  "fixtures",
  "hook-activity-jev-no-request.jsonl",
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

/** Exactly what the two-tier path records for a TodoWrite call: nothing to ask, no request sent. */
const noRequest = (mode: "shadow" | "enforce" = "enforce", ts = NOW - 1_000) =>
  row({ timestamp: ts, toolName: "TodoWrite", evaluator: "jev", jevDecision: "allow", jevMode: mode });
const answered = (latency: number, extra: Partial<HookActivityEntry> = {}) =>
  row({ evaluator: "jev", jevDecision: "allow", jevLatencyMs: latency, jevModel: "jev-1.13.0", jevMode: "enforce", ...extra });
const timedOut = () => row({ evaluator: "jev-fallback", jevFallbackReason: "timeout", jevLatencyMs: 1_500, jevMode: "enforce" });
const hardDeny = () => row({ decision: "deny", policyName: "block-sudo", evaluator: "jev", jevMode: "enforce" });

describe("jevOutcome: a call Jev sent no request for", () => {
  it("classifies the recorded no-request row as no-request, not answered", () => {
    expect(jevOutcome(noRequest("enforce"))).toBe("no-request");
    expect(jevOutcome(noRequest("shadow"))).toBe("no-request");
    expect(jevOutcome({ evaluator: "jev", jevDecision: "allow" })).toBe("no-request");
    for (const r of JEV_NO_REQUEST_ROWS) expect(jevOutcome(r), r.toolName ?? "").toBe("no-request");
  });

  it("still counts a verdict only an answer can produce as answered", () => {
    // With no questions asked, the evaluator's verdict is always allow; a deny
    // or instruct means Jev's answers fired a policy.
    expect(jevOutcome({ evaluator: "jev", jevMode: "enforce", jevDecision: "deny" })).toBe("answered");
    expect(jevOutcome({ evaluator: "jev", jevMode: "enforce", jevDecision: "instruct" })).toBe("answered");
    // An allow with anything a request produces is an answer.
    expect(jevOutcome(answered(30))).toBe("answered");
    expect(jevOutcome({ evaluator: "jev", jevDecision: "allow", jevLatencyMs: 12 })).toBe("answered");
    expect(jevOutcome({ evaluator: "jev", jevDecision: "allow", jevModel: "jev-1.13.0" })).toBe("answered");
    expect(jevOutcome({ evaluator: "jev", jevDecision: "allow", jevCleared: ["block-env-files"] })).toBe("answered");
    // And the other shapes keep their meaning.
    expect(jevOutcome(hardDeny())).toBe("not-consulted");
    expect(jevOutcome(timedOut())).toBe("fallback");
  });
});

describe("jev status stats", () => {
  it("keeps no-request calls out of total, answered and the fallback rate", () => {
    // 8 TodoWrite calls (nothing to ask), 1 real answer, 1 timeout.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => noRequest("enforce", NOW - 1_000 - i)),
      answered(40),
      timedOut(),
    ];
    const s = computeJevStats(rows, { now: NOW, windowMs: 60_000 });
    expect(s.total).toBe(2);
    expect(s.answered).toBe(1);
    expect(s.fallbacks).toBe(1);
    expect(s.noRequest).toBe(8);
    expect(s.notConsulted).toBe(0);
    expect(s.fallbackRate).toBeCloseTo(0.5);
    expect(s.decisions).toEqual({ allow: 1, instruct: 0, deny: 0 });
    expect(s.modes).toEqual({ shadow: 0, enforce: 2 });
  });

  it("prints the no-request calls on a line of their own", () => {
    const s = computeJevStats([noRequest(), noRequest(), noRequest(), hardDeny(), answered(40), timedOut()], {
      now: NOW,
      windowMs: 3_600_000,
    });
    expect(formatJevStats(s)).toBe(
      [
        "Activity (last 1h): 2 evaluations",
        "  Answered:     1 (allow 1, instruct 0, deny 0)",
        "  Fell back:    1 (50.0%) — timeout 1",
        "  Not asked:    1 (a hard policy denied first)",
        "  No request:   3 (no semantic policy applied to the call)",
        "  Latency:      p50 40 ms, p95 40 ms",
      ].join("\n"),
    );
  });

  it("reports no evaluations when Jev never had anything to ask", () => {
    const s = computeJevStats([noRequest(), noRequest("shadow")], { now: NOW, windowMs: 3_600_000 });
    expect(s.total).toBe(0);
    expect(s.answered).toBe(0);
    expect(s.noRequest).toBe(2);
    expect(formatJevStats(s)).toBe(
      [
        "Activity (last 1h): no Jev evaluations recorded.",
        "  No request:   2 (no semantic policy applied to the call)",
      ].join("\n"),
    );
  });
});

describe("the dashboard summary", () => {
  it("says no request was sent, and claims no verdict", () => {
    for (const mode of ["enforce", "shadow"] as const) {
      expect(describeJevActivity(noRequest(mode))).toEqual([JEV_NO_REQUEST_FACT]);
    }
  });
});

describe("PostHog properties", () => {
  it("mark the call no-request and claim no answer", () => {
    expect(jevTelemetryProperties(noRequest("enforce"))).toEqual({
      jev_evaluator: "jev",
      jev_mode: "enforce",
      jev_outcome: "no-request",
    });
  });

  it("leave an answered call's properties as they were", () => {
    const props = jevTelemetryProperties(answered(40) as JevActivityFields);
    expect(props.jev_decision).toBe("allow");
    expect(props).not.toHaveProperty("jev_outcome");
  });
});

describe("the collector's no-request golden rows", () => {
  it("are exactly what the store writes for the no-request shape", () => {
    // crates/fpai-collect/tests/hooks_jev.rs reads this file. If the store's
    // output changes, regenerate it from __tests__/fixtures/jev-no-request-rows.ts
    // (persist each row, copy current.jsonl) and re-run the Rust tests.
    const dir = mkdtempSync(join(tmpdir(), "jev-golden-nr-"));
    try {
      _resetForTest(dir);
      for (const r of JEV_NO_REQUEST_ROWS) persistHookActivity(r);
      const written = readFileSync(join(dir, "current.jsonl"), "utf-8");
      expect(written).toBe(readFileSync(GOLDEN, "utf-8"));
      for (const line of written.trim().split("\n")) {
        const keys = Object.keys(JSON.parse(line)).filter((k) => k === "evaluator" || k.startsWith("jev"));
        expect(keys.sort()).toEqual(["evaluator", "jevDecision", "jevMode"]);
      }
    } finally {
      _resetForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
