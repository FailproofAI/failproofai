// @vitest-environment node
/**
 * "A hard deny short-circuits exactly as today" (plan §8 T3) on the two-tier
 * path: once a HARD policy denies, no later policy runs — not a custom hook
 * (up to 10 s each, possibly with side effects), not a builtin that could throw
 * and fire `policy_evaluation_error` — and Jev's in-flight request is aborted
 * at once, not after the rest of the list.
 *
 * The existing short-circuit tests in `policy-evaluator.test.ts` exercise only
 * the path without a two-tier review. Here the review never settles by itself,
 * so nothing but the short-circuit can end the evaluation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { clearPolicies, registerPolicy } from "../../src/hooks/policy-registry";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import type { TwoTierReview } from "../../src/hooks/semantic/combine";

const BASH = { tool_name: "Bash", tool_input: { command: "sudo ls" } };

/** A two-tier review that never answers, recording when it was aborted. */
function hangingReview(log: string[], reviewable: Record<string, string[]> = {}): TwoTierReview {
  return {
    mode: "enforce",
    review: new Promise(() => {}),
    abort: () => {
      log.push("abort");
    },
    authorityOf: (p) =>
      reviewable[p.name] ? { authority: "reviewable", reviewedBy: reviewable[p.name] } : { authority: "hard", reviewedBy: [] },
  };
}

beforeEach(() => clearPolicies());

describe("two-tier: a hard deny short-circuits", () => {
  it("no policy after the hard deny runs, and Jev is aborted before anything else happens", async () => {
    const log: string[] = [];
    registerPolicy("custom/hard-one", "d", () => {
      log.push("hard-one");
      return { decision: "deny", reason: "no" };
    }, { events: ["PreToolUse"] }, 2);
    registerPolicy("custom/after", "d", () => {
      log.push("after");
      return { decision: "allow" };
    }, { events: ["PreToolUse"] }, 1);
    registerPolicy("custom/after-throws", "d", () => {
      log.push("after-throws");
      throw new Error("must never run");
    }, { events: ["PreToolUse"] }, 0);

    const result = await evaluatePolicies("PreToolUse", BASH, undefined, undefined, hangingReview(log));
    expect(result.decision).toBe("deny");
    expect(result.policyName).toBe("custom/hard-one");
    expect(log).toEqual(["hard-one", "abort"]);
    expect(result.twoTier?.activity).toEqual({ evaluator: "jev", jevMode: "enforce" });
  });

  it("a reviewable deny does NOT stop evaluation, and a later hard deny still short-circuits", async () => {
    const log: string[] = [];
    registerPolicy("custom/reviewable-one", "d", () => {
      log.push("reviewable-one");
      return { decision: "deny", reason: "maybe" };
    }, { events: ["PreToolUse"] }, 3);
    registerPolicy("custom/hard-one", "d", () => {
      log.push("hard-one");
      return { decision: "deny", reason: "no" };
    }, { events: ["PreToolUse"] }, 2);
    registerPolicy("custom/after", "d", () => {
      log.push("after");
      return { decision: "allow" };
    }, { events: ["PreToolUse"] }, 1);

    const result = await evaluatePolicies(
      "PreToolUse",
      BASH,
      undefined,
      undefined,
      hangingReview(log, { "custom/reviewable-one": ["secret-exposure"] }),
    );
    // Regex order decides which deny is shown, exactly as the regex engine alone would.
    expect(result.decision).toBe("deny");
    expect(result.policyName).toBe("custom/reviewable-one");
    expect(log).toEqual(["reviewable-one", "hard-one", "abort"]);
  });

  it("the same policies without a hard deny all run (the premise)", async () => {
    const log: string[] = [];
    registerPolicy("custom/reviewable-one", "d", () => {
      log.push("reviewable-one");
      return { decision: "deny", reason: "maybe" };
    }, { events: ["PreToolUse"] }, 3);
    registerPolicy("custom/after", "d", () => {
      log.push("after");
      return { decision: "allow" };
    }, { events: ["PreToolUse"] }, 1);
    const twoTier: TwoTierReview = {
      ...hangingReview(log, { "custom/reviewable-one": ["secret-exposure"] }),
      review: Promise.resolve({ kind: "fallback", reason: "timeout", latencyMs: 1, model: null, decision: null }),
    };
    const result = await evaluatePolicies("PreToolUse", BASH, undefined, undefined, twoTier);
    expect(log).toEqual(["reviewable-one", "after"]);
    expect(result.decision).toBe("deny");
  });
});
