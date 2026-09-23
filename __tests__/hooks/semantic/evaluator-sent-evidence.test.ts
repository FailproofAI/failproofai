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
 * The fix is structural rather than another subtraction: `buildEnvelope`
 * reports the WINDOW it carried (`Envelope.evidence`) and `prepareSemantic`
 * judges against that, so a turn the envelope dropped can never supply the
 * consent — including through a window rule added later.
 *
 * It reports the window with the text UNCUT, and that half matters just as
 * much. Judging the local check against the envelope's capped STRINGS closed
 * this hole and opened another: `targetNamedByUser` is a substring search, so
 * a target named in the cut middle of a long prompt stopped being found, and
 * an explicit user request turned into an instruct or a deny. A human turn is
 * consent the human typed; the window is what bounds it, not the cap.
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { DEFAULT_THRESHOLDS, DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import { MAX_USER_MESSAGES, MAX_USER_MESSAGE_CHARS } from "../../../src/hooks/semantic/envelope";
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
/** Repeats of `unit` needed to run comfortably past the per-message cap. */
const overCap = (unit: string) => Math.ceil((MAX_USER_MESSAGE_CHARS * 1.5) / unit.length);

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
 * The structural half: the local checks see exactly the WINDOW that was sent —
 * the same turns, in the same order, with the same inclusion decisions — and
 * see each turn's text UNCUT. This is what closes the class rather than the one
 * spelling: a window rule added to `buildEnvelope` later cannot reopen it, and
 * a per-message cap cannot lose consent the human actually typed.
 */
describe("what is judged is the window that was sent, uncut", () => {
  const LONG_TURN = "please tidy the analytics_events table. " + "Background the human pasted. ".repeat(overCap("Background the human pasted. "));
  const LONG_AGENT = "I can drop the analytics_events table. " + "Here is the plan in detail. ".repeat(overCap("Here is the plan in detail. "));

  const inputs: Array<[string, SemanticInput]> = [
    ["nothing said", call([])],
    ["one short turn", call([NAMES_THE_TARGET])],
    ["more turns than the window", call([NAMES_THE_TARGET, ...FILLER])],
    ["a turn longer than the per-message cap", call([LONG_TURN])],
    ["an agent message longer than the cap", call(["yes"], LONG_AGENT)],
    ["a whitespace-only agent message", call(["yes"], "   \n  ")],
    ["no agent message", call(["yes"], null)],
  ];

  /** `sent` is `judged` itself, or `judged` with its middle replaced by the omission mark. */
  const isSameTurn = (judged: string, sent: string): boolean => {
    if (judged === sent) return true;
    const mark = /\n…\[\d+ characters omitted\]…\n/.exec(sent);
    if (!mark) return false;
    const head = sent.slice(0, mark.index);
    const tail = sent.slice(mark.index + mark[0].length);
    return judged.length > sent.length && judged.startsWith(head) && judged.endsWith(tail);
  };

  it.each(inputs)("%s", (_label, input) => {
    const prepared = prepareSemantic(input, v1);
    const said = prepared.envelope.state.user_said as string[];
    const agent = prepared.envelope.state.agent_last_message;

    // Same window: one judged turn per sent turn, in order.
    expect(prepared.userSaid).toHaveLength(said.length);
    for (const [i, sent] of said.entries()) expect(isSameTurn(prepared.userSaid[i], sent)).toBe(true);
    // Same inclusion decision for the agent message …
    expect(prepared.agentLastMessage === null).toBe(typeof agent !== "string");
    // … and, unlike the human's turns, its text is the SENT text exactly. The
    // agent writes that channel and it repeats file, web and tool-output text
    // a third party controls, so consent found only in a part of it Jev never
    // read is the subtraction this design refuses everywhere else.
    if (typeof agent === "string") expect(prepared.agentLastMessage).toBe(agent);
    // Never MORE than the window: nothing local that was not sent.
    expect(prepared.userSaid.length).toBeLessThanOrEqual(MAX_USER_MESSAGES);
  });

  it("every judged HUMAN turn is at least as long as the turn that was sent", () => {
    const prepared = prepareSemantic(call([LONG_TURN], LONG_AGENT), v1);
    const said = prepared.envelope.state.user_said as string[];
    expect(said[0].length).toBeLessThanOrEqual(MAX_USER_MESSAGE_CHARS);
    expect(prepared.userSaid[0].length).toBeGreaterThan(said[0].length);
    // The agent's is not: it is exactly the capped string.
    expect((prepared.agentLastMessage as string).length).toBeLessThanOrEqual(MAX_USER_MESSAGE_CHARS);
  });

  /**
   * The defect the uncut-evidence rule caused when it was applied to BOTH
   * channels: a target named only in the cut middle of a 5,000-character
   * AGENT message satisfied the local `targetNamedByUser` check, and Jev's own
   * deny was downgraded to allow on text Jev never read — in the one channel
   * the design treats as hostile.
   */
  it("a target named only in the cut middle of the AGENT message does not override", async () => {
    const middle = `${"Here is the plan in detail. ".repeat(overCap("Here is the plan in detail. "))} I will ${NAMES_THE_TARGET} now. ${"Then I will continue. ".repeat(overCap("Then I will continue. "))}`;
    const prepared = prepareSemantic(call(["yes, go ahead"], middle), v1);
    const sentAgent = prepared.envelope.state.agent_last_message as string;
    // The premise: the target is in the message, but not in what was sent.
    expect(middle).toContain("analytics_events");
    expect(sentAgent).not.toContain("analytics_events");

    const r = await run(call(["yes, go ahead"], middle), v1);
    expect(r.named).toBe(false);
    expect(r.verdict).not.toBe("overridden");
    expect(r.combined.cleared).toEqual([]);
    expect(r.combined.final.decision).toBe("deny");

    // Control: the same target in the HEAD of the message, which was sent.
    const head = `I will ${NAMES_THE_TARGET} now. ${"Then I will continue. ".repeat(overCap("Then I will continue. ") * 2)}`;
    const control = await run(call(["yes, go ahead"], head), v1);
    expect(control.named).toBe(true);
    expect(control.verdict).toBe("overridden");
  });
});

/**
 * The other half of the same rule, and the defect the capped-strings version
 * introduced: a long prompt must not LOSE the consent it contains.
 *
 * `targetNamedByUser` is a plain substring search. Run against a head-and-tail
 * cut of a 3,000-character prompt, a target named in the dropped middle is not
 * found, the `op-requested` override does not fire, and a call the human asked
 * for in so many words becomes an instruct or a deny. A pasted spec, a file
 * list or a stack trace puts an ordinary prompt over the cap, so this was not
 * a corner case.
 */
describe("a long prompt does not lose the consent it contains", () => {
  const pad = (n: number) => "some background for you to read. ".repeat(n);
  /** Names the target in the MIDDLE — exactly where the per-message cap cuts. */
  const buried = (n: number) => `${pad(n)}${NAMES_THE_TARGET}. ${pad(n)}`;
  /** Enough padding on each side that the target lands in the cut middle. */
  const BURY = Math.ceil(MAX_USER_MESSAGE_CHARS / 33);

  it("control: the same request, short, clears the reviewable deny", async () => {
    const r = await run(call([`${NAMES_THE_TARGET}.`]), v1);
    expect(r.named).toBe(true);
    expect(r.verdict).toBe("overridden");
    expect(r.combined.final.decision).toBe("allow");
  });

  it("buried in the middle of a long prompt, Jev's own verdict is still allow", async () => {
    const input = call([buried(BURY)]);
    const prepared = prepareSemantic(input, v1);
    // The premise: the prompt is over the cap and the target is in the cut middle.
    expect(input.userSaid[0].length).toBeGreaterThan(MAX_USER_MESSAGE_CHARS);
    expect((prepared.envelope.state.user_said as string[])[0]).not.toContain("analytics_events");

    const r = await run(input, v1);
    expect(r.named).toBe(true);
    expect(r.verdict).toBe("overridden");
    // The regression this pins: judging the local check against the CAPPED
    // string made this an instruct (and a deny at a lower `task_step`), on a
    // call the human asked for in so many words.
    expect(r.outcome.verdict.decision).toBe("allow");
    expect(r.combined.activity.jevDecision).toBe("allow");
    // And the clear lands, exactly as it does for the short prompt above. A
    // cut MESSAGE is not evidence about the call: it used to withdraw every
    // clear, so the same request came out `allow` when the human was brief and
    // `deny` when they pasted a spec.
    expect(r.combined.cleared).toHaveLength(1);
    expect(r.combined.final.decision).toBe("allow");
    expect(r.combined.activity).toMatchObject({ evaluator: "jev" });
    expect(r.combined.activity.jevFallbackReason).toBeUndefined();
  });

  it("v0's `decide` does not lose it either", async () => {
    const r = await run(call([buried(BURY)]), v0);
    expect(r.named).toBe(true);
    expect(r.verdict).toBe("overridden");
    expect(r.outcome.verdict.decision).toBe("allow");
  });

  it("but a target named only in a DROPPED turn still clears nothing, however long the prompt", async () => {
    const r = await run(call([buried(BURY), ...FILLER]), v1);
    expect(r.named).toBe(false);
    expect(r.combined.cleared).toEqual([]);
    expect(r.combined.final.decision).toBe("deny");
  });
});
