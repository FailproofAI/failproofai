// @vitest-environment node
/**
 * Per-policy `observe` on a FailproofAI Cloud Jev assignment, and the
 * deployment's `jevPolicies` list (which agents have Cloud Jev checks).
 *
 * An observed Cloud check's answer is recorded (the row's `observed` list),
 * never applied: it neither denies nor clears. Cloud may say so per outcome
 * (`effect: "observe"`) or the machine's deployment does (`jevPolicies`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudReply } from "../../../src/hooks/semantic/cloud-jev";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import {
  _resetCloudManagedCachesForTest,
  cloudJevAssignmentsFor,
  readCloudJevAssignments,
} from "../../../src/hooks/cloud-managed-policies";
import { JevError } from "../../../src/hooks/semantic/jev-client";

function outcome(policy: string, cloudPolicyId: string, verdict: string, over: Record<string, unknown> = {}) {
  return {
    policy,
    mode: "deny",
    userCanOverride: true,
    evidence: verdict === "none" ? 0.05 : 0.95,
    exempt: null,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    verdict,
    origin: { cloudPolicyId, cloudVersion: 3 },
    ...over,
  };
}

function block(outcomes: Array<ReturnType<typeof outcome>>, decision: string, reason: string | null = null) {
  return {
    verdict: { decision, reason, outcomes, injectionSuspected: 0.05, scopeWithinRequest: null, beyondTask: false },
    asked: outcomes.map((o) => o.policy),
    droppedLocal: [],
    droppedCloud: [],
  };
}

describe("parseCloudReply: observe assignments", () => {
  it("an outcome Cloud marks observe leaves the verdict and is recorded as a would-have", () => {
    const reply = parseCloudReply(
      block([outcome("prod-db-check", "prod-db", "deny", { effect: "observe", reason: "Touches prod." })], "allow"),
    );
    expect(reply.verdict.decision).toBe("allow");
    expect(reply.verdict.outcomes).toEqual([]);
    expect(reply.observed).toEqual([
      { cloudPolicyId: "prod-db", cloudVersion: 3, check: "prod-db-check", decision: "deny", reason: "Touches prod." },
    ]);
    expect(reply.observedAsked).toEqual(["prod-db-check"]);
  });

  it("the deployment's observe list applies even when Cloud folded the deny into its verdict", () => {
    const reply = parseCloudReply(block([outcome("prod-db-check", "prod-db", "deny")], "deny", "Touches prod."), ["prod-db"]);
    expect(reply.verdict.decision).toBe("allow");
    expect(reply.verdict.reason).toBeNull();
    expect(reply.observed[0]).toMatchObject({ cloudPolicyId: "prod-db", decision: "deny" });
    expect(reply.observed[0].reason).toContain("semantic/prod-db-check");
  });

  it("an enforced deny beside an observed one still denies, with Cloud's reason", () => {
    const reply = parseCloudReply(
      block([outcome("a", "obs", "deny", { effect: "observe" }), outcome("b", "enf", "deny")], "deny", "b says no"),
    );
    expect(reply.verdict.decision).toBe("deny");
    expect(reply.verdict.reason).toBe("b says no");
    expect(reply.verdict.outcomes.map((o) => o.policy)).toEqual(["b"]);
    expect(reply.observed.map((o) => o.cloudPolicyId)).toEqual(["obs"]);
  });

  it("an observed check that found nothing is asked but has no would-have", () => {
    const reply = parseCloudReply(block([outcome("a", "obs", "none", { effect: "observe" })], "allow"));
    expect(reply.observed).toEqual([]);
    expect(reply.observedAsked).toEqual(["a"]);
  });

  it("an unknown effect refuses the reply", () => {
    expect(() => parseCloudReply(block([outcome("a", "p", "none", { effect: "maybe" })], "allow"))).toThrow(JevError);
  });

  it("an enforced deny under an allowing verdict is still a contradiction", () => {
    expect(() => parseCloudReply(block([outcome("a", "p", "deny")], "allow"))).toThrow(JevError);
  });
});

describe("parseCloudReply: the observed block (the server's contract)", () => {
  const observedBlock = (outcomes: Array<ReturnType<typeof outcome>>, decision: string, reason: string | null = null) => ({
    verdict: { decision, reason, outcomes, injectionSuspected: 0.05, scopeWithinRequest: null, beyondTask: false },
    asked: outcomes.map((o) => o.policy),
  });

  it("records the watched checks' would-haves and keeps them out of the verdict", () => {
    const reply = parseCloudReply({
      ...block([outcome("enf-check", "enf", "none")], "allow"),
      observed: observedBlock([outcome("prod-db-check", "prod-db", "deny")], "deny", "Touches prod."),
    });
    expect(reply.verdict.decision).toBe("allow");
    expect(reply.verdict.outcomes.map((o) => o.policy)).toEqual(["enf-check"]);
    expect(reply.asked).toEqual(["enf-check"]);
    expect(reply.observed).toEqual([
      { cloudPolicyId: "prod-db", cloudVersion: 3, check: "prod-db-check", decision: "deny", reason: "Touches prod." },
    ]);
    expect(reply.observedAsked).toEqual(["prod-db-check"]);
  });

  it("a watched check that found nothing is asked, with no would-have", () => {
    const reply = parseCloudReply({ ...block([], "allow"), observed: observedBlock([outcome("w", "obs", "none")], "allow") });
    expect(reply.observed).toEqual([]);
    expect(reply.observedAsked).toEqual(["w"]);
  });

  it.each([
    ["an outcome it did not ask", { ...observedBlock([outcome("w", "obs", "none")], "allow"), asked: [] }],
    ["the same outcome twice", { ...observedBlock([outcome("w", "obs", "none"), outcome("w", "obs", "none")], "allow") }],
    ["a deny under an allowing verdict", observedBlock([outcome("w", "obs", "deny")], "allow")],
    ["no verdict", { asked: [] }],
    ["not an object", ["x"]],
  ])("refuses the whole reply for %s", (_why, observed) => {
    expect(() => parseCloudReply({ ...block([], "allow"), observed })).toThrow(JevError);
  });

  it("an absent or null observed block is no watched check", () => {
    expect(parseCloudReply({ ...block([], "allow"), observed: null }).observedAsked).toEqual([]);
  });
});

describe("toReview carries the observed checks, outside asked and notDenied", () => {
  it("clears nothing with an observed outcome and records its would-have", () => {
    const reply = parseCloudReply(block([outcome("a", "obs", "deny", { effect: "observe" })], "allow"));
    const review = toReview({
      status: "ok",
      verdict: reply.verdict,
      answers: {},
      latencyMs: 12,
      inputTokens: null,
      questionCount: 2,
      truncated: false,
      requestCut: false,
      redactions: 0,
      model: "jev-1.13.0",
      modelVerified: true,
      via: "failproofai",
      cloud: { asked: reply.asked, droppedLocal: [], droppedCloud: [], observed: reply.observed, observedAsked: reply.observedAsked },
    } as Parameters<typeof toReview>[0]);
    expect(review.kind).toBe("answered");
    if (review.kind !== "answered") return;
    expect(review.decision).toBe("allow");
    expect(review.asked).toEqual([]);
    expect(review.notDenied).toEqual([]);
    expect(review.observedAsked).toEqual(["a"]);
    expect(review.observedCloud).toEqual([{ cloudPolicyId: "obs", cloudVersion: 3, decision: "deny", reason: expect.any(String) }]);
  });
});

describe("active.json jevPolicies", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-jevpolicies-"));
    saved = { FAILPROOFAI_CLOUD_POLICY_DIR: process.env.FAILPROOFAI_CLOUD_POLICY_DIR, FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME };
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = dir;
    // Hermetic: the reader treats a `config.json` saying `mode: oss`
    // (disconnected) as no deployment, and the runner's real home may hold one
    // that another test or step wrote.
    process.env.FAILPROOFAI_HOME = join(dir, "home");
    _resetCloudManagedCachesForTest();
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCloudManagedCachesForTest();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (body: Record<string, unknown>) => {
    const tmp = join(dir, `active.json.tmp-${Math.random()}`);
    writeFileSync(tmp, JSON.stringify({ deployment: 5, policies: [], jevMode: "enforce", ...body }));
    renameSync(tmp, join(dir, "active.json"));
    _resetCloudManagedCachesForTest();
  };
  const CLAUDE = { integration: "claude" as const, instanceId: "agt_1234567890abcdef" };
  const CODEX = { integration: "codex" as const, instanceId: "agt_abcdef1234567890" };

  it("absent means unknown: every call still goes to Cloud", () => {
    write({ schemaVersion: 2 });
    expect(readCloudJevAssignments()).toBeNull();
    expect(cloudJevAssignmentsFor(CODEX)).toBeNull();
  });

  it("a check scoped to claude does not apply to codex, or to an unknown agent", () => {
    write({
      schemaVersion: 3,
      jevPolicies: [{ id: "prod-db", version: 2, effect: "observe", agentTargets: [{ integration: "claude" }] }],
    });
    expect(cloudJevAssignmentsFor(CLAUDE)).toEqual([
      { id: "prod-db", version: 2, effect: "observe", agentTargets: [{ integration: "claude" }] },
    ]);
    expect(cloudJevAssignmentsFor(CODEX)).toEqual([]);
    expect(cloudJevAssignmentsFor(null)).toEqual([]);
  });

  it("an unscoped check applies to every agent; absent effect is enforce", () => {
    write({ schemaVersion: 2, jevPolicies: [{ id: "all", version: 1 }] });
    expect(cloudJevAssignmentsFor(null)).toEqual([{ id: "all", version: 1, effect: "enforce" }]);
  });

  it("an empty list means no Cloud check here", () => {
    write({ schemaVersion: 2, jevPolicies: [] });
    expect(cloudJevAssignmentsFor(CLAUDE)).toEqual([]);
  });

  it("a list this build cannot read is unknown, never a partial answer", () => {
    write({ schemaVersion: 2, jevPolicies: [{ id: "a", version: 1, effect: "maybe" }] });
    expect(readCloudJevAssignments()).toBeNull();
    write({ schemaVersion: 2, jevPolicies: [{ id: "a", version: 1, agentTargets: [{ integration: "claude" }] }] });
    expect(readCloudJevAssignments()).toBeNull();
  });
});
