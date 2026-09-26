/**
 * Shadow mode's "would have": Jev's own deny or instruct, recorded rather than
 * applied (contract §5B).
 *
 * `combineTwoTier` returns it as `shadowVerdict`, and the handler files it in
 * the row's `observed` list. What is pinned here is that it is the verdict
 * ENFORCE mode would have applied — same name, same decision, same reason —
 * and that it appears in shadow mode only, for deny/instruct only, without
 * changing anything shadow mode enforces.
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier, regexOnly, type JevReview, type RegexVerdict } from "../../../src/hooks/semantic/combine";

const allowAll: RegexVerdict[] = [{ policyName: "failproofai/block-sudo", decision: "allow", reason: null, authority: "hard", reviewedBy: [] }];

function answered(over: Partial<Extract<JevReview, { kind: "answered" }>> = {}): JevReview {
  return {
    kind: "answered",
    decision: "deny",
    reason: "Destructive deletion (semantic/destructive-deletion, p=0.97). Ask before deleting.",
    policyName: "semantic/destructive-deletion",
    asked: ["destructive-deletion"],
    notDenied: [],
    injectionAsked: true,
    injected: false,
    truncated: false,
    requestCut: false,
    latencyMs: 812,
    model: "jev-1.13.0",
    ...over,
  };
}

describe("shadowVerdict", () => {
  it.each(["deny", "instruct"] as const)("a Jev %s in shadow mode is recorded exactly as enforce mode would apply it", (decision) => {
    const review = answered({ decision });
    const shadow = combineTwoTier(allowAll, review, "shadow");
    const enforce = combineTwoTier(allowAll, review, "enforce");

    // Shadow enforces the regex result, unchanged.
    expect(shadow.final).toEqual(regexOnly(allowAll));
    expect(shadow.decidedByJev).toBe(false);

    // Enforce applied Jev's verdict; shadow records the same one.
    expect(enforce.decidedByJev).toBe(true);
    expect(enforce.final.decision).toBe(decision);
    expect(shadow.shadowVerdict).toEqual({
      policyName: enforce.final.entries[0].policyName,
      decision,
      reason: enforce.final.entries[0].reason,
      version: "jev-1.13.0",
    });
    expect(enforce.shadowVerdict).toBeUndefined();
  });

  it("uses enforce mode's fixed template when Jev gave no reason", () => {
    const shadow = combineTwoTier(allowAll, answered({ reason: null }), "shadow");
    expect(shadow.shadowVerdict?.reason).toBe("Flagged by semantic review (semantic/destructive-deletion)");
  });

  it("records nothing when Jev allowed", () => {
    expect(combineTwoTier(allowAll, answered({ decision: "allow" }), "shadow").shadowVerdict).toBeUndefined();
  });

  it("records nothing when Jev did not answer or was not consulted", () => {
    expect(combineTwoTier(allowAll, { kind: "fallback", reason: "http-503", latencyMs: 40, model: null }, "shadow").shadowVerdict).toBeUndefined();
    expect(combineTwoTier(allowAll, { kind: "not-consulted" }, "shadow").shadowVerdict).toBeUndefined();
  });

  it("keeps Jev's own verdict on a cut or injected call, as enforce mode does (upward only)", () => {
    for (const over of [{ requestCut: true, truncated: true }, { injected: true }]) {
      const review = answered(over);
      expect(combineTwoTier(allowAll, review, "enforce").final.decision).toBe("deny");
      expect(combineTwoTier(allowAll, review, "shadow").shadowVerdict?.decision).toBe("deny");
    }
  });

  it("records it beside a regex deny too: it is Jev's verdict, not the row's", () => {
    const regexDeny: RegexVerdict[] = [{ policyName: "failproofai/block-sudo", decision: "deny", reason: "no sudo", authority: "hard", reviewedBy: [] }];
    const shadow = combineTwoTier(regexDeny, answered(), "shadow");
    expect(shadow.final.decision).toBe("deny");
    expect(shadow.final.entries[0].policyName).toBe("failproofai/block-sudo");
    expect(shadow.shadowVerdict?.policyName).toBe("semantic/destructive-deletion");
  });

  it("files the version as the model id, or `jev` when there is none this build would store", () => {
    expect(combineTwoTier(allowAll, answered({ model: null }), "shadow").shadowVerdict?.version).toBe("jev");
    expect(combineTwoTier(allowAll, answered({ model: "typesafe/jev-1.13-20260917" }), "shadow").shadowVerdict?.version).toBe(
      "typesafe/jev-1.13-20260917",
    );
    // A reported id carrying a space or a newline is not a model id.
    expect(combineTwoTier(allowAll, answered({ model: "jev 1.13\nrm -rf" }), "shadow").shadowVerdict?.version).toBe("jev");
  });
});
