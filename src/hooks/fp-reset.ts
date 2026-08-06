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
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  LAYOUT_VERSION,
  customPoliciesDir,
  failproofaiHome,
  hookActivityDir,
  legacy,
  policiesDir,
  resettablePaths,
} from "./fp-home";
import { detectLayout, readConfig, updateConfig, writeVersionFile, type LayoutState } from "./fp-config";
import {
  daemonServiceStatus,
  daemonStatusCommand,
  daemonVersionSkew,
  isDaemonSupportedPlatform,
  probeDaemonEndToEnd,
} from "./daemon-service";

export interface ResetOutcome {
  /** Paths that existed and were removed. */
  removed: string[];
  /** Basenames of user-authored policy files moved into `custom-policies/`. */
  migrated: string[];
  /** Basenames of decision-log pages carried into layout 2's `hook-activity/`. */
  activity: string[];
  /** The layout that was found before the reset. */
  from: number;
}

/** Script files a person could have written by hand. `.d.ts` is a type stub. */
const USER_SOURCE_RE = /\.(js|mjs|ts)$/;

/**
 * Move hand-written policies from layout 1's `policies/` into layout 2's
 * `policies/custom-policies/`, where the loader actually reads them.
 *
 * Layout 1 documented `~/.failproofai/policies/` as the user scope for personal
 * convention policies, and layout 2 moved the directory the loader opens down a
 * level (`customPoliciesDir()`). Left alone, those files survive the reset —
 * that part is handled by keeping the parent out of `resettablePaths()` — but
 * nothing would ever load them again, which is the same silent enforcement gap
 * by a slower route.
 *
 * Every loadable extension moves, not just the `*policies.{js,mjs,ts}` names
 * the convention loads: a file that misses the naming convention is still
 * source somebody wrote, and `findSkippedPolicyFiles` exists precisely to tell
 * them so. Leaving it behind to be reported against an empty directory helps
 * nobody.
 *
 * A destination that already exists is never overwritten — the source is left
 * in place instead. The parent directory is no longer deleted, so "left in
 * place" means "still there to look at", which is the right outcome for the
 * only case that reaches it (a half-finished earlier migration).
 */
export function migrateConventionPolicies(): string[] {
  const from = policiesDir();
  if (!existsSync(from)) return [];
  const moved: string[] = [];
  try {
    const entries = readdirSync(from, { withFileTypes: true }).filter(
      (e) => e.isFile() && USER_SOURCE_RE.test(e.name) && !e.name.endsWith(".d.ts"),
    );
    if (entries.length === 0) return [];

    const to = customPoliciesDir();
    mkdirSync(to, { recursive: true });
    for (const entry of entries) {
      const target = resolve(to, entry.name);
      if (existsSync(target)) continue;
      try {
        renameSync(resolve(from, entry.name), target);
        moved.push(entry.name);
      } catch {
        // One unmovable file must not strand the rest. It stays where it is,
        // and the reset no longer deletes that directory.
      }
    }
  } catch {
    // A policies directory we cannot read is not worth aborting a reset over.
  }
  return moved.sort((a, b) => a.localeCompare(b));
}

/**
 * Carry layout 1's decision log into layout 2, WITHOUT re-shipping it.
 *
 * `cache/hook-activity` was deleted along with the rest of `cache/`, so an
 * upgrade silently discarded every decision the machine had ever recorded —
 * the data the dashboard's activity tab exists to show, and on a connected
 * machine the data an operator had already been billed the collection of.
 *
 * # Why this MOVES rather than copies
 *
 * The collector keys its cursors on `(device, inode)` — deliberately, because
 * the store rotates by RENAMING `current.jsonl`, and a path-keyed cursor would
 * both re-ship the rotated file and carry its offset onto the fresh one.
 * `rename()` preserves the inode, so a moved page is still the file its cursor
 * belongs to and resumes at the right offset. A copy gives every page a NEW
 * inode, which reads as "never seen before" and re-ships all of it.
 *
 * `head_fingerprint` is what makes that safe rather than lucky: the cursor
 * verifies the file's first bytes whenever a resumed cursor's path has changed,
 * which is exactly this situation. It was added for inode REUSE; a migration is
 * the same question asked the other way round.
 *
 * The fallback for `EXDEV` (a `cache/` on a different filesystem — rare, since
 * both live under one home, but possible with bind mounts) is a copy, accepting
 * that those pages re-ship. Ingest dedups on a content hash and collapses them
 * at merge, so the cost is bandwidth, not duplicate rows.
 *
 * # What is deliberately NOT carried
 *
 * `current.count` and `stats.json` are derived state, and two of each cannot be
 * merged without inventing a number. They are dropped and the store rebuilds
 * them. The legacy `current.jsonl` is moved under a PAGE name rather than onto
 * the destination's own `current.jsonl`, which may already exist and may be
 * mid-write — a rotated page is exactly what the store would have made of it.
 */
export function migrateHookActivity(): string[] {
  const from = legacy.hookActivityDir();
  if (!existsSync(from)) return [];
  const moved: string[] = [];
  try {
    const entries = readdirSync(from, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".jsonl"),
    );
    if (entries.length === 0) return [];

    const to = hookActivityDir();
    mkdirSync(to, { recursive: true });

    // One timestamp for the whole migration, with a per-file counter, so the
    // names are stable, ordered, and cannot collide with each other.
    const stamp = Date.now();
    let seq = 0;

    for (const entry of entries) {
      const source = resolve(from, entry.name);
      // `current.jsonl` becomes a page: the destination has its own, and the
      // store's reader treats pages and current identically.
      let name = entry.name === "current.jsonl" ? `page-${stamp}-${seq++}.jsonl` : entry.name;
      let target = resolve(to, name);
      // Never overwrite. A same-named page in the destination is a different
      // file with different records, and losing either is worse than a rename.
      while (existsSync(target)) {
        name = `page-${stamp}-${seq++}.jsonl`;
        target = resolve(to, name);
      }
      try {
        renameSync(source, target);
        moved.push(name);
      } catch (err) {
        // EXDEV: a rename across filesystems. Copy instead and accept the
        // re-ship; a page left behind would be data lost.
        if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
          try {
            copyFileSync(source, target);
            moved.push(name);
          } catch {
            // Unreadable or undeletable — leave it where it is. `cache/` is no
            // longer deleted wholesale, so "left behind" means "still there".
          }
        }
      }
    }
  } catch {
    // An activity directory we cannot read is not worth aborting a reset over.
  }
  return moved.sort((a, b) => a.localeCompare(b));
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
  // BEFORE the deletions, so a file that is mid-move is never one the reset
  // then walks over.
  const migrated = migrateConventionPolicies();
  const activity = migrateHookActivity();
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
  return { removed, migrated, activity, from };
}

export interface LayoutCheck {
  state: LayoutState;
  /** Lines to print. Empty when there is nothing to say. */
  lines: string[];
  /** True when the caller should stop rather than continue. */
  fatal: boolean;
  /**
   * True when this call actually reset the home.
   *
   * The caller must force setup when it is set. A reset removes the global
   * policy config, but `isConfigured()` is a union that also counts the agent
   * CLIs' settings files — which the reset deliberately leaves alone — so the
   * machine still reads as configured, the wizard is skipped, and
   * `markLauncherSeen()` back-fills the marker so every later run skips it too.
   * The user is left with hooks firing on every tool call against no policies
   * at all, and nothing ever says so again.
   */
  didReset: boolean;
}

/**
 * The interactive path: reset a stale home, refuse a future one.
 *
 * A future layout is refused rather than reset because the two failures are
 * not the same. An older home can be rebuilt by re-running setup; a home
 * written by a NEWER CLI holds data this build cannot read but a simple
 * upgrade could, and deleting it would destroy something recoverable.
 */
export async function checkLayoutForCli(): Promise<LayoutCheck> {
  const state = detectLayout();

  if (state.kind === "future") {
    return {
      state,
      fatal: true,
      didReset: false,
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
    const { removed, migrated, activity } = resetHome(state.found);
    return {
      state,
      fatal: false,
      didReset: true,
      lines: [
        `failproofai reorganised ${failproofaiHome()} in this version.`,
        // "activity history" was in this sentence while the reset was deleting
        // it. It is carried over now, so the message says what was KEPT as well
        // as what went — a user who reads "removed" and nothing else has no way
        // to know their decision log survived.
        `Removed ${removed.length} item(s) from the old layout — policy config and`,
        `audit cache. Your daemon binary and decision history were kept.`,
        // Named individually rather than counted. These are files a person
        // wrote; "moved 3 items" is not something you can check at a glance,
        // and the whole point of saying it is that they can.
        ...(migrated.length > 0
          ? [
              ``,
              `Kept your own policy file(s) and moved them to where this version`,
              `loads them (${customPoliciesDir()}):`,
              ...migrated.map((name) => `  ${name}`),
            ]
          : []),
        // Counted, not named. Unlike policy files these are machine-written
        // pages with generated names — a list of them tells the reader nothing
        // they could act on, where the COUNT answers the only question they
        // have: did my history survive.
        ...(activity.length > 0
          ? [
              ``,
              `Carried ${activity.length} page(s) of decision history into ${hookActivityDir()}.`,
            ]
          : []),
        ``,
        `Run \`failproofai config\` to set up again.`,
      ],
    };
  }

  if (state.kind === "absent") writeVersionFile();
  return {
    state,
    fatal: false,
    didReset: false,
    lines: [...(await healDaemonFlag()), ...staleDaemonHint()],
  };
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
async function healDaemonFlag(): Promise<string[]> {
  try {
    const cfg = readConfig();
    if (!cfg.daemon.configured) return [];
    if (!isDaemonSupportedPlatform()) return [];

    const status = daemonServiceStatus();
    if (status === "not-installed") {
      updateConfig({ daemon: { configured: false } });
      return [
        `failproofaid is no longer installed, but this machine was still configured`,
        `to require it — which denies every tool call. Cleared that flag; policies`,
        `now evaluate in-process. Run \`failproofai config\` to reinstall the daemon.`,
        ``,
      ];
    }

    // Installed, and systemd has refused to start it: one of the paths the unit
    // is gated on is gone. This is what `npm rm -g failproofai` leaves behind —
    // npm runs no uninstall script, so the unit survives the package that
    // supplies its worker, and every tool call on the machine then denies with
    // nothing to point at.
    //
    // Treated like "not-installed" rather than like "stopped" because systemd
    // has already made the call and will keep making it at every boot. That is
    // the distinction `condition-failed` exists to carry; see its definition.
    if (status === "condition-failed") {
      updateConfig({ daemon: { configured: false } });
      return [
        `failproofaid is installed but cannot start — a file its service requires is`,
        `gone (most often because failproofai was removed with \`npm rm -g\`, which`,
        `deletes the worker but leaves the service behind). This machine was`,
        `configured to require the daemon, which denies every tool call, so that flag`,
        `is cleared; policies now evaluate in-process.`,
        ``,
        `Run \`failproofai uninstall\` to remove the leftover service, or`,
        `\`failproofai config\` to rebuild it. \`${daemonStatusCommand()}\` names the missing path.`,
        ``,
      ];
    }

    // Installed and RUNNING is not the same as working, and the difference is
    // a total lockout. `ExecStart` bakes in `process.execPath`, so an
    // `nvm uninstall 20` months later leaves a unit systemd still calls active
    // whose worker dies on every spawn. Nothing else catches it: the install
    // probe cannot run retroactively, and the not-installed branch above never
    // fires because the unit is very much installed.
    //
    // Clearing the flag is the whole repair, and it is deliberately NOT
    // accompanied by an uninstall: this runs unprompted at the top of whatever
    // command the user typed, and tearing down a root-owned service from there
    // is not a decision to make on their behalf. Removing and reinstalling the
    // unit is the wizard's job, where a person is present — see the
    // `daemonAlreadyHealthy` probe in `configure-wizard.ts`.
    if (status === "running" && !(await probeDaemonEndToEnd())) {
      updateConfig({ daemon: { configured: false } });
      return [
        `failproofaid is running but cannot evaluate policies — its worker process`,
        `will not start (most often because the Node install its service was built`,
        `against is gone). This machine was configured to require it, which denies`,
        `every tool call, so that flag is cleared; policies now evaluate in-process.`,
        `Run \`failproofai config\` to rebuild the service.`,
        ``,
      ];
    }
    return [];
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
