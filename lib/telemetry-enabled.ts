/**
 * The single answer to "may we send telemetry?", shared by every dispatcher.
 *
 * There are four of them — the CLI and hook path (`src/hooks/hook-telemetry.ts`),
 * the Next.js server (`lib/telemetry.ts`), the browser (`lib/client-telemetry.ts`,
 * which inherits this via `getTelemetryConfig`), and the install script
 * (`scripts/install-telemetry.mjs`, gated by its TypeScript caller). A dispatcher
 * that resolved this differently would be an opt-out that silently does not hold,
 * which is worse than having no opt-out at all.
 *
 * ## Two sources, and why the file is the important one
 *
 * `FAILPROOFAI_TELEMETRY_DISABLED=1` is read from `process.env`. That works for
 * anything the user launches from a shell, and it is kept because people already
 * rely on it. It cannot work for **failproofaid**: the daemon is a system-scope
 * service unit whose environment carries essentially nothing, so an exported
 * variable is structurally incapable of reaching it. `[telemetry] enabled` in
 * config.toml is a file both the CLI and the daemon read, which is why it is the
 * off-switch the documentation points at.
 *
 * They resolve to the **more restrictive** of the two: either says stop, and we
 * stop. The environment can never re-enable something the file switched off —
 * an env var that could override a written preference is not an opt-out.
 */
import { readConfig } from "../src/hooks/fp-config";

/**
 * Resolved fresh on every call, deliberately.
 *
 * Memoising this was the obvious optimisation and it is the wrong one. An
 * opt-out that a long-lived process (the dashboard server, the warm worker)
 * keeps ignoring until it restarts is an opt-out that does not hold, and
 * "telemetry stopped only after a reboot" is precisely the bug that destroys
 * trust in a switch like this.
 *
 * The cost is a small `readFileSync` + TOML parse per event. That is affordable
 * even on the hook path's 150ms fail-closed budget: the same `readConfig()` is
 * already called there by `isDaemonConfigured()`, so this adds a repeat of work
 * the path was already paying for, on a file of a few hundred bytes.
 */
export function isTelemetryEnabled(): boolean {
  // Checked first, and cheaply: an env lookup costs nothing, and letting it
  // short-circuit means an operator who exported the variable never pays for a
  // file read at all.
  if (process.env.FAILPROOFAI_TELEMETRY_DISABLED === "1") return false;
  try {
    return readConfig().telemetry.enabled;
  } catch {
    // readConfig already resolves an unreadable or malformed file to the
    // defaults, so reaching here means something more unusual. Fall back to the
    // shipped default rather than inventing a third answer.
    return true;
  }
}
