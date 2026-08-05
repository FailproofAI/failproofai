// @vitest-environment node
/**
 * `risks` mode's single predicate.
 *
 * Two things matter here beyond the obvious cases. First, that the predicate is
 * the audit's OWN model rather than a second one invented alongside it — so it
 * is checked against `severityForBuiltin` and against the live detector
 * catalog, not against a hardcoded list. Second, that every severity it can
 * hand out is one the SERVER will act on: a predicate that says "harmful" and
 * then labels the row something the server files as benign is worse than no
 * predicate, because both sides look correct in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  HARMFUL_WIRE_SEVERITIES,
  harmfulFindings,
  harmfulSeverity,
  hasHarmfulFindings,
  isHarmful,
} from "../../src/audit/harmful";
import { severityForBuiltin } from "../../src/audit/features";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { AUDIT_DETECTORS } from "../../src/audit/detectors";
import type { AuditCount, AuditResult } from "../../src/audit/types";

function row(over: Partial<AuditCount> = {}): AuditCount {
  return {
    name: "failproofai/block-sudo",
    source: "builtin",
    category: "Dangerous Commands",
    severity: "deny",
    hits: 3,
    projects: 1,
    examples: [],
    displayTitle: "",
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...over,
  };
}

describe("what counts as harmful", () => {
  it("is exactly the block-* builtins, per the audit's own severity model", () => {
    for (const policy of BUILTIN_POLICIES) {
      const expected = severityForBuiltin(policy.name) === "deny";
      expect(
        isHarmful(row({ name: policy.name, category: policy.category })),
        `${policy.name} (severity ${severityForBuiltin(policy.name)})`,
      ).toBe(expected);
    }
  });

  it("is exactly the Risky detectors, per the catalog's own split", () => {
    for (const detector of AUDIT_DETECTORS) {
      expect(
        isHarmful(
          row({
            name: detector.name,
            source: "audit-detector",
            category: detector.category,
            severity: detector.severity,
          }),
        ),
        `${detector.name} (${detector.category})`,
      ).toBe(detector.category === "Risky");
    }
    // The split is real in the shipped catalog, so neither branch above is
    // vacuous — this fails if someone deletes the last Risky or last Wasteful
    // detector and quietly turns one of those loops into a no-op.
    expect(AUDIT_DETECTORS.some((d) => d.category === "Risky")).toBe(true);
    expect(AUDIT_DETECTORS.some((d) => d.category === "Wasteful")).toBe(true);
  });

  it("never returns a severity the server files as benign", () => {
    const seen = new Set<string>();
    for (const policy of BUILTIN_POLICIES) {
      const s = harmfulSeverity(row({ name: policy.name }));
      if (s) seen.add(s);
    }
    for (const detector of AUDIT_DETECTORS) {
      const s = harmfulSeverity(
        row({ name: detector.name, source: "audit-detector", category: detector.category }),
      );
      if (s) seen.add(s);
    }
    for (const s of seen) expect(HARMFUL_WIRE_SEVERITIES).toContain(s);
    // Both wire severities are actually reachable from the live catalog.
    expect([...seen].sort()).toEqual([...HARMFUL_WIRE_SEVERITIES].sort());
  });
});

describe("the suppressions", () => {
  it("suppresses a rule the machine already enforces", () => {
    expect(isHarmful(row({ enabledInConfig: true }))).toBe(false);
  });

  it("suppresses a zero-hit row, which the server would reject anyway", () => {
    expect(isHarmful(row({ hits: 0 }))).toBe(false);
    expect(isHarmful(row({ hits: Number.NaN }))).toBe(false);
  });

  it("treats an unrecognised source as NOT harmful", () => {
    // Same direction the server takes with an unknown severity: a quiet week
    // beats mailing about a row nobody can explain.
    expect(isHarmful(row({ source: "cloud-policy" as AuditCount["source"] }))).toBe(false);
  });
});

describe("whole-result helpers", () => {
  const result = (results: AuditCount[]): AuditResult => ({
    version: 2,
    scannedAt: "2026-08-05T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 1 },
    results,
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 1,
    enabledBuiltinNames: [],
  });

  it("is silent on a clean week", () => {
    expect(hasHarmfulFindings(result([]))).toBe(false);
    expect(hasHarmfulFindings(result([row({ name: "failproofai/warn-git-amend" })]))).toBe(false);
    expect(harmfulFindings(result([row({ name: "failproofai/warn-git-amend" })]))).toEqual([]);
  });

  it("keeps the audit's own ranking", () => {
    const found = harmfulFindings(
      result([
        row({ name: "failproofai/block-sudo", hits: 9 }),
        row({ name: "failproofai/warn-git-amend", hits: 8 }),
        row({ name: "failproofai/block-rm-rf", hits: 7 }),
      ]),
    );
    expect(found.map((r) => r.name)).toEqual([
      "failproofai/block-sudo",
      "failproofai/block-rm-rf",
    ]);
  });
});
