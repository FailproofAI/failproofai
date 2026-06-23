// @vitest-environment node
/**
 * Unit coverage for the `failproofai audit` command's pure pieces:
 *   • AUDIT_STAGES stays in lockstep with the dashboard's RunProgress STAGES
 *     (the CLI and dashboard must tell the same four-step story).
 *   • buildSummary renders the right post-run line(s) for clean / mixed /
 *     singular results.
 *
 * The server-launch + browser-open path is a thin wrapper over the existing
 * `launch()` and is exercised by the build/smoke test, not here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_STAGES, buildSummary } from "../../src/audit/cli";
import type { AuditCount, AuditResult } from "../../src/audit/types";

const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, "");

function count(over: Partial<AuditCount>): AuditCount {
  return {
    name: "x",
    source: "builtin",
    category: "Risky",
    severity: "deny",
    hits: 1,
    projects: 1,
    examples: [],
    displayTitle: "x",
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...over,
  };
}

function result(over: Partial<AuditResult>): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-06-22T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 },
    results: [],
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 0,
    enabledBuiltinNames: [],
    ...over,
  };
}

describe("AUDIT_STAGES", () => {
  it("matches the dashboard's RunProgress STAGES labels (guards drift)", () => {
    const src = readFileSync(
      join(__dirname, "../../app/audit/_components/run-progress.tsx"),
      "utf-8",
    );
    const dashboardLabels = [...src.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(dashboardLabels.length).toBeGreaterThan(0);
    expect(AUDIT_STAGES.map((s) => s.label)).toEqual(dashboardLabels);
  });
});

describe("buildSummary", () => {
  it("reports tool calls, sessions, and projects (with thousands separators)", () => {
    const lines = buildSummary(
      result({
        eventsScanned: 1240,
        transcripts: { scanned: 18, skipped: 0, errors: 0, durationMs: 0 },
        projectsScanned: ["/a", "/b", "/c", "/d"],
        totals: { hits: 0, projectsWithHits: 0 },
      }),
    ).map(stripAnsi);
    expect(lines[0]).toContain("audit complete");
    expect(lines[0]).toContain("1,240 tool calls across 18 sessions");
    expect(lines[0]).toContain("4 projects");
  });

  it("shows a clean-run line when something was scanned but nothing flagged", () => {
    const lines = buildSummary(
      result({
        eventsScanned: 10,
        transcripts: { scanned: 2, skipped: 0, errors: 0, durationMs: 0 },
      }),
    ).map(stripAnsi);
    expect(lines.join("\n")).toContain("clean run");
    expect(lines.join("\n")).not.toContain("slipping through");
  });

  it("does NOT claim a clean run when zero events were scanned", () => {
    const lines = buildSummary(result({ eventsScanned: 0 })).map(stripAnsi);
    expect(lines.join("\n")).not.toContain("clean run");
    expect(lines[0]).toContain("0 tool calls across 0 sessions");
  });

  it("splits slipping-through vs already-blocked findings", () => {
    const lines = buildSummary(
      result({
        eventsScanned: 500,
        transcripts: { scanned: 9, skipped: 0, errors: 0, durationMs: 0 },
        totals: { hits: 12, projectsWithHits: 3 },
        results: [
          count({ source: "builtin", enabledInConfig: true }),
          count({ source: "builtin", enabledInConfig: true }),
          count({ source: "builtin", enabledInConfig: false }),
          count({ source: "audit-detector", enabledInConfig: false }),
          count({ source: "audit-detector", enabledInConfig: false }),
        ],
      }),
    ).map(stripAnsi);
    const joined = lines.join("\n");
    expect(joined).toContain("3 patterns slipping through");
    expect(joined).toContain("2 already blocked by your policies");
  });

  it("uses singular nouns for counts of one", () => {
    const lines = buildSummary(
      result({
        eventsScanned: 1,
        transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 0 },
        totals: { hits: 1, projectsWithHits: 1 },
        results: [count({ source: "audit-detector", enabledInConfig: false })],
      }),
    ).map(stripAnsi);
    expect(lines[0]).toContain("1 tool call across 1 session");
    expect(lines.join("\n")).toContain("1 pattern slipping through");
  });
});
