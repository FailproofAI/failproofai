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
import { MAX_REQUEST_CHARS } from "../../../src/hooks/semantic/compile";
import { DEFAULT_ENVELOPE_LIMITS, MAX_STATE_CHARS, MAX_STRING_CHARS, buildEnvelope } from "../../../src/hooks/semantic/envelope";
import { computeFacts, scanCommand } from "../../../src/hooks/semantic/facts";
import { evaluateSemantic, prepareSemantic, type SemanticOptions, type SemanticOutcome } from "../../../src/hooks/semantic/evaluator";
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

/**
 * The same class, one spelling further out: pad the call past the REQUEST
 * budget rather than past a field's cap.
 *
 * `MAX_REQUEST_CHARS` used to be a hard `degraded("request-too-large")`, which
 * `toReview` files as `kind: "fallback"` — no verdict, the regex result
 * stands, exactly the outcome the rule above exists to prevent. Getting there
 * cost one extra key: `facts.paths` copied `file_path` verbatim with no cap of
 * its own, so a 70,000-character path no policy reads was enough. Nesting
 * alone did it too, with every individual string inside its cap.
 *
 * `prepareSemantic` now rebuilds an oversized call with tighter caps and
 * `truncated` set, so it lands on the rule above instead: nothing is cleared,
 * and Jev's own deny still applies.
 */
describe("padding past the request budget is the same class", () => {
  /** Long enough that `as_written` + `resolved` alone overran the old budget. */
  const HUGE_PATH = "/work/project/" + "d".repeat(70_000);

  /** 24 x 24 x 1,500 characters. No single string is over `MAX_STRING_CHARS`. */
  function nestedPadding(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 24; i++) {
      const inner: Record<string, unknown> = {};
      for (let j = 0; j < 24; j++) inner[`k${j}`] = "x".repeat(1_500);
      out[`n${i}`] = inner;
    }
    return out;
  }

  const padded = (extra: Record<string, unknown>): SemanticInput => ({
    ...bash(DANGEROUS),
    toolInput: { command: DANGEROUS, ...extra },
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["an ignored 70k file_path beside the command", { file_path: HUGE_PATH }],
    ["an ignored 70k path beside the command", { path: HUGE_PATH }],
    ["an ignored 70k notebook_path beside the command", { notebook_path: HUGE_PATH }],
    ["nesting alone, every string within its cap", nestedPadding()],
  ];

  it.each(cases)("%s: the call is cut, not abandoned", async (_label, extra) => {
    const input = padded(extra);

    // The premise: carried verbatim — which is how `facts.paths` and a nested
    // `tool_input` used to reach the request — this one call is over the whole
    // budget by itself, which is what made it `request-too-large`.
    const scanned = scanCommand(DANGEROUS);
    const facts = computeFacts(input.toolName, input.toolInput, input.cwd ?? null, null, scanned);
    const uncapped =
      JSON.stringify(input.toolInput).length + facts.paths.reduce((n, p) => n + p.asWritten.length + p.resolved.length, 0);
    expect(uncapped).toBeGreaterThan(MAX_REQUEST_CHARS);

    const prepared = prepareSemantic(input, opts(alarmed));
    expect(prepared.oversized).toBe(false);
    expect(prepared.truncated).toBe(true);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);

    const { outcome, review } = await judged(input);
    // Before the shrink this was `degraded("request-too-large")` -> fallback.
    expect(outcome.status).toBe("ok");
    expect(review).toMatchObject({ kind: "answered", truncated: true, decision: "deny" });

    const out = combineTwoTier([], review, "enforce");
    expect(out.final.decision).toBe("deny");
    expect(out.decidedByJev).toBe(true);
    expect(out.activity).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "truncated", jevDecision: "deny" });
  });

  it("nesting that used to overrun the budget is bounded at the default caps", () => {
    const input = padded(nestedPadding());
    const scanned = scanCommand(DANGEROUS);
    const facts = computeFacts(input.toolName, input.toolInput, input.cwd ?? null, null, scanned);
    // The premise: carried verbatim this is 24 x 24 x 1,500 characters, seven
    // times the request budget, with every individual string inside
    // `MAX_STRING_CHARS` — so per-field caps alone would cut nothing.
    expect(JSON.stringify(input.toolInput).length).toBeGreaterThan(MAX_REQUEST_CHARS);

    // There is no smaller rebuild to fall back on any more: the DEFAULT caps
    // are already a hard total budget, and they are what the product uses.
    const atDefault = buildEnvelope(input.toolInput, input.userSaid, facts, scanned, { limits: DEFAULT_ENVELOPE_LIMITS });
    expect(JSON.stringify(atDefault.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(atDefault.truncated).toBe(true);

    const prepared = prepareSemantic(input, opts(alarmed));
    expect(prepared.oversized).toBe(false);
    expect(prepared.truncated).toBe(true);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
  });

  it("the dangerous part of the command survives the caps", async () => {
    const prepared = prepareSemantic(padded(nestedPadding()), opts(alarmed));
    const request = prepared.envelope.state.agent_request as { input: { command: string } };
    expect(request.input.command).toContain("--no-preserve-root");
  });

  it("a cut call still clears nothing, however it was padded", async () => {
    const reviewable: RegexVerdict = {
      policyName: "failproofai/warn-destructive-sql",
      decision: "deny",
      reason: "destructive sql",
      authority: "reviewable",
      reviewedBy: ["database-destruction"],
    };
    const input: SemanticInput = {
      ...bash("psql -c 'DROP TABLE analytics_events'", ["drop the analytics_events table"]),
      toolInput: { command: "psql -c 'DROP TABLE analytics_events'", file_path: HUGE_PATH },
    };
    const { review } = await judged(input, calm);
    expect(review).toMatchObject({ kind: "answered", truncated: true });
    const out = combineTwoTier([reviewable], review, "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final).toEqual(regexOnly([reviewable]));
  });

  it("the budget has room to spare, so `request-too-large` stays unreachable", async () => {
    // Deliberately worse than anything above: every axis at once.
    const worst: Record<string, unknown> = { command: DANGEROUS, file_path: HUGE_PATH, path: HUGE_PATH };
    for (let i = 0; i < 40; i++) {
      const inner: Record<string, unknown> = {};
      for (let j = 0; j < 40; j++) inner[`k${j}`] = "y".repeat(MAX_STRING_CHARS);
      worst[`n${i}`] = inner;
    }
    const input: SemanticInput = {
      ...bash(DANGEROUS, ["a".repeat(50_000), "b".repeat(50_000), "c".repeat(50_000), "d".repeat(50_000)]),
      toolInput: worst,
    };
    const prepared = prepareSemantic(input, opts(alarmed));
    expect(prepared.oversized).toBe(false);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThan(MAX_REQUEST_CHARS / 2);

    const { outcome, review } = await judged(input);
    expect(outcome.status).toBe("ok");
    expect(review).toMatchObject({ kind: "answered", truncated: true, decision: "deny" });
    expect(combineTwoTier([], review, "enforce").final.decision).toBe("deny");
  });

  it("an ordinary call is not cut and is not marked cut", () => {
    const prepared = prepareSemantic(bash("ls -la"), opts(calm));
    expect(prepared.truncated).toBe(false);
    expect(prepared.oversized).toBe(false);
  });
});

/**
 * `facts` used to be the one part of the envelope with no caps at all:
 * `extractPaths` copies `file_path` / `path` / `notebook_path` verbatim and
 * `buildEnvelope` passed `as_written` / `resolved` straight through, so a long
 * path grew the request without ever setting `truncated`. That is what made
 * the budget reachable in the first place.
 */
describe("facts are capped like everything else", () => {
  const LONG = "/work/project/" + "d".repeat(MAX_STRING_CHARS + 500);

  it("a long path is cut in `facts`, and the cut is flagged", () => {
    const prepared = prepareSemantic(
      {
        eventType: "PreToolUse",
        toolName: "Read",
        toolInput: { file_path: LONG },
        cwd: "/work/project",
        userSaid: ["read that file"],
        agentLastMessage: null,
      },
      opts(calm),
    );
    // Small enough that nothing was shrunk: the flag comes from the cap alone.
    expect(prepared.oversized).toBe(false);
    expect(JSON.stringify(prepared.compiled.request).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
    expect(prepared.truncated).toBe(true);

    const facts = prepared.envelope.state.facts as { paths: Array<{ as_written: string; resolved: string }> };
    expect(facts.paths.length).toBeGreaterThan(0);
    for (const p of facts.paths) {
      expect(p.as_written.length).toBeLessThan(MAX_STRING_CHARS + 200);
      expect(p.resolved.length).toBeLessThan(MAX_STRING_CHARS + 200);
    }
  });

  it("a short path is untouched and flags nothing", () => {
    const prepared = prepareSemantic(
      {
        eventType: "PreToolUse",
        toolName: "Read",
        toolInput: { file_path: "/work/project/notes.md" },
        cwd: "/work/project",
        userSaid: ["read that file"],
        agentLastMessage: null,
      },
      opts(calm),
    );
    expect(prepared.truncated).toBe(false);
    const facts = prepared.envelope.state.facts as { paths: Array<{ as_written: string }> };
    expect(facts.paths.map((p) => p.as_written)).toContain("/work/project/notes.md");
  });
});
