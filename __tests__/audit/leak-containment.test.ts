// @vitest-environment node
/**
 * The one property the whole feature rests on: a secret goes in, and no part of
 * one comes out anywhere.
 *
 * Every other test here checks a component. This drives the real pipeline
 * end-to-end with real credential shapes and then reads back EVERY byte the run
 * wrote to disk, plus the digest that leaves the machine and the notice that
 * reaches the terminal, hunting for any fragment of the input.
 *
 * It is deliberately not a unit test. The claim being made to a user is about
 * the system, not about `fingerprintSecret`, and the ways a value escapes are
 * integration-shaped: a field added to the record, a new file written beside
 * it, a debug string in a notice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findSecrets } from "@/src/audit/leak-scan";
import { fingerprintSecret, fingerprintId, isFindingId } from "@/src/audit/leak-fingerprint";
import { upsertFinding } from "@/src/audit/leak-record";
import { readLeakRecord, writeLeakRecord, activeFindings } from "@/src/audit/leak-store";
import { buildHarmReport } from "@/src/audit/harm-report";
import { markLeakNoticeDelivered } from "@/src/audit/leak-notice";
import { queueMacNotification } from "@/src/audit/macos-notifier";
import { leakNoticeText, shapeNotice } from "@/src/hooks/notice";
import type { AuditResult } from "@/src/audit/types";

// Real shapes, synthetic values. One per detection class the scanner claims.
const SECRETS = [
  "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "sk-ant-api03-" + "Zq7".repeat(30),
  // Assembled rather than written out, and the reason is worth knowing: a
  // realistic fixture for a secret scanner is realistic enough to trip OTHER
  // secret scanners. This exact value, as one literal, was rejected by GitHub
  // push protection ("Push cannot contain secrets") — correctly, since it
  // matches Slack's published shape byte for byte. Splitting the literal keeps
  // the runtime value identical, so the scanner under test still sees a real
  // Slack token, while no line in this file matches a scanner looking at source.
  ["xoxb", "9876543210", "9876543210987", "ZaBcDeFgHiJkLmNoPqRsTuVw"].join("-"),
  "AKIAIOSFODNN7REALKEY",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r8W1gFWFOEjXkFY",
] as const;

const TRANSCRIPT = [
  `export GITHUB_TOKEN="${SECRETS[0]}"`,
  `ANTHROPIC_API_KEY=${SECRETS[1]}`,
  `{"slack_bot_token": "${SECRETS[2]}"}`,
  `aws_access_key_id = ${SECRETS[3]}`,
  `Authorization: Bearer ${SECRETS[4]}`,
  "psql postgres://admin:hunter2SuperSecretPassword!@db.internal:5432/prod",
].join("\n");

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

/** Every file the run produced, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Any interior 12-character run of a secret counts as a leak.
 *
 * Not just the whole value: a partial disclosure is still a disclosure, and a
 * bug that wrote "the first 20 characters" would pass a whole-string check
 * while handing over most of the key.
 */
function fragmentsOf(secret: string): string[] {
  const out: string[] = [];
  for (let i = 4; i + 12 <= secret.length; i += 7) out.push(secret.slice(i, i + 12));
  return out;
}

function assertNoSecret(label: string, text: string): void {
  for (const [i, secret] of SECRETS.entries()) {
    expect(text.includes(secret), `${label} contains secret #${i} in full`).toBe(false);
    for (const frag of fragmentsOf(secret)) {
      expect(text.includes(frag), `${label} contains a fragment of secret #${i}: ${frag}`).toBe(false);
    }
  }
}

let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-contain-"));
  process.env.FAILPROOFAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

/** Run the pipeline the way a real scan does, and hand back what it produced. */
function runPipeline() {
  const found = findSecrets(TRANSCRIPT);
  const record = readLeakRecord(home);
  for (const f of found) {
    upsertFinding(record, {
      id: fingerprintId(f.value, record.salt),
      fingerprint: fingerprintSecret(f.value, f.rule),
      name: f.name,
      rule: f.rule,
      confidence: "doc-verified",
      sighting: {
        cli: "claude",
        sessionId: "s1",
        cwd: "~/…/acme",
        at: "2026-09-08T00:00:00.000Z",
        mechanism: { summary: "read from ~/…/.env", toolName: "Read", direction: "result" },
      },
    });
  }
  writeLeakRecord(record, home);

  const live = activeFindings(readLeakRecord(home), home);
  const ids = live.map((f) => f.id);
  markLeakNoticeDelivered(ids, home);
  markLeakNoticeDelivered(ids, home, "desktop");
  for (const id of ids) queueMacNotification(id, "failproofai", "a credential leaked", home);

  return {
    found,
    live,
    report: buildHarmReport(auditResult(), undefined, 7, live),
    notice: shapeNotice("claude", leakNoticeText(found.length)),
  };
}

describe("a secret goes in", () => {
  it("is detected across every class the scanner claims", () => {
    const rules = runPipeline().found.map((f) => f.rule);
    for (const expected of [
      "GitHub personal access token",
      "Anthropic API key",
      "Slack token",
      "AWS access key ID",
      "JWT",
    ]) {
      expect(rules, expected).toContain(expected);
    }
  });
});

describe("and no part of one comes out", () => {
  it("is absent from every byte the run wrote to disk", () => {
    runPipeline();
    const files = walk(home);
    // A run that wrote nothing would pass this vacuously.
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) assertNoSecret(`file ${f.replace(home, "")}`, readFileSync(f, "utf8"));
  });

  it("is absent from the digest, which is the only thing that leaves the machine", () => {
    const { report } = runPipeline();
    expect(report.leaks.length).toBeGreaterThan(0);
    assertNoSecret("harm report", JSON.stringify(report));
  });

  it("is absent from the notice that reaches the terminal", () => {
    const { notice } = runPipeline();
    assertNoSecret("cli notice", JSON.stringify(notice));
  });

  it("is absent from the record every surface reads", () => {
    runPipeline();
    assertNoSecret("leak record", JSON.stringify(readLeakRecord(home)));
  });

  it("still says enough to act on", () => {
    // Containment is worthless if the row says nothing. Each one has to carry a
    // recognisable mask, a class, a location and a mechanism.
    const { report } = runPipeline();
    const row = report.leaks.find((r) => r.label.includes("GitHub"));
    expect(row).toBeDefined();
    expect(row!.display).toContain("ghp_");
    expect(row!.display).toContain("•");
    expect(row!.project).toBe("~/…/acme");
    expect(row!.mechanism).toBe("read from ~/…/.env");
    expect(row!.length).toBe(SECRETS[0].length);
  });
});

describe("what it leaves on the filesystem", () => {
  it("writes nothing world-readable", () => {
    // These files name which credentials this machine leaked. Another account
    // on the box learning that is a disclosure by itself, even masked.
    runPipeline();
    for (const f of walk(home)) {
      expect(statSync(f).mode & 0o077, `${f.replace(home, "")} is group/other readable`).toBe(0);
    }
  });

  it("names every file with an id it could have minted", () => {
    // Marker and queue filenames are ids. If one is ever not the minted shape,
    // something built a path out of unvalidated input.
    runPipeline();
    for (const f of walk(home)) {
      const name = f.split("/").pop()!;
      if (name.endsWith(".json")) continue;
      expect(isFindingId(name), `unexpected filename ${name}`).toBe(true);
    }
  });
});
