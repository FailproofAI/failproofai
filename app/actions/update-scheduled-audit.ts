"use server";

/**
 * Write side of the /settings "Scheduled audit" section. Every write goes
 * through `updateConfig` — never a raw file write — so the layout-2 config
 * helpers stay the single writer of `config.toml` and the dashboard can never
 * disagree with what the CLI reads.
 *
 * ## CLI ⟷ dashboard parity
 *   - `setAutoAuditAction(enabled)`   ⟷ `[audit] auto`          (updateConfig)
 *   - `setAuditIntervalAction(days)`  ⟷ `[audit] interval_days` (updateConfig)
 * Both keys are exactly what the `failproofai config` wizard writes, so a value
 * set here is indistinguishable from one set on the CLI.
 */

import { readConfig, updateConfig } from "@/src/hooks/fp-config";

/**
 * Turn the scheduled scan on or off.
 *
 * Returns the value actually stored (re-read), so an optimistic UI can confirm
 * against the source of truth rather than assume its own guess landed.
 */
export async function setAutoAuditAction(enabled: boolean): Promise<{ auto: boolean }> {
  const next = updateConfig({ audit: { auto: enabled } });
  return { auto: next.audit.auto };
}

/**
 * Set the days between scheduled scans.
 *
 * The clamp lives in `fp-config.readIntervalDays` (1..90, with 0/negatives/
 * fractions falling back to the default) and is DELIBERATELY not reimplemented
 * here: we write the raw value and then RE-READ, so what we return to the UI is
 * exactly what the config decided to keep. Reflecting the re-read value is how a
 * hand-typed 3650 shows up in the dashboard as the 90 the config actually
 * enforces, with no second copy of the bounds to drift.
 */
export async function setAuditIntervalAction(days: number): Promise<{ intervalDays: number }> {
  updateConfig({ audit: { intervalDays: days } });
  // Re-read through readConfig so the returned value carries the config's own
  // clamp, not the raw input.
  return { intervalDays: readConfig().audit.intervalDays };
}
