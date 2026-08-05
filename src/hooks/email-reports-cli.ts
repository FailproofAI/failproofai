/**
 * `failproofai config --email | --no-email`, and the email half of `--status`.
 *
 * # Why enabling can fail, and why that is the whole point
 *
 * Emailed scan reports need three things that a local-only machine does not
 * have and cannot get:
 *
 *   1. an **organisation** to scope the report row to,
 *   2. a **machine key** the server will accept, and
 *   3. a **verified address** to deliver to.
 *
 * The tempting fallback — let the machine name its own recipient — is an open
 * mail relay: anything that can reach the endpoint could then have our server
 * send mail to any address it likes, from our domain and our IP reputation.
 * There is no version of that which is safe, so there is no fallback. `--email`
 * on an unenrolled machine exits non-zero and points at `--connect`.
 *
 * # And why it stores nothing when it fails
 *
 * Recording an address for a machine that can never use it is a privacy cost
 * with no benefit: a plaintext address on disk, in a backup, in a support
 * bundle, bought with nothing. So the two writes happen together, after both
 * checks pass, or neither happens.
 *
 * # The address is READ, never asked for
 *
 * It comes from `auth.json` — the session the user already proved with an OTP.
 * Prompting for one here would create a second email field that can disagree
 * with the first, and an unverified address is not something to promise
 * delivery to. It is also not sent anywhere: the payload has no recipient
 * field, and the server resolves recipients from org membership. What is stored
 * is the record of WHOSE consent the opt-in represents.
 */
import { readAuth } from "../../lib/auth/auth-store";
import { machineScanTarget } from "../audit/machine-scan-report";
import { readConfig, readCredentials, updateConfig, writeCredentials } from "./fp-config";
import { configFile, credentialsFile } from "./fp-home";
import type { CommandResult } from "./cloud-enrollment-cli";

/**
 * Turn scan reports on.
 *
 * Non-zero on every refusal, because this is a command a provisioning script
 * runs in a chain and "silently did nothing" is the outcome that gets found six
 * months later when nobody has been receiving reports.
 */
export function runEmailReportsOnCommand(): CommandResult {
  if (!machineScanTarget()) {
    return {
      exitCode: 1,
      lines: [
        "This machine is not connected to Failproof Cloud, so it cannot receive",
        "emailed audit reports.",
        "",
        "  Reports are rendered and sent by the cloud, from a scan summary this",
        "  machine uploads. Without an enrolment there is no organisation to",
        "  scope the report to, no key the server would accept, and no verified",
        "  address to send to. A local-only machine naming its own recipient",
        "  would be an open mail relay, so there is no offline fallback.",
        "",
        "  Connect first:",
        "    failproofai config --connect <url> --token <key>",
        "",
        "Nothing was stored.",
      ],
    };
  }

  const auth = readAuth();
  if (!auth?.user.email) {
    return {
      exitCode: 1,
      lines: [
        "No verified email address on this machine.",
        "",
        "  Reports go to the address you already verified by one-time code —",
        "  failproofai does not take a second one, because an address nobody",
        "  proved is not one to promise delivery to.",
        "",
        "  Sign in first:",
        "    failproofai auth login",
        "",
        "Nothing was stored.",
      ],
    };
  }

  // Both writes, or neither. The boolean is the gate the scheduled audit reads;
  // the address is only the record of whose consent it was.
  updateConfig({ email: { reports: true } });
  writeCredentials({ ...readCredentials(), email: { verifiedFor: auth.user.email } });

  return {
    exitCode: 0,
    lines: [
      `Emailed audit reports are ON, agreed under ${auth.user.email}.`,
      "",
      "  A scheduled scan uploads counts only — rule ids, hit counts, how many",
      "  projects each fired in, and timestamps. Never a file path, a command, a",
      "  prompt or anything from a transcript.",
      "  You are mailed only when a scan finds something harmful still getting",
      "  through. A clean week is silent, on purpose.",
      "  Recipients are resolved by the server from your organisation, not by",
      "  this machine — so this address is a record of consent, not a target.",
      "",
      `  Opt-in    ${configFile()}  ([email] reports)`,
      `  Address   ${credentialsFile()}  (owner-only)`,
      ...(readConfig().audit.auto
        ? []
        : [
            "",
            "! Scheduled scanning is OFF, so nothing will be reported yet.",
            "  Turn it on with: failproofai config",
          ]),
      "",
      "Turn reports off again with: failproofai config --no-email",
    ],
  };
}

/**
 * Turn scan reports off, and forget the address.
 *
 * Always exit 0, including when nothing was on: "stop sending me email" has one
 * acceptable outcome and it is not an error message. The address goes with the
 * boolean — keeping it would leave a plaintext address on disk in service of a
 * feature that is off.
 */
export function runEmailReportsOffCommand(): CommandResult {
  const wasOn = readConfig().email.reports;
  const current = readCredentials();
  const hadAddress = Boolean(current.email?.verifiedFor);

  updateConfig({ email: { reports: false } });
  if (hadAddress) {
    const { email: _dropped, ...rest } = current;
    // Merge-preserving, like every other credential writer here: dropping the
    // address must not revoke the cloud token, the ingest key or the session.
    writeCredentials(rest);
  }

  if (!wasOn && !hadAddress) {
    return { exitCode: 0, lines: ["Emailed audit reports were already off."] };
  }
  return {
    exitCode: 0,
    lines: [
      "Emailed audit reports are OFF.",
      "",
      "  Nothing about this machine's scans is uploaded. Scheduled scanning and",
      "  the local audit dashboard are unaffected; cloud policy and hook",
      "  activity reporting are unaffected.",
    ],
  };
}

/**
 * The email half of `--status`.
 *
 * Always prints something, including on a machine where the feature can never
 * work — "why am I not getting reports?" is the question this answers, and an
 * omitted line answers it with silence.
 */
export function emailReportStatusLines(): string[] {
  const config = readConfig();
  const stored = readCredentials().email?.verifiedFor;

  if (!config.email.reports) {
    if (!machineScanTarget()) {
      return ["Reports: off — this machine is not connected, so email is unavailable."];
    }
    return ["Reports: off. Turn on emailed audit reports with: failproofai config --email"];
  }

  const lines = [`Reports: emailing harmful findings, agreed under ${stored ?? "an unknown address"}.`];

  if (!config.audit.auto) {
    // The single likeliest reason a user who turned this on receives nothing.
    lines.push("  ! Scheduled scanning is OFF, so no scan is ever produced to report.");
    lines.push("    Turn it on with: failproofai config");
  }
  if (!machineScanTarget()) {
    // Reachable: --disconnect clears the credential and the mode but leaves
    // this opt-in alone, because reconnecting should not silently re-consent.
    lines.push("  ! Not connected to Failproof Cloud, so nothing is being uploaded.");
    lines.push("    Reconnect with: failproofai config --connect <url> --token <key>");
  }

  const signedInAs = readAuth()?.user.email;
  if (stored && signedInAs && signedInAs !== stored) {
    // Not an error and not a reason to stop: recipients come from the org, not
    // from this address. But somebody else signing in on a shared machine is
    // worth seeing rather than discovering from an inbox.
    lines.push(`  ! Signed in as ${signedInAs}, which is not who opted in.`);
    lines.push("    Re-confirm with: failproofai config --email");
  }

  return lines;
}
