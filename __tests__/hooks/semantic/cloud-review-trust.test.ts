/**
 * Security review of #873: the review trusts a FailproofAI Cloud outcome only
 * for a check the reply's own `asked` names. A Cloud outcome is what clears a
 * `both` policy's regex half, so one the reply does not vouch for (or a
 * Cloud-origin outcome with no Cloud reply at all) turns the review into a
 * fallback: the regex decides alone.
 */
import { describe, expect, it } from "vitest";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import type { CloudSemanticOutcome } from "../../../src/hooks/semantic/cloud-jev";
import type { PolicyOutcome } from "../../../src/hooks/semantic/types";

function outcome(policy: string, verdict: PolicyOutcome["verdict"], packId = "cloud:no-prod-db"): PolicyOutcome {
  return {
    policy,
    mode: "deny",
    origin: { packId, packVersion: "3" },
    evidence: verdict === "none" ? 0.05 : 0.95,
    exempt: null,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    verdict,
  };
}

function reply(outcomes: PolicyOutcome[], asked: string[]): CloudSemanticOutcome {
  return {
    status: "ok",
    verdict: { decision: "allow", reason: null, outcomes, injectionSuspected: 0.01, scopeWithinRequest: null, beyondTask: false },
    answers: {},
    latencyMs: 12,
    inputTokens: null,
    questionCount: 3,
    truncated: false,
    requestCut: false,
    redactions: 0,
    model: "jev-1.13.0",
    modelVerified: true,
    via: "failproofai",
    cloud: { asked, droppedLocal: [], droppedCloud: [], answers: {}, observed: [], observedAsked: [], observedOutcomes: [] },
  } as CloudSemanticOutcome;
}

describe("toReview trusts only the Cloud outcomes `asked` vouches for", () => {
  it("clears with an outcome for an asked check", () => {
    const review = toReview(reply([outcome("acme-x", "none")], ["acme-x"]));
    expect(review.kind).toBe("answered");
    if (review.kind !== "answered") return;
    expect(review.asked).toEqual(["cloud:no-prod-db/acme-x"]);
    expect(review.notDenied).toEqual(["cloud:no-prod-db/acme-x"]);
  });

  it.each([
    ["asked: []", [] as string[]],
    ["asked names another check", ["acme-y"]],
  ])("falls back, clearing nothing, when %s", (_why, asked) => {
    const review = toReview(reply([outcome("acme-x", "none")], asked));
    expect(review).toMatchObject({ kind: "fallback", reason: "malformed" });
  });

  it("falls back when one of several outcomes is unvouched", () => {
    const review = toReview(reply([outcome("acme-x", "none"), outcome("acme-z", "none")], ["acme-x"]));
    expect(review.kind).toBe("fallback");
  });

  it("falls back on a Cloud-origin outcome with no Cloud reply at all", () => {
    const { cloud: _cloud, ...local } = reply([outcome("acme-x", "none")], ["acme-x"]) as CloudSemanticOutcome & { cloud: unknown };
    void _cloud;
    expect(toReview(local as never).kind).toBe("fallback");
  });

  it("leaves an installed pack's own outcome alone", () => {
    const review = toReview(reply([outcome("acme-local", "none", "acme/pack")], []));
    expect(review.kind).toBe("answered");
    if (review.kind !== "answered") return;
    expect(review.notDenied).toEqual(["acme-local"]);
  });
});
