// @vitest-environment node
/**
 * The privacy envelope around a scheduled scan.
 *
 * The audit reads the CONTENTS of every session transcript on the machine.
 * These tests exist to make it structurally hard for any of that to leave, and
 * the load-bearing one is `the emitted key set is frozen` — a projection built
 * by construction rather than by filtering is only worth anything if something
 * fails the moment a field joins it.
 */
import { describe, it, expect } from "vitest";
import {
  buildMachineScanPayload,
  slugifyCategory,
  isValidMachineId,
  isValidOsUser,
  KNOWN_RULE_IDS,
  MACHINE_SCAN_FINDING_KEYS,
  MACHINE_SCAN_PAYLOAD_KEYS,
  MACHINE_SCAN_SCHEMA_VERSION,
  MAX_SCAN_FINDINGS,
} from "../../src/audit/machine-scan-payload";
import { HARMFUL_WIRE_SEVERITIES } from "../../src/audit/harmful";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import type { AuditCount, AuditResult } from "../../src/audit/types";

/** A row shaped exactly like the orchestrator builds them — INCLUDING the two
 *  fields that are known to carry user content. */
function row(over: Partial<AuditCount> = {}): AuditCount {
  return {
    name: "failproofai/block-sudo",
    source: "builtin",
    category: "Dangerous Commands",
    severity: "deny",
    hits: 12,
    projects: 4,
    firstSeen: "2026-06-01T10:00:00.000Z",
    lastSeen: "2026-08-01T10:00:00.000Z",
    examples: [
      {
        sessionId: "sess-1",
        cwd: "/home/chetan/clients/acme-bank/core",
        timestamp: "2026-08-01T10:00:00.000Z",
        example: 'psql "postgres://admin:hunter2@db.acme-bank.internal/prod"',
      },
    ],
    displayTitle: "Ran a command as root",
    impact: "Anything it touched is outside your user's blast radius.",
    enabledInConfig: false,
    installHint: "Enable in one command:  failproofai policies --install block-sudo",
    ...over,
  };
}

function result(over: Partial<AuditResult> = {}): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-08-05T00:00:00.000Z",
    scope: { cli: ["claude"], projects: ["/home/chetan/clients/acme-bank"], since: null },
    transcripts: { scanned: 3277, skipped: 2, errors: 1, durationMs: 104_000 },
    results: [row()],
    totals: { hits: 12, projectsWithHits: 4 },
    projectsScanned: ["/home/chetan/clients/acme-bank/core", "/home/chetan/personal/taxes"],
    eventsScanned: 91_204,
    enabledBuiltinNames: ["block-force-push"],
    ...over,
  };
}

const NOW = Date.parse("2026-08-05T00:01:00.000Z");

function build(over: Partial<AuditResult> = {}) {
  return buildMachineScanPayload({
    result: result(over),
    machineId: "3f0c1a2e-9f4b-4a11-8c31-0a2b3c4d5e6f",
    osUser: "chetan",
    now: NOW,
  });
}

describe("the frozen allowlist", () => {
  it("emits exactly the keys on the list and no others", () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Sorted comparison, so reordering the constant is not a failure but
    // ADDING to either side is.
    expect(Object.keys(built.payload).sort()).toEqual([...MACHINE_SCAN_PAYLOAD_KEYS].sort());
    for (const finding of built.payload.findings) {
      expect(Object.keys(finding).sort()).toEqual([...MACHINE_SCAN_FINDING_KEYS].sort());
    }
  });

  it("survives an AuditResult that grows a new field, without forwarding it", () => {
    // The exact regression the additive design exists to prevent: someone adds
    // a field upstream, a subtractive filter forwards it, and nobody notices.
    const grown = {
      ...result(),
      // A plausible future addition, and a hostile one.
      hostnamesSeen: ["db.acme-bank.internal"],
      results: [{ ...row(), rawTranscriptExcerpt: "AWS_SECRET_ACCESS_KEY=wJalr..." }],
    } as unknown as AuditResult;

    const built = buildMachineScanPayload({
      result: grown,
      machineId: "machine-1",
      osUser: "chetan",
      now: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.payload).sort()).toEqual([...MACHINE_SCAN_PAYLOAD_KEYS].sort());
    expect(Object.keys(built.payload.findings[0]).sort()).toEqual(
      [...MACHINE_SCAN_FINDING_KEYS].sort(),
    );
  });

  it("carries no example, no cwd, no project path and no prose anywhere in the JSON", () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const wire = JSON.stringify(built.payload);

    // The two verified hazards, plus everything else the row carries.
    for (const forbidden of [
      "postgres://",
      "hunter2",
      "acme-bank",
      "/home/chetan",
      "taxes",
      "sess-1",
      "Ran a command as root",
      "blast radius",
      "policies --install",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("sends a COUNT of projects, never their names", () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.findings[0].projects).toBe(4);
    expect(JSON.stringify(built.payload)).not.toContain("projectsScanned");
  });
});

describe("risks mode", () => {
  it("sends nothing at all when nothing is harmful", () => {
    const wasteful = row({
      name: "redundant-cd-cwd",
      source: "audit-detector",
      category: "Wasteful",
      severity: "warn",
    });
    expect(build({ results: [wasteful] })).toEqual({
      ok: false,
      reason: "no-harmful-findings",
    });
  });

  it("sends nothing when the only harmful rule is already enforcing", () => {
    // `enabledInConfig` means the machine already closed this. Mailing about it
    // would be the proof-of-life digest section 6 ruled out.
    expect(build({ results: [row({ enabledInConfig: true })] })).toEqual({
      ok: false,
      reason: "no-harmful-findings",
    });
  });

  it("drops the benign rows and keeps the harmful ones in one scan", () => {
    const built = build({
      results: [
        row(),
        row({ name: "failproofai/sanitize-jwt", category: "Sanitize", severity: "sanitize" }),
        row({ name: "failproofai/warn-git-amend", category: "Git", severity: "warn" }),
        row({
          name: "git-commit-no-verify",
          source: "audit-detector",
          category: "Risky",
          severity: "warn",
        }),
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.findings.map((f) => f.ruleId)).toEqual([
      "failproofai/block-sudo",
      "failproofai/git-commit-no-verify",
    ]);
  });

  it("labels every finding with a severity the server treats as harmful", () => {
    // The disagreement this pins: a Risky detector's OWN severity is "warn",
    // which the server would read as benign — stored, never mailed.
    const built = build({
      results: [
        row(),
        row({
          name: "find-from-root",
          source: "audit-detector",
          category: "Risky",
          severity: "warn",
        }),
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const finding of built.payload.findings) {
      expect(HARMFUL_WIRE_SEVERITIES).toContain(finding.severity);
    }
  });
});

describe("identifiers the server will accept", () => {
  it("refuses to send under an identity the server would reject", () => {
    // A mangled identity would MERGE or SPLIT a reporting identity, which is
    // worse than not reporting.
    expect(
      buildMachineScanPayload({ result: result(), machineId: "machine 1", osUser: "chetan" }),
    ).toEqual({ ok: false, reason: "invalid-identity" });
    expect(
      buildMachineScanPayload({ result: result(), machineId: "..", osUser: "chetan" }),
    ).toEqual({ ok: false, reason: "invalid-identity" });
    expect(
      buildMachineScanPayload({ result: result(), machineId: "machine-1", osUser: "" }),
    ).toEqual({ ok: false, reason: "invalid-identity" });
  });

  it("accepts the OS user shapes real machines have", () => {
    expect(isValidOsUser("chetan")).toBe(true);
    expect(isValidOsUser("ACME\\alice")).toBe(true); // Windows domain account
    expect(isValidOsUser("svc_deploy$")).toBe(true); // machine account
    expect(isValidOsUser("a b")).toBe(false);
    expect(isValidOsUser("x".repeat(65))).toBe(false);
  });

  it("accepts a minted machine id and rejects the reserved path names", () => {
    expect(isValidMachineId("3f0c1a2e-9f4b-4a11-8c31-0a2b3c4d5e6f")).toBe(true);
    expect(isValidMachineId(".")).toBe(false);
    expect(isValidMachineId("..")).toBe(false);
    expect(isValidMachineId("")).toBe(false);
  });

  it("slugifies every category in the live catalog into the server's charset", () => {
    // "Packages & System" would 422 the whole scan verbatim.
    const categories = new Set(BUILTIN_POLICIES.map((p) => p.category));
    for (const category of categories) {
      const slug = slugifyCategory(category);
      expect(slug, `category ${category}`).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
    expect(slugifyCategory("Packages & System")).toBe("packages-system");
    expect(slugifyCategory("Dangerous Commands")).toBe("dangerous-commands");
    expect(slugifyCategory("&&&")).toBeNull();
  });

  it("drops a rule id that is not in our own catalog", () => {
    // A future change that replays a customer's policies must not ship their
    // policy NAMES — those describe the customer's business, not ours.
    const built = build({
      results: [row({ name: "acme/block-prod-deploy-friday", category: "Custom" })],
    });
    expect(built).toEqual({ ok: false, reason: "no-harmful-findings" });
    expect(KNOWN_RULE_IDS.has("acme/block-prod-deploy-friday")).toBe(false);
    expect(KNOWN_RULE_IDS.has("failproofai/block-sudo")).toBe(true);
  });
});

describe("bounds the server enforces", () => {
  it("truncates rather than losing the whole scan to the 200-finding cap", () => {
    const blocks = BUILTIN_POLICIES.filter((p) => p.name.startsWith("block-"));
    // Repeat the catalog's block-* policies until well past the cap; duplicate
    // ids are collapsed, so pad with detectors too.
    const many = [
      ...blocks.map((p) => row({ name: p.name, category: p.category })),
      ...Array.from({ length: MAX_SCAN_FINDINGS + 50 }, (_, i) =>
        row({ name: `failproofai/block-generated-${i}` }),
      ),
    ];
    const built = build({ results: many });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.findings.length).toBeLessThanOrEqual(MAX_SCAN_FINDINGS);
    // The generated ids are not in the catalog, so only the real ones survive.
    expect(built.payload.findings.length).toBe(blocks.length);
  });

  it("never emits a duplicate rule id", () => {
    const built = build({
      results: [row({ name: "block-sudo" }), row({ name: "failproofai/block-sudo" })],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.findings.map((f) => f.ruleId)).toEqual(["failproofai/block-sudo"]);
  });

  it("falls back to now when the machine's own scannedAt is outside the window", () => {
    const built = build({ scannedAt: "1999-01-01T00:00:00.000Z" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.scannedAt).toBe(new Date(NOW).toISOString());
  });

  it("clamps counts and drops unparseable timestamps instead of failing", () => {
    const built = build({
      eventsScanned: -5 as unknown as number,
      transcripts: { scanned: 3, skipped: 0, errors: 0, durationMs: 99 * 24 * 3600 * 1000 },
      results: [row({ firstSeen: "not a date", lastSeen: undefined })],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.eventsScanned).toBe(0);
    expect(built.payload.durationMs).toBe(7 * 24 * 3600 * 1000);
    expect(built.payload.findings[0].firstSeen).toBeNull();
    expect(built.payload.findings[0].lastSeen).toBeNull();
  });

  it("stamps the schema version the server pins", () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.schemaVersion).toBe(MACHINE_SCAN_SCHEMA_VERSION);
    expect(MACHINE_SCAN_SCHEMA_VERSION).toBe(1);
  });
});
