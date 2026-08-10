/**
 * The first (and only) TypeScript reader of `~/.failproofai/state/audit-schedule.json`.
 *
 * The **daemon is the sole writer** of that file (`crates/failproofaid/src/
 * audit_lane.rs`); everything on this side only reads it. This module is that
 * read side: `getScheduledAuditAction` calls it to answer "when did the last
 * scheduled scan run, and when is the next one due?" on the /settings page.
 *
 * ## Why this tolerates a file it did not write
 *
 * The daemon and the CLI ship and upgrade independently — a machine can be
 * running a newer `failproofaid` than its `failproofai`, so the schedule file
 * on disk can be a schema *ahead* of this build. A settings page that threw, or
 * blanked its whole scheduled-audit section, because one derived state file was
 * a version in front would be strictly worse than showing slightly less. So we
 * read every field **by name, independent of `schema`**: a future file that
 * still carries `next_due_at_ms` still renders a next-due time. Absent,
 * unreadable, malformed, and non-object all resolve to `null` (the caller shows
 * "no scheduled scan yet"); a recognised-but-unknown-higher schema still yields
 * whatever numeric fields it shares, plus `schemaAhead` so the UI can say "a
 * newer daemon wrote this" rather than silently dropping a field.
 *
 * ## What happened to `next-audit.json` — the one open sub-decision (resolved)
 *
 * `~/.failproofai/next-audit.json` (`lib/auth/auth-store.ts`
 * `readReminder`/`writeReminder`) predates the scheduler and looks like a second
 * source of truth for "the next audit". It is **not**, and after this change
 * there is exactly one answer to "when does the next *scan* run": this file's
 * `next_due_at_ms`. The two are kept **separate with deliberately distinct
 * meanings**, because they answer different questions:
 *
 *   - `audit-schedule.json` (here) = when the machine will next **run a scan
 *     itself**, headless, via the daemon. This is the scan schedule. It needs
 *     no human and no sign-in. `[audit] auto` + `interval_days` in `config.toml`
 *     drive it; the daemon derives and writes this file.
 *   - `next-audit.json` = an **email nudge to a signed-in human** ("come back
 *     and audit again"), set from the /audit "come back better" section,
 *     delivered by Failproof Cloud over SES via the api-server. It runs nothing
 *     locally; it is re-engagement, not a schedule.
 *
 * Collapsing them would merge "the box scans on a timer" with "email this person
 * a reminder", which are neither the same trigger, the same actor, nor the same
 * effect. So the /settings scheduled-audit section reads and writes **only** the
 * scan schedule (this file + `[audit]`) and never touches `next-audit.json`,
 * leaving the reminder as the /audit page's own concern. That keeps the scan
 * schedule single-writer (the daemon) and single-file, which is the property the
 * two-sources-of-truth worry was really about.
 */
import { readFileSync } from "node:fs";
import { auditScheduleFile } from "../hooks/fp-home";

/**
 * The schema the daemon currently writes — mirrors `SCHEMA` in
 * `crates/failproofaid/src/audit_lane.rs`. Only used to *flag* a file that
 * declares a higher one (`schemaAhead`); reads never gate on it, on purpose.
 */
export const AUDIT_SCHEDULE_SCHEMA = 1;

export interface AuditScheduleView {
  /** The `schema` the file declared, or null if absent/non-numeric. */
  schema: number | null;
  /** Absolute wall-clock ms of the next scheduled scan, or null. */
  nextDueAtMs: number | null;
  /** When a scan was last STARTED (written before the child spawns), or null. */
  lastAttemptAtMs: number | null;
  /** When a scan last finished successfully (never advanced by an exit-75
   *  "lock held"), or null. */
  lastRunAtMs: number | null;
  /** The scheduled child's last exit code, or null. */
  lastExitCode: number | null;
  /** The file declares a schema newer than this build knows. Fields are still
   *  read best-effort; this only tells the UI to caveat what it shows. */
  schemaAhead: boolean;
}

/**
 * Read the scheduled-audit state, or null when there is nothing usable to show.
 *
 * Never throws: every failure mode (absent file, EACCES, truncated write,
 * non-JSON, JSON that is not an object) collapses to null, which the caller
 * renders as "no scheduled scan has run yet".
 */
export function readAuditSchedule(home?: string): AuditScheduleView | null {
  let raw: string;
  try {
    raw = readFileSync(auditScheduleFile(home), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const schema = num(obj.schema);
  return {
    schema,
    nextDueAtMs: num(obj.next_due_at_ms),
    lastAttemptAtMs: num(obj.last_attempt_at_ms),
    lastRunAtMs: num(obj.last_run_at_ms),
    lastExitCode: num(obj.last_exit_code),
    schemaAhead: schema !== null && schema > AUDIT_SCHEDULE_SCHEMA,
  };
}
