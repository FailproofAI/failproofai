"use server";

/**
 * Read side of the /settings "Scheduled audit" section. Reads only — the write
 * counterparts live in `update-scheduled-audit.ts`, mirroring the
 * get-hooks-config / update-hooks-config split.
 *
 * ## CLI ⟷ dashboard parity (state it here so the two cannot silently diverge)
 *
 * Every field this returns is the same `config.toml` / state the CLI reads:
 *   - `auto`         ⟷ `config.json [audit] auto` (readConfig / updateConfig —
 *                       the same call `failproofai audit --schedule` makes, so
 *                       the two cannot diverge)
 *   - `intervalDays` ⟷ `config.json [audit] interval_days` (readConfig owns the
 *                       1..90 clamp — see fp-config.readIntervalDays)
 *   - `daemon`       ⟷ `systemctl status failproofaid@<user>` (daemonServiceStatus)
 *   - `schedule`     ⟷ `audit/schedule.json` (daemon-written; readAuditSchedule)
 *   - `lastScan`     ⟷ `audit/audit-dashboard.json` (the same result /audit renders)
 * There is no bespoke dashboard storage here: writing goes through the exact
 * same `updateConfig` the CLI uses, so a value set on either side is identical.
 */

import { readConfig } from "@/src/hooks/fp-config";
import { readAuditSchedule } from "@/src/audit/audit-schedule";
import {
  daemonServiceStatus,
  daemonStartedAtMs,
  type DaemonServiceStatus,
} from "@/src/hooks/daemon-service";
import { readDashboardCacheMeta } from "@/src/audit/dashboard-cache";
import { readAuth } from "@/lib/auth/auth-store";

export interface ScheduledAuditSchedule {
  nextDueAtMs: number | null;
  lastAttemptAtMs: number | null;
  lastRunAtMs: number | null;
  lastExitCode: number | null;
  schemaAhead: boolean;
}

/**
 * What the most recent audit on this machine found — scheduled OR manual.
 *
 * Read past the dashboard cache's TTL on purpose (see
 * `readDashboardCacheMeta`): this stat's whole subject is how long ago the scan
 * was, so dropping it for being old would blank the one cell that exists to say
 * so. Counts are the same fields /audit renders, never recomputed here.
 */
export interface ScheduledAuditLastScan {
  finishedAt: string;
  /** Total policy hits. Null means the cached result was unreadable — a
   *  different claim from 0, which means the scan found nothing. */
  findings: number | null;
  sessionsScanned: number | null;
  eventsScanned: number | null;
}

export interface ScheduledAuditView {
  /** `[audit] auto` — whether the daemon scans on a timer. */
  auto: boolean;
  /** `[audit] interval_days`, already clamped to 1..90 by readConfig. */
  intervalDays: number;
  /**
   * Who this machine would mail, or null when signed out.
   *
   * Read from the local session file rather than round-tripped to the
   * api-server: the file is the source of truth for who is signed in on this
   * machine, and a settings panel that went blank because the network was down
   * would be reporting on the wrong thing.
   */
  signedInAs: { id: string; email: string } | null;
  /** The systemd/launchd service state. The scheduler cannot run without a
   *  running daemon, so a settings page that hides this reads "on but silent". */
  daemon: DaemonServiceStatus;
  /** The daemon's persisted schedule, or null when no scheduled scan has run. */
  schedule: ScheduledAuditSchedule | null;
  /** ISO time of the most recent audit RESULT on disk (scheduled OR manual),
   *  or null if no audit has ever produced a dashboard. Distinct from
   *  `schedule.lastRunAtMs`, which is scheduled runs only. */
  lastResultAt: string | null;
  /** That same result's counts, for the LAST SCAN / FINDINGS stats. */
  lastScan: ScheduledAuditLastScan | null;
  /**
   * Epoch ms the running daemon started, or null when it is not running, the
   * platform cannot answer, or the answer would be a guess.
   *
   * An absolute time rather than "up 11d" so the page keeps counting on its own;
   * a duration computed here is stale the moment it renders.
   */
  daemonStartedAtMs: number | null;
}

export async function getScheduledAuditAction(): Promise<ScheduledAuditView> {
  const config = readConfig();
  const schedule = readAuditSchedule();
  const meta = readDashboardCacheMeta();

  const auth = readAuth();
  const daemon = daemonServiceStatus();

  return {
    auto: config.audit.auto,
    intervalDays: config.audit.intervalDays,
    signedInAs: auth ? { id: auth.user.id, email: auth.user.email } : null,
    daemon,
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
    lastScan: meta
      ? {
          finishedAt: meta.cachedAt,
          findings: meta.findings,
          sessionsScanned: meta.sessionsScanned,
          eventsScanned: meta.eventsScanned,
        }
      : null,
    // Only asked when the service is actually up: systemd keeps the LAST
    // activation stamp on a stopped unit, so reading it unconditionally would
    // report an uptime for a daemon that is not running.
    daemonStartedAtMs: daemon === "running" ? daemonStartedAtMs() : null,
  };
}
