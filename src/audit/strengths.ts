/**
 * Derive the StrengthsSection rows from a live AuditResult.
 *
 * The reference (assets/audit/audit.jsx) ships 5 hand-curated strengths
 * with placeholder numbers. Here we compute each one off the actual
 * scanned data. Output shape mirrors the original.
 *
 * Most strengths are "absences" — the cleaner the agent, the more
 * strengths we surface (e.g. "0 credential leaks" only counts as a
 * strength when no sanitize-* policies fired).
 */
import type { AuditResult } from "./types";

export interface Strength {
  metric: string;
  unit: string;
  headline: string;
  detail: string;
}

function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function hitsForShort(result: AuditResult, names: string[]): number {
  const set = new Set(names);
  let total = 0;
  for (const r of result.results) {
    if (set.has(shortName(r.name))) total += r.hits;
  }
  return total;
}

/** Pick up to 5 derived strengths. Each strength has a true-or-not test —
 *  only included when the agent actually demonstrates the behavior. */
export function deriveStrengths(result: AuditResult): Strength[] {
  const out: Strength[] = [];
  const events = result.eventsScanned ?? 0;
  const totalHits = result.totals.hits;
  const detectorsTriggered = result.results.filter((r) => r.source === "audit-detector").length;
  const cleanRate = events > 0 ? Math.max(0, Math.min(100, Math.round(((events - totalHits) / events) * 100))) : 100;

  // 1. Always show the "X tool calls, Y detectors triggered" headline.
  if (events > 0) {
    out.push({
      metric: `${cleanRate}%`,
      unit: "clean tool calls",
      headline: `ran ${events.toLocaleString()} tool calls. ${detectorsTriggered} detector${detectorsTriggered === 1 ? "" : "s"} triggered.`,
      detail: `${cleanRate}% of tool calls came back clean before today's audit.`,
    });
  }

  // 2. Zero credential exposure to stdout — only when no sanitize-* and no
  //    block-env-files / block-secrets-write / block-read-outside-cwd hits.
  const credentialPolicies = [
    "sanitize-api-keys", "sanitize-jwt", "sanitize-connection-strings",
    "sanitize-private-key-content", "sanitize-bearer-tokens",
    "block-env-files", "block-secrets-write", "block-read-outside-cwd",
    "protect-env-vars", "block-secret-in-write", "block-credential-files",
  ];
  if (hitsForShort(result, credentialPolicies) === 0) {
    out.push({
      metric: "0",
      unit: "credential leaks",
      headline: "zero credential exposure to stdout.",
      detail: "no env files, secret writes, or sanitize hits across the audit window.",
    });
  }

  // 3. Average sessions task length — `events / sessions`. Faster than
  //    median (50) is celebrated; slower than it is mentioned in findings.
  if (result.transcripts.scanned > 0 && events > 0) {
    const avgTurns = Math.max(1, Math.round(events / result.transcripts.scanned));
    if (avgTurns < 30) {
      out.push({
        metric: String(avgTurns),
        unit: "avg turns / session",
        headline: `sessions complete in ${avgTurns} turns on average.`,
        detail: avgTurns < 15
          ? "faster than the median agent in this cohort."
          : "comfortably within the typical session length envelope.",
      });
    }
  }

  // 4. No retry storms — `warn-repeated-tool-calls` + `sleep-polling-loop`
  //    are both quiet.
  const retryHits = hitsForShort(result, ["warn-repeated-tool-calls", "sleep-polling-loop"]);
  if (retryHits === 0) {
    out.push({
      metric: "0",
      unit: "retry storms",
      headline: "no retry storms or polling loops detected.",
      detail: "failed calls were diagnosed or moved on from. no six-times-in-a-row spirals.",
    });
  }

  // 5. No production-shape git mistakes.
  const gitHits = hitsForShort(result, [
    "block-push-master", "block-force-push", "block-work-on-main",
    "git-commit-no-verify",
  ]);
  if (gitHits === 0) {
    out.push({
      metric: "0",
      unit: "push-to-main attempts",
      headline: "kept changes off main without prompting.",
      detail: "no direct pushes, force pushes, or hook bypasses across every session.",
    });
  }

  // 6. No double-writes / re-reads — agent is efficient with edits.
  const wastefulEdits = hitsForShort(result, [
    "reread-after-edit", "prefer-edit-over-sed-awk", "prefer-write-over-heredoc",
  ]);
  if (wastefulEdits === 0 && events > 0) {
    out.push({
      metric: "0",
      unit: "double-writes",
      headline: "no double-writes across production projects.",
      detail: "the agent never re-read a file it had just edited, or rewrote via shell.",
    });
  }

  // Cap to 5. If we somehow have <2 strengths, surface a generic "no
  // findings in this category" so the section never looks empty.
  if (out.length < 2) {
    out.push({
      metric: "—",
      unit: "audit window",
      headline: "audit complete.",
      detail: `${result.transcripts.scanned} session${result.transcripts.scanned === 1 ? "" : "s"} scanned across ${result.totals.projectsWithHits} project${result.totals.projectsWithHits === 1 ? "" : "s"}.`,
    });
  }

  return out.slice(0, 5);
}
