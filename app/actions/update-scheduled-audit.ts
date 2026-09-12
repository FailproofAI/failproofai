"use server";

/**
 * Write side of the /settings scheduled-audit panel. Every write goes through
 * `updateConfig` — never a raw file write — so `fp-config` stays the single
 * writer of `config.json` and the dashboard can never disagree with what the
 * CLI reads.
 *
 * ## CLI ⟷ dashboard parity
 *   - `setAutoAuditAction(enabled)`  ⟷ `[audit] auto`
 *   - `setAuditNotifyAction(enabled)` ⟷ `[audit] notify`
 *   - `setAuditIntervalAction(days)` ⟷ `[audit] interval_days`
 *
 * All go through the same `updateConfig` the CLI uses — `failproofai audit
 * --schedule` / `--no-schedule` call it too — so a value set on either side is
 * byte-identical. That is the whole mechanism behind "the two
 * surfaces are always in sync": there is one file, one writer function, and no
 * second copy of the state to drift.
 */

import { readConfig, updateConfig } from "@/src/hooks/fp-config";

/**
 * The outcome of trying to turn scheduling on.
 *
 * "Signed out" is RETURNED, not thrown, and that is the whole point of this
 * type. Next masks a server action's thrown error before the browser sees it —
 * the client gets an opaque digest, never the message — so a caller matching on
 * the text works in development and silently degrades to a generic failure in
 * production, which is exactly what happened: the page showed an address it had
 * read from the local session file, the toggle took the signed-in path, and the
 * user got "could not turn that on." with no way forward from that click.
 *
 * A returned discriminant survives the boundary, so the caller can open the
 * sign-in dialog for the one failure that has an obvious next step.
 */
export type SetAutoAuditResult = { ok: true; auto: boolean };

/**
 * Turn the scheduled scan on or off.
 *
 * Scheduling is local and independent of authentication. A signed-in identity
 * adds email delivery; without one the scan and desktop notification continue.
 *
 * Returns the value actually stored (re-read), so an optimistic UI can confirm
 * against the source of truth rather than assume its own guess landed.
 */
export async function setAutoAuditAction(enabled: boolean): Promise<SetAutoAuditResult> {
  const next = updateConfig({ audit: { auto: enabled } });
  return { ok: true, auto: next.audit.auto };
}

/**
 * Turn OS notifications for scheduled credential findings on or off.
 *
 * This does not change the timer or email delivery. It writes the same setting
 * as `failproofai audit --notify` / `--no-notify` and returns the value re-read
 * from the shared config so the dashboard never maintains a second truth.
 */
export async function setAuditNotifyAction(enabled: boolean): Promise<{ notify: boolean }> {
  const next = updateConfig({ audit: { notify: enabled } });
  return { notify: next.audit.notify };
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
