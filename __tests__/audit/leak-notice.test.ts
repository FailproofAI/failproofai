// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pendingLeakNotice,
  markLeakNoticeDelivered,
  releaseLeakNoticeClaims,
  pruneNoticeMarkers,
  sessionNoticePending,
  markSessionNoticed,
} from "@/src/audit/leak-notice";
import {
  readLeakRecord,
  writeLeakRecord,
  dismissFinding,
  markLeakReportViewed,
} from "@/src/audit/leak-store";
import { upsertFinding, type LeakSighting } from "@/src/audit/leak-record";
import { shapeNotice, canDeliverNotice, leakNoticeText, desktopLeakNotice } from "@/src/hooks/notice";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fp-notice-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const FP = { display: "ghp_••••••••4f2a", label: "GitHub token", length: 40, attributed: true };
const sighting: LeakSighting = {
  cli: "claude", sessionId: "s1", cwd: "~/…/acme", at: "2026-09-08T00:00:00Z",
  mechanism: { summary: "read from ~/…/.env", toolName: "Read", direction: "input" },
};
function seed(...ids: string[]) {
  const r = readLeakRecord(home);
  for (const id of ids) {
    upsertFinding(r, { id, fingerprint: FP, name: "GITHUB_TOKEN", rule: "sanitize-api-keys",
      confidence: "doc-verified", sighting });
  }
  writeLeakRecord(r, home);
}

describe("what still owes the user a notice", () => {
  it("is every new finding, and nothing once claimed", () => {
    seed("0000000000000a01", "0000000000000b02");
    expect(pendingLeakNotice(home).count).toBe(2);
    markLeakNoticeDelivered(["0000000000000a01", "0000000000000b02"], home);
    expect(pendingLeakNotice(home).count).toBe(0);
  });

  it("stays quiet for a finding the user dismissed", () => {
    seed("0000000000000a01", "0000000000000b02");
    dismissFinding("0000000000000a01", home);
    expect(pendingLeakNotice(home).ids).toEqual(["0000000000000b02"]);
  });

  it("returns nothing rather than guessing when the record is unreadable", () => {
    expect(pendingLeakNotice("/nonexistent/path/xyz").count).toBe(0);
  });
});

// THE CLAIM THE DESIGN RESTS ON. A `notifiedAt` field on the record failed 100%
// of the time here: 2 concurrent sessions gave 2 notices, 8 gave 8 — and two
// sessions with DIFFERENT findings lost one mark permanently, so it re-notified
// forever. Running several agents at once in one project is how this tool is
// used, not an edge case.
describe("concurrency", () => {
  it("lets exactly one claimant win, however many race", () => {
    seed("0000000000000a01");
    const winners = Array.from({ length: 8 }, () => markLeakNoticeDelivered(["0000000000000a01"], home));
    expect(winners.flat()).toEqual(["0000000000000a01"]);
    expect(pendingLeakNotice(home).count).toBe(0);
  });

  it("never loses a claim on a DIFFERENT finding", () => {
    // The lost-update case: different findings touch different files, so both
    // survive. A single shared watermark map could not do this.
    seed("0000000000000a01", "0000000000000b02");
    expect(markLeakNoticeDelivered(["0000000000000a01"], home)).toEqual(["0000000000000a01"]);
    expect(markLeakNoticeDelivered(["0000000000000b02"], home)).toEqual(["0000000000000b02"]);
    expect(pendingLeakNotice(home).count).toBe(0);
  });

  it("reports which ids this caller actually won", () => {
    seed("0000000000000a01", "0000000000000b02");
    markLeakNoticeDelivered(["0000000000000a01"], home);
    expect(markLeakNoticeDelivered(["0000000000000a01", "0000000000000b02"], home)).toEqual(["0000000000000b02"]);
  });

  it("can release a failed delivery claim so the next attempt retries", () => {
    seed("0000000000000a01");
    const won = markLeakNoticeDelivered(["0000000000000a01"], home, "desktop");
    expect(pendingLeakNotice(home, "desktop").count).toBe(0);
    releaseLeakNoticeClaims(won, home, "desktop");
    expect(pendingLeakNotice(home, "desktop").ids).toEqual(["0000000000000a01"]);
  });
});

describe("marker housekeeping", () => {
  it("drops markers for findings that no longer exist", () => {
    seed("0000000000000a01");
    markLeakNoticeDelivered(["0000000000000a01", "00000000000f0000"], home);
    pruneNoticeMarkers(home);
    // "00000000000f0000" is gone; "0000000000000a01" is still a live finding so its claim stands.
    expect(pendingLeakNotice(home).count).toBe(0);
    const r = readLeakRecord(home);
    r.findings = [];
    writeLeakRecord(r, home);
    pruneNoticeMarkers(home);
    expect(pendingLeakNotice(home).count).toBe(0);
  });
});

describe("shaping the notice per CLI", () => {
  it("uses the channel each host was proven to render", () => {
    const text = leakNoticeText(2);
    expect(JSON.parse(shapeNotice("claude", text).stdout).systemMessage).toContain("2 possible credential exposures");
    expect(JSON.parse(shapeNotice("codex", text).stdout).systemMessage).toContain("2 possible credential exposures");
    expect(shapeNotice("copilot", text).stderr).toContain("2 possible credential exposures");
    expect(shapeNotice("factory", text).stdout).toContain("2 possible credential exposures");
    for (const cli of ["opencode", "pi"] as const) {
      expect(canDeliverNotice(cli)).toBe(true);
      expect(JSON.parse(shapeNotice(cli, text).stdout).failproofaiNotice)
        .toContain("2 possible credential exposures");
    }
  });

  // Guessing a channel is worse than having none: it produces output that looks
  // delivered from our side and reaches nobody, so we would record a leak as
  // "notified" that the user never saw.
  it("delivers nothing on a CLI with no proven channel", () => {
    for (const cli of ["cursor", "devin", "goose", "antigravity", "hermes"] as const) {
      expect(canDeliverNotice(cli), cli).toBe(false);
      expect(shapeNotice(cli, leakNoticeText(1)), cli).toEqual({ stdout: "", stderr: "" });
    }
  });

  it("merges into an existing verdict instead of emitting a second JSON document", () => {
    // Two JSON objects on one stream is a syntax error to every host, and it
    // would take the verdict down with the courtesy message.
    const verdict = JSON.stringify({ decision: "block", reason: "CI is red" });
    const out = shapeNotice("claude", leakNoticeText(1), verdict);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toBe("CI is red");
    expect(parsed.systemMessage).toContain("a possible credential exposure");
  });

  it("leaves a verdict alone rather than risk destroying it", () => {
    const notJson = "{ this is not json";
    expect(shapeNotice("claude", leakNoticeText(1), notJson).stdout).toBe(notJson);
  });

  it("never emits plain stdout over a verdict on factory", () => {
    const verdict = JSON.stringify({ decision: "block" });
    expect(shapeNotice("factory", leakNoticeText(1), verdict).stdout).toBe(verdict);
  });
});

// A fixed template, with only a number interpolated. The alternative is
// interpolating a finding's example — the verbatim text of a command, which a
// repository controls via a README or an npm script, and which the redactor
// does not sanitise because it masks secrets rather than instructions.
describe("the notice text", () => {
  it("interpolates a count and nothing else", () => {
    expect(leakNoticeText(1)).toContain("a possible credential exposure");
    expect(leakNoticeText(5)).toContain("5 possible credential exposures");
    expect(leakNoticeText(1)).toContain("failproofai audit");
  });

  it("keeps the desktop banner factual and focused on the next action", () => {
    const notice = desktopLeakNotice();
    expect(notice.title).toBe("failproofai audit needs review");
    expect(notice.body).toContain("Possible credential exposure");
    expect(notice.body).toContain("failproofai audit");
    expect(notice.body).not.toMatch(/email|schedule|500|leaked credential/i);
  });

  it("carries no fingerprint, path, project or command", () => {
    const text = leakNoticeText(3);
    expect(text).not.toContain("•");
    expect(text).not.toMatch(/[~/]\w/);
    expect(text).not.toContain("ghp_");
  });
});

// ── The in-CLI notice's delivery model ───────────────────────────────────────
//
// The per-finding claim above is right for the desktop banner and WRONG for the
// in-CLI notice, and the difference was learned the expensive way. "We emitted
// it once" is not "it arrived": on a real machine 499 findings were marked
// delivered and nothing was ever shown — once because the notice was attached
// to an event whose channel the host ignores, and once because hooks were
// disabled in the project under test. Neither is detectable from inside, and a
// claimed finding is never retried.
//
// So this channel keys on the USER's action instead of ours.
describe("the in-CLI notice keys on whether the user has looked", () => {
  const seedOld = (id: string) => {
    const r = readLeakRecord(home);
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    upsertFinding(r, {
      id, fingerprint: FP, name: "GITHUB_TOKEN", rule: "sanitize-api-keys",
      confidence: "doc-verified", sighting: { ...sighting, at: past },
    });
    writeLeakRecord(r, home);
  };

  it("tells one session once, not once per turn", () => {
    seedOld("0000000000000a01");
    expect(sessionNoticePending("sess-a", home).count).toBe(1);
    expect(markSessionNoticed("sess-a", home)).toBe(true);
    expect(sessionNoticePending("sess-a", home).count).toBe(0);
  });

  it("tells the NEXT session too, because the first one may never have shown it", () => {
    // The whole point. A dropped notice costs one session's silence rather than
    // the alert itself.
    seedOld("0000000000000a01");
    markSessionNoticed("sess-a", home);
    expect(sessionNoticePending("sess-b", home).count).toBe(1);
  });

  it("goes quiet once the user opens the report", () => {
    seedOld("0000000000000a01");
    markLeakReportViewed(home);
    expect(sessionNoticePending("sess-c", home).count).toBe(0);
  });

  it("speaks again when something NEW leaks after they looked", () => {
    seedOld("0000000000000a01");
    markLeakReportViewed(home);
    // A credential first seen after the view is news; one they already reviewed
    // is not, however recently the scan tripped over it again.
    const r = readLeakRecord(home);
    upsertFinding(r, {
      id: "0000000000000b02", fingerprint: FP, name: "N", rule: "r",
      confidence: "doc-verified",
      sighting: { ...sighting, at: new Date(Date.now() + 1000).toISOString() },
    });
    writeLeakRecord(r, home);
    expect(sessionNoticePending("sess-d", home).count).toBe(1);
  });

  it("stays silent when a finding is merely seen again", () => {
    // lastSeen moving is not news — only firstSeen decides.
    seedOld("0000000000000a01");
    markLeakReportViewed(home);
    const r = readLeakRecord(home);
    upsertFinding(r, {
      id: "0000000000000a01", fingerprint: FP, name: "GITHUB_TOKEN", rule: "r",
      confidence: "doc-verified", sighting: { ...sighting, at: new Date().toISOString() },
    });
    writeLeakRecord(r, home);
    expect(sessionNoticePending("sess-e", home).count).toBe(0);
  });

  it("says nothing at all when there are no findings", () => {
    expect(sessionNoticePending("sess-f", home).count).toBe(0);
  });

  it("refuses a session id that could escape the marker directory", () => {
    // Same rule as a finding id: it becomes a filename.
    seedOld("0000000000000a01");
    for (const bad of ["../../../../tmp/PWNED", "a/b", ""]) {
      expect(markSessionNoticed(bad, home), bad).toBe(false);
      expect(sessionNoticePending(bad, home).count, bad).toBe(0);
    }
    expect(existsSync("/tmp/PWNED")).toBe(false);
  });

  it("lets exactly one concurrent turn claim a session", () => {
    seedOld("0000000000000a01");
    const wins = Array.from({ length: 8 }, () => markSessionNoticed("sess-race", home));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
