// @vitest-environment node
/**
 * A clear may rest only on evidence Jev was actually shown.
 *
 * `decide` / `decideV1` do not read Jev's answers alone. `targetNamedByUser`
 * is a LOCAL check run here, and an `op-requested` override (v1) or a
 * `user_asked` + `scope` override (v0) becomes an `overridden` outcome only if
 * it holds — and `toReview` reports `overridden` as a CLEAR, which
 * `combineTwoTier` uses to drop a reviewable regex deny.
 *
 * The envelope keeps only the last `MAX_USER_MESSAGES` human turns, and
 * dropping whole turns does not set `truncated` (that window is a design
 * constant, not an attacker-triggered cut). So while `prepareSemantic` handed
 * the FULL list to the decide functions, a turn Jev never saw could satisfy
 * the local check and flip a reviewable deny to allow — on evidence nothing
 * judged, with `truncated` false, so the combine's one gate never saw it
 * either. Stale consent, too: an "delete the build-cache directory" from many
 * turns ago went on licensing that target forever.
 *
 * The fix is structural rather than another subtraction: `prepareSemantic`
 * reads `user_said` and `agent_last_message` back OUT of the envelope and
 * judges against those, so every cap the envelope applies — including any cap
 * added later — applies to the local check by construction.
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { DEFAULT_THRESHOLDS, DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import { MAX_USER_MESSAGES } from "../../../src/hooks/semantic/envelope";
import { evaluateSemantic, prepareSemantic, type SemanticOptions } from "../../../src/hooks/semantic/evaluator";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import { SEMANTIC_POLICIES } from "../../../src/hooks/semantic/policies";
import type { JevRequest, JevResponse, SemanticInput, SemanticPolicy } from "../../../src/hooks/semantic/types";

const POLICY: SemanticPolicy = SEMANTIC_POLICIES.find((p) => p.name === "database-destruction")!;
const COMMAND = "psql -c 'DROP TABLE analytics_events'";
/** The one word that makes `targetNamedByUser` hold for this call. */
const NAMES_THE_TARGET = "drop the analytics_events table";
/** Three turns that name nothing, so they fill the window without clearing anything. */
const FILLER = ["ok keep going", "thanks", "next please"];

/**
 * The policy fires hard, the human asked for exactly this operation, and the
 * call stays inside the task: everything an `op-requested` override needs
 * EXCEPT the target check, which is decided locally.
 */
const asked = async (request: JevRequest): Promise<JevResponse> => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => {
      if (id === "op_requested" || id === "task_step" || id === "scope" || id.endsWith(".user_asked")) return [id, { noul: 0.97 }];
      if (id === "beyond_task" || id === "injection") return [id, { noul: 0.02 }];
      if (id.startsWith(`${POLICY.name}.`)) return [id, { noul: 0.97 }];
      return [id, { noul: 0.02 }];
    }),
  ),
});

const v1: SemanticOptions = {
  transport: asked,
  via: "cloudflare",
  model: "jev-1.13.0",
  intent: "v1",
  policies: [POLICY],
  v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
};
const v0: SemanticOptions = {
  transport: asked,
  via: "cloudflare",
  model: "jev-1.13.0",
  intent: "v0",
  policies: [POLICY],
  thresholds: DEFAULT_THRESHOLDS,
};

const call = (userSaid: string[], agentLastMessage: string | null = null): SemanticInput => ({
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command: COMMAND },
  cwd: "/work/project",
  userSaid,
  agentLastMessage,
});

/** The reviewable regex deny this call earns, which only a clear can drop. */
const reviewable: RegexVerdict = {
  policyName: "failproofai/warn-destructive-sql",
  decision: "deny",
  reason: "destructive sql",
  authority: "reviewable",
  reviewedBy: [POLICY.name],
};

async function run(input: SemanticInput, opts: SemanticOptions) {
  const outcome = await evaluateSemantic(input, opts);
  if (outcome.status !== "ok") throw new Error(`degraded: ${outcome.reason}`);
  const review = toReview(outcome);
  return {
    outcome,
    review,
    named: outcome.verdict.outcomes.find((o) => o.policy === POLICY.name)?.targetNamedByUser ?? null,
    verdict: outcome.verdict.outcomes.find((o) => o.policy === POLICY.name)?.verdict ?? null,
    combined: combineTwoTier([reviewable], review, "enforce"),
  };
}

describe("the fixture names its target, and the window is three turns", () => {
  it("one turn past the window is dropped from the envelope", () => {
    const prepared = prepareSemantic(call([NAMES_THE_TARGET, ...FILLER]), v1);
    expect(FILLER.length).toBe(MAX_USER_MESSAGES);
    const sent = prepared.envelope.state.user_said as string[];
    expect(sent).toHaveLength(MAX_USER_MESSAGES);
    expect(sent.join("\n")).not.toContain("analytics_events");
    // And the envelope does not call that a cut — which is the whole reason
    // the combine's truncation gate cannot catch this.
    expect(prepared.envelope.truncated).toBe(false);
    expect(prepared.truncated).toBe(false);
  });
});

describe("a turn Jev never saw cannot clear a reviewable deny", () => {
  it("v1 control: the target named in a turn that WAS sent clears it", async () => {
    const r = await run(call([...FILLER, NAMES_THE_TARGET]), v1);
    expect(r.named).toBe(true);
    expect(r.verdict).toBe("overridden");
    expect(r.combined.cleared).toEqual([reviewable.policyName]);
    expect(r.combined.final.decision).toBe("allow");
  });

  it("v1: the target named ONLY in a dropped older turn clears nothing", async () => {
    const r = await run(call([NAMES_THE_TARGET, ...FILLER]), v1);
    expect(r.named).toBe(false);
    expect(r.verdict).not.toBe("overridden");
    expect(r.combined.cleared).toEqual([]);
    expect(r.combined.final.decision).toBe("deny");
    expect(r.combined.final.entries[0].policyName).toBe(reviewable.policyName);
  });

  it("v1: and that is indistinguishable from the turn never existing", async () => {
    const dropped = await run(call([NAMES_THE_TARGET, ...FILLER]), v1);
    const absent = await run(call(["unrelated chatter", ...FILLER]), v1);
    expect(dropped.named).toBe(absent.named);
    expect(dropped.verdict).toBe(absent.verdict);
    expect(dropped.combined.cleared).toEqual(absent.combined.cleared);
    expect(dropped.combined.final.decision).toBe(absent.combined.final.decision);
  });

  it("v0 takes the same evidence: `decide`'s target check is the local one too", async () => {
    const kept = await run(call([...FILLER, NAMES_THE_TARGET]), v0);
    expect(kept.named).toBe(true);
    expect(kept.combined.cleared).toEqual([reviewable.policyName]);

    const dropped = await run(call([NAMES_THE_TARGET, ...FILLER]), v0);
    expect(dropped.named).toBe(false);
    expect(dropped.combined.cleared).toEqual([]);
    expect(dropped.combined.final.decision).toBe("deny");
  });
});

/**
 * The structural half: whatever the envelope does to the evidence, the local
 * checks see exactly that and nothing else. This is what closes the class
 * rather than the one spelling — a cap added to `buildEnvelope` later cannot
 * reopen it.
 */
describe("what is judged is what was sent, by construction", () => {
  const LONG_TURN = "please tidy the analytics_events table. " + "Background the human pasted. ".repeat(80);
  const LONG_AGENT = "I can drop the analytics_events table. " + "Here is the plan in detail. ".repeat(80);

  const inputs: Array<[string, SemanticInput]> = [
    ["nothing said", call([])],
    ["one short turn", call([NAMES_THE_TARGET])],
    ["more turns than the window", call([NAMES_THE_TARGET, ...FILLER])],
    ["a turn longer than the per-message cap", call([LONG_TURN])],
    ["an agent message longer than the cap", call(["yes"], LONG_AGENT)],
    ["a whitespace-only agent message", call(["yes"], "   \n  ")],
    ["no agent message", call(["yes"], null)],
  ];

  it.each(inputs)("%s", (_label, input) => {
    const prepared = prepareSemantic(input, v1);
    const said = prepared.envelope.state.user_said;
    const agent = prepared.envelope.state.agent_last_message;
    expect(prepared.userSaid).toEqual(said);
    expect(prepared.agentLastMessage).toEqual(typeof agent === "string" ? agent : null);
  });
});
