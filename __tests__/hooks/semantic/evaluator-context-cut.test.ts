// @vitest-environment node
/**
 * §4 falls back to the regex result when Jev judged a truncated envelope —
 * the call, the human's words or the agent's last message cut. The intent
 * store (T4) caps what it keeps to fit INSIDE the envelope's own limit,
 * omission mark included, so the envelope never cuts a stored message a second
 * time and its own `truncated` flag stays false. The cut must still count:
 * `prepareSemantic` / `evaluateSemantic` report it, and `toReview` turns it
 * into the `truncated` fallback.
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

  it("the review falls back: Jev's answer is recorded, nothing is cleared", async () => {
    for (const input of [
      outsideRead([storedByIntentStore(LONG_PROMPT)]),
      outsideRead(["tidy my notes"], storedByIntentStore(LONG_AGENT)),
    ]) {
      const outcome = await evaluateSemantic(input, OPTS);
      expect(outcome.status).toBe("ok");
      expect(outcome.truncated).toBe(true);
      expect(toReview(outcome)).toMatchObject({ kind: "fallback", reason: "truncated", decision: "allow" });
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
