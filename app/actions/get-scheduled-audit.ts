"use server";

/**
 * Read side of the /settings "Scheduled audit" section. Reads only — the write
 * counterparts live in `update-scheduled-audit.ts`, mirroring the
 * get-hooks-config / update-hooks-config split.
 *
 * ## CLI ⟷ dashboard parity (state it here so the two cannot silently diverge)
 *
 * Every field this returns is the same `config.toml` / state the CLI reads:
 *   - `auto`         ⟷ `config.toml [audit] auto`         (readConfig / updateConfig;
 *                       the same key the `failproofai config` wizard sets)
 *   - `intervalDays` ⟷ `config.toml [audit] interval_days` (readConfig owns the
 *                       1..90 clamp — see fp-config.readIntervalDays)
 *   - `daemon`       ⟷ `systemctl status failproofaid@<user>` (daemonServiceStatus)
 *   - `schedule`     ⟷ `state/audit-schedule.json` (daemon-written; readAuditSchedule)
 * There is no bespoke dashboard storage here: writing goes through the exact
 * same `updateConfig` the CLI uses, so a value set on either side is identical.
 */

import { readConfig } from "@/src/hooks/fp-config";
import { readAuditSchedule } from "@/src/audit/audit-schedule";
import { daemonServiceStatus, type DaemonServiceStatus } from "@/src/hooks/daemon-service";
import { readDashboardCacheMeta } from "@/src/audit/dashboard-cache";

export interface ScheduledAuditSchedule {
  nextDueAtMs: number | null;
  lastAttemptAtMs: number | null;
  lastRunAtMs: number | null;
  lastExitCode: number | null;
  schemaAhead: boolean;
}

export interface ScheduledAuditView {
  /** `[audit] auto` — whether the daemon scans on a timer. */
  auto: boolean;
  /** `[audit] interval_days`, already clamped to 1..90 by readConfig. */
  intervalDays: number;
  /** The systemd/launchd service state. The scheduler cannot run without a
   *  running daemon, so a settings page that hides this reads "on but silent". */
  daemon: DaemonServiceStatus;
  /** The daemon's persisted schedule, or null when no scheduled scan has run. */
  schedule: ScheduledAuditSchedule | null;
  /** ISO time of the most recent audit RESULT on disk (scheduled OR manual),
   *  or null if no audit has ever produced a dashboard. Distinct from
   *  `schedule.lastRunAtMs`, which is scheduled runs only. */
  lastResultAt: string | null;
}

export async function getScheduledAuditAction(): Promise<ScheduledAuditView> {
  const config = readConfig();
  const schedule = readAuditSchedule();
  const meta = readDashboardCacheMeta();

  return {
    auto: config.audit.auto,
    intervalDays: config.audit.intervalDays,
    daemon: daemonServiceStatus(),
    schedule: schedule
      ? {
          nextDueAtMs: schedule.nextDueAtMs,
          lastAttemptAtMs: schedule.lastAttemptAtMs,
          lastRunAtMs: schedule.lastRunAtMs,
          lastExitCode: schedule.lastExitCode,
          schemaAhead: schedule.schemaAhead,
        }
      : null,
    lastResultAt: meta?.cachedAt ?? null,
  };
}
