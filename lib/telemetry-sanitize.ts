import os from "node:os";

/** Max length of a telemetry error message; longer strings are truncated. */
const MAX_ERROR_MESSAGE_LEN = 300;

/**
 * Turn an error into a telemetry-safe message string for the `error_message`
 * property on failure events (e.g. `cli_audit_failed`, `audit_run_failed`).
 *
 * Two protections keep this consistent with failproofai's telemetry philosophy
 * (no raw local paths / PII on the wire):
 *   1. The user's home directory is collapsed to `~`, so an error that embeds a
 *      path like `/home/alice/.codex/…` is reported as `~/.codex/…`.
 *   2. The message is truncated to a bounded length (with an ellipsis marker).
 *
 * Never throws — falls back to `"unknown"` if the error can't be stringified.
 */
export function sanitizeErrorMessage(err: unknown): string {
  let msg: string;
  try {
    msg = err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown";
  }
  if (!msg) return "";

  let home = "";
  try {
    home = os.homedir();
  } catch {
    /* homedir unavailable — skip path stripping */
  }
  // Only strip a real, non-root home to avoid mangling messages when homedir is
  // "/" or empty.
  if (home && home.length > 1) {
    msg = msg.split(home).join("~");
  }

  if (msg.length > MAX_ERROR_MESSAGE_LEN) {
    msg = msg.slice(0, MAX_ERROR_MESSAGE_LEN) + "…";
  }
  return msg;
}
