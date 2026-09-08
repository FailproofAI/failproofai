// @vitest-environment node
/**
 * What the emailed digest is allowed to say about a leaked credential.
 *
 * The whole point of the leak record is that it never stores a secret, only a
 * fingerprint of one. This file is where that claim is checked against the ONE
 * path that leaves the machine.
 */
import { describe, it, expect } from "vitest";

import { buildHarmReport, selectLeaks } from "@/src/audit/harm-report";
import type { LeakFinding } from "@/src/audit/leak-record";
import { fingerprintSecret } from "@/src/audit/leak-fingerprint";
import type { AuditResult } from "@/src/audit/types";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function finding(over: Partial<LeakFinding> = {}): LeakFinding {
  return {
    id: "id-1",
    fingerprint: fingerprintSecret(SECRET),
    name: "GITHUB_TOKEN",
    rule: "sanitize-api-keys",
    confidence: "doc-verified",
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-09-05T00:00:00.000Z",
    occurrences: 3,
    sightings: [
      {
        cli: "claude", sessionId: "s0", cwd: "~/…/old", at: "2026-09-01T00:00:00.000Z",
        mechanism: { summary: "written to ~/…/.env", toolName: "Write", direction: "input" },
      },
      {
        cli: "codex", sessionId: "s1", cwd: "~/…/acme", at: "2026-09-05T00:00:00.000Z",
        mechanism: { summary: "read from ~/…/.env", toolName: "Read", direction: "result" },
      },
    ],
    ...over,
  };
}

const WINDOW = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-08T00:00:00Z") };

function auditResult(): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-09-08T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 0 },
    results: [],
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 1,
    enabledBuiltinNames: [],
  };
}

// The property that makes this feature shippable at all. Not "the code is
// careful" — the record has no field that could hold a secret, so there is
// nothing here for a bug to send.
describe("what cannot leave the machine", () => {
  it("carries no part of the secret, at any window or shape", () => {
    const rows = selectLeaks([finding()], WINDOW.from, WINDOW.to);
    const wire = JSON.stringify(rows);
    expect(wire).not.toContain(SECRET);
    // Nor a long enough run of it to be worth anything: the tail is the last 4
    // characters, and the prefix is the vendor's own public marker.
    expect(wire).not.toContain(SECRET.slice(4, 24));
    expect(rows[0].display).toContain("•");
    expect(rows[0].display).toContain("ghp_");
  });

  it("says what class it is and how long, which is what a person acts on", () => {
    const [row] = selectLeaks([finding()], WINDOW.from, WINDOW.to);
    expect(row.label).toContain("GitHub");
    expect(row.length).toBe(SECRET.length);
    expect(row.attributed).toBe(true);
    // The identifier name is not a secret, and for a first-party key it is the
    // ONLY actionable field — no vendor console exists to revoke it at.
    expect(row.name).toBe("GITHUB_TOKEN");
  });
});

describe("the 5W1H a row has to answer", () => {
  it("describes the most recent exposure, not the first", () => {
    // Where the key is NOW is what matters; where it debuted is history.
    const [row] = selectLeaks([finding()], WINDOW.from, WINDOW.to);
    expect(row.cli).toBe("codex");
    expect(row.project).toBe("~/…/acme");
    expect(row.mechanism).toBe("read from ~/…/.env");
    expect(row.direction).toBe("result");
    expect(row.first_seen).toBe("2026-09-01T00:00:00.000Z");
    expect(row.last_seen).toBe("2026-09-05T00:00:00.000Z");
    expect(row.occurrences).toBe(3);
  });

  it("survives a finding with no sightings left rather than dropping it", () => {
    // Sightings are capped and pruned; the credential is not. A row with a
    // vague "how" still tells the user to rotate something.
    const [row] = selectLeaks([finding({ sightings: [] })], WINDOW.from, WINDOW.to);
    expect(row.display).toContain("ghp_");
    expect(row.mechanism).toBe("seen in a transcript");
  });
});

describe("which findings a window includes", () => {
  it("windows on last-seen, so a key still in use keeps being reported", () => {
    // Windowing on firstSeen would go quiet on exactly the credentials that are
    // still circulating — reporting them once, in the window they debuted.
    const old = finding({ id: "old", firstSeen: "2026-01-01T00:00:00.000Z" });
    expect(selectLeaks([old], WINDOW.from, WINDOW.to)).toHaveLength(1);
  });

  it("drops one whose last sighting predates the window", () => {
    const stale = finding({ id: "stale", lastSeen: "2026-06-01T00:00:00.000Z" });
    expect(selectLeaks([stale], WINDOW.from, WINDOW.to)).toHaveLength(0);
  });

  it("keeps one with no usable timestamp rather than losing it silently", () => {
    const undated = finding({ id: "undated", lastSeen: "not a date" });
    expect(selectLeaks([undated], WINDOW.from, WINDOW.to)).toHaveLength(1);
  });

  it("never mails a finding the user already dismissed", () => {
    // They looked at it and said it is not a secret. Mailing it weekly after
    // that is how a tool teaches people to filter it out of their inbox.
    const dismissed = finding({ id: "d", dismissedAt: "2026-09-06T00:00:00.000Z" });
    expect(selectLeaks([dismissed], WINDOW.from, WINDOW.to)).toHaveLength(0);
  });

  it("puts the most recently seen first", () => {
    const a = finding({ id: "a", lastSeen: "2026-09-02T00:00:00.000Z" });
    const b = finding({ id: "b", lastSeen: "2026-09-07T00:00:00.000Z" });
    expect(selectLeaks([a, b], WINDOW.from, WINDOW.to).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("the report as a whole", () => {
  it("carries leaks alongside the harmful counts, not instead of them", () => {
    // Two different claims: `harmful` counts policy activity, `leaks` names a
    // specific object to rotate. A digest that replaced one with the other
    // would silently stop reporting the half that already worked.
    const report = buildHarmReport(auditResult(), undefined, 7, [finding()]);
    expect(report.harmful).toEqual([]);
    expect(report.leaks).toHaveLength(1);
    expect(report.window_to).toBe("2026-09-08T00:00:00.000Z");
  });

  it("defaults to no leaks when the caller passes none", () => {
    // Every existing caller predates this argument, and must keep producing a
    // valid report rather than throwing on an undefined list.
    expect(buildHarmReport(auditResult(), undefined, 7).leaks).toEqual([]);
  });
});
