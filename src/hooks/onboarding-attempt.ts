/**
 * Why the last first-run setup stopped, and whether it is worth offering again.
 *
 * # The problem this exists for
 *
 * Setup is deliberately all-or-nothing: every abort path writes NOTHING, so a
 * machine that could not be configured is left exactly as it was found rather
 * than carrying half a configuration (a `daemonConfigured` flag with no daemon
 * behind it denies every tool call across all twelve CLIs). That invariant is
 * right and is not changed here.
 *
 * But it left onboarding with no memory. `isConfigured()` reads three signals —
 * a global policy config, live user-scope hooks, the legacy marker — and an
 * abort sets none of them, so "never tried" and "tried twenty times and could
 * not finish" are indistinguishable. On a machine without passwordless sudo,
 * every single command relaunched the whole wizard, forever.
 *
 * # What this is NOT
 *
 * Not a fourth "configured" signal. Nothing here may make `isConfigured()` true.
 * A machine that failed setup is unconfigured and must keep saying so — to the
 * hook path, to `--status`, and to the wizard when it is asked for by name.
 * This only changes whether the wizard is *offered unprompted*.
 *
 * # Re-offering
 *
 * A hint that never becomes an offer again is its own failure: the common case
 * is someone who hits the sudo prompt, gives up, and comes back later able to
 * elevate. So each reason carries a cheap local check for whether its blocker
 * is gone, and the wizard offers itself again the moment one is:
 *
 *   needs_root          -> elevation is now possible without a prompt
 *   daemon_failed       -> the service manager now reports something different
 *   cancelled           -> the CLI version changed; an upgrade is a fair moment to
 *                          ask again, and nothing else about a deliberate cancel
 *                          should re-nag
 *   unsupported_platform -> the CLI version changed (a future release might
 *                          support this platform)
 *
 * Every probe is local and takes milliseconds. None of them runs on the hook
 * path — `--hook` never reaches the first-run gate at all.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { onboardingAttemptFile } from "./fp-home";
import type { WizardAbort } from "./configure-wizard";

/** Bumped only for a deliberate shape change; an unreadable record is ignored. */
const SCHEMA_VERSION = 1;

export interface OnboardingAttempt {
  schemaVersion: number;
  /** Why the wizard stopped. */
  reason: WizardAbort;
  /** The CLI that made the attempt, so an upgrade can re-offer. */
  cliVersion: string;
  /**
   * What the service manager said at the time. Compared, never trusted — the
   * point is only whether it has CHANGED since.
   */
  daemonStatus: string;
  /** Epoch ms, for support and for nothing else. */
  at: number;
}

export function readOnboardingAttempt(): OnboardingAttempt | null {
  const path = onboardingAttemptFile();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<OnboardingAttempt>;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof raw.reason !== "string" || typeof raw.cliVersion !== "string") return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      reason: raw.reason as WizardAbort,
      cliVersion: raw.cliVersion,
      daemonStatus: typeof raw.daemonStatus === "string" ? raw.daemonStatus : "",
      at: typeof raw.at === "number" ? raw.at : 0,
    };
  } catch {
    // A corrupt record reads as "no record", which degrades to today's
    // behaviour — offering the wizard. Never to "configured".
    return null;
  }
}

/** Best-effort: a machine that cannot record this simply keeps being offered. */
export function recordOnboardingAttempt(
  reason: WizardAbort,
  cliVersion: string,
  daemonStatus: string,
  now: number = Date.now(),
): void {
  try {
    const path = onboardingAttemptFile();
    mkdirSync(dirname(path), { recursive: true });
    const record: OnboardingAttempt = {
      schemaVersion: SCHEMA_VERSION,
      reason,
      cliVersion,
      daemonStatus,
      at: now,
    };
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Called on a completed apply. A stale record would keep suppressing the offer
 * on a machine that has since been reconfigured by hand and un-configured again.
 */
export function clearOnboardingAttempt(): void {
  try {
    rmSync(onboardingAttemptFile(), { force: true });
  } catch {
    // best-effort
  }
}

export interface RetryProbe {
  /** Elevation is possible without prompting. */
  canElevate: () => boolean;
  /** What the service manager says right now. */
  daemonStatus: () => string;
  /** This CLI's version. */
  cliVersion: string;
}

/**
 * Whether the thing that stopped setup last time has since changed.
 *
 * `true` means offer the wizard again; `false` means a one-line hint. An
 * unrecognised reason returns `true` — an unknown blocker is one we cannot
 * prove is still present, and the safe direction is offering setup rather than
 * silently withholding it.
 */
export function blockerCleared(attempt: OnboardingAttempt, probe: RetryProbe): boolean {
  switch (attempt.reason) {
    case "needs_root":
      return probe.canElevate();
    case "daemon_failed":
      // Any movement at all: not-installed -> stopped, stopped -> running, or a
      // platform that has gained a service manager. Comparing rather than
      // demanding "running" is what lets a partially-repaired machine be
      // offered setup again instead of waiting for a state it cannot reach on
      // its own.
      return probe.daemonStatus() !== attempt.daemonStatus || probe.canElevate();
    case "cancelled":
      // A deliberate stop. Re-asking on the next command is exactly the nagging
      // this module removes — but an upgrade is a new thing to say, so it is
      // allowed to ask once more.
      return probe.cliVersion !== attempt.cliVersion;
    case "unsupported_platform":
      // A permanent property of the machine, not the invocation — nagging every
      // command would just repeat the hard-fail. Only a new release is a reason
      // to ask again (it might add support for this platform).
      return probe.cliVersion !== attempt.cliVersion;
    case "not_a_tty":
    case "running_as_sudo":
      // Both are properties of the invocation, not of the machine, so the next
      // one may well be fine.
      return true;
    default:
      return true;
  }
}

/** The one line shown instead of relaunching the wizard. */
export function attemptHintLines(attempt: OnboardingAttempt): string[] {
  const why: Record<string, string> = {
    needs_root: "it needs root to install the failproofaid service",
    daemon_failed: "the failproofaid service could not be started",
    cancelled: "it was cancelled",
    unsupported_platform: "failproofaid does not run on this platform",
    not_a_tty: "there was no terminal to ask in",
    running_as_sudo: "it was run under sudo",
  };
  const detail = why[attempt.reason] ?? "it did not finish";
  // Every other reason is fixable by the user right now, so the generic
  // retry is correct. unsupported_platform is not — blockerCleared only
  // re-offers it on a CLI version change, and `failproofai config` would
  // hit the exact same hard-fail in the meantime.
  const action =
    attempt.reason === "unsupported_platform"
      ? "Check for a failproofai update — this platform may be supported by a newer release."
      : "Run `failproofai config` when you are ready.";
  return [
    ``,
    `[failproofai] Setup is not finished — ${detail}.`,
    `              ${action}`,
    ``,
  ];
}
