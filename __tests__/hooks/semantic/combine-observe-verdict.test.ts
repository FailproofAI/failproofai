/**
 * Observe mode's "would have": Jev's own deny or instruct, recorded rather than
 * applied (contract §5B).
 *
 * `combineTwoTier` returns it as `observeVerdict`, and the handler files it in
 * the row's `observed` list. What is pinned here is that it is the verdict
 * ENFORCE mode would have applied — same name, same decision, same reason —
 * and that it appears in observe mode only, for deny/instruct only, without
 * changing anything observe mode enforces.
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

describe("observeVerdict", () => {
  it.each(["deny", "instruct"] as const)("a Jev %s in observe mode is recorded exactly as enforce mode would apply it", (decision) => {
    const review = answered({ decision });
    const observe = combineTwoTier(allowAll, review, "observe");
    const enforce = combineTwoTier(allowAll, review, "enforce");

    // Observe enforces the regex result, unchanged.
    expect(observe.final).toEqual(regexOnly(allowAll));
    expect(observe.decidedByJev).toBe(false);

    // Enforce applied Jev's verdict; observe records the same one.
    expect(enforce.decidedByJev).toBe(true);
    expect(enforce.final.decision).toBe(decision);
    expect(observe.observeVerdict).toEqual({
      policyName: enforce.final.entries[0].policyName,
      decision,
      reason: enforce.final.entries[0].reason,
      version: "jev-1.13.0",
    });
    expect(enforce.observeVerdict).toBeUndefined();
  });

  it("uses enforce mode's fixed template when Jev gave no reason", () => {
    const observe = combineTwoTier(allowAll, answered({ reason: null }), "observe");
    expect(observe.observeVerdict?.reason).toBe("Flagged by semantic review (semantic/destructive-deletion)");
  });

  it("records nothing when Jev allowed", () => {
    expect(combineTwoTier(allowAll, answered({ decision: "allow" }), "observe").observeVerdict).toBeUndefined();
  });

  it("records nothing when Jev did not answer or was not consulted", () => {
    expect(combineTwoTier(allowAll, { kind: "fallback", reason: "http-503", latencyMs: 40, model: null }, "observe").observeVerdict).toBeUndefined();
    expect(combineTwoTier(allowAll, { kind: "not-consulted" }, "observe").observeVerdict).toBeUndefined();
  });

  it("keeps Jev's own verdict on a cut or injected call, as enforce mode does (upward only)", () => {
    for (const over of [{ requestCut: true, truncated: true }, { injected: true }]) {
      const review = answered(over);
      expect(combineTwoTier(allowAll, review, "enforce").final.decision).toBe("deny");
      expect(combineTwoTier(allowAll, review, "observe").observeVerdict?.decision).toBe("deny");
    }
  });

  it("records it beside a regex deny too: it is Jev's verdict, not the row's", () => {
    const regexDeny: RegexVerdict[] = [{ policyName: "failproofai/block-sudo", decision: "deny", reason: "no sudo", authority: "hard", reviewedBy: [] }];
    const observe = combineTwoTier(regexDeny, answered(), "observe");
    expect(observe.final.decision).toBe("deny");
    expect(observe.final.entries[0].policyName).toBe("failproofai/block-sudo");
    expect(observe.observeVerdict?.policyName).toBe("semantic/destructive-deletion");
  });

  it("files the version as the model id, or `jev` when there is none this build would store", () => {
    expect(combineTwoTier(allowAll, answered({ model: null }), "observe").observeVerdict?.version).toBe("jev");
    expect(combineTwoTier(allowAll, answered({ model: "typesafe/jev-1.13-20260917" }), "observe").observeVerdict?.version).toBe(
      "typesafe/jev-1.13-20260917",
    );
    // A reported id carrying a space or a newline is not a model id.
    expect(combineTwoTier(allowAll, answered({ model: "jev 1.13\nrm -rf" }), "observe").observeVerdict?.version).toBe("jev");
  });
});
