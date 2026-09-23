// @vitest-environment node
/**
 * §4 keeps the regex result when Jev judged a truncated envelope — the call,
 * the human's words or the agent's last message cut. The intent store (T4)
 * caps what it keeps to fit INSIDE the envelope's own limit, omission mark
 * included, so the envelope never cuts a stored message a second time and its
 * own `truncated` flag stays false. The cut must still count:
 * `prepareSemantic` / `evaluateSemantic` report it, and `toReview` marks the
 * answer `truncated`, which withdraws every clear and records the call as
 * `jev-fallback` / `truncated`.
 *
 * Where the cut comes from matters, because a cut TAKES JEV'S CLEARS AWAY —
 * every reviewable deny then stands. `user_said` and `agent_last_message` are
 * content — the agent writes the second one, and it repeats file and
 * tool-output text a third party controls — so a cut must never be something
 * that text can simply claim:
 *
 * - `SemanticOptions.contextTruncated` is the store's own word, out of band,
 *   and is believed exactly (`startJevReview` reads it off `readIntent`).
 * - With no word from the store, the mark alone is not enough: a message the
 *   store cut also FILLS the cap, and one that merely quotes a mark does not.
 *
 * `storedByIntentStore` reproduces what T4's `capWithin` stores (head and
 * tail around the same `\n…[N characters omitted]…\n` mark `capHeadTail`
 * writes, the mark counted inside the limit), so these tests hold against the
 * contract stub and T4's real store alike. `two-tier-intent-storage.test.ts`
 * runs the same rule end to end through whichever intent store is built in.
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { combineTwoTier, regexOnly, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import { MAX_USER_MESSAGE_CHARS, capHeadTail } from "../../../src/hooks/semantic/envelope";
import { evaluateSemantic, prepareSemantic, type SemanticOptions } from "../../../src/hooks/semantic/evaluator";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import type { JevRequest, JevResponse, SemanticInput } from "../../../src/hooks/semantic/types";

const mark = (omitted: number) => `\n…[${omitted} characters omitted]…\n`;

/** A message capped the way the intent store caps it: at most `max` characters, the mark included. */
function storedByIntentStore(text: string, max = MAX_USER_MESSAGE_CHARS): string {
  const budget = max - mark(text.length).length;
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}${mark(text.length - budget)}${text.slice(text.length - tail)}`;
}

const LONG_PROMPT = "Please tidy the notes folder. " + "Background detail the human pasted about the project. ".repeat(90);
const LONG_AGENT = "Here is the plan. " + "Step: move the file and check the result. ".repeat(80);

/**
 * A message that merely QUOTES the mark — an excerpt of one of our own capped
 * prompts, pasted into a file the agent then summarised. Nothing was cut.
 */
const QUOTES_THE_MARK = `I read the saved prompt; it ends "${mark(4_213)}…and then run the tests."`;

const allLow = async (request: JevRequest): Promise<JevResponse> => ({
  model: request.model,
  answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 0.05 }])),
});

const OPTS: SemanticOptions = {
  transport: allLow,
  via: "cloudflare",
  model: "jev-1.13.0",
  intent: "v1",
  v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
};

/** The reviewable regex deny that call earns, as `evaluatePolicies` records it. */
function outsideReadDeny(): RegexVerdict {
  return {
    policyName: "failproofai/block-read-outside-cwd",
    decision: "deny",
    reason: "reads outside the workspace",
    authority: "reviewable",
    reviewedBy: ["read-outside-workspace"],
  };
}

/** A read outside the project, inside home: read-outside-workspace is asked. Paths only; nothing is touched. */
function outsideRead(userSaid: string[], agentLastMessage: string | null = null): SemanticInput {
  return {
    eventType: "PreToolUse",
    toolName: "Read",
    toolInput: { file_path: join(homedir(), "fpai-context-cut-other", "notes.txt") },
    cwd: join(homedir(), "fpai-context-cut-project"),
    userSaid,
    agentLastMessage,
  };
}

describe("the fixture is what the intent store keeps", () => {
  it("fits the envelope's limit with its mark, so the envelope does not cut it again", () => {
    const stored = storedByIntentStore(LONG_PROMPT);
    expect(stored.length).toBeLessThanOrEqual(MAX_USER_MESSAGE_CHARS);
    expect(stored).toContain(" characters omitted]…");
    expect(capHeadTail(stored, MAX_USER_MESSAGE_CHARS).truncated).toBe(false);
  });

  it("the quoting fixture carries the same mark and is nowhere near the cap", () => {
    expect(QUOTES_THE_MARK).toContain(" characters omitted]…");
    expect(QUOTES_THE_MARK.length).toBeLessThan(MAX_USER_MESSAGE_CHARS / 2);
  });
});

describe("a message the intent store already cut is a truncated envelope (§4)", () => {
  it("a capped human prompt: envelope.truncated is false, the call is still truncated", () => {
    const prepared = prepareSemantic(outsideRead([storedByIntentStore(LONG_PROMPT)]), OPTS);
    // The premise: the envelope alone cannot see this cut.
    expect(prepared.envelope.truncated).toBe(false);
    expect(prepared.selected.map((p) => p.name)).toContain("read-outside-workspace");
    expect(prepared.truncated).toBe(true);
  });

  it("a capped agent message: the same", () => {
    const prepared = prepareSemantic(outsideRead(["tidy my notes"], storedByIntentStore(LONG_AGENT)), OPTS);
    expect(prepared.envelope.truncated).toBe(false);
    expect(prepared.truncated).toBe(true);
  });

  it("the review is marked truncated: Jev's answer is recorded, nothing is cleared", async () => {
    for (const input of [
      outsideRead([storedByIntentStore(LONG_PROMPT)]),
      outsideRead(["tidy my notes"], storedByIntentStore(LONG_AGENT)),
    ]) {
      const outcome = await evaluateSemantic(input, OPTS);
      expect(outcome.status).toBe("ok");
      expect(outcome.truncated).toBe(true);
      const review = toReview(outcome);
      expect(review).toMatchObject({ kind: "answered", truncated: true, decision: "allow" });
      // Its reviewer came back clear, and the cut still withdraws the clear.
      expect(review.kind === "answered" && review.clear).toContain("read-outside-workspace");
      const verdicts = [outsideReadDeny()];
      const out = combineTwoTier(verdicts, review, "enforce");
      expect(out.cleared).toEqual([]);
      expect(out.final).toEqual(regexOnly(verdicts));
      expect(out.activity).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "truncated", jevDecision: "allow" });
    }
  });

  it("only what is SENT counts: a capped prompt older than the last three is not in the envelope", () => {
    const prepared = prepareSemantic(
      outsideRead([storedByIntentStore(LONG_PROMPT), "tidy my notes", "and the build folder", "thanks"]),
      OPTS,
    );
    expect(prepared.truncated).toBe(false);
  });

  it("control: the same call with nothing cut is answered, and its reviewer is clear", async () => {
    const prepared = prepareSemantic(outsideRead(["tidy my notes"], "I can tidy them."), OPTS);
    expect(prepared.truncated).toBe(false);
    const review = toReview(await evaluateSemantic(outsideRead(["tidy my notes"], "I can tidy them."), OPTS));
    expect(review).toMatchObject({ kind: "answered", injectionAsked: true });
    expect(review.kind === "answered" && review.clear).toContain("read-outside-workspace");
  });

  it("a message the envelope cuts itself is still truncated (unchanged)", () => {
    const prepared = prepareSemantic(outsideRead([LONG_PROMPT]), OPTS);
    expect(prepared.envelope.truncated).toBe(true);
    expect(prepared.truncated).toBe(true);
  });
});

/**
 * The regression this guards: the mark used to be the whole test, so a message
 * that merely contained it forced the call onto the regex-only path and threw
 * Jev's verdict away — an off switch for the semantic tier that any repo file
 * the agent quoted could pull, logged below the default level so nothing
 * surfaced it.
 */
describe("a mark inside content does not switch the semantic tier off", () => {
  it("an agent message that quotes a mark is judged normally", async () => {
    const input = outsideRead(["tidy my notes"], QUOTES_THE_MARK);
    const prepared = prepareSemantic(input, OPTS);
    expect(prepared.envelope.truncated).toBe(false);
    expect(prepared.truncated).toBe(false);

    const review = toReview(await evaluateSemantic(input, OPTS));
    expect(review.kind).toBe("answered");
    expect(review.kind === "answered" && review.clear).toContain("read-outside-workspace");
  });

  it("a human message that quotes a mark is judged normally", async () => {
    const input = outsideRead([QUOTES_THE_MARK]);
    expect(prepareSemantic(input, OPTS).truncated).toBe(false);
    expect(toReview(await evaluateSemantic(input, OPTS)).kind).toBe("answered");
  });

  it("a mark pasted into the tool input is not a cut either", () => {
    const input = outsideRead(["tidy my notes"]);
    input.toolInput = { file_path: join(homedir(), "fpai-context-cut-other", `notes${mark(9_000)}.txt`) };
    expect(prepareSemantic(input, OPTS).truncated).toBe(false);
  });
});

describe("the store's own word (`contextTruncated`) is believed exactly", () => {
  it("true: the call is truncated although nothing in it looks cut", async () => {
    const input = outsideRead(["tidy my notes"], "I can tidy them.");
    const prepared = prepareSemantic(input, { ...OPTS, contextTruncated: true });
    expect(prepared.envelope.truncated).toBe(false);
    expect(prepared.truncated).toBe(true);
    expect(toReview(await evaluateSemantic(input, { ...OPTS, contextTruncated: true }))).toMatchObject({
      kind: "answered",
      truncated: true,
    });
  });

  it("false: a store that says it cut nothing overrides the mark-and-cap guess", () => {
    const input = outsideRead([storedByIntentStore(LONG_PROMPT)]);
    expect(prepareSemantic(input, OPTS).truncated).toBe(true);
    expect(prepareSemantic(input, { ...OPTS, contextTruncated: false }).truncated).toBe(false);
  });

  it("false cannot talk away a cut the envelope made itself", () => {
    const prepared = prepareSemantic(outsideRead([LONG_PROMPT]), { ...OPTS, contextTruncated: false });
    expect(prepared.envelope.truncated).toBe(true);
    expect(prepared.truncated).toBe(true);
  });
});
