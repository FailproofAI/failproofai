// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  readLeakIdentity,
  readLeakRecord,
  writeLeakRecord,
  dismissFinding,
  activeFindings,
} from "@/src/audit/leak-store";
import { upsertFinding, type LeakSighting } from "@/src/audit/leak-record";
import { auditLeaksFile, auditLeakIdentityFile } from "@/src/hooks/fp-home";
import { HOME_CLASSES } from "@/src/hooks/fp-home";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fp-leak-store-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const FP = { display: "ghp_••••••••4f2a", label: "GitHub token", length: 40, attributed: true };
const sighting = (at: string): LeakSighting => ({
  cli: "claude", sessionId: "s1", cwd: "~/…/acme", at,
  mechanism: { summary: "read from ~/…/.env", toolName: "Read", direction: "input" },
});
// Ids are what `fingerprintId` mints — 16 lowercase hex — and `readLeakRecord`
// now drops anything else, because an id becomes a FILENAME. The short labels
// below stay readable at the call sites and are padded into real ids here.
const idFor = (label: string) => label.padEnd(16, "0");
const finding = (label: string) => ({
  id: idFor(label), fingerprint: FP, name: "GITHUB_TOKEN", rule: "sanitize-api-keys",
  confidence: "doc-verified" as const, sighting: sighting("2026-09-08T00:00:00Z"),
});

describe("the salt", () => {
  it("is minted once and reused, so ids stay stable across scans", () => {
    const a = readLeakIdentity(home);
    const b = readLeakIdentity(home);
    expect(a.salt).toBe(b.salt);
    expect(a.salt.length).toBeGreaterThanOrEqual(64);
  });

  it("is random per machine, not derived from anything guessable", () => {
    const other = mkdtempSync(join(tmpdir(), "fp-leak-store-b-"));
    try {
      expect(readLeakIdentity(home).salt).not.toBe(readLeakIdentity(other).salt);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("is written 0600 — it is a machine secret", () => {
    readLeakIdentity(home);
    expect(statSync(auditLeakIdentityFile(home)).mode & 0o777).toBe(0o600);
  });
});

describe("round-trip", () => {
  it("persists and reloads findings", () => {
    const r = readLeakRecord(home);
    upsertFinding(r, finding("a"));
    expect(writeLeakRecord(r, home)).toBe(true);
    const back = readLeakRecord(home);
    expect(back.findings).toHaveLength(1);
    expect(back.findings[0].fingerprint.display).toBe(FP.display);
  });

  it("writes the record 0600 too — it maps which project leaked what", () => {
    const r = readLeakRecord(home);
    upsertFinding(r, finding("a"));
    writeLeakRecord(r, home);
    expect(statSync(auditLeaksFile(home)).mode & 0o777).toBe(0o600);
  });

  it("never stores a raw credential", () => {
    const r = readLeakRecord(home);
    upsertFinding(r, finding("a"));
    writeLeakRecord(r, home);
    const raw = readFileSync(auditLeaksFile(home), "utf8");
    expect(raw).toContain("•");
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});

// A scan must not fail because its own bookkeeping is damaged. The failure mode
// that matters least must never cause the one that matters most.
describe("never throws", () => {
  it("treats a corrupt record as absent", () => {
    mkdirSync(dirname(auditLeaksFile(home)), { recursive: true });
    writeFileSync(auditLeaksFile(home), "{ not json at all");
    expect(() => readLeakRecord(home)).not.toThrow();
    expect(readLeakRecord(home).findings).toEqual([]);
  });

  it("discards a record from a newer schema rather than guessing at it", () => {
    mkdirSync(dirname(auditLeaksFile(home)), { recursive: true });
    writeFileSync(
      auditLeaksFile(home),
      JSON.stringify({ schemaVersion: 999, salt: "x", updatedAt: "", findings: [finding("a")] }),
    );
    expect(readLeakRecord(home).findings).toEqual([]);
  });

  it("treats a corrupt identity file as absent and mints a new salt", () => {
    mkdirSync(dirname(auditLeakIdentityFile(home)), { recursive: true });
    writeFileSync(auditLeakIdentityFile(home), "garbage");
    expect(() => readLeakIdentity(home)).not.toThrow();
    expect(readLeakIdentity(home).salt.length).toBeGreaterThanOrEqual(64);
  });
});

describe("dismissal", () => {
  it("hides a finding without destroying the evidence", () => {
    const r = readLeakRecord(home);
    upsertFinding(r, finding("a"));
    upsertFinding(r, finding("b"));
    writeLeakRecord(r, home);
    dismissFinding(idFor("a"), home);

    const back = readLeakRecord(home);
    // Still on disk — a mis-click costs a row in a list, not the fact of a leak.
    expect(back.findings).toHaveLength(2);
    expect(activeFindings(back, home).map((f) => f.id)).toEqual([idFor("b")]);
  });

  it("is idempotent", () => {
    dismissFinding(idFor("a"), home);
    dismissFinding(idFor("a"), home);
    expect(readLeakIdentity(home).dismissed).toEqual([idFor("a")]);
  });
});

// This is the claim that justifies two files instead of one. If either half
// were classified `derived`, a reset would silently re-alert every credential
// the machine has ever seen.
describe("reset semantics — why the split exists", () => {
  it("classifies the findings as derived and the identity as identity", () => {
    const cls = (fn: (h?: string) => string) =>
      HOME_CLASSES.find((e) => e.path(home) === fn(home))?.class;
    expect(cls(auditLeaksFile)).toBe("derived");
    expect(cls(auditLeakIdentityFile)).toBe("identity");
  });
});

// `leaks.json` is a file on disk: a full disk can truncate it mid-write, a hand
// can edit it, and a newer build can write a shape this one does not expect.
// Before this gate existed, one malformed entry threw out of `buildHarmReport`
// — which sits outside `reportHarm`'s try — so a scan that succeeded and cached
// correctly still exited 1, and kept doing so every run.
describe("a corrupt record", () => {
  const write = (findings: unknown[]) =>
    writeFileSync(
      auditLeaksFile(home),
      JSON.stringify({ schemaVersion: 1, salt: "x", updatedAt: "", findings }),
    );

  beforeEach(() => {
    // Create the directory before writing the file by hand.
    mkdirSync(dirname(auditLeaksFile(home)), { recursive: true });
  });

  it("drops entries it cannot render, and keeps the ones it can", () => {
    write([
      null,
      "a string",
      { id: "0123456789abcdef" },                       // no fingerprint
      { id: "not-an-id", fingerprint: FP },              // id could not be minted
      { id: "abc0000000000000", fingerprint: FP, sightings: [], firstSeen: "", lastSeen: "", occurrences: 1 },
    ]);
    const kept = readLeakRecord(home).findings;
    expect(kept.map((f) => f.id)).toEqual(["abc0000000000000"]);
  });

  it("keeps a finding whose sightings are unusable, and drops just those", () => {
    // The credential is the thing that needs rotating. "seen in a transcript"
    // with no detail beats silence about a leaked key.
    write([
      {
        id: "abc0000000000000", fingerprint: FP, name: null, rule: "r",
        confidence: "doc-verified", firstSeen: "", lastSeen: "", occurrences: 3,
        sightings: [null, { mechanism: null }, { nope: true }],
      },
    ]);
    const [kept] = readLeakRecord(home).findings;
    expect(kept.id).toBe("abc0000000000000");
    expect(kept.sightings).toEqual([]);
    expect(kept.occurrences).toBe(3);
  });

  it("never throws, whatever the file holds", () => {
    for (const findings of [[{}], [[]], [{ id: 1 }], [{ id: "abc0000000000000", fingerprint: 7 }]]) {
      write(findings);
      expect(() => readLeakRecord(home)).not.toThrow();
    }
  });
});
