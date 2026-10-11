/**
 * `failproofai uninstall` — the sanctioned way off this machine.
 *
 * It exists because npm cannot do it. npm runs NO uninstall script (this repo
 * proved that empirically and deleted the dead `preuninstall` that assumed
 * otherwise), so `npm rm -g failproofai` deletes the package and leaves behind
 * every durable thing the package installed: hook entries in up to twelve agent
 * CLIs' settings files, and a root-owned systemd unit.
 *
 * That leftovers set is not inert. The hook entries invoke `npx -y failproofai`,
 * which happily re-downloads the package from the registry — so a "removed"
 * failproofai keeps running on every tool call. And on a machine with
 * `[daemon] configured = true`, the surviving unit points at a worker script
 * that npm just deleted, which under fail-closed semantics denies EVERY tool
 * call across every agent CLI, with nothing on screen naming the cause.
 *
 * ORDER IS THE SAFETY PROPERTY HERE, and it is not the obvious one.
 *
 * `daemonConfigured` is cleared FIRST — before hooks, before the service, before
 * anything that can fail or need a password. From that instant the machine can
 * only fail OPEN: policies evaluate in-process, and every later step is
 * best-effort cleanup. Doing it in the intuitive order (tear the service down,
 * then update config) leaves a window where the flag demands a daemon that is
 * already gone, and that window is a total lockout of the user's agent — the
 * exact failure `healDaemonFlag` was written to repair after it bricked a
 * machine during development.
 *
 * Nothing here is silent about failure. A step that cannot complete (no sudo,
 * an unwritable settings file) is reported with the command to finish it by
 * hand, and the exit code says whether anything was left behind — because the
 * one thing worse than a leftover unit is a leftover unit the operator was told
 * did not exist.
 */
import { existsSync, rmSync } from "node:fs";

import { failproofaiHome } from "./fp-home";
import { readConfig } from "./fp-config";
import {
  daemonServiceFilePath,
  daemonServiceStatus,
  daemonStatusCommand,
  isDaemonSupportedPlatform,
  primeElevation,
  setDaemonConfigured,
  uninstallDaemonService,
} from "./daemon-service";
import { listInstallableIds, getIntegration } from "./integrations";
import type { IntegrationType } from "./types";
import { removeHooks } from "./manager";
import { optsFor, screenKit, type RenderOpts } from "./tui";

export interface UninstallOptions {
  /** Also delete ~/.failproofai (config, credentials, state, audit cache, daemon binary). */
  purge?: boolean;
  /** Report what would change and touch nothing. */
  dryRun?: boolean;
  /** Proceed without the interactive confirmation. */
  yes?: boolean;
  /** Project/local scopes are read relative to here. */
  cwd?: string;
  /**
   * The ONE question (D17): handed the plan — which says exactly what goes —
   * and answering yes removes all of it, the daemon service included, exactly
   * as `--yes` does. Injected so the decision is testable without a TTY.
   * Absent means "no confirmation available", which is a REFUSAL rather than
   * an assumed yes — see the non-interactive branch.
   *
   * There used to be a second question, whether to keep the service. Keeping
   * the daemon while removing the hooks is `failproofai policies --uninstall`,
   * which takes the hooks out and leaves everything else alone.
   */
  confirm?: (lines: string[]) => Promise<boolean>;
  /**
   * Ask for the sudo password before removing the service. Injected for tests;
   * defaults to `primeElevation`.
   */
  elevate?: () => boolean;
  /** How to draw the lines. Defaults to what stdout can show. */
  render?: RenderOpts;
}

export interface UninstallResult {
  exitCode: number;
  lines: string[];
  /**
   * How many leading entries of `lines` are the plan — the block already handed
   * to `confirm`.
   *
   * Returned rather than inferred so the caller can skip re-printing it without
   * pattern-matching its own output. A caller that guesses (by searching for a
   * blank line, say) silently prints the whole plan twice the day a message
   * above it gains one.
   */
  planLines: number;
  /**
   * Whether `~/.failproofai` was actually deleted.
   *
   * The caller needs this to know that NOTHING may touch the home afterwards.
   * Telemetry is the trap: `getInstanceId()` lazily writes
   * `state/telemetry-id`, so a routine post-command event re-created the whole
   * directory seconds after the purge reported deleting it — leaving a machine
   * the user had just wiped holding a brand-new tracking identifier, and the
   * command's own "✓ deleted" line a lie. Caught by the container test, which
   * checked the filesystem rather than the output.
   */
  purged: boolean;
}

/** Everything this machine has that uninstalling would remove. */
interface Leftovers {
  clis: IntegrationType[];
  servicePath: string | null;
  serviceInstalled: boolean;
  daemonConfigured: boolean;
  homeExists: boolean;
}

function survey(cwd?: string): Leftovers {
  const clis: IntegrationType[] = [];
  // Every INSTALLABLE cli, not every DETECTED one. A CLI can be uninstalled
  // after failproofai wrote hooks into its settings file, and those entries are
  // exactly the orphans this command exists to clear — surveying only what is
  // currently on PATH would walk straight past them.
  for (const id of listInstallableIds()) {
    for (const scope of ["user", "project", "local"] as const) {
      try {
        if (getIntegration(id).hooksInstalledInSettings(scope, cwd)) {
          clis.push(id);
          break;
        }
      } catch {
        // An unreadable or malformed settings file is not proof of absence, but
        // it is not proof of presence either, and `removeHooks` will report its
        // own failure against it later with a better message than a guess here.
      }
    }
  }

  let daemonConfigured = false;
  try {
    daemonConfigured = readConfig().daemon.configured;
  } catch {
    /* no config = nothing configured */
  }

  const servicePath = isDaemonSupportedPlatform() ? daemonServiceFilePath() : null;
  return {
    clis,
    servicePath,
    serviceInstalled: !!servicePath && existsSync(servicePath),
    daemonConfigured,
    homeExists: existsSync(failproofaiHome()),
  };
}

export async function runUninstallCommand(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const found = survey(opts.cwd);
  const kit = screenKit(opts.render ?? optsFor(process.stdout));
  const home = failproofaiHome();
  const many = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const lines: string[] = [];

  const nothingToDo =
    found.clis.length === 0 && !found.serviceInstalled && !found.daemonConfigured &&
    !(opts.purge && found.homeExists);
  if (nothingToDo) {
    return {
      exitCode: 0,
      planLines: 0,
      purged: false,
      lines: kit.notice(
        "ok",
        "Nothing to uninstall: no hooks, no failproofaid service, and nothing configured." +
          (found.homeExists && !opts.purge
            ? `\n${home} still holds settings and history. Delete it with  \`failproofai uninstall --purge\``
            : ""),
      ),
    };
  }

  // The plan is the question (D17), and it is the same text the confirmation
  // shows, so what is agreed to and what is done cannot drift. It names every
  // thing the steps below remove, read off them rather than summarised:
  // `removeHooks(undefined, "all", …)` also resets the policy settings in
  // policies-config.json, which "settings survive a reinstall" used to hide.
  const purging = Boolean(opts.purge && found.homeExists);
  const removals: string[] = [];
  if (found.clis.length > 0) removals.push(`failproofai's hooks from ${many(found.clis.length, "agent")}`);
  if (found.serviceInstalled) removals.push("the failproofaid service (needs sudo)");
  if (purging) removals.push(home);
  const releasesDaemon = found.daemonConfigured && !found.serviceInstalled;
  const listed =
    removals.length <= 1 ? removals.join("") : `${removals.slice(0, -1).join(", ")} and ${removals[removals.length - 1]}`;
  const lead =
    removals.length === 0
      ? "This stops this machine requiring the failproofaid daemon."
      : `This removes ${listed}${releasesDaemon ? ", and stops this machine requiring the failproofaid daemon" : ""}.`;
  const details: string[] = [];
  if (found.clis.length > 0) {
    details.push(
      `Agents: ${found.clis.map((id) => getIntegration(id).displayName ?? id).join(", ")}`,
      "Also resets enabled policies, custom policy paths and policy parameters in policies-config.json.",
    );
  }
  if (purging) details.push(`${home} holds your settings, credentials, audit history and the daemon binary.`);
  else if (found.homeExists) {
    details.push(`${found.clis.length > 0 ? "The rest of " : ""}${home} is kept unless you add --purge.`);
  }

  // `--yes` asks nothing, so it has no question to show: what it did follows.
  // A dry run IS the plan, and a refusal says what it would have removed.
  if (opts.dryRun || !opts.yes) lines.push(...kit.notice("caution", [lead, ...details].join("\n")));
  // Everything pushed so far IS the plan; `confirm` is shown exactly this.
  const planLines = lines.length;

  if (opts.dryRun) {
    lines.push("", kit.ok("Dry run: nothing was changed."));
    return { exitCode: 0, lines, planLines, purged: false };
  }

  if (!opts.yes) {
    // No confirmation channel and no --yes is a REFUSAL, never an assumed yes.
    // This runs in scripts and CI, where a prompt that cannot be answered would
    // otherwise read as consent to delete a root-owned service.
    if (!opts.confirm) {
      lines.push(
        "",
        ...kit.notice(
          "fail",
          "Nothing was removed: there is no terminal to confirm on.\n" +
            `Re-run with --yes to go ahead:  \`failproofai uninstall${opts.purge ? " --purge" : ""} --yes\``,
        ),
      );
      return { exitCode: 1, lines, planLines, purged: false };
    }
    if (!(await opts.confirm(lines))) {
      return { exitCode: 1, planLines, purged: false, lines: [...lines, "", "Cancelled. Nothing was changed."] };
    }
  }

  if (lines.length > 0) lines.push("");
  const failures: string[] = [];
  let purged = false;

  // STEP 1, and it must stay step 1. See the header: from here the machine can
  // only fail open, so every remaining step is cleanup rather than a step that
  // can lock anybody out by failing halfway.
  if (found.daemonConfigured) {
    try {
      setDaemonConfigured(false);
      lines.push(kit.ok("This machine no longer requires the daemon; policies evaluate in-process."));
    } catch (err) {
      // Uniquely fatal: everything after this assumes the flag is down. Removing
      // the service while it is still up is the lockout this command exists to
      // prevent, so stop rather than press on.
      return {
        exitCode: 2,
        planLines,
        purged: false,
        lines: [
          ...lines,
          ...kit.notice(
            "fail",
            `Could not update ${home}/config.json: ${errText(err)}\n` +
              "Stopped before the service: removing it while this machine requires it would deny every tool call.\n" +
              "Fix the file's permissions, then run  `failproofai uninstall`  again.",
          ),
        ],
      };
    }
  }

  if (found.clis.length > 0) {
    try {
      // Scope "all" and every cli that HAS entries — the same list the plan
      // named. `removeCustomHooks` clears the configured custom-policy paths as
      // well; leaving them behind would point a reinstall at files this command
      // may be about to purge.
      // Silent: the line below says what happened, under the question, and
      // `removeHooks`' own `policies --uninstall` rows would land between them.
      await removeHooks(undefined, "all", opts.cwd, {
        cli: found.clis,
        removeCustomHooks: true,
        source: "uninstall_command",
        silent: true,
      });
      lines.push(kit.ok(`Removed hooks from ${many(found.clis.length, "agent")}.`));
    } catch (err) {
      failures.push(
        `Could not remove the hooks: ${errText(err)}\n` +
          "Finish with  `failproofai policies --uninstall --scope all`",
      );
    }
  }

  if (found.serviceInstalled) {
    // Every run that gets here agreed to the whole plan, and the plan names the
    // service: `--yes` is yes to the plan, an interactive yes is the same answer
    // to the same text (D17), and `--purge` cannot leave it behind anyway — it
    // deletes `~/.failproofai`, where the daemon BINARY lives
    // (`bin/failproofaid-<version>`), so an enabled unit left pointing at it
    // would crash-loop at every boot.
    //
    // Ask for the password BEFORE trying, rather than failing on `sudo -n` and
    // printing a unit file to delete by hand. `uninstallDaemonService()` is
    // deliberately non-interactive — the wizard cannot prompt from under a
    // full-screen TUI — but this command is plain line output and has a person
    // in front of it, which is the same reasoning `failproofai update` follows.
    // Best-effort: a refused or absent sudo still falls through to the
    // "still there, here is what to run as root" path below.
    const elevate = opts.elevate ?? primeElevation;
    try {
      elevate();
    } catch {
      // A failed prompt is not a reason to skip the attempt; `sudo -n` inside
      // the removal will simply fail the same way it would have anyway.
    }
    // What to run as root when the removal could not elevate, and where to look.
    const byHand = (servicePath: string): string =>
      "\nRemove it as root:\n" +
      manualServiceRemoval(servicePath).map((step) => `  \`${step}\``).join("\n") +
      (daemonStatusCommand() ? `\nCheck it with  \`${daemonStatusCommand()}\`` : "");
    try {
      await uninstallDaemonService();
      // uninstallDaemonService is best-effort by contract — it warns and
      // returns rather than throwing when it cannot elevate — so the unit file
      // is what gets believed here, not the absence of an exception.
      if (found.servicePath && existsSync(found.servicePath)) {
        failures.push(
          "The failproofaid service is still there, most often because sudo was not available." +
            byHand(found.servicePath),
        );
      } else {
        lines.push(kit.ok("Stopped and removed the failproofaid service."));
      }
    } catch (err) {
      failures.push(
        `Could not remove the failproofaid service: ${errText(err)}` +
          (found.servicePath && existsSync(found.servicePath) ? byHand(found.servicePath) : ""),
      );
    }
  }

  if (purging) {
    // Last, and only after the service is down: the daemon binary and its
    // socket live here, and deleting them out from under a running unit is how
    // a clean uninstall turns into a restart loop.
    try {
      rmSync(home, { recursive: true, force: true });
      purged = true;
      lines.push(kit.ok(`Deleted ${home}.`));
    } catch (err) {
      failures.push(`Could not delete ${home}: ${errText(err)}`);
    }
  }

  if (failures.length > 0) {
    lines.push("");
    for (const failure of failures) lines.push(...kit.notice("fail", failure));
    // Exit 1, not 0: enforcement is off (step 1 succeeded, or there was nothing
    // to clear), but something durable is still installed and the operator has
    // to act. A 0 here is what makes people believe a machine is clean when a
    // root-owned unit is still on it.
    return { exitCode: 1, lines, planLines, purged };
  }

  // npm runs no uninstall script, which is why this command exists — and why
  // the package itself is still there for npm to remove.
  lines.push(
    "",
    ...kit.notice(
      "ok",
      "failproofai no longer enforces anything on this machine.\n" +
        "Remove the npm package too:  `npm rm -g failproofai`" +
        (!opts.purge && found.homeExists ? `\n${home} was kept. Delete it with  \`failproofai uninstall --purge\`` : ""),
    ),
  );
  return { exitCode: 0, lines, planLines, purged };
}

/** The exact commands to finish a service removal that could not elevate. */
function manualServiceRemoval(servicePath: string): string[] {
  if (process.platform === "darwin") {
    return [`sudo launchctl unload -w ${servicePath}`, `sudo rm -f ${servicePath}`];
  }
  const unit = servicePath.split("/").pop() ?? servicePath;
  return [
    `sudo systemctl disable --now ${unit}`,
    `sudo rm -f ${servicePath}`,
    `sudo systemctl daemon-reload`,
  ];
}

/** What `daemonServiceStatus()` says, for the status line the CLI prints. */
export function serviceStateLabel(): string {
  const status = daemonServiceStatus();
  if (status === "condition-failed") return "installed but skipped by systemd (a file it needs is missing)";
  // Printing a bare "unknown" invites the reading "something is wrong". It is
  // narrower than that: the service is installed and we could not read its
  // state, because doing so on macOS needs root and no sudo credential was
  // cached. Say which, so the reader knows there is nothing to fix.
  if (status === "unknown") return "installed (state needs sudo to read)";
  return status;
}
