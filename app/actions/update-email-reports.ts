"use server";

/**
 * Write side of the /settings "Email reports" section.
 *
 * This does NOT re-implement the on/off rules — it delegates to the exact same
 * `runEmailReportsOnCommand` / `runEmailReportsOffCommand` the CLI's
 * `failproofai config --email` / `--no-email` call. Those functions own the
 * whole policy: refuse-if-not-enrolled, refuse-if-not-signed-in, write the
 * boolean and the verified address together or not at all, and forget the
 * address on the way off. Keeping that logic in ONE place is the point — a
 * second copy here is exactly how the dashboard and CLI would drift into
 * disagreeing about when email is allowed.
 *
 * The `CommandResult` ({ exitCode, lines }) is returned as-is so the UI can show
 * the same refusal text the CLI prints (why it could not be enabled, and that
 * nothing was stored) instead of a generic "failed".
 */

import {
  runEmailReportsOnCommand,
  runEmailReportsOffCommand,
} from "@/src/hooks/email-reports-cli";
import type { CommandResult } from "@/src/hooks/cloud-enrollment-cli";

export async function setEmailReportsAction(enabled: boolean): Promise<CommandResult> {
  return enabled ? runEmailReportsOnCommand() : runEmailReportsOffCommand();
}
