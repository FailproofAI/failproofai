// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  deriveScore,
  deriveScoreExact,
  projectedScore,
  gradeFor,
} from "../../src/audit/scoring";
import type { AuditCount, AuditResult } from "../../src/audit/types";

function mkRow(name: string, hits: number, opts: Partial<AuditCount> = {}): AuditCount {
  return {
    name, source: "builtin", category: "test", severity: "deny",
    hits, projects: 1, examples: [], displayTitle: name, impact: "",
    enabledInConfig: false, installHint: "", ...opts,
  };
}

function mkResult(rows: AuditCount[], events = 300, scanned = 5): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-06-01T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned, skipped: 0, errors: 0, durationMs: 0 },
    results: rows,
    totals: { hits: rows.reduce((s, r) => s + r.hits, 0), projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: events,
    enabledBuiltinNames: [],
  };
}

describe("deriveScore", () => {
  it("returns 0 for zero scanned transcripts (no grade)", () => {
    expect(deriveScore(mkResult([mkRow("failproofai/block-rm-rf", 5)], 300, 0))).toBe(0);
  });

  it("a clean agent scores near the top", () => {
    expect(deriveScore(mkResult([], 1000))).toBeGreaterThanOrEqual(90);
  });

  it("clamps to the 0-100 range", () => {
    const s = deriveScore(mkResult([mkRow("failproofai/block-rm-rf", 9999)], 50));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe("deriveScore — dynamic, not threshold-locked", () => {
  it("is strictly monotonic in hit count across the realistic range", () => {
    // The old hard caps made e.g. 30 and 60 hits identical once the cap was
    // hit. The saturator keeps them strictly ordered everywhere on its slope
    // (it only flattens to float-epsilon at catastrophic, equally-bad counts).
    const score = (hits: number) =>
      deriveScoreExact(mkResult([mkRow("failproofai/block-rm-rf", hits)], 600));
    const a = score(5), b = score(15), c = score(30), d = score(45);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(d);
  });

  it("rewards volume: same hits over more tool calls scores higher", () => {
    const rows = [mkRow("failproofai/block-rm-rf", 20)];
    expect(deriveScoreExact(mkResult(rows, 2000)))
      .toBeGreaterThan(deriveScoreExact(mkResult(rows, 200)));
  });

  it("each severity bucket contributes independently (not collapsed to deny)", () => {
    const base = mkResult([mkRow("failproofai/block-rm-rf", 10, { severity: "deny" })], 300);
    const withWarn = mkResult([
      mkRow("failproofai/block-rm-rf", 10, { severity: "deny" }),
      mkRow("failproofai/warn-git-amend", 10, { severity: "warn" }),
    ], 300);
    const withSanitize = mkResult([
      mkRow("failproofai/block-rm-rf", 10, { severity: "deny" }),
      mkRow("failproofai/sanitize-jwt", 10, { severity: "sanitize" }),
    ], 300);
    expect(deriveScoreExact(withWarn)).toBeLessThan(deriveScoreExact(base));
    expect(deriveScoreExact(withSanitize)).toBeLessThan(deriveScoreExact(base));
  });

  it("detector hits penalise via their own bucket", () => {
    const clean = deriveScoreExact(mkResult([], 300));
    const withDet = deriveScoreExact(mkResult([
      mkRow("redundant-cd-cwd", 20, { source: "audit-detector", severity: "warn" }),
    ], 300));
    expect(withDet).toBeLessThan(clean);
  });

  it("is deterministic — same input twice yields the same score", () => {
    const r = mkResult([mkRow("failproofai/block-rm-rf", 7)], 420);
    expect(deriveScore(r)).toBe(deriveScore(r));
  });
});

describe("projectedScore", () => {
  it("never drops below the current score and caps at 92", () => {
    const r = mkResult([mkRow("failproofai/block-rm-rf", 30, { enabledInConfig: false })], 300);
    const cur = deriveScore(r);
    const proj = projectedScore(r, cur);
    expect(proj).toBeGreaterThanOrEqual(cur);
    expect(proj).toBeLessThanOrEqual(92);
  });

  it("recovers points from unenabled builtins, not from enabled ones", () => {
    const unenabled = mkResult([mkRow("failproofai/block-rm-rf", 30, { enabledInConfig: false })], 300);
    const enabled = mkResult([mkRow("failproofai/block-rm-rf", 30, { enabledInConfig: true })], 300);
    const projUnenabled = projectedScore(unenabled, deriveScore(unenabled));
    const projEnabled = projectedScore(enabled, deriveScore(enabled));
    expect(projUnenabled).toBeGreaterThan(deriveScore(unenabled));
    // Already-enabled hits aren't "recoverable" → projection equals current.
    expect(projEnabled).toBe(deriveScore(enabled));
  });
});

describe("gradeFor", () => {
  it("maps the documented thresholds", () => {
    expect(gradeFor(95)).toBe("S");
    expect(gradeFor(85)).toBe("A");
    expect(gradeFor(75)).toBe("B");
    expect(gradeFor(60)).toBe("C");
    expect(gradeFor(45)).toBe("D");
    expect(gradeFor(20)).toBe("F");
  });
});
