// @vitest-environment node
/**
 * Every audit renderer that emits an example must redact it first.
 *
 * `redact-example.ts` was written carefully and then wired to exactly ONE of the
 * places an example can leave the machine: the emailed digest. The markdown file
 * the CLI prints as "Shareable report" wrote raw commands and raw cwd into the
 * user's working tree, and `formatJson` was a bare stringify of the whole
 * result. Both are artifacts whose entire purpose is to be sent somewhere.
 *
 * These tests pin the wiring rather than the redactor — `redact-example.test.ts`
 * covers what a secret looks like once masked. What is asserted here is that
 * each renderer is CONNECTED, because the defect was never a bad mask; it was a
 * mask nobody called.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatText, formatMarkdown, formatJson } from "@/src/audit/report";
import { redactAuditResult } from "@/src/audit/redact-example";
import type { AuditCount, AuditResult } from "@/src/audit/types";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HOME_PATH = "/home/testuser/clients/acme-bank/src/db.ts";

function count(overrides: Partial<AuditCount> = {}): AuditCount {
  return {
    name: "failproofai/block-secrets-write",
    source: "builtin",
    category: "Security",
    severity: "deny",
    hits: 3,
    projects: 1,
    firstSeen: "2026-09-01T10:00:00.000Z",
    lastSeen: "2026-09-04T10:00:00.000Z",
    examples: [
      {
        sessionId: "s1",
        cwd: "/home/testuser/clients/acme-bank",
        timestamp: "2026-09-04T10:00:00.000Z",
        example: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`,
      },
    ],
    displayTitle: "Wrote a secret to a file",
    impact: "The credential outlives the session.",
    enabledInConfig: true,
    installHint: "",
    ...overrides,
  };
}

function result(results: AuditCount[] = [count()]): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-09-07T10:00:00.000Z",
    scope: { cli: ["claude"], projects: [HOME_PATH], since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 1 },
    results,
    totals: { hits: 3, projectsWithHits: 1 },
    projectsScanned: ["/home/testuser/clients/acme-bank"],
    eventsScanned: 10,
    enabledBuiltinNames: ["block-secrets-write"],
    // OPTIONAL fields must be present here or the reflection guard below has
    // no teeth: it walks a real object, and TypeScript will not complain about
    // an optional field the redactor forgot. This fixture is the only thing
    // standing between a new field and a silent passthrough.
    leakIds: ["abc123"],
    newLeakIds: ["abc123"],
  };
}

describe("redactAuditResult — a whitelist, not a spread", () => {
  // It used to be `{...result}` plus three named rewrites, so every field it
  // did not name passed through byte-identical — including fields added later,
  // with absolute home paths intact. The compiler catches a new REQUIRED field;
  // it stays quiet about an optional one, and the leak record arrives as
  // optional fields. So this reflects over a real result instead.
  it("has consciously handled every key on the real object", async () => {
    const { REDACTED_AUDIT_RESULT_KEYS } = await import("@/src/audit/redact-example");
    const actual = Object.keys(result()).sort();
    const handled = [...REDACTED_AUDIT_RESULT_KEYS].sort();
    const unhandled = actual.filter((k) => !handled.includes(k as never));
    expect(
      unhandled,
      `AuditResult grew ${unhandled.join(", ")} — decide in redactAuditResult whether it needs ` +
        `redacting, then add it to REDACTED_AUDIT_RESULT_KEYS`,
    ).toEqual([]);
  });

  it("leaves no absolute home path anywhere in the redacted object", () => {
    const out = redactAuditResult(result(), "/home/testuser");
    expect(JSON.stringify(out)).not.toContain("/home/testuser");
  });
});

describe("formatMarkdown — the file the CLI calls a Shareable report", () => {
  it("never writes a credential into the report body", () => {
    const md = formatMarkdown(result());
    expect(md).toContain("Examples");
    expect(md).not.toContain(SECRET);
    expect(md).toContain("[REDACTED");
  });

  it("shortens the cwd so the report does not carry a map of someone's disk", () => {
    const md = formatMarkdown(result());
    expect(md).not.toContain("/home/testuser/clients/acme-bank");
  });
});

describe("formatJson — piped wherever the caller wants", () => {
  it("redacts examples inside the serialized result", () => {
    const json = formatJson(result());
    expect(json).not.toContain(SECRET);
  });

  it("redacts the project paths carried alongside the findings", () => {
    const json = formatJson(result());
    expect(json).not.toContain("/home/testuser/clients/acme-bank");
  });

  it("leaves the caller's own object untouched", () => {
    const r = result();
    formatJson(r);
    expect(r.results[0].examples[0].example).toContain(SECRET);
  });
});

describe("formatText — the local terminal", () => {
  it("masks the credential", () => {
    const text = formatText(result(), { showExamples: true });
    expect(text).not.toContain(SECRET);
  });

  it("keeps the real path, because shortening it protects nobody on their own machine", () => {
    const withPath = count({
      examples: [
        {
          sessionId: "s1",
          cwd: "/home/testuser/clients/acme-bank",
          timestamp: "2026-09-04T10:00:00.000Z",
          example: `cat ${HOME_PATH}`,
        },
      ],
    });
    const text = formatText(result([withPath]), { showExamples: true });
    expect(text).toContain(HOME_PATH);
  });
});

describe("wiring tripwire", () => {
  it("keeps report.ts importing the redactor", () => {
    // The defect was structural: redactExample had exactly two non-definition
    // references and both were in harm-report.ts. If this import is ever
    // dropped, every renderer above silently starts emitting raw examples
    // again — and the tests above only catch it for the shapes they model.
    const src = readFileSync(join(process.cwd(), "src/audit/report.ts"), "utf-8");
    expect(src).toMatch(/from "\.\/redact-example"/);
  });

  it("keeps more than one module depending on the redactor", () => {
    const files = ["src/audit/report.ts", "src/audit/harm-report.ts"];
    const importers = files.filter((f) =>
      readFileSync(join(process.cwd(), f), "utf-8").includes('from "./redact-example"'),
    );
    expect(importers).toEqual(files);
  });
});
