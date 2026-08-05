"use server";

/**
 * Read side of the /settings "Email reports" section.
 *
 * Everything the section needs to decide WHICH control to show — signed in?
 * cloud-enrolled? reports already on? — plus `statusLines`, which is the exact
 * same `emailReportStatusLines()` the CLI's `failproofai config --status`
 * prints. Reusing it is the parity guarantee: the dashboard and the CLI describe
 * this feature's state from one function, so they cannot drift.
 *
 * ## CLI ⟷ dashboard parity
 *   - toggle          ⟷ `failproofai config --email` / `--no-email`
 *                        (runEmailReportsOnCommand / OffCommand — see update-email-reports.ts)
 *   - `reportsOn`     ⟷ `config.toml [email] reports`
 *   - `verifiedFor`   ⟷ `credentials.toml [email] verified_for`
 *   - `cloudEnrolled` ⟷ `machineScanTarget()` (mode=cloud + a usable credential)
 *   - `signedInEmail` ⟷ the OTP-verified `auth.json` session (readAuth)
 */

import { readConfig, readCredentials } from "@/src/hooks/fp-config";
import { machineScanTarget } from "@/src/audit/machine-scan-report";
import { emailReportStatusLines } from "@/src/hooks/email-reports-cli";
import { readAuth } from "@/lib/auth/auth-store";

export interface EmailReportsView {
  /** `[email] reports` — the consent gate the scheduled audit reads. */
  reportsOn: boolean;
  /** Machine has a usable cloud enrolment (mode=cloud + credential). Email is
   *  impossible without it — there is no org to scope to and no verified
   *  recipient, and letting a machine name its own would be an open relay. */
  cloudEnrolled: boolean;
  /** The OTP-verified address of the current dashboard session, or null when
   *  signed out. The control leads into the EXISTING login flow in that case —
   *  never a second email field. */
  signedInEmail: string | null;
  /** Whose sign-in the opt-in was agreed under (credentials.toml). Shown so a
   *  different person signing in on a shared machine is visible. */
  verifiedFor: string | null;
  /** `[audit] auto`. Email needs a scan to report on; when this is off, reports
   *  can be on and still produce nothing — the section says so explicitly. */
  autoAuditOn: boolean;
  /** The same human-readable status the CLI prints, reused verbatim. */
  statusLines: string[];
}

export async function getEmailReportsAction(): Promise<EmailReportsView> {
  const config = readConfig();
  return {
    reportsOn: config.email.reports,
    cloudEnrolled: machineScanTarget() !== null,
    signedInEmail: readAuth()?.user.email ?? null,
    verifiedFor: readCredentials().email?.verifiedFor ?? null,
    autoAuditOn: config.audit.auto,
    statusLines: emailReportStatusLines(),
  };
}
