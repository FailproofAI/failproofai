/**
 * The two-tier combine rules: regex policy verdicts + Jev's review → one
 * final verdict, plus what to record about how it was reached.
 *
 * Pure and synchronous, with type-only imports, so it can sit on the hook path
 * (`policy-evaluator.ts` imports it) without pulling the semantic evaluator
 * into the bundle, and so every row of the table below is testable offline.
 *
 * | Situation                                   | Result                                                        |
 * |---------------------------------------------|---------------------------------------------------------------|
 * | not configured / FAILPROOFAI_EVALUATOR=legacy | `regexOnly` — never reaches this module's `combineTwoTier`  |
 * | any HARD deny                               | the regex result (Jev was aborted, so nothing is cleared)     |
 * | Jev degraded, or its envelope was truncated | the regex result, every deny counts; recorded `jev-fallback`  |
 * | Jev answered                                | reviewable denies/instructs Jev covered are cleared; final =  |
 * |                                             | the most severe of {remaining regex results, Jev's verdict}   |
 *
 * `shadow` mode computes and records all of it, and still returns the regex
 * result.
 *
 * "Jev can only clear what it was actually asked about": a reviewable
 * policy's deny or instruct is cleared only if EVERY semantic policy named in
 * its `reviewedBy` was among the ones put to Jev for this call AND came back
 * `none` or `overridden`. A name Jev was not asked about — its precondition was
 * false, the tool class did not apply, the name is misspelled — keeps the
 * regex verdict standing.
 *
 * Suspected injection withdraws every clear — and so does an injection probe
 * that was never asked. A clear is only as good as the check that the call is
 * not acting on text planted by a repo, a tool result or the agent itself;
 * v1 asks that probe only when a human message was recorded, so a call with
 * no captured intent (the first call of a session, every call on a CLI with
 * no prompt event) clears nothing.
 */
import type { PolicyAuthority } from "../policy-types";

export type Decision = "allow" | "deny" | "instruct";
export type JevMode = "shadow" | "enforce";

/** One regex policy's verdict, in evaluation order. */
export interface RegexVerdict {
  policyName: string;
  decision: Decision;
  /**
   * deny / instruct: the reason exactly as it would be shown (hint appended).
   * allow: the informational note, or null for a silent allow.
   */
  reason: string | null;
  /** EFFECTIVE authority (see `effectiveAuthority`), never the declared one. */
  authority: PolicyAuthority;
  /** The semantic policies that must all come back clear. Empty for `hard`. */
  reviewedBy: readonly string[];
}

/** What Jev said, reduced to exactly what the combine rules read. */
export type JevReview =
  | {
      /** Aborted because a hard deny already decided; Jev's answer was never read. */
      kind: "not-consulted";
    }
  | {
      /** Degraded (timeout, 429, HTTP/parse error, model mismatch, …) or truncated. */
      kind: "fallback";
      reason: string;
      latencyMs: number | null;
      model: string | null;
      /** Set when Jev did answer (a truncated envelope) — recorded, never enforced. */
      decision: Decision | null;
    }
  | {
      kind: "answered";
      decision: Decision;
      reason: string | null;
      /** Attribution for Jev's own deny/instruct, e.g. `semantic/destructive-deletion`. */
      policyName: string;
      /** Semantic policies whose questions were in the request that was answered. */
      asked: readonly string[];
      /** Of `asked`, the ones whose outcome was `none` or `overridden`. */
      clear: readonly string[];
      /**
       * The injection probe was in the request and answered. False → no clear:
       * an unmeasured injection is not an absent one.
       */
      injectionAsked: boolean;
      /** The injection probe held: every clear is withdrawn. */
      injected: boolean;
      /**
       * Null when nothing had to be sent (no semantic policy applied), or when
       * the answer came from the throttle's cache: a hit's ~0 ms is not a
       * provider latency.
       */
      latencyMs: number | null;
      model: string | null;
    };

/**
 * What `evaluatePolicies` receives when the two-tier path is on: an in-flight
 * Jev review (started before the regex policies run) and how to read each
 * registered policy's effective authority. Built by `jev-review.ts`.
 */
export interface TwoTierReview {
  mode: JevMode;
  /** Resolves once Jev answered, failed, or was aborted. Never rejects. */
  review: Promise<JevReview>;
  /** Abort the in-flight request (a hard deny decided). No-op once settled. */
  abort(): void;
  /**
   * Called once, right before the evaluator awaits `review` — by then every
   * read of the process-global policy registry for this call is done. The
   * daemon's warm worker serializes requests around that registry, and uses
   * this to let the next queued request run while this one waits on the
   * network instead of holding every hook on the machine behind it.
   */
  releaseRegistry?: () => void;
  /** Effective authority + the reviewing semantic policies (empty unless reviewable). */
  authorityOf(p: { name: string; authority?: PolicyAuthority; reviewedBy?: string[] }): {
    authority: PolicyAuthority;
    reviewedBy: string[];
  };
}

export interface FinalVerdict {
  decision: Decision;
  /** deny: exactly the one decider; instruct: every instruct; allow: every note. */
  entries: Array<{ policyName: string; reason: string }>;
}

/** The hook-activity fields (§7 contract) for one two-tier evaluation. */
export interface JevActivityFields {
  evaluator: "jev" | "jev-fallback";
  jevDecision?: Decision;
  jevCleared?: string[];
  jevFallbackReason?: string;
  jevLatencyMs?: number;
  jevModel?: string;
  jevMode: JevMode;
}

export interface CombineOutcome {
  final: FinalVerdict;
  /** Reviewable regex policies Jev cleared (in shadow: would have cleared). */
  cleared: string[];
  /** True when the first entry of `final` is Jev's own verdict. */
  decidedByJev: boolean;
  activity: JevActivityFields;
}

/**
 * The regex engine's answer on its own — exactly what `evaluatePolicies`
 * returned before two tiers existed: the first deny in evaluation order wins;
 * otherwise every instruct, joined; otherwise every allow that carried a note.
 */
export function regexOnly(verdicts: readonly RegexVerdict[]): FinalVerdict {
  const deny = verdicts.find((v) => v.decision === "deny");
  if (deny) return { decision: "deny", entries: [{ policyName: deny.policyName, reason: deny.reason ?? "" }] };
  const instructs = verdicts.filter((v) => v.decision === "instruct");
  if (instructs.length > 0) {
    return { decision: "instruct", entries: instructs.map((v) => ({ policyName: v.policyName, reason: v.reason ?? "" })) };
  }
  return {
    decision: "allow",
    entries: verdicts
      .filter((v) => v.decision === "allow" && v.reason)
      .map((v) => ({ policyName: v.policyName, reason: v.reason as string })),
  };
}

/** Whether Jev's answer clears this regex verdict. */
function clears(v: RegexVerdict, asked: ReadonlySet<string>, clear: ReadonlySet<string>): boolean {
  if (v.decision === "allow" || v.authority !== "reviewable") return false;
  if (v.reviewedBy.length === 0) return false;
  return v.reviewedBy.every((name) => asked.has(name) && clear.has(name));
}

export function combineTwoTier(
  verdicts: readonly RegexVerdict[],
  review: JevReview,
  mode: JevMode,
): CombineOutcome {
  const legacy = regexOnly(verdicts);

  if (review.kind === "not-consulted") {
    // A hard deny decided. Nothing was asked, so nothing is cleared, and the
    // regex result is final — byte for byte what the regex engine says alone.
    return { final: legacy, cleared: [], decidedByJev: false, activity: { evaluator: "jev", jevMode: mode } };
  }

  if (review.kind === "fallback") {
    return {
      final: legacy,
      cleared: [],
      decidedByJev: false,
      activity: {
        evaluator: "jev-fallback",
        ...(review.decision ? { jevDecision: review.decision } : {}),
        jevFallbackReason: review.reason,
        ...(review.latencyMs !== null ? { jevLatencyMs: review.latencyMs } : {}),
        ...(review.model ? { jevModel: review.model } : {}),
        jevMode: mode,
      },
    };
  }

  const asked = new Set(review.asked);
  const clearSet = new Set(review.clear);
  const cleared =
    review.injected || !review.injectionAsked
      ? []
      : verdicts.filter((v) => clears(v, asked, clearSet)).map((v) => v.policyName);
  const activity: JevActivityFields = {
    evaluator: "jev",
    jevDecision: review.decision,
    ...(cleared.length > 0 ? { jevCleared: cleared } : {}),
    ...(review.latencyMs !== null ? { jevLatencyMs: review.latencyMs } : {}),
    ...(review.model ? { jevModel: review.model } : {}),
    jevMode: mode,
  };

  if (mode === "shadow") return { final: legacy, cleared, decidedByJev: false, activity };

  const clearedSet = new Set(cleared);
  const remaining = verdicts.filter((v) => !clearedSet.has(v.policyName));
  const jevEntry = { policyName: review.policyName, reason: review.reason ?? `Flagged by semantic review (${review.policyName})` };

  // Most severe wins; within a severity, the regex engine's own order first.
  const regexDeny = remaining.find((v) => v.decision === "deny");
  if (regexDeny) {
    return {
      final: { decision: "deny", entries: [{ policyName: regexDeny.policyName, reason: regexDeny.reason ?? "" }] },
      cleared,
      decidedByJev: false,
      activity,
    };
  }
  if (review.decision === "deny") {
    return { final: { decision: "deny", entries: [jevEntry] }, cleared, decidedByJev: true, activity };
  }
  const instructs = remaining
    .filter((v) => v.decision === "instruct")
    .map((v) => ({ policyName: v.policyName, reason: v.reason ?? "" }));
  if (review.decision === "instruct") instructs.push(jevEntry);
  if (instructs.length > 0) {
    return {
      final: { decision: "instruct", entries: instructs },
      cleared,
      decidedByJev: instructs[0] === jevEntry,
      activity,
    };
  }
  return { final: regexOnly(remaining), cleared, decidedByJev: false, activity };
}
