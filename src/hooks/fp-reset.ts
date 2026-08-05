/**
 * What happens when this CLI meets a home directory written by a different
 * layout.
 *
 * The decision was wipe-and-re-setup rather than migrate. A migration has to
 * be right on every path or it half-moves a home, and a half-moved home fails
 * in the worst available way: the daemon writes where the dashboard does not
 * read, and an absent directory is indistinguishable from an idle one. A reset
 * is one destructive operation that is either done or not done.
 *
 * ## Where the deletion happens, and where it deliberately does not
 *
 * Only a real CLI command resets. A HOOK never deletes anything, because a
 * hook runs unattended, once per tool call, with an agent waiting on stdout —
 * removing a user's audit history and cursors from inside one would be a
 * destructive act nobody asked for and nobody saw.
 *
 * But a hook must not stay silent either. On a stale layout the merged config
 * resolves to nothing, so every builtin policy quietly stops firing: the
 * machine looks protected and is not. That is the single worst outcome here,
 * so the hook path says so on stderr, every time, until setup is re-run.
 *
 * ## Why the hook does not simply deny
 *
 * Failing closed is this product's instinct, and it is the wrong instinct
 * here. A stale layout is the result of an upgrade the user did not ask to be
 * interrupted by, and this branch has already demonstrated — on this very
 * machine — that a blanket deny takes `UserPromptSubmit` with it and locks the
 * user out of their agent entirely, with no way back except hand-editing JSON.
 * A loud warning that survives until setup runs is the proportionate answer.
 */
import { existsSync, rmSync } from "node:fs";
import { LAYOUT_VERSION, failproofaiHome, resettablePaths } from "./fp-home";
import { detectLayout, readConfig, updateConfig, writeVersionFile, type LayoutState } from "./fp-config";
import { daemonServiceStatus, daemonVersionSkew, isDaemonSupportedPlatform } from "./daemon-service";

export interface ResetOutcome {
  /** Paths that existed and were removed. */
  removed: string[];
  /** The layout that was found before the reset. */
  from: number;
}

/**
 * Delete every path layout 1 or layout 2 could have written, then stamp
 * VERSION so the next run reads as current.
 *
 * Enumerated rather than "remove the home directory": a reset must never take
 * out something a future layout adds that this list has not been taught about,
 * and `bin/` and `run/` are excluded on purpose — a downloaded daemon binary is
 * large, version-pinned and re-verified on use, and `run/` holds sockets
 * belonging to a process that may be alive right now.
 */
export function resetHome(from: number): ResetOutcome {
  const removed: string[] = [];
  for (const path of resettablePaths()) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // A path we cannot remove is not worth aborting the reset over; the
      // VERSION stamp below is what stops this repeating, and a leftover
      // directory from an old layout is inert once nothing reads it.
    }
  }
  writeVersionFile();
  return { removed, from };
}

export interface LayoutCheck {
  state: LayoutState;
  /** Lines to print. Empty when there is nothing to say. */
  lines: string[];
  /** True when the caller should stop rather than continue. */
  fatal: boolean;
}

/**
 * The interactive path: reset a stale home, refuse a future one.
 *
 * A future layout is refused rather than reset because the two failures are
 * not the same. An older home can be rebuilt by re-running setup; a home
 * written by a NEWER CLI holds data this build cannot read but a simple
 * upgrade could, and deleting it would destroy something recoverable.
 */
export function checkLayoutForCli(): LayoutCheck {
  const state = detectLayout();

  if (state.kind === "future") {
    return {
      state,
      fatal: true,
      lines: [
        `This machine's failproofai directory was written by a newer version`,
        `(layout ${state.found}; this build speaks ${LAYOUT_VERSION}).`,
        ``,
        `Upgrade rather than reset — the data is fine, this build just cannot read it:`,
        `  npm install -g failproofai@latest`,
      ],
    };
  }

  if (state.kind === "stale") {
    const { removed } = resetHome(state.found);
    return {
      state,
      fatal: false,
      lines: [
        `failproofai reorganised ${failproofaiHome()} in this version.`,
        `Removed ${removed.length} item(s) from the old layout — policy config, activity`,
        `history and audit cache. Your downloaded daemon binary was kept.`,
        ``,
        `Run \`failproofai config\` to set up again.`,
      ],
    };
  }

  if (state.kind === "absent") writeVersionFile();
  return { state, fatal: false, lines: [...healDaemonFlag(), ...staleDaemonHint()] };
}

/**
 * Clear `daemonConfigured` when the service it points at is provably gone.
 *
 * This exists because the combination it repairs bricked a real machine during
 * development. `daemonConfigured` makes every hook route through failproofaid
 * and FAIL CLOSED when it cannot be reached — so removing the service without
 * first clearing the flag denies every tool call on the box, including
 * `UserPromptSubmit`, which locks the user out of their agent entirely. There
 * was no command to undo it: the only recovery was hand-editing JSON.
 *
 * Deliberately keyed on "not-installed", never on "stopped". A stopped service
 * is usually a restart in progress, and clearing the flag there would silently
 * downgrade a healthy machine to the in-process path — trading a loud, correct
 * failure for a quiet, wrong one.
 */
function healDaemonFlag(): string[] {
  try {
    const cfg = readConfig();
    if (!cfg.daemon.configured) return [];
    if (!isDaemonSupportedPlatform()) return [];
    if (daemonServiceStatus() !== "not-installed") return [];

    updateConfig({ daemon: { configured: false } });
    return [
      `failproofaid is no longer installed, but this machine was still configured`,
      `to require it — which denies every tool call. Cleared that flag; policies`,
      `now evaluate in-process. Run \`failproofai config\` to reinstall the daemon.`,
      ``,
    ];
  } catch {
    // Never let a self-heal attempt break the command the user actually typed.
    return [];
  }
}

/**
 * One line when the daemon is older than the CLI.
 *
 * Deliberately NOT on the hook path. A stale daemon still enforces every policy
 * correctly — it is slower to notice an upgrade, not broken — so a warning once
 * per tool call would be noise about something that is working. CLI commands
 * are where a person is present to act on it.
 */
function staleDaemonHint(): string[] {
  try {
    const skew = daemonVersionSkew();
    if (!skew) return [];
    return [
      `[failproofai] daemon is ${skew.installed}, CLI is ${skew.expected} — ` +
        `run \`failproofai config\` to update it.`,
      ``,
    ];
  } catch {
    return [];
  }
}

/**
 * The hook path: never delete, never deny, but never stay quiet either.
 *
 * Returns a single stderr line when the layout is not current. Hooks run once
 * per tool call, so this repeats — deliberately. A warning that appears once
 * and then stops is a warning nobody sees, and the state it describes (a
 * machine whose global policies have silently stopped firing) persists until
 * somebody acts on it.
 */
export function layoutWarningForHook(): string | null {
  const state = detectLayout();
  if (state.kind === "current" || state.kind === "absent") return null;
  if (state.kind === "future") {
    return (
      `[failproofai] this directory was written by a newer version ` +
      `(layout ${state.found} vs ${LAYOUT_VERSION}) — policies are NOT being enforced. ` +
      `Upgrade failproofai.`
    );
  }
  return (
    `[failproofai] setup predates this version — global policies are NOT being enforced. ` +
    `Run \`failproofai config\` to re-create it.`
  );
}
