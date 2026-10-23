/**
 * The per-check record of an answered Jev call (`jevChecks` on the activity
 * row, `jev_checks` on the shipped decision): which checks were asked and what
 * each concluded — verdict, why, evidence, exempt, probe answers — names,
 * codes and numbers only.
 */
import { describe, expect, it } from "vitest";
import { toReview, checkRecords } from "../../../src/hooks/semantic/jev-review";
import { cloudCheckAnswers, parseObservedOutcomes, type CloudSemanticOutcome } from "../../../src/hooks/semantic/cloud-jev";
import { combineTwoTier, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { jevOutcome, sanitizeJevActivity, sanitizeJevChecks } from "../../../src/hooks/jev-activity";
import type { PolicyOutcome } from "../../../src/hooks/semantic/types";

function outcome(over: Partial<PolicyOutcome> & Pick<PolicyOutcome, "policy" | "verdict">): PolicyOutcome {
  return {
    mode: "deny",
    userCanOverride: false,
    origin: { packId: "cloud:block-git-push-force", packVersion: "2" },
    evidence: 0.44,
    exempt: 0.03,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    ...over,
  };
}

function reply(outcomes: PolicyOutcome[], asked: string[], answers: Record<string, number>, observed: PolicyOutcome[] = []): CloudSemanticOutcome {
  return {
    status: "ok",
    verdict: { decision: "allow", reason: null, outcomes, injectionSuspected: 0.07, scopeWithinRequest: null, beyondTask: false },
    answers: { injection: 0.07, task_step: 0.96, op_requested: 0.98, beyond_task: 0.05 },
    latencyMs: 585,
    inputTokens: null,
    questionCount: 8,
    truncated: false,
    requestCut: false,
    redactions: 0,
    model: "jev-1.13.0",
    modelVerified: true,
    via: "failproofai",
    cloud: { asked, droppedLocal: [], droppedCloud: [], answers, observed },
  } as CloudSemanticOutcome;
}

const CHECK = "git-force-push-owned-feature-exception";

describe("an answered call records every asked check", () => {
  it("the issue-12 call: the probe missed, so the regex deny was cleared — and the row says why", () => {
    const review = toReview(
      reply([outcome({ policy: CHECK, verdict: "none" })], [CHECK], {
        [`${CHECK}.force_push`]: 0.44,
        [`${CHECK}.exempt`]: 0.03,
      }),
    );
    expect(review.kind).toBe("answered");
    if (review.kind !== "answered") return;
    expect(review.checks).toEqual([
      {
        check: CHECK,
        policy: "cloud/block-git-push-force@2",
        verdict: "none",
        why: "not-detected",
        p: 0.44,
        exempt: 0.03,
        probes: { force_push: 0.44 },
      },
    ]);
    const regex: RegexVerdict[] = [
      {
        policyName: "cloud/block-git-push-force@2/block-git-push-force",
        decision: "deny",
        reason: "Force push detected.",
        authority: "reviewable",
        reviewedBy: [`cloud:block-git-push-force/${CHECK}`],
      },
    ];
    const combined = combineTwoTier(regex, review, "enforce");
    expect(combined.final.decision).toBe("allow");
    expect(combined.activity.jevCleared).toEqual(["cloud/block-git-push-force@2/block-git-push-force"]);
    expect(combined.activity.jevChecks).toEqual(review.checks);
  });

  it("why: exempt, fired, injection, consent, downgrade, incomplete scan", () => {
    const why = (o: Partial<PolicyOutcome> & Pick<PolicyOutcome, "verdict">) =>
      checkRecords([outcome({ policy: "c", ...o })], {})[0]!.why;
    expect(why({ verdict: "none", evidence: 0.95, exempt: 0.8 })).toBe("exempt");
    expect(why({ verdict: "none", evidence: 0.2 })).toBe("not-detected");
    expect(why({ verdict: "deny", evidence: 0.95 })).toBe("fired");
    expect(why({ verdict: "deny", evidence: 0.95, escalatedByInjection: true })).toBe("injection");
    expect(why({ verdict: "overridden", evidence: 0.95, intent: "op-requested" })).toBe("op-requested");
    expect(why({ verdict: "overridden", evidence: 0.95, intent: "task-step" })).toBe("task-step");
    expect(why({ verdict: "overridden", evidence: 0.95 })).toBe("user-asked");
    expect(why({ verdict: "instruct", evidence: 0.95, intent: "downgraded-task-step" })).toBe("downgraded");
    expect(why({ verdict: "instruct", evidence: 0.95, targetScanIncomplete: true })).toBe("scan-incomplete");
  });

  it("a pack check is attributed to its pack; consent questions are not probes", () => {
    const [rec] = checkRecords(
      [outcome({ policy: "destructive-delete", verdict: "deny", evidence: 0.913, exempt: null, origin: { packId: "acme/guards", packVersion: "1.2.0" } })],
      { "destructive-delete.deletes": 0.913, "destructive-delete.user_asked": 0.9, "other.deletes": 0.1, injection: 0.01 },
    );
    expect(rec).toEqual({ check: "destructive-delete", policy: "pack/acme/guards@1.2.0", verdict: "deny", why: "fired", p: 0.91, probes: { deletes: 0.91 } });
  });

  it("a request with no check records an empty list, which reads as no-request", () => {
    const review = toReview(reply([], [], {}));
    if (review.kind !== "answered") throw new Error("answered expected");
    expect(review.checks).toEqual([]);
    const combined = combineTwoTier([], review, "observe");
    expect(combined.activity.jevChecks).toEqual([]);
    expect(jevOutcome(combined.activity)).toBe("no-request");
  });
});

describe("Cloud check answers are read off the reply by asked name", () => {
  it("keeps only `<asked check>.<part>` ids with a probability", () => {
    const response = {
      model: "jev-1.13.0",
      answers: {
        [`${CHECK}.force_push`]: { noul: 0.44 },
        [`${CHECK}.exempt`]: { noul: 0.03 },
        [`${CHECK}.Bad Id`]: { noul: 0.5 },
        "not-asked.p": { noul: 0.9 },
        injection: { noul: 0.07 },
        [`${CHECK}.nan`]: { noul: "x" },
      },
    };
    expect(cloudCheckAnswers(response as never, [CHECK])).toEqual({ [`${CHECK}.force_push`]: 0.44, [`${CHECK}.exempt`]: 0.03 });
    expect(cloudCheckAnswers(response as never, [])).toEqual({});
  });
});

describe("the activity row keeps only well-formed records", () => {
  it("drops text-shaped values and bad entries, rounds, caps", () => {
    const checks = sanitizeJevChecks([
      { check: "ok-check", verdict: "deny", why: "fired", p: 0.987654, probes: { a_b: 0.5, "Not Id": 0.5, c: 2 } },
      { check: "rm -rf /", verdict: "deny", why: "fired", p: 0.9 },
      { check: "x", verdict: "maybe", why: "fired", p: 0.9 },
      { check: "y", verdict: "none", why: "because the user said so", p: 0.9 },
      { check: "z", verdict: "none", why: "exempt", p: 0.9, policy: "curl -d @payroll.csv", exempt: 7 },
    ]);
    expect(checks).toEqual([
      { check: "ok-check", verdict: "deny", why: "fired", p: 0.99, probes: { a_b: 0.5 } },
      { check: "z", verdict: "none", why: "exempt", p: 0.9 },
    ]);
    expect(sanitizeJevChecks(Array.from({ length: 40 }, () => ({ check: "c", verdict: "none", why: "not-detected", p: 0 })))).toHaveLength(32);
    expect(sanitizeJevChecks([{ bad: true }])).toBeUndefined();
    expect(sanitizeJevChecks("no")).toBeUndefined();
  });

  it("only an answered (`jev`) row carries them", () => {
    const row = { evaluator: "jev-fallback", jevMode: "enforce", jevChecks: [{ check: "c", verdict: "none", why: "exempt", p: 1 }] } as const;
    expect(sanitizeJevActivity({ ...row }).jevChecks).toBeUndefined();
    const ok = sanitizeJevActivity({ ...row, evaluator: "jev" as const, jevLatencyMs: 4 });
    expect(ok.jevChecks).toHaveLength(1);
    expect(jevOutcome(ok)).toBe("answered");
  });
});

describe("checks of watched Cloud policies", () => {
  const wire = (policy: string, verdict: string) => ({
    policy, mode: "deny", userCanOverride: false, evidence: 0.97, exempt: null, userAsked: null,
    targetNamedByUser: false, escalatedByInjection: false, verdict, origin: { cloudPolicyId: "watch-sudo", cloudVersion: 4 },
  });

  it("are read off `observed`, only for names it asked, and never break the reply", () => {
    const got = parseObservedOutcomes({ observed: { asked: ["sudo-check"], verdict: { outcomes: [wire("sudo-check", "deny"), wire("other", "deny")] } } });
    expect(got.map((o) => [o.policy, o.verdict, o.origin?.packId])).toEqual([["sudo-check", "deny", "cloud:watch-sudo"]]);
    expect(parseObservedOutcomes({ observed: { asked: ["x"], verdict: { outcomes: [{ junk: 1 }] } } })).toEqual([]);
    expect(parseObservedOutcomes({})).toEqual([]);
    expect(parseObservedOutcomes(null)).toEqual([]);
  });

  it("are recorded as watched and never decide or clear", () => {
    const watched = parseObservedOutcomes({ observed: { asked: ["sudo-check"], verdict: { outcomes: [wire("sudo-check", "deny")] } } });
    const review = toReview(reply([], [], { "sudo-check.runs_sudo": 0.97 }, watched));
    if (review.kind !== "answered") throw new Error("answered expected");
    expect(review.decision).toBe("allow");
    expect(review.asked).toEqual([]);
    expect(review.checks).toEqual([
      { check: "sudo-check", policy: "cloud/watch-sudo@4", verdict: "deny", why: "fired", p: 0.97, probes: { runs_sudo: 0.97 }, watched: true },
    ]);
    const combined = combineTwoTier([], review, "enforce");
    expect(combined.final.decision).toBe("allow");
    expect(jevOutcome(combined.activity)).toBe("answered");
    expect(sanitizeJevChecks(combined.activity.jevChecks)?.[0]?.watched).toBe(true);
  });
});
