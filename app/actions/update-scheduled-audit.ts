"use server";

/**
 * Write side of the /settings scheduled-audit panel. Every write goes through
 * `updateConfig` — never a raw file write — so `fp-config` stays the single
 * writer of `config.json` and the dashboard can never disagree with what the
 * CLI reads.
 *
 * ## CLI ⟷ dashboard parity
 *   - `setAutoAuditAction(enabled)`  ⟷ `[audit] auto`
 *   - `setAuditIntervalAction(days)` ⟷ `[audit] interval_days`
 *
 * Both go through the same `updateConfig` the CLI uses, so a value set on
 * either side is byte-identical. That is the whole mechanism behind "the two
 * surfaces are always in sync": there is one file, one writer function, and no
 * second copy of the state to drift.
 */

import { readConfig, updateConfig } from "@/src/hooks/fp-config";
import { whoAmI } from "@/lib/auth/auth-store";

/**
 * Turn the scheduled scan on or off.
 *
 * Turning it ON is refused without a session. Scheduling and mailing are ONE
 * decision — the reason to put a scan on a timer is to be told what it found —
 * so a machine with the timer set and nobody to tell is a switch that reads as
 * on and produces nothing, discoverable only by noticing that no digest ever
 * arrives. The caller signs the user in first and retries.
 *
 * Turning it OFF never checks. An expired session must not be able to trap
 * somebody into keeping a feature they are trying to disable.
 *
 * Note this gates SETTING UP the timer, not the machine's ongoing work: a
 * session that later expires leaves the timer running and the local scan
 * working, and only the digest stops. See `report-harm.ts`.
 *
 * Returns the value actually stored (re-read), so an optimistic UI can confirm
 * against the source of truth rather than assume its own guess landed.
 */
export async function setAutoAuditAction(enabled: boolean): Promise<{ auto: boolean }> {
  if (enabled) {
    const who = await whoAmI();
    if (!who) {
      throw new Error("sign in before scheduling audits");
    }
  }
  const next = updateConfig({ audit: { auto: enabled } });
  return { auto: next.audit.auto };
}

/**
 * Set the days between scheduled scans.
 *
 * The clamp lives in `fp-config.readIntervalDays` (1..90, with 0/negatives/
 * fractions falling back to the default) and is DELIBERATELY not reimplemented
 * here: we write the raw value and then RE-READ, so what comes back is exactly
 * what the config decided to keep. Reflecting the re-read value is how a
 * hand-typed 3650 shows up as the 90 the config actually enforces, with no
 * second copy of the bounds to drift.
 */
export async function setAuditIntervalAction(days: number): Promise<{ intervalDays: number }> {
  updateConfig({ audit: { intervalDays: days } });
  return { intervalDays: readConfig().audit.intervalDays };
}
