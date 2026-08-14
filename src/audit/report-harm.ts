/**
 * The side effect a scheduled audit has that no other audit does: telling the
 * api-server what it found, so a harm digest can be mailed.
 *
 * Separated from `harm-report.ts` on purpose. That module is pure — result in,
 * payload out — and is where the windowing rules live and are tested. This one
 * is the IO: read config, read session, refresh, POST, persist the watermark. It
 * is the part that can fail in ways that must never matter.
 *
 * ## Nothing here may break a scan
 *
 * By the time this runs the scan has already completed and its result is already
 * on disk. Every failure below therefore returns rather than throws, and the
 * caller reports the exit code of the SCAN, not of the report. A machine whose
 * token expired, whose network is down, or whose api-server is having a bad day
 * must keep auditing itself locally and keep showing results on its own
 * dashboard — the local feature does not depend on the remote one, and a person
 * who never enabled emailed reports must never be able to tell this code exists.
 *
 * ## Why the CHILD does this and not the daemon
 *
 * Refresh rotation is theft-detecting: presenting a spent refresh token revokes
 * every session the user has. The dashboard already needed in-process dedup to
 * avoid self-inflicting that. If the daemon also held and refreshed the token,
 * that dedup would have to work across processes, and losing the race logs the
 * user out of everything with no way to tell why. Running here keeps the token
 * inside the audit lock, which already serialises every entry point, so only one
 * process can hold it at a time.
 */
import { getValidAccessToken } from "../../lib/auth/auth-store";
import { AuthApiError, submitAuditReport } from "../../lib/auth/api-server-client";
import { readConfig } from "../hooks/fp-config";
import { buildHarmReport } from "./harm-report";
import {
  ensureMachineIdentity,
  machineLabel,
  recordReportWatermark,
} from "./machine-store";
import type { AuditResult } from "./types";

/** What happened, for the one line the scheduled run prints. */
export type HarmReportOutcome =
  | { kind: "disabled" }
  | { kind: "signed-out" }
  | { kind: "sent"; hits: number }
  | { kind: "held"; hits: number; reason: string }
  | { kind: "failed"; error: string };

/**
 * Report this scan's harmful findings, if the user asked for that.
 *
 * Returns an outcome rather than a boolean so the caller can say something
 * truthful. "held" in particular is not a failure — a machine below the
 * threshold, or inside its cooldown, is working exactly as intended, and a line
 * that called that an error would train people to ignore the line.
 */
export async function reportHarm(result: AuditResult): Promise<HarmReportOutcome> {
  // Two switches, not one. `auto` schedules the local scan and needs no account;
  // `emailEnabled` is the separate opt-in that sends anything anywhere. A
  // machine with the first and not the second scans on a timer and stays silent,
  // which is what keeps "runs fully offline" true for everyone who wants it.
  let emailEnabled = false;
  let intervalDays = 7;
  try {
    const config = readConfig();
    emailEnabled = config.audit.emailEnabled;
    // Also the width of a FIRST report's window, so a new machine's opening
    // digest covers the same period every later one will.
    intervalDays = config.audit.intervalDays;
  } catch {
    // An unreadable config reads as off — the direction that sends nothing.
    return { kind: "disabled" };
  }
  if (!emailEnabled) return { kind: "disabled" };

  const auth = await getValidAccessToken();
  if (!auth) {
    // Expired, revoked, or never signed in. The scan already succeeded and its
    // result is on the dashboard; the only thing lost is the email, and the
    // remedy is a sign-in the user has to be present for anyway.
    return { kind: "signed-out" };
  }

  let identity: ReturnType<typeof ensureMachineIdentity>;
  try {
    identity = ensureMachineIdentity();
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  const report = buildHarmReport(result, identity.last_reported_at, intervalDays);
  const hits = report.harmful.reduce((n, p) => n + p.hits, 0);

  try {
    const res = await submitAuditReport(auth.access_token, {
      machine_id: identity.machine_id,
      label: machineLabel(),
      platform: process.platform,
      window_from: report.window_from,
      window_to: report.window_to,
      harmful: report.harmful,
    });

    // Persist whatever the server says the next window starts at, INCLUDING when
    // nothing was mailed. Its answer already accounts for that: a held or failed
    // digest leaves the watermark where it was, so writing the value back is how
    // this machine inherits that decision instead of re-deriving it and getting
    // it subtly wrong.
    try {
      recordReportWatermark(res.next_window_from);
    } catch {
      // A watermark that did not persist means the next report re-covers this
      // window. Duplicated findings, never missing ones — and the server's
      // cooldown bounds how often that can turn into an email.
    }

    return res.emailed
      ? { kind: "sent", hits }
      : { kind: "held", hits, reason: res.reason ?? "not_sent" };
  } catch (err) {
    // A 401 here means the session died between `getValidAccessToken` and this
    // call — rare, and indistinguishable from any other failure as far as this
    // run is concerned. The next scheduled run will re-check and report
    // signed-out properly.
    const error =
      err instanceof AuthApiError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { kind: "failed", error };
  }
}

/** One line for the scheduled run's stdout/stderr. */
export function describeOutcome(outcome: HarmReportOutcome): string | null {
  switch (outcome.kind) {
    case "disabled":
      return null; // Say nothing at all to the majority who never opted in.
    case "signed-out":
      return "failproofai: emailed reports are on but this machine is signed out — sign in from the audit page to resume them";
    case "sent":
      return `failproofai: emailed a harm digest (${outcome.hits} finding${outcome.hits === 1 ? "" : "s"})`;
    case "held":
      return `failproofai: ${outcome.hits} finding${outcome.hits === 1 ? "" : "s"} reported, no email (${outcome.reason})`;
    case "failed":
      return `failproofai: could not send the harm report: ${outcome.error}`;
  }
}
