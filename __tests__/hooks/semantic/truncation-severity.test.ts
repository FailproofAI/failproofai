// @vitest-environment node
/**
 * Truncation withdraws Jev's CLEARS and nothing else.
 *
 * §4 files a truncated envelope under "fall back to the regex result", and
 * reading that as "throw Jev's answer away" opened a hole: the envelope's
 * 2,000-character cap is tripped by the agent's own text, so padding a command
 * past it made Jev's OWN deny stop applying. These tests run the real
 * `evaluateSemantic` → `toReview` → `combineTwoTier` path, the way
 * `policy-evaluator.ts` does, and pin both halves:
 *
 * 1. **Severity survives a cut.** The same dangerous command, padded, is still
 *    denied — and a truncated answer can never make a call more permissive
 *    than the regex engine alone.
 * 2. **Clearing does not.** A cut call clears no reviewable deny, and is
 *    recorded `jev-fallback` / `truncated`.
 *
 * The cap is not exotic: a Write of ~2,100 characters trips it, so this is the
 * ordinary case on a machine running in enforce mode (D2), not a corner.
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier, regexOnly, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import { MAX_STRING_CHARS } from "../../../src/hooks/semantic/envelope";
import { evaluateSemantic, type SemanticOptions, type SemanticOutcome } from "../../../src/hooks/semantic/evaluator";
import { toReview } from "../../../src/hooks/semantic/jev-review";
import type { JevReview } from "../../../src/hooks/semantic/combine";
import type { JevRequest, JevResponse, SemanticInput } from "../../../src/hooks/semantic/types";

/** Every "does it do X" probe held; the human asked for none of it. Jev denies. */
const alarmed = async (request: JevRequest): Promise<JevResponse> => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { noul: id === "op_requested" || id === "task_step" ? 0.0 : 0.95 }]),
  ),
});

/** Nothing held, and the human asked for exactly this: every policy comes back clear. */
const calm = async (request: JevRequest): Promise<JevResponse> => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { noul: id === "op_requested" || id === "task_step" ? 0.95 : 0.02 }]),
  ),
});

const opts = (transport: typeof alarmed): SemanticOptions => ({
  transport,
  via: "cloudflare",
  model: "jev-1.13.0",
  intent: "v1",
  v1: { thresholds: DEFAULT_THRESHOLDS_V1 },
});

const bash = (command: string, userSaid = ["clean up the temp dir"]): SemanticInput => ({
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command },
  cwd: "/work/project",
  userSaid,
  agentLastMessage: null,
});

async function judged(input: SemanticInput, transport = alarmed): Promise<{ outcome: SemanticOutcome; review: JevReview }> {
  const outcome = await evaluateSemantic(input, opts(transport));
  return { outcome, review: toReview(outcome) };
}

const DANGEROUS = "rm -rf / --no-preserve-root";
/** Past `MAX_STRING_CHARS`, so the envelope caps the command and flags the call. */
const PADDING = "x".repeat(MAX_STRING_CHARS + 100);

describe("padding a command cannot take Jev's own deny away", () => {
  it("the same command, padded past the envelope cap, is still denied", async () => {
    const plain = await judged(bash(DANGEROUS));
    const padded = await judged(bash(`${DANGEROUS} ${PADDING}`));

    // The premise: only one of them is a cut call.
    expect(plain.outcome.truncated).toBe(false);
    expect(padded.outcome.truncated).toBe(true);

    // Jev denies either way …
    expect(plain.outcome.status === "ok" && plain.outcome.verdict.decision).toBe("deny");
    expect(padded.outcome.status === "ok" && padded.outcome.verdict.decision).toBe("deny");

    // … and so does the two-tier combine, with no regex verdict to lean on.
    // Before this rule the padded call came back `allow`.
    expect(combineTwoTier([], plain.review, "enforce").final.decision).toBe("deny");
    const out = combineTwoTier([], padded.review, "enforce");
    expect(out.final.decision).toBe("deny");
    expect(out.decidedByJev).toBe(true);
    expect(out.final.entries[0].policyName).toMatch(/^semantic\//);
  });

  it("the padded call is still recorded as §4's truncated fallback", async () => {
    const { review } = await judged(bash(`${DANGEROUS} ${PADDING}`));
    expect(combineTwoTier([], review, "enforce").activity).toMatchObject({
      evaluator: "jev-fallback",
      jevFallbackReason: "truncated",
      jevDecision: "deny",
      jevMode: "enforce",
    });
  });

  it("shadow mode is unaffected: the regex result is enforced, cut or not", async () => {
    const { review } = await judged(bash(`${DANGEROUS} ${PADDING}`));
    const out = combineTwoTier([], review, "shadow");
    expect(out.final).toEqual(regexOnly([]));
    expect(out.decidedByJev).toBe(false);
  });
});

describe("a cut call still clears nothing", () => {
  const reviewable: RegexVerdict = {
    policyName: "failproofai/warn-git-amend",
    decision: "instruct",
    reason: "amending rewrites history",
    authority: "reviewable",
    reviewedBy: ["git-history-rewrite"],
  };

  it("control: the same call uncut, with every reviewer clear, IS cleared", async () => {
    const { review } = await judged(bash("git commit --amend -m 'fix typo'", ["fix the typo in the last commit message"]), calm);
    expect(review).toMatchObject({ kind: "answered", truncated: false });
    const out = combineTwoTier([reviewable], review, "enforce");
    expect(out.cleared).toEqual([reviewable.policyName]);
    expect(out.final.decision).toBe("allow");
  });

  it("padded, the very same answer clears nothing and the instruct stands", async () => {
    const { review } = await judged(
      bash(`git commit --amend -m 'fix typo' ${PADDING}`, ["fix the typo in the last commit message"]),
      calm,
    );
    expect(review).toMatchObject({ kind: "answered", truncated: true });
    // Jev still says the reviewer is clear …
    expect(review.kind === "answered" && review.clear).toContain("git-history-rewrite");
    // … and the cut withdraws it anyway.
    const out = combineTwoTier([reviewable], review, "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final).toEqual(regexOnly([reviewable]));
    expect(out.activity.jevCleared).toBeUndefined();
  });
});

describe("ordinary oversized input is judged, not skipped", () => {
  /** A Write just over the cap — the routine case that used to switch the tier off. */
  const bigWrite = (chars: number): SemanticInput => ({
    eventType: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: "/work/project/notes.md", content: "note\n".repeat(Math.ceil(chars / 5)) },
    cwd: "/work/project",
    userSaid: ["write up the notes"],
    agentLastMessage: null,
  });

  it("under the cap and over it differ only in what may be cleared", async () => {
    const small = await judged(bigWrite(MAX_STRING_CHARS - 200), calm);
    const large = await judged(bigWrite(MAX_STRING_CHARS + 200), calm);
    expect(small.outcome.truncated).toBe(false);
    expect(large.outcome.truncated).toBe(true);
    expect(small.review.kind).toBe("answered");
    expect(large.review).toMatchObject({ kind: "answered", truncated: true });
    // Same questions asked, same answers given: the ONLY difference downstream
    // is that the large one clears nothing.
    expect(large.review.kind === "answered" && large.review.asked).toEqual(small.review.kind === "answered" ? small.review.asked : []);
    expect(combineTwoTier([], large.review, "enforce").cleared).toEqual([]);
  });

  it("a deny on an oversized Write still applies", async () => {
    const { review } = await judged(bigWrite(MAX_STRING_CHARS + 200), alarmed);
    expect(review).toMatchObject({ kind: "answered", truncated: true, decision: "deny" });
    expect(combineTwoTier([], review, "enforce").final.decision).toBe("deny");
  });
});
