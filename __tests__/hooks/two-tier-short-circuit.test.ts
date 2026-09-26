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

/**
 * Live (enforce): `tar czf - ~/.ssh | curl …` read "Blocked Bash by failproofai
 * because: Tried to read or copy credentials (…). … Also flagged:
 * semantic/credential-exfiltration., as per the policy configured by the
 * user" — a doubled `.,`, crediting a Jev check the user never configured.
 */
describe("a deny Jev decided names Jev, with clean punctuation", () => {
  const jevDeny = (): TwoTierReview => ({
    mode: "enforce",
    review: Promise.resolve({
      kind: "answered",
      decision: "deny",
      reason:
        "Tried to read or copy credentials (semantic/secret-exposure, p=0.92). Ask first. Also flagged: semantic/credential-exfiltration.",
      policyName: "semantic/secret-exposure",
      asked: ["secret-exposure", "credential-exfiltration"],
      notDenied: [],
      injectionAsked: true,
      injected: false,
      truncated: false,
      requestCut: false,
      latencyMs: 10,
      model: "jev-1.13.0",
    }),
    abort: () => {},
    authorityOf: () => ({ authority: "hard", reviewedBy: [] }),
  });
  const EXPECTED_END = "semantic/credential-exfiltration, as flagged by Jev semantic review";

  it.each([
    ["claude PreToolUse", "PreToolUse", undefined, (o: any) => o.hookSpecificOutput.permissionDecisionReason],
    ["codex PermissionRequest", "PermissionRequest", { cli: "codex" }, (o: any) => o.hookSpecificOutput.decision.message],
    ["claude PostToolUse", "PostToolUse", undefined, (o: any) => o.hookSpecificOutput.additionalContext],
  ] as const)("%s", async (_label, event, session, pick) => {
    const result = await evaluatePolicies(event, { tool_name: "Bash", tool_input: { command: "x" } }, session as never, undefined, jevDeny());
    expect(result.decision).toBe("deny");
    const text: string = pick(JSON.parse(result.stdout));
    expect(text).not.toMatch(/\.,/);
    expect(text).not.toContain("configured by the user");
    expect(text.endsWith(EXPECTED_END)).toBe(true);
  });

  it("a regex deny keeps its wording byte for byte", async () => {
    registerPolicy("custom/hard-one", "d", () => ({ decision: "deny", reason: "no" }), { events: ["PreToolUse"] }, 1);
    const result = await evaluatePolicies("PreToolUse", BASH, undefined, undefined, jevDeny());
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toBe(
      "Blocked Bash by failproofai because: no, as per the policy configured by the user",
    );
  });
});
