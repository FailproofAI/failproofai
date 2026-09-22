/**
 * The §4 combine table, exhaustively: every row × {shadow, enforce} ×
 * {complete, truncated}. Each row is driven from a SemanticOutcome — what
 * `evaluateSemantic` actually returns — through `toReview` (how the handler
 * reads it) and `combineTwoTier` (what it enforces), so the truncation →
 * fallback step is covered by the same table rather than beside it.
 *
 * The expected result is written out for `enforce` + complete. The other
 * columns follow from rules the table asserts on every row: shadow enforces
 * the regex result, and a truncated envelope — whatever was cut: the call,
 * the human's words or the agent's last message — falls back to it (§4).
 */
import { describe, expect, it } from "vitest";
import { combineTwoTier, regexOnly, type JevMode, type JevReview, type RegexVerdict } from "../../../src/hooks/semantic/combine";
import { fallbackCode, toReview } from "../../../src/hooks/semantic/jev-review";
import { DEFAULT_THRESHOLDS_V1 } from "../../../src/hooks/semantic/decide";
import type { SemanticOutcome } from "../../../src/hooks/semantic/evaluator";
import type { PolicyOutcome, SemanticVerdict } from "../../../src/hooks/semantic/types";

// ── Builders ─────────────────────────────────────────────────────────────────

const hard = (policyName: string, decision: RegexVerdict["decision"], reason: string | null = `${policyName} says ${decision}`): RegexVerdict => ({
  policyName,
  decision,
  reason,
  authority: "hard",
  reviewedBy: [],
});
const reviewable = (
  policyName: string,
  decision: RegexVerdict["decision"],
  reviewedBy: string[],
  reason = `${policyName} says ${decision}`,
): RegexVerdict => ({ policyName, decision, reason, authority: "reviewable", reviewedBy });

type SemVerdict = PolicyOutcome["verdict"];

function semOutcome(opts: {
  decision?: SemanticVerdict["decision"];
  reason?: string | null;
  policies?: Record<string, SemVerdict>;
  /** Default 0.05: the probe was asked and came back low. `null`: it was not asked. */
  injection?: number | null;
  truncated?: boolean;
  via?: "cloudflare" | "none";
  beyondTask?: boolean;
}): SemanticOutcome {
  const outcomes: PolicyOutcome[] = Object.entries(opts.policies ?? {}).map(([policy, verdict]) => ({
    policy,
    mode: "deny",
    evidence: verdict === "none" ? 0.1 : 0.95,
    exempt: null,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    verdict,
  }));
  return {
    status: "ok",
    verdict: {
      decision: opts.decision ?? "allow",
      reason: opts.reason ?? null,
      outcomes,
      injectionSuspected: opts.injection === undefined ? 0.05 : opts.injection,
      scopeWithinRequest: null,
      beyondTask: opts.beyondTask ?? false,
    },
    answers: {},
    latencyMs: 42,
    inputTokens: 100,
    questionCount: outcomes.length,
    truncated: opts.truncated ?? false,
    redactions: 0,
    model: "jev-1.13.0",
    modelVerified: true,
    via: opts.via ?? "cloudflare",
  };
}

function degradedOutcome(reason: string, truncated = false): SemanticOutcome {
  return { status: "degraded", reason, latencyMs: 1500, questionCount: 3, truncated };
}

type Truncation = "complete" | "truncated";
const withTruncation = (o: SemanticOutcome, t: Truncation): SemanticOutcome => ({ ...o, truncated: t === "truncated" });

// ── The table ────────────────────────────────────────────────────────────────

interface Expect {
  decision: "allow" | "deny" | "instruct";
  /** policyName of every final entry, in order. */
  names: string[];
  cleared: string[];
  decidedByJev?: boolean;
}

interface Row {
  id: string;
  verdicts: RegexVerdict[];
  /** null → a hard deny decided and Jev was never consulted. */
  outcome: SemanticOutcome | null;
  enforce: Expect;
  /** Expected fallback reason, when this row is a fallback even untruncated. */
  fallback?: string;
}

const RRO = "failproofai/block-read-outside-cwd";
const PEV = "failproofai/protect-env-vars";
const AMEND = "failproofai/warn-git-amend";

const ROWS: Row[] = [
  // ── Any hard deny → the regex result; Jev aborted ────────────────────────
  {
    id: "hard deny alone",
    verdicts: [hard("failproofai/block-sudo", "deny")],
    outcome: null,
    enforce: { decision: "deny", names: ["failproofai/block-sudo"], cleared: [] },
  },
  {
    id: "reviewable deny before a hard deny: first deny named, nothing cleared",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), hard("failproofai/block-sudo", "deny")],
    outcome: null,
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  // ── Jev degraded → the regex result, every deny counting ─────────────────
  ...["timeout", "http-429", "http-503", "out-of-credits", "malformed", "model-mismatch", "rate-limited", "network", "no-transport"].map(
    (reason): Row => ({
      id: `degraded: ${reason}`,
      verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), hard(AMEND, "instruct")],
      outcome: degradedOutcome(reason),
      fallback: reason,
      enforce: { decision: "deny", names: [RRO], cleared: [] },
    }),
  ),
  {
    id: "degraded with an exception message: only the code is recorded",
    verdicts: [reviewable(RRO, "instruct", ["read-outside-workspace"])],
    outcome: degradedOutcome("error: connect ECONNREFUSED 10.0.0.1:443 while reading /home/someone/.env"),
    fallback: "error",
    enforce: { decision: "instruct", names: [RRO], cleared: [] },
  },
  // ── Jev answered ─────────────────────────────────────────────────────────
  {
    id: "reviewable deny, its reviewer asked and clear → cleared",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ policies: { "read-outside-workspace": "none", "secret-exposure": "none" } }),
    enforce: { decision: "allow", names: [], cleared: [RRO] },
  },
  {
    id: "reviewable deny, its reviewer overridden (the human asked) → cleared",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ policies: { "read-outside-workspace": "overridden" } }),
    enforce: { decision: "allow", names: [], cleared: [RRO] },
  },
  {
    id: "two reviewers, both asked and clear → cleared",
    verdicts: [reviewable(PEV, "deny", ["env-secrets-dump", "secret-exposure"])],
    outcome: semOutcome({ policies: { "env-secrets-dump": "none", "secret-exposure": "overridden" } }),
    enforce: { decision: "allow", names: [], cleared: [PEV] },
  },
  {
    id: "two reviewers, one NOT asked → stands (Jev can only clear what it was asked)",
    verdicts: [reviewable(PEV, "deny", ["env-secrets-dump", "secret-exposure"])],
    outcome: semOutcome({ policies: { "env-secrets-dump": "none" } }),
    enforce: { decision: "deny", names: [PEV], cleared: [] },
  },
  {
    id: "reviewer not asked at all (precondition false) → stands",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ policies: { "secret-exposure": "none" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "reviewedBy names a policy that does not exist → stands",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace-typo"])],
    outcome: semOutcome({ policies: { "read-outside-workspace": "none" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "reviewer came back instruct → stands, and the regex deny outranks Jev's instruct",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ decision: "instruct", reason: "reads outside", policies: { "read-outside-workspace": "instruct" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "reviewer came back deny → stands",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ decision: "deny", reason: "reads outside", policies: { "read-outside-workspace": "deny" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "injection suspected → every clear withdrawn",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), reviewable(AMEND, "instruct", ["git-history-rewrite"])],
    outcome: semOutcome({ injection: 0.9, policies: { "read-outside-workspace": "none", "git-history-rewrite": "none" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "injection probe NOT asked (no human message recorded) → every clear withheld",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), reviewable(AMEND, "instruct", ["git-history-rewrite"])],
    outcome: semOutcome({ injection: null, policies: { "read-outside-workspace": "none", "git-history-rewrite": "none" } }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "injection probe NOT asked, reviewable instruct only → it stands",
    verdicts: [reviewable(AMEND, "instruct", ["git-history-rewrite"])],
    outcome: semOutcome({ injection: null, policies: { "git-history-rewrite": "none" } }),
    enforce: { decision: "instruct", names: [AMEND], cleared: [] },
  },
  {
    id: "injection probe below threshold → clears apply",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ injection: 0.4, policies: { "read-outside-workspace": "none" } }),
    enforce: { decision: "allow", names: [], cleared: [RRO] },
  },
  {
    id: "reviewable instruct cleared",
    verdicts: [reviewable(AMEND, "instruct", ["git-history-rewrite"])],
    outcome: semOutcome({ policies: { "git-history-rewrite": "none" } }),
    enforce: { decision: "allow", names: [], cleared: [AMEND] },
  },
  {
    id: "hard instruct is never cleared",
    verdicts: [hard("failproofai/warn-package-publish", "instruct")],
    outcome: semOutcome({ policies: { "external-destructive-action": "none" } }),
    enforce: { decision: "instruct", names: ["failproofai/warn-package-publish"], cleared: [] },
  },
  {
    id: "regex allows, Jev denies → Jev's deny",
    verdicts: [hard("failproofai/block-sudo", "allow", null)],
    outcome: semOutcome({ decision: "deny", reason: "deletes the database", policies: { "destructive-deletion": "deny" } }),
    enforce: { decision: "deny", names: ["semantic/destructive-deletion"], cleared: [], decidedByJev: true },
  },
  {
    id: "regex instruct, Jev deny → Jev's deny (most severe)",
    verdicts: [hard("failproofai/warn-git-stash-drop", "instruct")],
    outcome: semOutcome({ decision: "deny", reason: "rewrites history", policies: { "git-history-rewrite": "deny" } }),
    enforce: { decision: "deny", names: ["semantic/git-history-rewrite"], cleared: [], decidedByJev: true },
  },
  {
    id: "regex instruct + Jev instruct → both, regex first",
    verdicts: [hard("failproofai/warn-git-stash-drop", "instruct")],
    outcome: semOutcome({ decision: "instruct", reason: "touches the system", policies: { "system-modification": "instruct" } }),
    enforce: {
      decision: "instruct",
      names: ["failproofai/warn-git-stash-drop", "semantic/system-modification"],
      cleared: [],
      decidedByJev: false,
    },
  },
  {
    id: "cleared reviewable deny + Jev's own instruct → Jev's instruct",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({
      decision: "instruct",
      reason: "beyond the task",
      policies: { "read-outside-workspace": "none" },
      beyondTask: true,
    }),
    enforce: { decision: "instruct", names: ["semantic/beyond-task"], cleared: [RRO], decidedByJev: true },
  },
  {
    id: "cleared reviewable deny, remaining hard instruct → instruct",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), hard("failproofai/warn-background-process", "instruct")],
    outcome: semOutcome({ policies: { "read-outside-workspace": "none" } }),
    enforce: { decision: "instruct", names: ["failproofai/warn-background-process"], cleared: [RRO] },
  },
  {
    id: "two reviewable denies, one cleared → the other decides",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"]), reviewable(PEV, "deny", ["env-secrets-dump", "secret-exposure"])],
    outcome: semOutcome({ policies: { "read-outside-workspace": "none", "env-secrets-dump": "instruct", "secret-exposure": "none" } }),
    enforce: { decision: "deny", names: [PEV], cleared: [RRO] },
  },
  {
    id: "a hard deny cannot reach combine as answered, but a hard deny verdict is never cleared",
    verdicts: [hard("failproofai/block-sudo", "deny")],
    outcome: semOutcome({ policies: { "privilege-escalation": "none" } }),
    enforce: { decision: "deny", names: ["failproofai/block-sudo"], cleared: [] },
  },
  {
    id: "no semantic policy applied (nothing sent) → nothing cleared",
    verdicts: [reviewable(RRO, "deny", ["read-outside-workspace"])],
    outcome: semOutcome({ via: "none", policies: {} }),
    enforce: { decision: "deny", names: [RRO], cleared: [] },
  },
  {
    id: "allow notes survive clears",
    verdicts: [hard("failproofai/p-note", "allow", "a note"), reviewable(AMEND, "instruct", ["git-history-rewrite"])],
    outcome: semOutcome({ policies: { "git-history-rewrite": "none" } }),
    enforce: { decision: "allow", names: ["failproofai/p-note"], cleared: [AMEND] },
  },
  {
    id: "everything allows",
    verdicts: [hard("failproofai/block-sudo", "allow", null)],
    outcome: semOutcome({ policies: { "privilege-escalation": "none" } }),
    enforce: { decision: "allow", names: [], cleared: [] },
  },
];

const MODES: JevMode[] = ["enforce", "shadow"];
const TRUNCATED: Truncation[] = ["complete", "truncated"];

function reviewFor(row: Row, truncated: Truncation): JevReview {
  if (!row.outcome) return { kind: "not-consulted" };
  return toReview(withTruncation(row.outcome, truncated));
}

describe("combine table (§4) — every row × shadow/enforce × complete/truncated", () => {
  for (const row of ROWS) {
    for (const mode of MODES) {
      for (const truncated of TRUNCATED) {
        it(`${row.id} | ${mode} | ${truncated}`, () => {
          const review = reviewFor(row, truncated);
          const out = combineTwoTier(row.verdicts, review, mode);
          const legacy = regexOnly(row.verdicts);
          const names = out.final.entries.map((e) => e.policyName);

          const hardDecided = row.outcome === null;
          // Truncation is a fallback only for a call Jev was actually sent:
          // with no semantic policy applying nothing is judged, so nothing was
          // judged on a cut envelope (and the answered row clears nothing).
          const nothingSent = row.outcome?.status === "ok" && row.outcome.via === "none";
          const fallback = !hardDecided && (row.fallback !== undefined || (truncated === "truncated" && !nothingSent));
          const answered = !hardDecided && !fallback;

          // What is ENFORCED.
          if (mode === "enforce" && answered) {
            expect(out.final.decision).toBe(row.enforce.decision);
            expect(names).toEqual(row.enforce.names);
            expect(out.decidedByJev).toBe(row.enforce.decidedByJev ?? false);
          } else {
            // shadow, a fallback (degraded or truncated) and a hard deny all
            // enforce exactly what the regex engine says alone.
            expect(out.final).toEqual(legacy);
            expect(out.decidedByJev).toBe(false);
          }

          // What is RECORDED.
          expect(out.activity.jevMode).toBe(mode);
          if (hardDecided) {
            expect(out.activity).toEqual({ evaluator: "jev", jevMode: mode });
            expect(out.cleared).toEqual([]);
          } else if (fallback) {
            expect(out.activity.evaluator).toBe("jev-fallback");
            expect(out.activity.jevFallbackReason).toBe(row.fallback ?? "truncated");
            expect(out.activity.jevCleared).toBeUndefined();
            expect(out.cleared).toEqual([]);
            if (row.fallback === undefined) {
              // Truncated: Jev did answer, and that answer is kept for the record.
              expect(out.activity.jevDecision).toBe(row.outcome!.status === "ok" ? row.outcome!.verdict.decision : undefined);
            } else {
              expect(out.activity.jevDecision).toBeUndefined();
            }
          } else {
            expect(out.activity.evaluator).toBe("jev");
            expect(out.activity.jevFallbackReason).toBeUndefined();
            expect(out.activity.jevDecision).toBe(row.outcome!.status === "ok" ? row.outcome!.verdict.decision : undefined);
            // Shadow records what enforce WOULD have cleared.
            expect(out.cleared).toEqual(row.enforce.cleared);
            expect(out.activity.jevCleared).toEqual(row.enforce.cleared.length > 0 ? row.enforce.cleared : undefined);
          }
        });
      }
    }
  }

  it("covers every documented situation", () => {
    const hardRows = ROWS.filter((r) => r.outcome === null);
    const degradedRows = ROWS.filter((r) => r.fallback !== undefined);
    const answeredRows = ROWS.filter((r) => r.outcome !== null && r.fallback === undefined);
    expect(hardRows.length).toBe(2);
    expect(degradedRows.length).toBe(10);
    expect(answeredRows.length).toBe(24);
    // Every answered row also runs truncated (the truncation → fallback row).
    expect(ROWS.length * MODES.length * TRUNCATED.length).toBe(144);
    // The four degraded causes §10 gate 5 names must each be a row.
    for (const cause of ["timeout", "http-429", "out-of-credits", "model-mismatch"]) {
      expect(degradedRows.map((r) => r.fallback)).toContain(cause);
    }
  });
});

describe("recorded Jev latency and model", () => {
  it("records latency and model when a request was sent", () => {
    const out = combineTwoTier([], toReview(semOutcome({ policies: { "secret-exposure": "none" } })), "enforce");
    expect(out.activity).toMatchObject({ jevLatencyMs: 42, jevModel: "jev-1.13.0" });
  });
  it("records neither when nothing had to be sent", () => {
    const out = combineTwoTier([], toReview(semOutcome({ via: "none" })), "enforce");
    expect(out.activity.jevLatencyMs).toBeUndefined();
    expect(out.activity.jevModel).toBeUndefined();
    expect(out.activity.jevDecision).toBe("allow");
  });
  it("records the latency of a degraded call, never a model", () => {
    const out = combineTwoTier([], toReview(degradedOutcome("timeout")), "enforce");
    expect(out.activity).toEqual({ evaluator: "jev-fallback", jevFallbackReason: "timeout", jevLatencyMs: 1500, jevMode: "enforce" });
  });
});

describe("regexOnly is the pre-two-tier evaluator", () => {
  it("first deny wins over everything after it", () => {
    expect(regexOnly([hard("a", "instruct"), hard("b", "deny"), hard("c", "deny")])).toEqual({
      decision: "deny",
      entries: [{ policyName: "b", reason: "b says deny" }],
    });
  });
  it("otherwise every instruct, in order, notes dropped", () => {
    expect(regexOnly([hard("n", "allow", "note"), hard("a", "instruct"), hard("b", "instruct")]).entries.map((e) => e.policyName)).toEqual([
      "a",
      "b",
    ]);
  });
  it("otherwise the notes; silent allows contribute nothing", () => {
    expect(regexOnly([hard("s", "allow", null), hard("n", "allow", "note")])).toEqual({
      decision: "allow",
      entries: [{ policyName: "n", reason: "note" }],
    });
  });
});

describe("fallbackCode", () => {
  it("keeps stable codes", () => {
    for (const code of ["timeout", "http-429", "model-mismatch", "out-of-credits", "cloudflare-error"]) expect(fallbackCode(code)).toBe(code);
  });
  it("drops any detail after the code", () => {
    expect(fallbackCode("prepare: cannot read /home/x/secret")).toBe("prepare");
    expect(fallbackCode("error: boom")).toBe("error");
  });
  it("never passes through free text", () => {
    expect(fallbackCode("Something Weird Happened")).toBe("error");
    expect(fallbackCode("")).toBe("error");
  });
});

describe("the clear rule, on hand-built reviews", () => {
  const answered = (over: Partial<Extract<JevReview, { kind: "answered" }>> = {}): JevReview => ({
    kind: "answered",
    decision: "allow",
    reason: null,
    policyName: "semantic/jev",
    asked: ["read-outside-workspace"],
    clear: ["read-outside-workspace"],
    injectionAsked: true,
    injected: false,
    latencyMs: 10,
    model: "jev-1.13.0",
    ...over,
  });
  const verdicts = [reviewable(RRO, "deny", ["read-outside-workspace"])];

  it("clears when the reviewer was asked, came back clear, and injection was measured low", () => {
    const out = combineTwoTier(verdicts, answered(), "enforce");
    expect(out.cleared).toEqual([RRO]);
    expect(out.final.decision).toBe("allow");
  });

  it("a reviewer reported clear but NOT asked does not clear", () => {
    const out = combineTwoTier(verdicts, answered({ asked: [] }), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final).toEqual(regexOnly(verdicts));
  });

  it("a reviewer asked but not clear does not clear", () => {
    const out = combineTwoTier(verdicts, answered({ clear: [] }), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final.decision).toBe("deny");
  });

  it("an unasked injection probe withholds every clear", () => {
    const out = combineTwoTier(verdicts, answered({ injectionAsked: false }), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final).toEqual(regexOnly(verdicts));
    expect(out.activity.jevCleared).toBeUndefined();
  });

  it("a held injection probe withholds every clear", () => {
    const out = combineTwoTier(verdicts, answered({ injected: true }), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final.decision).toBe("deny");
  });

  // Round 2: the exported pure function is safe on its own, not only behind
  // authorityOf — a verdict it is handed is cleared only when it is BOTH
  // reviewable AND names at least one reviewer.
  it("a HARD verdict is never cleared, even one that names a reviewer Jev cleared", () => {
    const hardNamed: RegexVerdict = { ...reviewable(RRO, "deny", ["read-outside-workspace"]), authority: "hard" };
    const out = combineTwoTier([hardNamed], answered(), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final).toEqual(regexOnly([hardNamed]));
  });

  it("a reviewable verdict that names NO reviewer is never cleared (every() on nothing is not a clear)", () => {
    const unnamed = reviewable(RRO, "deny", []);
    const out = combineTwoTier([unnamed], answered(), "enforce");
    expect(out.cleared).toEqual([]);
    expect(out.final.decision).toBe("deny");
    const instruct = reviewable(AMEND, "instruct", []);
    expect(combineTwoTier([instruct], answered(), "enforce").cleared).toEqual([]);
  });
});

describe("toReview", () => {
  it("records whether the injection probe was asked", () => {
    const asked = toReview(semOutcome({ injection: 0.1, policies: { "secret-exposure": "none" } }));
    const notAsked = toReview(semOutcome({ injection: null, policies: { "secret-exposure": "none" } }));
    expect(asked).toMatchObject({ kind: "answered", injectionAsked: true, injected: false });
    expect(notAsked).toMatchObject({ kind: "answered", injectionAsked: false, injected: false });
  });

  it("nothing sent → nothing asked, injection included", () => {
    expect(toReview(semOutcome({ via: "none", injection: 0.1 }))).toMatchObject({ asked: [], clear: [], injectionAsked: false });
  });

  it("any truncation of the envelope is a fallback, with Jev's decision kept for the record", () => {
    const out = toReview({ ...semOutcome({ decision: "instruct", policies: { "secret-exposure": "instruct" } }), truncated: true });
    expect(out).toEqual({ kind: "fallback", reason: "truncated", latencyMs: 42, model: "jev-1.13.0", decision: "instruct" });
  });

  it("a truncated envelope that was never SENT is not a fallback: nothing was judged, nothing can clear", () => {
    const out = toReview({ ...semOutcome({ via: "none", policies: {} }), truncated: true });
    expect(out).toMatchObject({ kind: "answered", decision: "allow", asked: [], clear: [], injectionAsked: false, latencyMs: null, model: null });
    // …so the combine records an answered call and enforces the regex result.
    const verdicts = [reviewable(RRO, "deny", ["read-outside-workspace"])];
    const combined = combineTwoTier(verdicts, out, "enforce");
    expect(combined.final).toEqual(regexOnly(verdicts));
    expect(combined.activity.evaluator).toBe("jev");
    expect(combined.activity.jevFallbackReason).toBeUndefined();
  });

  it("injection is held AT the threshold, not only above it", () => {
    const at = DEFAULT_THRESHOLDS_V1.injection;
    expect(toReview(semOutcome({ injection: at, policies: { "secret-exposure": "none" } }))).toMatchObject({ injected: true });
    expect(toReview(semOutcome({ injection: at - 0.001, policies: { "secret-exposure": "none" } }))).toMatchObject({ injected: false });
  });

  it("a cache hit is applied like any answer, but its ~0 ms is not recorded as a latency", () => {
    const outcome = semOutcome({ policies: { "secret-exposure": "none" } });
    expect(toReview(outcome, true)).toMatchObject({ kind: "answered", latencyMs: null, model: "jev-1.13.0", clear: ["secret-exposure"] });
    expect(toReview(outcome)).toMatchObject({ kind: "answered", latencyMs: 42 });
    expect(combineTwoTier([], toReview(outcome, true), "enforce").activity.jevLatencyMs).toBeUndefined();
  });
});
