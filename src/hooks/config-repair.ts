/**
 * Put a drifted CLI hook config back into the shape this build installs.
 *
 * `config-drift.ts` finds files whose shape no longer matches what
 * `writeHookEntries` produces. This rewrites them — which makes it the single
 * most dangerous automated action in the product, because the file it touches
 * is the only thing telling a vendor's CLI to call us at all. Get it wrong and
 * the machine stops enforcing, silently, which is the failure repair exists to
 * end.
 *
 * ## Why it runs unattended anyway
 *
 * The alternative was "warn, and let a human fix it". failproofai runs on
 * headless servers with no operator, where a warning goes to a log nobody
 * opens — indistinguishable from everything working. So a warn-only design
 * guarantees a long window of silent zero enforcement on exactly the machines
 * that cannot report it and where an unattended agent matters most.
 *
 * The failure symmetry is what makes that defensible: on an unmonitored box,
 * *no* repair means enforcement is silently absent, and a *bad* repair means
 * enforcement is silently absent plus a mangled file. Nobody notices either.
 * So the rules below are not there to protect a watching human — they exist so
 * the worst case of repairing is no worse than not repairing.
 *
 * ## The rules
 *
 * 1. **Only `stale`.** Never `absent` (they never installed here — installing
 *    would be us deciding for them), never `stale_path` (benign: our own
 *    install path, not the vendor's format), never `unsupported`, and never
 *    `unreadable` — repair runs the same writer that already threw, so it would
 *    fail every attempt while looking like it tried.
 * 2. **Never this repo's own dogfood configs.** They carry the same marker a
 *    real install does; rewriting one points enforcement at the published
 *    package while the tree is being edited.
 * 3. **Back up first, verify after, roll back on failure.** Verification is not
 *    "we wrote the file" — that is the tautology `hooksInstalledInSettings()`
 *    already fails at. It is re-running detection and requiring `ok`.
 * 4. **Never throw.** A repair pass that dies partway is how a machine ends up
 *    with one file rewritten and eleven not, and no record of which.
 *
 * What this deliberately does NOT prove is that the vendor now accepts the
 * file. Only the vendor's own behaviour can show that — hooks arriving again —
 * and that check belongs to whatever schedules this, not to the write itself.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getIntegration, resetMistypedContainers } from "./integrations";
import { configBackupsDir } from "./fp-home";
import { detectConfigDrift, type ConfigDriftReport } from "./config-drift";
import type { HookScope, IntegrationType } from "./types";
import { resolveFailproofaiBinary } from "./manager";

/** Backups kept per (cli, scope). Enough to undo, bounded so it cannot grow. */
const KEEP_BACKUPS = 3;

export type RepairAction =
  /** Rewritten, and detection now reports `ok`. */
  | "repaired"
  /** Not eligible — the status was not `stale`, or it is a dogfood config. */
  | "skipped"
  /** Rewritten, still not `ok`, previous bytes restored. */
  | "rolled_back"
  /** Could not be attempted or the rollback itself failed. Needs a human. */
  | "failed";

export interface RepairOutcome {
  cli: IntegrationType;
  scope: HookScope;
  settingsPath: string;
  action: RepairAction;
  /** Why, in a form a log line can carry. Never file contents. */
  reason: string;
  backupPath?: string;
}

export interface RepairOptions {
  cwd?: string;
  /** Report what would happen and touch nothing. */
  dryRun?: boolean;
  /** Restrict to these CLIs. */
  clis?: readonly IntegrationType[];
  /** Restrict to these scopes. */
  scopes?: readonly HookScope[];
}

/**
 * Everything one repair is about to overwrite, and whether it existed.
 *
 * `existed: false` is not a detail — it is the inverse operation. A repair that
 * CREATES a file (a registration whose shim was missing) must, on rollback,
 * delete it again. Restoring "nothing" by doing nothing would leave the machine
 * holding a file it did not have before, which is not the state we promised to
 * return it to.
 */
interface BackedUpFile {
  original: string;
  copy: string;
  existed: boolean;
}

interface BackupSet {
  dir: string;
  /** The settings file's copy, for the outcome's `backupPath`. */
  settingsCopy: string;
  files: BackedUpFile[];
}

/**
 * Copy everything this repair can touch, before touching any of it.
 *
 * Under `~/.failproofai` rather than beside the originals: a `.bak` dropped
 * next to `~/.claude/settings.json` is clutter in someone else's directory, and
 * some vendors read every file in their config dir.
 *
 * One directory per repair, because a repair is not always one file. OpenCode's
 * installation is a settings entry AND a generated plugin shim, and an earlier
 * version of this backed up only the settings file — so repair could write two
 * files and undo one. The guarantee is "no worse than not repairing", and that
 * was quietly false for the one integration with a sidecar: a bad shim plus a
 * restored settings file is a mismatched pair, and a machine left worse than we
 * found it.
 */
function backup(
  cli: IntegrationType,
  scope: HookScope,
  settingsPath: string,
  sidecarPaths: readonly string[],
): BackupSet {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(configBackupsDir(), `${cli}-${scope}`, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files: BackedUpFile[] = [];
  const record = (original: string, name: string): void => {
    const copy = join(dir, name);
    const existed = existsSync(original);
    if (existed) copyFileSync(original, copy);
    files.push({ original, copy, existed });
  };

  record(settingsPath, "settings.bak");
  sidecarPaths.forEach((path, i) => record(path, `sidecar-${i}.bak`));

  // Self-describing, so a human restoring by hand after a failed rollback can
  // see what went where without reading this file.
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ cli, scope, files }, null, 2), {
    mode: 0o600,
  });

  prune(join(configBackupsDir(), `${cli}-${scope}`));
  return { dir, settingsCopy: join(dir, "settings.bak"), files };
}

/** Keep the newest few repairs whole; a half-pruned set cannot restore. */
function prune(parent: string): void {
  try {
    const entries = readdirSync(parent)
      .map((n) => ({ n, path: join(parent, n) }))
      .filter((e) => {
        try {
          return statSync(e.path).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => ({ ...e, t: statSync(e.path).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const stale of entries.slice(KEEP_BACKUPS)) {
      rmSync(stale.path, { recursive: true, force: true });
    }
  } catch {
    // Pruning is hygiene; failing it must not fail a repair.
  }
}

/** Re-run detection for exactly one file. The only honest "did it work". */
function statusAfter(
  cli: IntegrationType,
  scope: HookScope,
  settingsPath: string,
  cwd: string,
): ConfigDriftReport | undefined {
  return detectConfigDrift({ clis: [cli], scopes: [scope], cwd }).find(
    (r) => r.settingsPath === settingsPath,
  );
}

function repairOne(report: ConfigDriftReport, cwd: string, dryRun: boolean): RepairOutcome {
  const { cli, scope, settingsPath } = report;
  const base = { cli, scope, settingsPath };

  if (report.status !== "stale") {
    return { ...base, action: "skipped", reason: `status=${report.status}` };
  }
  if (!existsSync(settingsPath)) {
    return { ...base, action: "skipped", reason: "vanished-before-repair" };
  }
  if (dryRun) {
    return { ...base, action: "skipped", reason: "dry-run" };
  }

  const integration = getIntegration(cli);
  const binaryPath = resolveFailproofaiBinary();

  let backupSet: BackupSet;
  try {
    // Ask the integration what else it owns. Only OpenCode answers with
    // anything — its generated plugin shim — and that is exactly the file an
    // earlier version of this could overwrite but not put back.
    let sidecarPaths: string[] = [];
    try {
      sidecarPaths = (integration.sidecarFiles?.(binaryPath, scope, settingsPath) ?? []).map(
        (f) => f.path,
      );
    } catch {
      // An integration that cannot describe its sidecars gets none backed up,
      // which is the status quo rather than a regression.
    }
    backupSet = backup(cli, scope, settingsPath, sidecarPaths);
  } catch (err) {
    // No backup means no way back, so we do not proceed. Refusing to repair is
    // the safe direction: it leaves the machine exactly as it was.
    return { ...base, action: "failed", reason: `backup-failed:${errorClass(err)}` };
  }

  let coerced: string[] = [];
  try {
    const settings = integration.readSettings(settingsPath);

    // Shared with the install path: a container whose type the vendor changed
    // cannot be written into, and reinstalling hits the same wall every time.
    coerced = resetMistypedContainers(integration, settings, binaryPath, scope);

    integration.writeHookEntries(settings, binaryPath, scope);
    integration.writeSettings(settingsPath, settings);
  } catch (err) {
    return restore(base, backupSet, `write-failed:${errorClass(err)}`);
  }

  const after = statusAfter(cli, scope, settingsPath, cwd);
  if (after?.status === "ok") {
    const note = coerced.length > 0 ? `verified-ok;coerced=${coerced.join(",")}` : "verified-ok";
    return { ...base, action: "repaired", reason: note, backupPath: backupSet.settingsCopy };
  }
  return restore(base, backupSet, `unverified:${after?.status ?? "gone"}`);
}

function restore(
  base: { cli: IntegrationType; scope: HookScope; settingsPath: string },
  set: BackupSet,
  reason: string,
): RepairOutcome {
  const failures: string[] = [];
  for (const file of set.files) {
    try {
      if (file.existed) copyFileSync(file.copy, file.original);
      // Did not exist before, so it must not exist after: this repair created
      // it, and rollback means the machine as it was.
      else rmSync(file.original, { force: true });
    } catch (err) {
      failures.push(errorClass(err));
    }
  }

  if (failures.length === 0) {
    return { ...base, action: "rolled_back", reason, backupPath: set.settingsCopy };
  }
  // The worst outcome available: we wrote, it did not verify, and we could not
  // put everything back. Say so loudly and name the directory, because a human
  // restoring it by hand is now the only route.
  return {
    ...base,
    action: "failed",
    reason: `${reason};restore-failed:${failures.join(",")}`,
    backupPath: set.dir,
  };
}

function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? err.constructor.name;
  }
  return "unknown";
}

/**
 * Repair every drifted config we are allowed to touch.
 *
 * Never throws: one file that cannot be repaired must not stop the other
 * eleven, because a partial pass with no record is worse than either outcome.
 */
export function repairConfigDrift(opts: RepairOptions = {}): RepairOutcome[] {
  const cwd = opts.cwd ?? process.cwd();
  const reports = detectConfigDrift({ cwd, clis: opts.clis, scopes: opts.scopes });
  const out: RepairOutcome[] = [];
  for (const report of reports) {
    // `absent` is the common case on any machine — reporting a skip for each
    // would bury the handful that matter.
    if (report.status === "absent") continue;
    try {
      out.push(repairOne(report, cwd, opts.dryRun === true));
    } catch (err) {
      out.push({
        cli: report.cli,
        scope: report.scope,
        settingsPath: report.settingsPath,
        action: "failed",
        reason: `unexpected:${errorClass(err)}`,
      });
    }
  }
  return out;
}
