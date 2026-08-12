import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseParkedName,
  deliveryHealth,
  deliveryHealthLine,
  describeAge,
} from "../../src/hooks/delivery-health";

let home: string;
let failed: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-delivery-health-"));
  failed = join(home, ".failproofai", "state", "failed");
  mkdirSync(failed, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Write a parked batch with the name the Rust uploader's `render()` produces. */
function park(name: string, ageMs = 0): void {
  const p = join(failed, name);
  writeFileSync(p, '{"e":1}\n');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(p, when, when);
  }
}

describe("hooks/delivery-health parseParkedName", () => {
  // These are the exact shapes `ParkedName::render()` emits in
  // crates/fpai-collect/src/uploader.rs. If that format changes, these fail —
  // which is the point: the two parsers must not drift.
  it("decomposes a definitively-refused batch", () => {
    expect(parseParkedName("claude-2026-08-11-0.a3.c401.jsonl")).toEqual({
      base: "claude-2026-08-11-0",
      attempt: 3,
      clientStatus: 401,
      poison: false,
    });
  });

  it("decomposes a batch parked without a client status", () => {
    // No `.cNNN` — server errors exhausted their retries. The retry pass picks
    // these up again, so they are NOT evidence of a bad credential.
    expect(parseParkedName("claude-2026-08-11-0.a5.jsonl")).toEqual({
      base: "claude-2026-08-11-0",
      attempt: 5,
      clientStatus: undefined,
      poison: false,
    });
  });

  it("recognises the poison suffix", () => {
    const parsed = parseParkedName("claude-0.a2.c422.jsonl.poison");
    expect(parsed.poison).toBe(true);
    expect(parsed.clientStatus).toBe(422);
    expect(parsed.base).toBe("claude-0");
  });

  it("leaves a non-numeric .c/.a in the base alone", () => {
    // Mirrors the Rust comment: parsing rather than merely matching the prefix
    // is what keeps a real spool name safe.
    const parsed = parseParkedName("claude.config-0.always.jsonl");
    expect(parsed.base).toBe("claude.config-0.always");
    expect(parsed.attempt).toBe(0);
    expect(parsed.clientStatus).toBeUndefined();
  });
});

describe("hooks/delivery-health deliveryHealth", () => {
  it("reports a machine with no failed directory as healthy", () => {
    const fresh = mkdtempSync(join(tmpdir(), "fpai-delivery-health-none-"));
    try {
      expect(deliveryHealth(fresh)).toEqual({
        total: 0,
        rejected: 0,
        credentialRejected: 0,
        byStatus: {},
      });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("counts refused batches by status and flags credential ones", () => {
    park("a-0.a1.c401.jsonl");
    park("a-1.a1.c401.jsonl");
    park("a-2.a1.c404.jsonl");
    park("a-3.a4.jsonl"); // transient: no client status

    const health = deliveryHealth(home);
    expect(health.total).toBe(4);
    expect(health.rejected).toBe(3);
    expect(health.credentialRejected).toBe(2);
    expect(health.byStatus).toEqual({ 401: 2, 404: 1 });
  });

  it("reports the age of the oldest parked batch", () => {
    park("recent.a1.c401.jsonl");
    park("old.a1.c401.jsonl", 3 * 60 * 60 * 1000);

    const health = deliveryHealth(home);
    expect(health.oldestAgeMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000 - 5_000);
  });
});

describe("hooks/delivery-health deliveryHealthLine", () => {
  it("says nothing when only transient parks exist", () => {
    // The retry pass will pick these up. Reporting them would cry wolf over a
    // blip the daemon is already handling.
    park("a-0.a5.jsonl");
    park("a-1.a5.jsonl");

    const health = deliveryHealth(home);
    expect(health.total).toBe(2);
    expect(deliveryHealthLine(health)).toBeUndefined();
  });

  it("names the credential and the fix when the key is being refused", () => {
    park("a-0.a1.c401.jsonl");
    park("a-1.a1.c401.jsonl");

    const line = deliveryHealthLine(deliveryHealth(home))!;
    expect(line).toContain("REJECTED (401)");
    expect(line).toContain("2 batches parked");
    expect(line).toContain("--connect");
  });

  it("does not blame the credential for a non-credential refusal", () => {
    park("a-0.a1.c404.jsonl");

    const line = deliveryHealthLine(deliveryHealth(home))!;
    expect(line).toContain("REJECTED (404)");
    expect(line).not.toContain("--connect");
  });

  it("uses the singular for one batch", () => {
    park("a-0.a1.c403.jsonl");
    expect(deliveryHealthLine(deliveryHealth(home))!).toContain("1 batch parked");
  });
});

describe("hooks/delivery-health describeAge", () => {
  it("formats coarsely", () => {
    expect(describeAge(30_000)).toBe("just now");
    expect(describeAge(5 * 60_000)).toBe("5m");
    expect(describeAge(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(describeAge(50 * 3_600_000)).toBe("2d 2h");
  });
});
