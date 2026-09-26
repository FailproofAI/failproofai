/**
 * A fallback where Jev DID answer.
 *
 * When the call is too big for the envelope, the combine rules keep the regex
 * result (`jev-fallback`, reason `truncated`) but still record the verdict Jev
 * gave (`jevDecision`). A call padded past the cap to slip by is exactly one
 * where that verdict matters: the collector ships such a row on its own when
 * Jev would have been stricter (hooks_jev.rs
 * `a_truncated_fallback_jev_would_have_blocked_is_shipped_on_its_own`). The
 * dashboard used to call Jev "unavailable" here, leave its verdict out, and
 * give the row the same plain pill as a timeout.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JevNote, JevPill, jevPillKind } from "@/app/components/jev-notices";
import { describeJevActivity, jevAnsweredButNotApplied, sanitizeJevActivity } from "@/src/hooks/jev-activity";

/** Exactly what T3's combineTwoTier records for a truncated review Jev denied. */
const TRUNCATED_DENY = {
  decision: "allow",
  evaluator: "jev-fallback",
  jevDecision: "deny",
  jevFallbackReason: "truncated",
  jevLatencyMs: 812,
  jevModel: "jev-1.13.0",
  jevMode: "enforce",
} as const;

describe("a fallback where Jev answered but was set aside", () => {
  it("says Jev's answer was not applied and what it was", () => {
    expect(describeJevActivity(TRUNCATED_DENY)).toEqual([
      "Jev's answer not applied: truncated",
      "Jev verdict (not applied): deny",
      "the regex policies decided alone",
      "812 ms",
      "jev-1.13.0",
    ]);
  });

  it("a model mismatch is an answer set aside too, not an outage", () => {
    expect(
      describeJevActivity({ evaluator: "jev-fallback", jevFallbackReason: "model-mismatch", jevModel: "jev-2.0.0" }),
    ).toEqual(["Jev's answer not applied: model-mismatch", "the regex policies decided alone", "jev-2.0.0"]);
  });

  it("a real outage still says unavailable, with no verdict and no model", () => {
    expect(describeJevActivity({ evaluator: "jev-fallback", jevFallbackReason: "timeout", jevLatencyMs: 1500 })).toEqual([
      "Jev unavailable: timeout",
      "the regex policies decided alone",
      "1500 ms",
    ]);
  });

  it("jevAnsweredButNotApplied: a verdict on the row, or a set-aside reason", () => {
    const yes = [
      TRUNCATED_DENY,
      { evaluator: "jev-fallback", jevFallbackReason: "truncated" },
      { evaluator: "jev-fallback", jevFallbackReason: "model-mismatch" },
      { evaluator: "jev-fallback", jevFallbackReason: "timeout", jevDecision: "allow" },
    ] as const;
    const no = [
      { evaluator: "jev-fallback", jevFallbackReason: "timeout" },
      { evaluator: "jev-fallback", jevFallbackReason: "http-429" },
      { evaluator: "jev-fallback" },
      { evaluator: "jev", jevDecision: "deny", jevFallbackReason: "truncated" },
      {},
    ] as const;
    for (const r of yes) expect(jevAnsweredButNotApplied(sanitizeJevActivity(r)), JSON.stringify(r)).toBe(true);
    for (const r of no) expect(jevAnsweredButNotApplied(sanitizeJevActivity(r)), JSON.stringify(r)).toBe(false);
  });
});

describe("the pill for a fallback Jev would have been stricter on", () => {
  it("is louder than a plain fallback when the unapplied verdict is stricter than what was enforced", () => {
    expect(jevPillKind(TRUNCATED_DENY)).toBe("fallback-stricter");
    expect(jevPillKind({ ...TRUNCATED_DENY, jevDecision: "instruct" })).toBe("fallback-stricter");
    expect(jevPillKind({ ...TRUNCATED_DENY, decision: "instruct" })).toBe("fallback-stricter");
  });

  it("is a plain fallback when the regex result was as strict, or Jev gave no verdict", () => {
    expect(jevPillKind({ ...TRUNCATED_DENY, decision: "deny" })).toBe("fallback");
    expect(jevPillKind({ ...TRUNCATED_DENY, jevDecision: "allow" })).toBe("fallback");
    expect(jevPillKind({ decision: "allow", evaluator: "jev-fallback", jevFallbackReason: "timeout" })).toBe("fallback");
  });

  it("renders with its own title", () => {
    render(<JevPill item={TRUNCATED_DENY} />);
    const pill = screen.getByText("jev fallback");
    expect(pill.getAttribute("title")).toContain("would have been stricter");
  });

  it("the detail panel line shows the verdict", () => {
    render(<JevNote item={TRUNCATED_DENY} />);
    expect(
      screen.getByText(
        "Jev's answer not applied: truncated · Jev verdict (not applied): deny · the regex policies decided alone · 812 ms · jev-1.13.0",
      ),
    ).toBeInTheDocument();
  });
});
