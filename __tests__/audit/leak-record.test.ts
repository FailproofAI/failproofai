// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  upsertFinding,
  pruneRecord,
  emptyRecord,
  describeMechanism,
  MAX_SIGHTINGS,
  MAX_FINDINGS,
  FINDING_TTL_DAYS,
  type LeakSighting,
} from "@/src/audit/leak-record";

const FP = { display: "ghp_••••••••4f2a", label: "GitHub personal access token", length: 40, attributed: true };

function sighting(at: string, sessionId = "s1"): LeakSighting {
  return {
    cli: "claude",
    sessionId,
    cwd: "~/…/acme",
    at,
    mechanism: describeMechanism("Read", "input", "~/…/.env"),
  };
}

function base(id: string) {
  return { id, fingerprint: FP, name: "GITHUB_TOKEN", rule: "sanitize-api-keys", confidence: "doc-verified" as const };
}

describe("upsertFinding — the unit is the distinct VALUE", () => {
  it("reports a first sighting as new, which is what the notice keys on", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    const { isNew } = upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-01T00:00:00Z") });
    expect(isNew).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].occurrences).toBe(1);
  });

  // The same key seen again must NOT re-alert. One pasted credential fanned out
  // to 11 files and 22 occurrences on the measured corpus, largely because the
  // agent's own checkpoint records replay the prompt that carried it.
  it("does not report a repeat sighting as new, however many times it recurs", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-01T00:00:00Z") });
    for (let i = 0; i < 20; i++) {
      const { isNew } = upsertFinding(r, {
        ...base("a"),
        sighting: sighting(`2026-09-02T00:00:${String(i).padStart(2, "0")}Z`, `s${i}`),
      });
      expect(isNew).toBe(false);
    }
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].occurrences).toBe(21);
  });

  it("counts every occurrence but stores only a bounded slice of evidence", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    for (let i = 0; i < 50; i++) {
      upsertFinding(r, {
        ...base("a"),
        sighting: sighting(`2026-09-0${(i % 9) + 1}T00:00:00Z`, `s${i}`),
      });
    }
    expect(r.findings[0].occurrences).toBe(50);
    expect(r.findings[0].sightings.length).toBeLessThanOrEqual(MAX_SIGHTINGS);
  });

  it("keeps the newest sighting after the evidence cap is reached", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    for (let i = 1; i <= MAX_SIGHTINGS + 2; i++) {
      upsertFinding(r, {
        ...base("a"),
        sighting: sighting(`2026-09-${String(i).padStart(2, "0")}T00:00:00Z`, `s${i}`),
      });
    }
    expect(r.findings[0].sightings).toHaveLength(MAX_SIGHTINGS);
    expect(r.findings[0].sightings[0].at).toBe("2026-09-01T00:00:00Z");
    expect(r.findings[0].sightings.at(-1)?.at).toBe("2026-09-07T00:00:00Z");
  });

  it("tracks first and last seen across out-of-order sightings", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-05T00:00:00Z") });
    upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-01T00:00:00Z", "s2") });
    upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-09T00:00:00Z", "s3") });
    expect(r.findings[0].firstSeen).toBe("2026-09-01T00:00:00Z");
    expect(r.findings[0].lastSeen).toBe("2026-09-09T00:00:00Z");
  });

  it("keeps distinct credentials apart", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    expect(upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-01T00:00:00Z") }).isNew).toBe(true);
    expect(upsertFinding(r, { ...base("b"), sighting: sighting("2026-09-01T00:00:00Z") }).isNew).toBe(true);
    expect(r.findings).toHaveLength(2);
  });

  it("never stores the credential itself", () => {
    const r = emptyRecord("salt", "2026-09-01T00:00:00Z");
    upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-01T00:00:00Z") });
    expect(JSON.stringify(r)).not.toContain("4f2a" + "SECRET");
    // The only rendering of the value is the mask, which carries no middle.
    expect(r.findings[0].fingerprint.display).toContain("•");
  });
});

describe("pruneRecord — the file cannot grow without bound", () => {
  it("drops findings older than the TTL", () => {
    const now = Date.parse("2026-09-08T00:00:00Z");
    const old = new Date(now - (FINDING_TTL_DAYS + 5) * 86_400_000).toISOString();
    const r = emptyRecord("salt", "2026-09-08T00:00:00Z");
    upsertFinding(r, { ...base("old"), sighting: sighting(old) });
    upsertFinding(r, { ...base("new"), sighting: sighting("2026-09-08T00:00:00Z") });
    pruneRecord(r, now);
    expect(r.findings.map((f) => f.id)).toEqual(["new"]);
  });

  // Age out BEFORE capping: capping first would let a burst of stale findings
  // evict fresh ones, which is the opposite of what either limit is for.
  it("caps the count, keeping the most recent", () => {
    const now = Date.parse("2026-09-08T00:00:00Z");
    const r = emptyRecord("salt", "2026-09-08T00:00:00Z");
    for (let i = 0; i < MAX_FINDINGS + 50; i++) {
      const at = new Date(now - i * 60_000).toISOString();
      upsertFinding(r, { ...base(`id-${i}`), sighting: sighting(at) });
    }
    pruneRecord(r, now);
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.findings[0].id).toBe("id-0");
  });

  it("stays small: a thousand sightings of one key cost the same as one", () => {
    const now = Date.parse("2026-09-08T00:00:00Z");
    const r = emptyRecord("salt", "2026-09-08T00:00:00Z");
    for (let i = 0; i < 1000; i++) {
      upsertFinding(r, { ...base("a"), sighting: sighting("2026-09-08T00:00:00Z", `s${i}`) });
    }
    pruneRecord(r, now);
    expect(JSON.stringify(r).length).toBeLessThan(2_000);
    expect(r.findings[0].occurrences).toBe(1000);
  });
});

describe("describeMechanism — the `how` of 5W1H, specific by construction", () => {
  it("names the file and the direction", () => {
    expect(describeMechanism("Read", "input", "~/…/.env").summary).toBe("read from ~/…/.env");
    expect(describeMechanism("Write", "input", "~/…/deploy.sh").summary).toBe("written to ~/…/deploy.sh");
    expect(describeMechanism("Edit", "input", "~/…/config.ts").summary).toBe("edited into ~/…/config.ts");
    expect(describeMechanism("Bash", "input", null).summary).toBe("passed in a shell command");
  });

  // Input vs result is not cosmetic: an input is deniable at PreToolUse on all
  // 12 CLIs, a result is not. They are different exposures with different fixes.
  it("distinguishes what the agent SENT from what it RECEIVED", () => {
    expect(describeMechanism("Read", "input", "~/…/.env").direction).toBe("input");
    const out = describeMechanism("Read", "result", "~/…/.env");
    expect(out.direction).toBe("result");
    expect(out.summary).toContain("output");
  });

  it("degrades to something still specific for an unknown tool", () => {
    expect(describeMechanism("WebFetch", "input", null).summary).toBe("sent to the WebFetch tool");
  });
});
