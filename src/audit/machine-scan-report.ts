/**
 * Sending a scheduled scan's harmful findings to Failproof Cloud.
 *
 * The daemon runs `failproofai audit --scheduled` as a one-shot subprocess; when
 * it finishes, this decides whether anything about that scan leaves the machine
 * and, if so, POSTs the whitelisted projection built by
 * `machine-scan-payload.ts`. The cloud renders and sends the email — this side
 * never names a recipient, and the payload has no field for one.
 *
 * # Three gates, all of which must open
 *
 *  1. **Cloud mode.** `mode = "oss"` is a hard gate everywhere else in the
 *     product and is one here: a machine that never opted in must be provably
 *     silent, not silent because a token lookup happened to return undefined.
 *  2. **The local opt-in** (`config.toml` `[email] reports`). This one is load
 *     bearing in a way that is easy to miss: the SERVER decides recipients from
 *     org membership and has no idea whether anyone on this machine asked to be
 *     mailed. So if this gate does not stop the upload, nothing does — an
 *     accepted scan with harmful findings mails somebody. The upload and the
 *     consent are therefore the same switch, deliberately, rather than
 *     "reporting" and "email" being separately toggleable.
 *  3. **Something harmful** (`harmful.ts`). `risks` mode: silence on a clean
 *     week, no proof-of-life digest. Nothing is sent, not an empty scan.
 *
 * An unenrolled machine posts nothing and says nothing. That is not an error
 * and is not reported as one — the overwhelming majority of installs are local
 * only, and a warning on every scheduled run would be noise about a feature
 * they never asked for.
 *
 * # Best-effort, bounded, and never retried
 *
 * Every failure resolves to an outcome value; nothing here throws and nothing
 * fails the audit. There is no retry loop at all: the next scheduled scan is
 * the retry, it is a day or more away, and a tight loop against a cloud that is
 * down is exactly how a fleet turns an outage into a second outage. The request
 * is bounded by a short timeout because the process exits the moment this
 * resolves — the audit's own work (~104 seconds) is long since done, so this
 * cannot delay any result, but it must not hold a subprocess open against a
 * black-holed socket either.
 */
import { userInfo } from "node:os";
import { fetchWithTimeout, isAbortError } from "../../lib/fetch-with-timeout";
import { readCloudCredentials } from "../hooks/cloud-enrollment";
import { cloudBaseFor } from "../hooks/cloud-connection";
import { readIngestCredential } from "../hooks/collector-config";
import { readConfig } from "../hooks/fp-config";
import { buildMachineScanPayload, MACHINE_SCAN_PATH } from "./machine-scan-payload";
import type { AuditResult } from "./types";

/** Short on purpose — see the module header. */
export const SCAN_REPORT_TIMEOUT_MS = 10_000;

export interface ScanReportTarget {
  /** Cloud base URL, no trailing slash and no path. */
  baseUrl: string;
  token: string;
  machineId: string;
}

/**
 * Where — and as whom — this machine would report, or null if it would not.
 *
 * Two credential shapes reach the same endpoint, because the server accepts
 * `events:add` OR `policies:pull` for this route. A `[cloud]` credential is
 * preferred (it carries the machine id directly); an `events:add`-only fleet
 * has no `[cloud]` table at all by design, so it falls back to `[ingest]` plus
 * the collector's machine id — which is the SAME id the collector stamps on
 * every event, so the server's `(machine_id, os_user)` identity lines up
 * either way. Requiring a policy-pull key here would have shipped the feature
 * inert for every reporting-only machine.
 */
export function machineScanTarget(): ScanReportTarget | null {
  if (readConfig().mode !== "cloud") return null;

  const cloud = readCloudCredentials();
  if (cloud?.url && cloud.token && cloud.machineId) {
    return { baseUrl: cloudBaseFor(cloud.url), token: cloud.token, machineId: cloud.machineId };
  }

  const ingest = readIngestCredential();
  const machineId = readConfig().collector.machineId;
  if (ingest?.url && ingest.key && machineId) {
    // `cloudBaseFor` strips the `/v1/events` (or legacy `/events`) suffix. A
    // raw ingest URL would put the scan into the events handler, which answers
    // 404 or, on the dashboard hostname, an HTML page with a 200.
    return { baseUrl: cloudBaseFor(ingest.url), token: ingest.key, machineId };
  }

  return null;
}

export type ScanReportOutcome =
  | { sent: true; status: number }
  /** Not enrolled, or enrolled without a usable credential. Silent by design. */
  | { sent: false; reason: "not-enrolled" }
  /** Enrolled, but nobody on this machine opted in. Silent by design. */
  | { sent: false; reason: "not-opted-in" }
  /** A clean week, or nothing survived validation. Silent by design. */
  | { sent: false; reason: "no-harmful-findings" }
  /** The identity would not pass the server's own validator. */
  | { sent: false; reason: "invalid-identity" }
  /** Reached the server and it refused, or never reached it. Both are the
   *  same to the caller: the next scan is the retry. */
  | { sent: false; reason: "rejected"; status: number }
  | { sent: false; reason: "unreachable"; detail: string };

export interface ReportScanOptions {
  /** The OS user this scan ran as. Defaults to the passwd entry for the real
   *  uid (never `$USER`, which a service unit's minimal environment may not
   *  carry) — resolved by the caller so this module stays testable. */
  osUser?: string;
  /** Injected by tests so nothing reaches the network. */
  fetchImpl?: typeof fetchWithTimeout;
  now?: number;
}

/**
 * The OS user this process runs as.
 *
 * `userInfo()` reads the password database for the real uid, matching how the
 * daemon resolves the same value in Rust (`getpwuid_r`, deliberately not
 * `$USER`). The two MUST agree or the machine reports under two identities —
 * one on its collected events and another on its scans.
 */
export function currentOsUser(): string {
  try {
    return userInfo().username ?? "";
  } catch {
    // No passwd entry (a container running as a bare uid, say). Reporting
    // under an invented name would merge two machines' users; reporting under
    // none is refused upstream, which is the right outcome.
    return "";
  }
}

/**
 * Report one completed scan. Never throws.
 *
 * The result is returned rather than logged so the caller owns the wording;
 * `runScheduledAudit` prints nothing for any of the silent outcomes.
 */
export async function reportScanToCloud(
  result: AuditResult,
  opts: ReportScanOptions = {},
): Promise<ScanReportOutcome> {
  try {
    const target = machineScanTarget();
    if (!target) return { sent: false, reason: "not-enrolled" };

    // Checked AFTER enrolment purely so the outcome is the more specific of the
    // two — an unenrolled machine has no opt-in to report on.
    if (!readConfig().email.reports) return { sent: false, reason: "not-opted-in" };

    const built = buildMachineScanPayload({
      result,
      machineId: target.machineId,
      osUser: opts.osUser ?? currentOsUser(),
      now: opts.now,
    });
    if (!built.ok) return { sent: false, reason: built.reason };

    const doFetch = opts.fetchImpl ?? fetchWithTimeout;
    const response = await doFetch(
      `${target.baseUrl}${MACHINE_SCAN_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(built.payload),
      },
      SCAN_REPORT_TIMEOUT_MS,
    );

    // 2xx of any kind counts: the handler answers 202 (the mail is dispatched
    // off the request), and pinning the exact code would break on a server
    // that starts answering 200.
    if (response.status >= 200 && response.status < 300) {
      return { sent: true, status: response.status };
    }
    return { sent: false, reason: "rejected", status: response.status };
  } catch (err) {
    // Includes the timeout. Deliberately terminal: no retry, no backoff, no
    // second request — the next scheduled scan is the retry.
    const detail = isAbortError(err)
      ? `no response within ${SCAN_REPORT_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return { sent: false, reason: "unreachable", detail };
  }
}
