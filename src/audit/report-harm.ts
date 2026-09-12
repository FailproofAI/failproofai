/**
 * The optional remote side effect of a scheduled audit: telling the api-server
 * about the newest masked credential exposure so an email alert can be sent.
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
 * who never added an email must never have the local scan depend on this code.
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
import { activeFindings, readLeakRecord } from "./leak-store";
import {
  ensureMachineIdentity,
  machineLabel,
  readMachineIdentity,
  recordReportWatermark,
} from "./machine-store";
import type { AuditResult } from "./types";

/** What happened, for the one line the scheduled run prints. */
export type HarmReportOutcome =
  | { kind: "disabled" }
  | { kind: "no-leak" }
  | { kind: "signed-out" }
  | { kind: "sent"; leaks: number }
  | { kind: "held"; leaks: number; reason: string }
  | { kind: "failed"; error: string };

/**
 * Report this scan's newest credential exposure when an email identity exists.
 *
 * Returns an outcome rather than a boolean so the caller can say something
 * truthful. "held" in particular is not a failure — a machine inside its
 * cooldown is working exactly as intended, and a line that called that an error
 * would train people to ignore the line.
 */
export async function reportHarm(result: AuditResult): Promise<HarmReportOutcome> {
  let auto = false;
  let intervalDays = 7;
  try {
    const config = readConfig();
    auto = config.audit.auto;
    // Also the width of a FIRST report's window, so a new machine's opening
    // digest covers the same period every later one will.
    intervalDays = config.audit.intervalDays;
  } catch {
    // An unreadable config reads as off — the direction that sends nothing.
    return { kind: "disabled" };
  }
  if (!auto) return { kind: "disabled" };

  // Decide whether there is anything emailable before touching auth or the
  // network. Scheduled scans are local by default; an email identity is an
  // optional delivery channel, and a scan with no credential leak must make no
  // report request at all.
  const prior = readMachineIdentity();
  const report = buildHarmReport(
    result,
    prior?.last_reported_at,
    intervalDays,
    activeFindings(readLeakRecord()),
  );
  if (report.leaks.length === 0) return { kind: "no-leak" };

  const auth = await getValidAccessToken();
  if (!auth) {
    // Expired, revoked, or signed out. NOT an error and NOT a reason to stop
    // scheduling: auth gates setting the timer up, never the machine's ongoing
    // work. The scan already succeeded and its result is on the local
    // dashboard; only the digest is lost, and the remedy needs a human present
    // anyway. A refresh token quietly expiring must never switch off a
    // background feature somebody configured months ago.
    return { kind: "signed-out" };
  }

  let identity: ReturnType<typeof ensureMachineIdentity>;
  try {
    identity = ensureMachineIdentity();
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await submitAuditReport(auth.access_token, {
      machine_id: identity.machine_id,
      label: machineLabel(),
      platform: process.platform,
      window_from: report.window_from,
      window_to: report.window_to,
      harmful: report.harmful,
      leaks: report.leaks,
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
      ? { kind: "sent", leaks: report.leaks.length }
      : { kind: "held", leaks: report.leaks.length, reason: res.reason ?? "not_sent" };
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
    case "no-leak":
      return null;
    case "signed-out":
      return "failproofai: a credential exposure was found, but no email is configured — run `failproofai audit --schedule --email you@example.com`";
    case "sent":
      return "failproofai: emailed the most recent credential exposure";
    case "held":
      return `failproofai: credential exposure reported, no email (${outcome.reason})`;
    case "failed":
      return `failproofai: could not send the credential alert: ${outcome.error}`;
  }
}
