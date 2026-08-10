/**
 * How a home written by an older layout reaches this one, step by step.
 *
 * ## The problem this replaces
 *
 * `resetHome(from)` took the layout it found and then largely ignored it: the
 * carry functions each asked "is layout 1's file here? is layout 2's?" and
 * handled whichever they found. That works for two old layouts and does not
 * scale — every carry has to know every historical path, so the knowledge grows
 * with the SQUARE of the layout count, in a set of hand-written functions with
 * nothing forcing them to stay complete. It is also the shape that produced every
 * silent-data-loss bug in `fp-reset.ts`'s history.
 *
 * A registry of steps replaces it. `planMigration()` composes a chain from what
 * is on disk to what this build speaks, and each step only has to know its own
 * ends.
 *
 * ## Keyed on the LAYOUT, never on the npm version
 *
 * The customer case is "on 1.0.0 for four months, then jumps to 1.3.0". The steps
 * are LAYOUT steps, not version steps, because npm versions change on every
 * release — dozens between two layouts — and a customer who skips thirty of them
 * with no layout change should run ZERO migrations, not thirty no-ops. The npm
 * version is recorded in the ledger for diagnostics and decides nothing.
 *
 * ## `to` is not always `from + 1`, and that is deliberate
 *
 * The obvious contract is single-hop steps. Today's two steps both land on layout
 * 3 — one from 1, one from 2 — because `resetHome` was written before this
 * registry existed and handles either source directly. Forcing them into single
 * hops would mean inventing a 1 → 2 step that produces an intermediate layout-2
 * home NO CODE IN THIS REPO WRITES ANY MORE, purely to satisfy the shape, and
 * then a 2 → 3 step that consumes it. That is more moving parts and one more
 * thing to get wrong, for a home state no user will ever hold.
 *
 * So the contract is `to > from`, and composition follows the `to` link rather
 * than counting. A chain from 1 today is one step; when layout 4 lands it becomes
 * `1 → 3` then `3 → 4`, and only the second has to be written.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { version as cliVersion } from "../../package.json";
import {
  LAYOUT_VERSION,
  configFile,
  credentialsFile,
  failproofaiHome,
  globalPolicyConfigFile,
  legacy,
  migrationBackupDir,
  migrationLedgerFile,
  migrationsDir,
  versionFile,
} from "./fp-home";
import { resetHome, type ResetOutcome } from "./fp-reset";

export interface Migration {
  /** The layout this step reads. */
  from: number;
  /** The layout the home speaks once it has run. Always greater than `from`. */
  to: number;
  /** One line, printed by `--dry-run`. Present tense, names what moves. */
  describe: string;
  run(): ResetOutcome;
}

/**
 * Every step, in order.
 *
 * Both current entries delegate to `resetHome`, which is where the actual carry
 * logic lives and stays — this module owns the ORDER and the record, not the
 * moves. A layout-4 step would be written as its own function here and would not
 * touch `resetHome` at all, which is the point: the next migration is additive.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 3,
    describe:
      "layout 1 → 3: carry the decision log out of cache/, keep the policy config in place, drop the layout-1 credential files",
    run: () => resetHome(1),
  },
  {
    from: 2,
    to: 3,
    describe:
      "layout 2 → 3: carry config.toml and credentials.toml into JSON, move custom-policies/ back up into policies/, nest the policy config at the root",
    run: () => resetHome(2),
  },
];

/**
 * The steps that take `from` to {@link LAYOUT_VERSION}.
 *
 * Returns an empty array when the home is already current. THROWS when no step
 * covers a layout, rather than returning a short chain — a partial plan silently
 * leaves a home half-migrated, which is the one outcome `fp-reset.ts`'s header
 * says is worse than refusing. `migrationCoverageGap()` below is the same check
 * run over every layout at once, so CI catches it before a user does.
 */
export function planMigration(from: number, registry: readonly Migration[] = MIGRATIONS): Migration[] {
  if (from >= LAYOUT_VERSION) return [];
  const chain: Migration[] = [];
  let at = from;
  while (at < LAYOUT_VERSION) {
    const step = registry.find((m) => m.from === at);
    if (!step) {
      throw new Error(
        `no migration from layout ${at} to ${LAYOUT_VERSION} — this build cannot upgrade that home`,
      );
    }
    chain.push(step);
    at = step.to;
  }
  return chain;
}

/**
 * Layouts with no way forward, and steps that cannot be reached.
 *
 * The CI guard. Bumping `LAYOUT_VERSION` without writing a step leaves every
 * older home unable to upgrade — and the symptom shows up on a user's machine
 * rather than in a test, because nothing in the normal path plans a chain for a
 * layout the developer does not happen to have on disk.
 */
export function migrationCoverageGap(registry: readonly Migration[] = MIGRATIONS): string[] {
  const problems: string[] = [];
  for (let layout = 1; layout < LAYOUT_VERSION; layout += 1) {
    try {
      planMigration(layout, registry);
    } catch {
      problems.push(`layout ${layout} has no path to ${LAYOUT_VERSION}`);
    }
  }
  for (const m of registry) {
    if (m.to <= m.from) problems.push(`step ${m.from} → ${m.to} does not move forward`);
    if (m.to > LAYOUT_VERSION) problems.push(`step ${m.from} → ${m.to} overshoots ${LAYOUT_VERSION}`);
  }
  const froms = registry.map((m) => m.from);
  if (froms.length !== new Set(froms).size) problems.push("two steps read the same layout");
  return problems;
}

// ── The ledger ───────────────────────────────────────────────────────────────

export interface LedgerEntry {
  from: number;
  to: number;
  /** The CLI that ran it. Diagnostics only — the chain is keyed on layout. */
  cli: string;
  /** ISO-8601, so a support request can be lined up against a deploy. */
  at: string;
  durationMs: number;
  ok: boolean;
  /** Counts, so "did my history survive" is answerable from the file alone. */
  removed?: number;
  migrated?: number;
  activity?: number;
}

export function readLedger(): LedgerEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(migrationLedgerFile(), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    // Absent on every machine that has never migrated, which is most of them.
    return [];
  }
}

/**
 * Append one entry.
 *
 * Read-modify-write rather than an append-only line format, because the file is
 * read as JSON by support and by `failproofai migrate --dry-run`, and a torn
 * final line would make the whole thing unparseable. Two migrations never race:
 * a migration only runs from a CLI command, and the onboarding lock already
 * serialises those.
 */
function appendLedger(entry: LedgerEntry): void {
  try {
    mkdirSync(migrationsDir(), { recursive: true });
    const all = [...readLedger(), entry];
    writeFileSync(migrationLedgerFile(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    // A ledger we cannot write must never fail the migration it is recording.
    // The `VERSION` stamp is what makes the migration durable; this is the audit
    // trail, and losing a line of it costs a support conversation, not a home.
  }
}

// ── The backup ───────────────────────────────────────────────────────────────

/**
 * The files worth copying before a step runs.
 *
 * Small, and each irreplaceable: nothing regenerates a cloud token, a policy
 * selection, or the settings that decide whether the machine fails closed. The
 * two retired TOMLs are included because a step is about to delete them, and they
 * are the only remaining copy of a layout-2 machine's enrolment.
 *
 * Deliberately NOT the whole home. `HOME_CLASSES` already stopped the migration
 * deleting anything irreplaceable by design, so a full copy would insure against
 * a threat that no longer exists — while costing a duplicate of `bin/` and
 * `hook-activity/`, and needing a rename window that has to dodge a live daemon.
 * What is left to insure against is a BUG in a step, and these files are where
 * such a bug would hurt.
 */
const BACKED_UP = [configFile, credentialsFile, globalPolicyConfigFile, versionFile];
const BACKED_UP_LEGACY = [
  legacy.configToml,
  legacy.credentialsToml,
  legacy.policyConfig,
  // Layout 1's credentials, which the migration DELETES and which nothing
  // regenerates. They were missing here while the carry that reads them was
  // added, so on the layout-1 leg — the one a user upgrading from the published
  // `latest` actually takes — the cloud token was removed with no copy kept. That
  // is precisely the file this backup exists for, and its absence made the backup
  // most incomplete exactly where it mattered most.
  legacy.cloudCredentials,
  legacy.ingestCredentials,
];

/**
 * The files that exist right now and would be backed up, each exactly once.
 *
 * ONE function, because there were two: `backupBeforeMigrating` deduped by path
 * and `describePlan` built the same list again without deduping, so
 * `migrate --dry-run` printed `policies-config.json` TWICE while the backup
 * correctly wrote it once. Seen on a real machine, in the one command whose
 * entire job is to state accurately what is about to happen.
 *
 * The duplicate is not a typo waiting to be spotted, it is structural:
 * `legacy.policyConfig()` and `globalPolicyConfigFile()` are the SAME path,
 * because layout 3 put the policy config back exactly where layout 1 kept it. Any
 * caller that walks both lists sees it twice. So the walk lives here once and
 * nobody walks those arrays directly — which is the same "state it once, derive
 * the rest" move `resettablePaths()` makes over `HOME_CLASSES`.
 */
function filesToBackUp(): string[] {
  const seen = new Set<string>();
  for (const at of [...BACKED_UP, ...BACKED_UP_LEGACY]) {
    const path = at();
    if (existsSync(path)) seen.add(path);
  }
  return [...seen];
}

/** Copy the irreplaceable files aside. Returns the basenames it saved. */
export function backupBeforeMigrating(from: number): string[] {
  const dir = migrationBackupDir(from);
  const saved: string[] = [];
  try {
    // A previous attempt's backup is replaced, not merged: a half-old, half-new
    // set is not a restorable snapshot of anything.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  for (const source of filesToBackUp()) {
    try {
      copyFileSync(source, resolve(dir, basename(source)));
      saved.push(basename(source));
    } catch {
      // One unreadable file must not stop the rest being saved, and must not
      // stop the migration — the backup is insurance, not a precondition.
    }
  }
  return saved.sort((a, b) => a.localeCompare(b));
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface MigrationRun {
  /** The layout found on disk. */
  from: number;
  steps: { from: number; to: number; ok: boolean }[];
  /** Basenames copied into `migrations/backup-layout<n>/`. */
  backedUp: string[];
  /** Merged outcome of every step that ran. */
  outcome: ResetOutcome;
  /** Set when a step threw. The home is left where that step got to. */
  failed?: { from: number; to: number; error: string };
}

/**
 * Run the chain from `from` to {@link LAYOUT_VERSION}, recording each step.
 *
 * The backup is taken ONCE, before the first step, against the layout actually
 * found — the point is to be able to get back to where the machine started, not
 * to snapshot each intermediate state.
 *
 * A step that throws STOPS the chain. It does not roll back: `resetHome` stamps
 * `VERSION` at the end of a successful run, so a step that failed part-way leaves
 * a home still marked with the old layout, which is the state the next command
 * will correctly try to migrate again. Continuing past a failure would be the
 * genuinely dangerous option — it would run a step against a home whose
 * preconditions the previous step never established.
 */
export function runMigrations(
  from: number,
  /**
   * The chain to run. Defaults to the real plan; a caller passes one only to
   * exercise a path the real registry cannot currently produce — a step that
   * THROWS, which is the branch that decides whether a machine can be left
   * half-migrated and is therefore the one most worth a test.
   */
  chain: readonly Migration[] = planMigration(from),
): MigrationRun {
  const backedUp = backupBeforeMigrating(from);
  const steps: MigrationRun["steps"] = [];
  const outcome: ResetOutcome = {
    removed: [],
    migrated: [],
    activity: [],
    policyConfig: [],
    from,
  };
  let failed: MigrationRun["failed"];

  for (const step of chain) {
    const startedAt = Date.now();
    try {
      const result = step.run();
      outcome.removed.push(...result.removed);
      outcome.migrated.push(...result.migrated);
      outcome.activity.push(...result.activity);
      outcome.policyConfig.push(...result.policyConfig);
      steps.push({ from: step.from, to: step.to, ok: true });
      appendLedger({
        from: step.from,
        to: step.to,
        cli: cliVersion,
        at: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        ok: true,
        removed: result.removed.length,
        migrated: result.migrated.length,
        activity: result.activity.length,
      });
    } catch (err) {
      steps.push({ from: step.from, to: step.to, ok: false });
      failed = {
        from: step.from,
        to: step.to,
        error: err instanceof Error ? err.message : String(err),
      };
      appendLedger({
        from: step.from,
        to: step.to,
        cli: cliVersion,
        at: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        ok: false,
      });
      break;
    }
  }

  return { from, steps, backedUp, outcome, failed };
}

/** What `--dry-run` prints: the chain, and what was saved last time. */
export function describePlan(from: number): string[] {
  if (from >= LAYOUT_VERSION) {
    return [`${failproofaiHome()} is already at layout ${LAYOUT_VERSION}. Nothing to migrate.`];
  }
  let chain: Migration[];
  try {
    chain = planMigration(from);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  return [
    `Layout ${from} on disk; this build speaks ${LAYOUT_VERSION}.`,
    `${chain.length} step(s) would run:`,
    ...chain.map((m) => `  ${m.from} → ${m.to}  ${m.describe}`),
    ``,
    `These would be copied to ${migrationBackupDir(from)} first:`,
    ...filesToBackUp().map((p) => `  ${basename(p)}`),
    ``,
    `Settings, cloud enrolment, policy selection, your own policy files, decision`,
    `history and undelivered events are carried, not removed — see \`HOME_CLASSES\`.`,
  ];
}

/** Restore a backup taken before the layout-`n` migration. */
export function restoreBackup(layout: number): string[] {
  const dir = migrationBackupDir(layout);
  if (!existsSync(dir)) return [];
  const restored: string[] = [];
  for (const at of [...BACKED_UP, ...BACKED_UP_LEGACY]) {
    const target = at();
    const source = resolve(dir, basename(target));
    if (!existsSync(source)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      restored.push(basename(target));
    } catch {
      // Report what did land rather than claiming a restore that did not.
    }
  }
  return restored.sort((a, b) => a.localeCompare(b));
}
