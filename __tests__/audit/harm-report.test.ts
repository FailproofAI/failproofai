/**
 * Harm selection and windowing.
 *
 * The window is the part worth testing hardest: `--since` filters on transcript
 * MTIME, so a session left open for a month arrives with a fresh mtime and its
 * whole history in tow. If the window were not re-applied per event here, the
 * first digest anyone received would describe everything their agent had ever
 * done as though it happened that week.
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";

import { buildHarmReport, isHarmful, selectHarmful } from "../../src/audit/harm-report";
import type { AuditCount, AuditResult } from "../../src/audit/types";

const AUG_01 = "2026-08-01T12:00:00.000Z";
const AUG_07 = "2026-08-07T12:00:00.000Z";
const AUG_10 = "2026-08-10T12:00:00.000Z";
const AUG_14 = "2026-08-14T12:00:00.000Z";

function count(over: Partial<AuditCount> & { name: string; severity: string }): AuditCount {
  return {
    source: "builtin",
    category: "Environment",
    hits: 1,
    projects: 1,
    examples: [],
    displayTitle: "Did a thing",
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...over,
  } as AuditCount;
}

function example(timestamp: string, text = "cat /home/sidd/work/acme/.env") {
  return { sessionId: "s", cwd: "/home/sidd/work/acme", timestamp, example: text };
}

function result(results: AuditCount[], scannedAt = AUG_14): AuditResult {
  return {
    version: 2,
    scannedAt,
    scope: { cli: [], projects: "all", since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 1 },
    results,
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 0,
    enabledBuiltinNames: [],
  };
}

describe("isHarmful", () => {
  it("takes deny and sanitize, and leaves hygiene alone", () => {
    expect(isHarmful(count({ name: "failproofai/block-rm-rf", severity: "deny" }))).toBe(true);
    expect(isHarmful(count({ name: "failproofai/sanitize-api-keys", severity: "sanitize" }))).toBe(true);
    expect(isHarmful(count({ name: "failproofai/warn-git-amend", severity: "warn" }))).toBe(false);
    expect(isHarmful(count({ name: "failproofai/require-commit-before-stop", severity: "warn" }))).toBe(false);
  });

  it("includes protect-env-vars despite its severity reading as warn", () => {
    // `severityForBuiltin` derives severity from the NAME PREFIX, so a policy
    // that blocks `env`/`printenv` outright reads as hygiene. Its whole subject
    // is an agent reaching for the environment — the "read my keys" case this
    // feature exists to report. Inheriting a scoring heuristic's blind spot into
    // a security digest would be the wrong kind of consistency.
    expect(isHarmful(count({ name: "failproofai/protect-env-vars", severity: "warn" }))).toBe(true);
  });

  it("never takes an audit-only detector", () => {
    // Detectors have no enforcement path, so "the engine would have blocked it"
    // is not true of any of them.
    expect(
      isHarmful(count({ name: "sleep-polling-loop", severity: "warn", source: "audit-detector" })),
    ).toBe(false);
  });
});

describe("selectHarmful — the window", () => {
  it("drops a policy whose entire history predates the watermark", () => {
    // The long-running-session case. Its transcript has a fresh mtime, so the
    // scan opened it; nothing in it is new.
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        hits: 40,
        firstSeen: AUG_01,
        lastSeen: AUG_07,
        examples: [example(AUG_01), example(AUG_07)],
      }),
    ]);
    expect(selectHarmful(r, new Date(AUG_10), new Date(AUG_14))).toEqual([]);
  });

  it("reports the true total when the policy fired entirely inside the window", () => {
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        hits: 12,
        firstSeen: AUG_10,
        lastSeen: AUG_14,
        examples: [example(AUG_10)],
      }),
    ]);
    const [p] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    expect(p.hits).toBe(12);
  });

  it("counts only in-window examples when activity straddles the boundary", () => {
    // `hits` is a total over everything scanned and there is no per-event
    // breakdown to subtract from it. Reporting the total would describe the
    // wrong period; reporting the in-window examples undercounts but every one
    // of them is a real event inside the window.
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        hits: 40,
        firstSeen: AUG_01,
        lastSeen: AUG_14,
        examples: [example(AUG_01), example(AUG_10), example(AUG_14)],
      }),
    ]);
    const [p] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    expect(p.hits).toBe(2);
    expect(p.examples).toHaveLength(2);
  });

  it("undercounts rather than overcounts, so it can delay a digest but never invent one", () => {
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        hits: 500,
        firstSeen: AUG_01,
        lastSeen: AUG_14,
        examples: [example(AUG_14)],
      }),
    ]);
    const [p] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    expect(p.hits).toBeLessThan(500);
  });

  it("takes everything up to `to` when given no lower bound", () => {
    const r = result([
      count({
        name: "failproofai/block-rm-rf",
        severity: "deny",
        hits: 3,
        firstSeen: AUG_01,
        lastSeen: AUG_07,
        examples: [example(AUG_01)],
      }),
    ]);
    const [p] = selectHarmful(r, undefined, new Date(AUG_14));
    expect(p.hits).toBe(3);
  });

  it("excludes activity after the window closed", () => {
    // A clock skew, or a scan that raced an event. It belongs to the next
    // report, not this one.
    const r = result([
      count({
        name: "failproofai/block-rm-rf",
        severity: "deny",
        firstSeen: "2999-01-01T00:00:00.000Z",
        lastSeen: "2999-01-02T00:00:00.000Z",
      }),
    ]);
    expect(selectHarmful(r, new Date(AUG_07), new Date(AUG_14))).toEqual([]);
  });

  it("keeps an unplaceable policy on a first report and drops it on a later one", () => {
    // No usable timestamps, so it cannot be placed. Silence about something new
    // is worse than repeating something old, so each window fails the way it
    // can afford to. Keyed on "is this the first report", NOT on "is there a
    // lower bound" — a first report now always has one.
    const r = result([count({ name: "failproofai/block-sudo", severity: "deny", hits: 2 })]);
    expect(
      selectHarmful(r, new Date(AUG_07), new Date(AUG_14), { includeUnplaceable: true }),
    ).toHaveLength(1);
    expect(selectHarmful(r, new Date(AUG_07), new Date(AUG_14))).toEqual([]);
  });

  it("redacts every example it sends", () => {
    // Built from the REAL homedir rather than a hardcoded /home/sidd. The
    // redactor resolves `homedir()` to decide whether a path earns the `~`
    // prefix, so a literal path only tildes on the machine that wrote the test
    // — this passed locally and failed on CI, where HOME is /home/runner.
    const secretPath = `${homedir()}/clients/big-bank/.env`;
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        firstSeen: AUG_10,
        lastSeen: AUG_10,
        examples: [example(AUG_10, `cat ${secretPath}`)],
      }),
    ]);
    const [p] = selectHarmful(r, undefined, new Date(AUG_14));
    expect(p.examples[0]).not.toContain("big-bank");
    expect(p.examples[0]).toContain("~/…/.env");
  });

  it("orders by hits so a truncated digest keeps the rows that matter", () => {
    const r = result([
      count({ name: "failproofai/block-sudo", severity: "deny", hits: 2, firstSeen: AUG_10, lastSeen: AUG_10 }),
      count({ name: "failproofai/block-rm-rf", severity: "deny", hits: 9, firstSeen: AUG_10, lastSeen: AUG_10 }),
    ]);
    const out = selectHarmful(r, undefined, new Date(AUG_14));
    expect(out.map((p) => p.policy)).toEqual(["block-rm-rf", "block-sudo"]);
  });
});

describe("buildHarmReport", () => {
  it("uses the scan's own scannedAt as the window end, not the current clock", () => {
    // The instant the evidence was gathered. A later reading would advance the
    // watermark past events that happened while the scan was still running —
    // events no report would ever cover.
    const r = buildHarmReport(result([], AUG_10), AUG_07, 7);
    expect(r.window_to).toBe(AUG_10);
    expect(r.window_from).toBe(AUG_07);
  });

  it("bounds a FIRST report to one interval rather than all of history", () => {
    // Found by running it: against a real machine the unbounded first window
    // covered 230 sessions and 22,059 tool calls and produced 5,815 findings.
    // Every number was true and the digest was still wrong — an opening email
    // describing an agent's entire recorded history as though it were this
    // week's news, tripping the critical bypass on day one for everyone.
    const r = buildHarmReport(result([], AUG_14), undefined, 7);
    expect(r.window_from).toBe(AUG_07);
    expect(r.window_to).toBe(AUG_14);
  });

  it("honours the configured interval for that first window", () => {
    const r = buildHarmReport(result([], AUG_14), undefined, 4);
    expect(r.window_from).toBe(AUG_10);
  });

  it("drops history older than the first window", () => {
    const r = buildHarmReport(
      result(
        [
          count({
            name: "failproofai/block-env-files",
            severity: "deny",
            hits: 500,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: AUG_01,
            examples: [example(AUG_01)],
          }),
        ],
        AUG_14,
      ),
      undefined,
      7,
    );
    expect(r.harmful).toEqual([]);
  });

  it("produces an empty harmful list rather than nothing at all", () => {
    // A quiet report is still a report — it is what keeps "scanned and found
    // nothing" distinguishable from "stopped reporting".
    expect(buildHarmReport(result([]), AUG_07, 7).harmful).toEqual([]);
  });
});

describe("the upper edge of the window", () => {
  const AUG_20 = "2026-08-20T12:00:00.000Z";

  it("does not report hits that happened after `to`", () => {
    // The straddle test above covers the LOWER edge — activity that began
    // before the window. This is the other one: a policy that started inside
    // the window and was still firing after it closed. `wholly` tested only the
    // lower bound, so this reported `hits: 40` — every hit, including the ones
    // after `to` — while its examples were correctly filtered to the window.
    const r = result(
      [
        count({
          name: "failproofai/block-env-files",
          severity: "deny",
          hits: 40,
          firstSeen: AUG_10,
          lastSeen: AUG_20,
          examples: [example(AUG_10), example(AUG_14), example(AUG_20)],
        }),
      ],
      AUG_20,
    );

    const [p] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    expect(p.hits).toBe(2);
    expect(p.examples).toHaveLength(2);
  });

  it("would otherwise count the same hits again in the next window", () => {
    // Why the early report is worse than a late one: the watermark advances to
    // `to`, so the next window STARTS where this one ended and those same
    // post-window hits fall inside it. Reported twice, from one occurrence.
    const r = result(
      [
        count({
          name: "failproofai/block-env-files",
          severity: "deny",
          hits: 40,
          firstSeen: AUG_10,
          lastSeen: AUG_20,
          examples: [example(AUG_10), example(AUG_14), example(AUG_20)],
        }),
      ],
      AUG_20,
    );

    const [first] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    const [second] = selectHarmful(r, new Date(AUG_14), new Date(AUG_20));
    expect(first.hits + second.hits).toBeLessThanOrEqual(3);
  });

  it("still reports the real total when the policy fits inside both edges", () => {
    // The fix must not turn every row into an example count — a policy wholly
    // inside the window still reports `hits`, which is larger than the handful
    // of examples the audit kept.
    const r = result([
      count({
        name: "failproofai/block-env-files",
        severity: "deny",
        hits: 40,
        firstSeen: AUG_10,
        lastSeen: AUG_14,
        examples: [example(AUG_10)],
      }),
    ]);
    const [p] = selectHarmful(r, new Date(AUG_07), new Date(AUG_14));
    expect(p.hits).toBe(40);
  });
});
