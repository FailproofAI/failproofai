/**
 * Score derivation for the audit dashboard.
 *
 * ## SWITCHED OFF — nothing in the product calls any of this (2026-09-07)
 *
 * Every function below is intact and still covered by
 * `__tests__/audit/scoring.test.ts`, deliberately: the score is commented out at
 * its call sites, not deleted, so restoring it is un-commenting rather than
 * rewriting. The call sites, all commented and cross-referenced back to here:
 * `audit-dashboard.tsx` (the four `useMemo`s, the poster/how-to-improve/
 * come-back-better props, and the `score`/`grade` PostHog properties),
 * `audit-poster.tsx` (the `.poster-score` block, the PNG filename, the share
 * payload), `how-to-improve-section.tsx` (the projected sub-heading),
 * `share-templates.ts` (19 of 20 templates interpolated the number).
 *
 * ### Why
 *
 * Two reasons, one product and one correctness.
 *
 * The product reason is the owner's: the audit tried to do too many things
 * shallowly, and grading a machine 0-100 with a letter tier was not the half
 * worth keeping.
 *
 * The correctness reason is worse and is the one to read before switching it
 * back on. **`deriveScore` never reads `enabledInConfig`** — only
 * `projectedScore` does, at the filter below. So the number the dashboard
 * rendered as "enable all N → projected {score}" was undeliverable by
 * construction: a user who took the prescription, enabled the policies and
 * re-ran got the SAME score with the projection gone. Advertised up to +22,
 * delivered 0. There is also no time window, so a hit denied today is counted
 * against the machine forever.
 *
 * Two further things measured at the same time, neither of them the score's
 * fault but both worth knowing if this comes back:
 *
 *  - `penaltyFor` consumes `row.hits`, i.e. OCCURRENCES. Occurrences amplify
 *    against distinct values by 10.7x-41x and non-uniformly by class, so the
 *    sum does not preserve rank order between classes. Fixing that needs a
 *    per-distinct-value carrier, which `AuditCount` does not have.
 *  - `syntheticRank`, `scoreToPercentile` and `COHORT_SIZE` had already lost
 *    their last caller before this change — the cohort they describe does not
 *    exist. They are dead either way.
 *
 * ### To restore
 *
 * Un-comment the call sites listed above (each carries its original inline) and
 * put the score-bearing share copy back from the block at the bottom of
 * `share-templates.ts`. Make `score`/`grade` required again in `ShareCtx` and in
 * `audit-poster.tsx`'s `Props`, and the compiler will walk you through the rest.
 * Fix the `enabledInConfig` defect first, or it will be advertising the same
 * undeliverable number.
 *
 * Score is on 0-100, mapped to letter grades that anchor the leaderboard
 * + tier prose. The thresholds match the reference design (assets/audit):
 *
 *     ≥ 90  S    "s tier"
 *     ≥ 80  A    "a tier"
 *     ≥ 71  B    "b tier"
 *     ≥ 55  C    "c tier"
 *     ≥ 40  D    "d tier"
 *     <  40 F    "f tier"
 *
 * The "projected score" is the hypothetical score after enabling every
 * recommended unenabled-builtin policy — used by the prescription section
 * to motivate enabling them.
 */
import type { AuditResult } from "./types";

export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export function gradeFor(score: number): Grade {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 71) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const TIER_NAME: Record<Grade, string> = {
  S: "s tier", A: "a tier", B: "b tier",
  C: "c tier", D: "d tier", F: "f tier",
};

export function tierName(g: Grade): string {
  return TIER_NAME[g];
}

/**
 * Heuristic score on 0-100. Three properties make it *dynamic* — distinct
 * inputs (almost) never collide on a fixed threshold the way the old
 * hard-capped scorer did:
 *
 *   1. Rate-normalised. Penalty scales with the *rate* of weighted faults per
 *      tool call (× REF_EVENTS), not the absolute count. A 1000-call session
 *      with 25 denies scores higher than a 100-call one with 25 denies — and
 *      heavy users no longer all pile onto the same cap.
 *
 *   2. Saturating, not clipped. Each severity bucket asymptotes to a cap via
 *      `cap·(1 − e^(−p/k))` instead of `min(p, cap)`. One bad area still can't
 *      tank the score, but the curve is *strictly monotonic*, so every extra
 *      hit still moves the number — no two counts land on the same value.
 *
 *   3. Credited. Up to +5 from the derived strengths, so clean agents spread
 *      upward instead of all sitting at 100.
 *
 * Per-hit weights (pre-normalisation): deny 1.2, warn/instruct 0.7,
 * sanitize 0.4, audit detector 0.5. Bucket caps 50 / 28 / 16 / 30 (they sum
 * past 100 so a multi-dimension reckless agent can bottom out at F).
 *
 * Sessions with zero scanned transcripts return 0 (no signal, no grade).
 */
import { MIN_EVENTS } from "./features";
import { deriveStrengths } from "./strengths";

/** Reference tool-call volume the rate is normalised against — chosen so a
 *  moderate footprint lands around C/B and the demo anchor (~58 → C) holds.
 *  Calibrated via __tests__/audit/scoring.test.ts. */
const REF_EVENTS = 300;

/** Concave saturator: → `cap` as `p → ∞`, strictly increasing for all p ≥ 0. */
function saturate(p: number, cap: number, k: number): number {
  return cap * (1 - Math.exp(-p / k));
}

/** Total weighted penalty for a set of rows, rate-normalised against `events`.
 *  Shared by `deriveScore` and `projectedScore` so they can't diverge. */
function penaltyFor(rows: AuditResult["results"], events: number): number {
  const norm = REF_EVENTS / Math.max(events, MIN_EVENTS);
  let deny = 0, instruct = 0, sanitize = 0, detector = 0;
  for (const row of rows) {
    if (row.source === "audit-detector") {
      detector += row.hits * 0.5;
      continue;
    }
    const sev = row.severity;
    if (sev === "deny") deny += row.hits * 1.2;
    else if (sev === "instruct" || sev === "warn") instruct += row.hits * 0.7;
    else sanitize += row.hits * 0.4; // sanitize-* and any other gentle category
  }
  // Per-bucket (cap, k). The cap bounds any single failure mode; k sets how
  // fast it ramps. k is small relative to the cap so penalties bite early and
  // the score uses the full S→F range rather than clustering near 100. Caps
  // sum past 100 on purpose, so a multi-dimension reckless agent can reach F.
  return (
    saturate(deny * norm, 50, 12) +
    saturate(instruct * norm, 28, 10) +
    saturate(sanitize * norm, 16, 8) +
    saturate(detector * norm, 30, 14)
  );
}

/** Positive credit (0-5) from the heuristic strengths. Deliberately small so a
 *  reckless agent's "absence" strengths (e.g. "no credential leaks") can't
 *  inflate it back into the top tier. */
function creditFor(result: AuditResult): number {
  return Math.min(deriveStrengths(result).length * 1.0, 5);
}

/** Exact (unrounded) score — used by tests to prove strict monotonicity and
 *  the absence of threshold collisions. */
export function deriveScoreExact(result: AuditResult): number {
  if (result.transcripts.scanned === 0) return 0;
  const events = result.eventsScanned ?? 0;
  const score = 100 - penaltyFor(result.results, events) + creditFor(result);
  return Math.max(0, Math.min(100, score));
}

export function deriveScore(result: AuditResult): number {
  return Math.round(deriveScoreExact(result));
}

/**
 * Projected score after enabling every unenabled builtin. Doesn't actually
 * re-run the audit — instead it credits back the hits the user would have
 * blocked by enabling those policies, applying the same weighted penalty
 * scheme used by `deriveScore`.
 *
 * Caps at 92 so the prescription never promises a guaranteed S — the user
 * still has to keep the policies on.
 */
export function projectedScore(result: AuditResult, currentScore: number): number {
  const events = result.eventsScanned ?? 0;
  // Penalty as-is vs. penalty with every unenabled builtin's hits removed
  // (enabling those policies would have blocked them). The delta is what the
  // user recovers — computed through the same saturating, rate-normalised
  // curve as `deriveScore`, so the projection is consistent rather than a
  // naive per-hit sum.
  const full = penaltyFor(result.results, events);
  const fixedRows = result.results.filter(
    (r) => !(r.source === "builtin" && !r.enabledInConfig),
  );
  const fixed = penaltyFor(fixedRows, events);
  const recoverable = Math.max(0, full - fixed);
  // Cap at 92 so the prescription never promises a guaranteed S.
  const proj = Math.min(92, currentScore + Math.round(recoverable));
  return Math.max(currentScore, proj);
}

/**
 * Approximate global rank in the cohort. We don't have a real leaderboard
 * yet — this is a deterministic synthetic rank derived from the score so
 * the UI doesn't feel jittery as the user re-runs.
 *
 * Distribution roughly matches a bell-shape centered at 60. Cohort size
 * is fixed at 2316 to match the reference design.
 */
export const COHORT_SIZE = 2316;

export function syntheticRank(score: number): number {
  // Roughly: 100 → top of leaderboard, 0 → bottom. Use a smooth curve so
  // small score changes feel meaningful but not catastrophic.
  const percentile = scoreToPercentile(score);
  return Math.max(1, Math.min(COHORT_SIZE, Math.round((1 - percentile) * COHORT_SIZE)));
}

function scoreToPercentile(score: number): number {
  // Logistic mapping centered at 58 — agents below 58 fall into the long
  // tail, agents above climb steeply. Anchors the default demo (58 → ~p20).
  const z = (score - 58) / 14;
  const p = 1 / (1 + Math.exp(-z));
  return p;
}
