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
  setDaemonConfigured,
  uninstallDaemonService,
} from "./daemon-service";
import { listInstallableIds, getIntegration } from "./integrations";
import type { IntegrationType } from "./types";
import { removeHooks } from "./manager";

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
   * Injected so the decision is testable without a TTY. Absent means "no
   * confirmation available", which is a REFUSAL rather than an assumed yes —
   * see the non-interactive branch.
   */
  confirm?: (lines: string[]) => Promise<boolean>;
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
  const lines: string[] = [];

  const nothingToDo =
    found.clis.length === 0 && !found.serviceInstalled && !found.daemonConfigured &&
    !(opts.purge && found.homeExists);
  if (nothingToDo) {
    return {
      exitCode: 0,
      planLines: 0,
      purged: false,
      lines: [
        "Nothing to uninstall — no hook entries, no daemon service, and nothing configured.",
        ...(found.homeExists && !opts.purge
          ? [``, `${failproofaiHome()} still holds settings and audit history.`,
             `Remove it with \`failproofai uninstall --purge\`.`]
          : []),
      ],
    };
  }

  // The plan is shown before anything happens and is the same text the
  // confirmation asks about, so what is agreed to and what is done cannot drift.
  const plan: string[] = [];
  if (found.clis.length > 0) {
    plan.push(
      `  • remove failproofai hook entries from ${found.clis.length} agent CLI${found.clis.length === 1 ? "" : "s"}: ` +
        found.clis.map((id) => getIntegration(id).displayName ?? id).join(", "),
    );
  }
  if (found.daemonConfigured) {
    plan.push(`  • stop requiring the daemon (policies go back to evaluating in-process)`);
  }
  if (found.serviceInstalled) {
    plan.push(`  • stop, disable and delete the service at ${found.servicePath} — needs sudo`);
  }
  let purged = false;
  if (opts.purge && found.homeExists) {
    plan.push(`  • delete ${failproofaiHome()} — settings, credentials, audit history and the daemon binary`);
  }

  lines.push("failproofai uninstall will:", ...plan);
  if (!opts.purge && found.homeExists) {
    lines.push(
      ``,
      `${failproofaiHome()} is KEPT (settings and audit history survive a reinstall).`,
      `Add --purge to delete it too.`,
    );
  }
  // Everything pushed so far IS the plan; `confirm` is shown exactly this.
  const planLines = lines.length;

  if (opts.dryRun) {
    lines.push(``, `--dry-run: nothing was changed.`);
    return { exitCode: 0, lines, planLines, purged: false };
  }

  if (!opts.yes) {
    // No confirmation channel and no --yes is a REFUSAL, never an assumed yes.
    // This runs in scripts and CI, where a prompt that cannot be answered would
    // otherwise read as consent to delete a root-owned service.
    if (!opts.confirm) {
      lines.push(``, `Refusing to uninstall without confirmation. Re-run with --yes.`);
      return { exitCode: 1, lines, planLines, purged: false };
    }
    if (!(await opts.confirm(lines))) {
      return { exitCode: 1, planLines, purged: false, lines: [...lines, ``, `Cancelled — nothing was changed.`] };
    }
  }

  lines.push(``);
  const failures: string[] = [];

  // STEP 1, and it must stay step 1. See the header: from here the machine can
  // only fail open, so every remaining step is cleanup rather than a step that
  // can lock anybody out by failing halfway.
  if (found.daemonConfigured) {
    try {
      setDaemonConfigured(false);
      lines.push(`✓ policies now evaluate in-process (this machine no longer requires the daemon)`);
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
          `✗ could not update ${failproofaiHome()}/config.json: ${err instanceof Error ? err.message : String(err)}`,
          ``,
          `Stopped before touching the service. Removing it while this machine still`,
          `requires it would deny every tool call. Fix the file's permissions and re-run.`,
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
      await removeHooks(undefined, "all", opts.cwd, {
        cli: found.clis,
        removeCustomHooks: true,
        source: "uninstall_command",
      });
      lines.push(`✓ removed hook entries from ${found.clis.length} agent CLI${found.clis.length === 1 ? "" : "s"}`);
    } catch (err) {
      failures.push(
        `hook entries: ${err instanceof Error ? err.message : String(err)} ` +
          `(finish with \`failproofai policies --uninstall --scope all\`)`,
      );
    }
  }

  if (found.serviceInstalled) {
    try {
      await uninstallDaemonService();
      // uninstallDaemonService is best-effort by contract — it warns and
      // returns rather than throwing when it cannot elevate — so the unit file
      // is what gets believed here, not the absence of an exception.
      if (found.servicePath && existsSync(found.servicePath)) {
        failures.push(
          `the service at ${found.servicePath} is still there (most often: no sudo). ` +
            `Remove it with the commands below.`,
        );
      } else {
        lines.push(`✓ stopped and removed the daemon service`);
      }
    } catch (err) {
      failures.push(`daemon service: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.purge && found.homeExists) {
    // Last, and only after the service is down: the daemon binary and its
    // socket live here, and deleting them out from under a running unit is how
    // a clean uninstall turns into a restart loop.
    try {
      rmSync(failproofaiHome(), { recursive: true, force: true });
      purged = true;
      lines.push(`✓ deleted ${failproofaiHome()}`);
    } catch (err) {
      failures.push(`${failproofaiHome()}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    lines.push(``, `Not everything could be removed:`);
    for (const f of failures) lines.push(`  ✗ ${f}`);
    if (found.servicePath && existsSync(found.servicePath)) {
      lines.push(
        ``,
        `To remove the service by hand:`,
        ...manualServiceRemoval(found.servicePath),
        ``,
        `(\`${daemonStatusCommand()}\` shows its current state.)`,
      );
    }
    // Exit 1, not 0: enforcement is off (step 1 succeeded, or there was nothing
    // to clear), but something durable is still installed and the operator has
    // to act. A 0 here is what makes people believe a machine is clean when a
    // root-owned unit is still on it.
    return { exitCode: 1, lines, planLines, purged };
  }

  lines.push(
    ``,
    `Done. failproofai no longer enforces anything on this machine.`,
    ``,
    `The npm package itself is still installed — npm runs no uninstall script, which`,
    `is why this command exists. Remove it with:`,
    `  npm rm -g failproofai`,
  );
  if (!opts.purge && found.homeExists) {
    lines.push(``, `${failproofaiHome()} was kept. Delete it with \`failproofai uninstall --purge\`.`);
  }
  return { exitCode: 0, lines, planLines, purged };
}

/** The exact commands to finish a service removal that could not elevate. */
function manualServiceRemoval(servicePath: string): string[] {
  if (process.platform === "darwin") {
    return [`  sudo launchctl unload -w ${servicePath}`, `  sudo rm -f ${servicePath}`];
  }
  const unit = servicePath.split("/").pop() ?? servicePath;
  return [
    `  sudo systemctl disable --now ${unit}`,
    `  sudo rm -f ${servicePath}`,
    `  sudo systemctl daemon-reload`,
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
