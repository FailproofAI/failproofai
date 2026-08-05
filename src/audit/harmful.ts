/**
 * What counts as HARMFUL — the one predicate `risks` mode is built on.
 *
 * The scheduled audit reports a machine to the cloud only when it found
 * something harmful, and the cloud mails a human only about harmful findings.
 * Two places asking that question two different ways is how a product ends up
 * mailing someone about a row the report calls benign, or staying silent about
 * one it calls dangerous — so the question is asked exactly once, here, and
 * both the wire projection (`machine-scan-payload.ts`) and any renderer read
 * the answer from this module rather than re-deriving it.
 *
 * # It invents no severity scheme
 *
 * Everything below is the audit's OWN existing model, read rather than
 * replaced:
 *
 *   - `severityForBuiltin()` (features.ts) already derives a builtin's severity
 *     from its name prefix — `block-*` → `deny`, `warn-`/`protect-`/`prefer-`/
 *     `require-*` → `warn`, `sanitize-*` → `sanitize`. `deny` is the tier that
 *     means "this policy would have STOPPED the call", which is exactly the set
 *     worth waking somebody up about.
 *   - Audit-only detectors carry a hand-authored `category`, and the catalog
 *     splits them `Risky` vs `Wasteful`. Wasteful is money and tokens; Risky is
 *     `git commit --no-verify` and `find /`. Only Risky qualifies.
 *   - `enabledInConfig` is the report's existing "already protected" vs
 *     "slipping through" split, and it is a gate here too — see below.
 *
 * # Why `enabledInConfig` suppresses a finding
 *
 * A hit means the policy WOULD have fired on that historical event. If the user
 * already has it enabled, it is firing now, and the exposure the email would
 * describe is one the machine already closed — a weekly "your agent tried to
 * force-push (and failproofai stopped it)" is a proof-of-life digest, which
 * section 6 explicitly ruled out. Audit-only detectors are always
 * `enabledInConfig: false` (they have no runtime enforcement path today), so
 * this gate only ever moves builtins.
 *
 * # Why the returned severity is not the row's own
 *
 * The server classifies harmfulness from the `severity` string it receives, and
 * its harmful set is `deny | critical | high`. A `Risky` detector's own
 * severity is `warn`, which the server would read as benign — so it would be
 * stored, never mailed, and this module and the server would quietly disagree
 * about the one thing they both exist to decide. Returning the wire severity
 * from the SAME call that decides harmfulness is what makes that impossible:
 * there is no path that classifies a row harmful and then labels it something
 * the server will ignore.
 */
import { severityForBuiltin } from "./features";
import type { AuditCount, AuditResult } from "./types";

/**
 * The severities the server treats as harmful, minus the ones this side never
 * produces. Mirrors `HARMFUL_SEVERITIES` in agenteye's `machine_scans` module
 * (`["deny", "critical", "high"]`); we emit only two of the three, and a test
 * pins that every value `harmfulSeverity()` can return is in that set. If the
 * server's list ever narrows, this constant is what has to move with it.
 */
export const HARMFUL_WIRE_SEVERITIES = ["deny", "high"] as const;

export type HarmfulSeverity = (typeof HARMFUL_WIRE_SEVERITIES)[number];

/** The detector category that means "this is a risk", not "this is waste". */
export const RISKY_DETECTOR_CATEGORY = "Risky";

/**
 * The wire severity for a harmful row, or `null` when the row is not harmful.
 *
 * One function rather than a boolean plus a lookup, so the caller cannot label
 * a row with a severity that disagrees with the decision to send it at all.
 */
export function harmfulSeverity(row: AuditCount): HarmfulSeverity | null {
  // A zero-hit row is a row the audit kept for display, not a finding. It would
  // also fail the server's `hits >= 1` bound and 422 the whole scan.
  if (!Number.isFinite(row.hits) || row.hits < 1) return null;

  // Already enforcing ⇒ already closed. See the module header.
  if (row.enabledInConfig) return null;

  if (row.source === "builtin") {
    // Derived from the rule identity rather than read off `row.severity`, so
    // the predicate is a pure function of WHICH policy fired. `index.ts` fills
    // `row.severity` from this same call today, but a hand-built row (a cached
    // result from an older build, a fixture) can carry anything, and a
    // mislabelled row must not be able to talk its way into an email.
    return severityForBuiltin(row.name) === "deny" ? "deny" : null;
  }

  if (row.source === "audit-detector") {
    return row.category === RISKY_DETECTOR_CATEGORY ? "high" : null;
  }

  // An unrecognised source — a shape from a newer audit than this code. Not
  // harmful, deliberately: a quiet week is cheaper than mailing a customer
  // about a row we cannot explain, and it is the same direction the server
  // takes with an unknown severity.
  return null;
}

/** True when the row is something a human should be told about. */
export function isHarmful(row: AuditCount): boolean {
  return harmfulSeverity(row) !== null;
}

/** Every harmful row in a completed audit, in the order the audit ranked them
 *  (`runAudit` sorts by hits, descending). */
export function harmfulFindings(result: AuditResult): AuditCount[] {
  return (result.results ?? []).filter(isHarmful);
}

/** Whether this scan found anything worth reporting at all. The gate that
 *  makes `risks` mode silent on a clean week. */
export function hasHarmfulFindings(result: AuditResult): boolean {
  return (result.results ?? []).some(isHarmful);
}
