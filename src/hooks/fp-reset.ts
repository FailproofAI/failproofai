/**
 * What happens when this CLI meets a home directory written by a different
 * layout.
 *
 * ## This was wipe-and-re-setup. It is a migration now.
 *
 * The original decision, and the reasoning for it, was: a migration has to be
 * right on every path or it half-moves a home, and a half-moved home fails in the
 * worst available way — the daemon writes where the dashboard does not read, and
 * an absent directory is indistinguishable from an idle one. A reset is one
 * destructive operation that is either done or not done.
 *
 * That was correct while there were no customers, no cloud tokens on real
 * machines, no fleet enrolment and no undelivered event spools. All four now
 * exist, and the cost landed on the other side of the ledger: a wipe deleted the
 * cloud token (so the machine dropped off the fleet, silently, still reporting
 * healthy), `daemon.configured` (so it stopped failing closed), every
 * `extra_paths` a person had typed, and events already read out of transcripts
 * and queued — the last of those PERMANENTLY, because `cursors/` survived and the
 * watermark had already moved past them.
 *
 * So the shape inverted. `HOME_CLASSES` in `fp-home.ts` classifies every path by
 * what it HOLDS and the delete list is derived from that, which means the default
 * is now "carried" and deletion is the exception a class has to earn. The
 * half-moved-home worry is answered by keeping the property that made a reset
 * safe: `VERSION` is stamped only after a step completes, so a step that fails
 * leaves the home marked with the OLD layout and the next command retries it. No
 * home is ever marked current on the strength of a partial migration.
 *
 * `migrations.ts` owns the ORDER and the record — which steps exist, which ran,
 * and what was copied aside first. This file owns the MOVES.
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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { rebuildHookActivityStats } from "./hook-activity-store";
import {
  LAYOUT_VERSION,
  customPoliciesDir,
  failproofaiHome,
  globalPolicyConfigFile,
  hookActivityDir,
  legacy,
  migrationBackupDir,
  policiesDir,
  spoolDir,
  failedDir,
  resettablePaths,
} from "./fp-home";
import {
  detectLayout,
  projectConfig,
  projectCredentials,
  readConfig,
  updateConfig,
  writeConfig,
  writeCredentials,
  writeVersionFile,
  type FpConfig,
  type FpCredentials,
  type LayoutState,
} from "./fp-config";
import {
  daemonServiceStatus,
  daemonStatusCommand,
  daemonVersionSkew,
  isDaemonSupportedPlatform,
  probeDaemonEndToEnd,
} from "./daemon-service";
import { installBundledPack } from "./pack-store";

export interface ResetOutcome {
  /** Paths that existed and were removed. */
  removed: string[];
  /** Basenames of user-authored policy files moved into `custom-policies/`. */
  migrated: string[];
  /** Basenames of decision-log pages carried into layout 2's `hook-activity/`. */
  activity: string[];
  /** Keys of the layout-1 policy config carried into layout 2's. */
  policyConfig: string[];
  /**
   * Undelivered event batches moved out of a legacy root `spool/`/`failed/`.
   *
   * Reported rather than discarded because these are events that had NOT been
   * shipped: if the number is ever non-zero on a real machine it is the only
   * evidence that a root spool existed at all, and silence would make a carry
   * indistinguishable from a directory that was never there.
   */
  spooled: string[];
  /** The layout that was found before the reset. */
  from: number;
}

/** Script files a person could have written by hand. `.d.ts` is a type stub. */
/**
 * Move the user's own policy directory back up: layout 2's
 * `policies/custom-policies/` into layout 3's `policies/`, where the loader
 * reads it.
 *
 * Left alone, nothing would ever load those files again — and worse, the reset
 * DELETES `custom-policies/` (it is in `resettablePaths()`), so they would not
 * merely stop loading, they would be gone.
 *
 * EVERY entry moves — every file regardless of extension, and every
 * subdirectory — not just the loadable sources. Moving only `*.{js,mjs,ts}`
 * deleted the rest along with the directory, and the two things it deleted are
 * exactly the things a real policy depends on: a `lib/` of shared helpers the
 * policy imports, and the `.json` data file it reads its rules from. The
 * surviving policy then referenced a `./lib/rules.mjs` that no longer existed,
 * so the migration turned a working policy into a broken one AND destroyed
 * source nothing regenerates. Reproduced exactly that way on a seeded home.
 *
 * Moving the whole directory is also what keeps relative imports valid: every
 * entry keeps its position relative to every other, so `./lib/rules.mjs`
 * resolves after the move for the same reason it did before.
 *
 * A destination that already exists is never overwritten. Two things make that
 * safe rather than lossy, and BOTH are required:
 *
 *  - DIRECTORIES MERGE. A colliding directory is not a conflict — `lib/` on both
 *    sides usually holds different files, and the likeliest collision of all is
 *    exactly `lib/`, because layout 1 → 2 left one behind (it moved only
 *    `*.{js,mjs,ts}`, which is the bug this function now fixes). Skipping the
 *    whole directory on a name match discarded every file inside it. Only a
 *    genuine leaf collision — the same name, and at least one side a file — is
 *    left alone.
 *  - WHAT CANNOT MOVE IS NOT DELETED. `custom-policies/` is deliberately NOT in
 *    `resettablePaths()`; this function removes it itself, and only once it is
 *    empty. It used to be on that list, so every entry deliberately "left in
 *    place" was deleted seconds later by the same `resetHome()` call that had
 *    just decided to preserve it — the user lost hand-written source, and the
 *    policy that DID move was left importing a `./lib/rules.mjs` that no longer
 *    existed. Verified on a seeded home: the helper was gone from the machine
 *    entirely and the surviving policy failed to load.
 */
export function migrateConventionPolicies(): string[] {
  // LAYOUT 3 REVERSED THIS. Layout 2 moved the user's `*.mjs` DOWN into
  // `policies/custom-policies/`; layout 3 reads them straight out of
  // `policies/`, which is where layout 1 kept them all along. So:
  //
  //   • from layout 1 — nothing to do. The files are already in the directory
  //     that now loads them, and moving them anywhere would be a regression.
  //   • from layout 2 — move them back UP, out of `custom-policies/`, or the
  //     reset deletes that directory (it is in `resettablePaths()`) and takes
  //     the user's own policies with it.
  //
  // `resetHome` calls this BEFORE it deletes anything, which is what makes the
  // second case safe rather than a race.
  const from = legacy.customPoliciesDir();
  if (!existsSync(from)) return [];
  const moved: string[] = [];

  // Returns the names it moved, relative to `dir`. Recurses only where both
  // sides are directories; everything else either moves whole or stays put.
  const mergeInto = (dir: string, dest: string, prefix: string): void => {
    let entries;
    try {
      // No filter: this whole directory is the user's — policy sources, the
      // helpers they import, and the data files they read.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is not worth aborting a reset over, and its
      // contents stay where they are rather than being lost.
      return;
    }
    if (entries.length === 0) return;
    try {
      mkdirSync(dest, { recursive: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const source = resolve(dir, entry.name);
      const target = resolve(dest, entry.name);
      const name = `${prefix}${entry.name}`;
      if (!existsSync(target)) {
        try {
          renameSync(source, target);
          moved.push(name);
        } catch {
          // One unmovable entry must not strand the rest — and because this
          // directory is no longer on the reset list, "not moved" now really
          // does mean "still on disk".
        }
        continue;
      }
      // Both directories: merge their contents rather than discarding the
      // source wholesale. Anything genuinely colliding inside is left alone by
      // the same rule, one level down.
      if (entry.isDirectory() && statSync(target).isDirectory()) {
        mergeInto(source, target, `${name}/`);
        // AND remove the child once the recursion drained it. Without this, a
        // merged directory leaves an empty husk behind, so the `rmdirSync(from)`
        // below throws ENOTEMPTY into a swallowing `catch` and
        // `custom-policies/` survives the migration it just completed —
        // permanently, because the next run recurses into the same empty child
        // and fails the same way, so it never self-heals.
        //
        // Only reachable when the merge moved EVERYTHING: a genuine leaf
        // collision inside leaves a file here, `rmdirSync` refuses, and the
        // catch is then correct — that husk is the user's remaining source,
        // which is the one thing this function must not delete.
        try {
          rmdirSync(source);
        } catch {
          // Not empty, so something was deliberately left. Keep it.
        }
      }
    }
  };

  mergeInto(from, policiesDir(), "");

  // Remove the directory ONLY if the merge emptied it. A non-empty
  // `custom-policies/` is the user's remaining files, and this is the one place
  // that decides their fate — `resettablePaths()` no longer lists it.
  try {
    rmdirSync(from);
  } catch {
    // Not empty, or not removable. Either way it stays, which is the point.
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
 * merged without inventing a number, so they are dropped — and then REBUILT here,
 * explicitly, by `rebuildHookActivityStats()`.
 *
 * That call is the fix for a real loss. This comment used to say the store rebuilt
 * them by itself; it did not. `stats.json` is incremental — one entry folded in per
 * append, nothing ever rescans — so a dropped file simply read as zeroes and began
 * accumulating again from the next event. A user upgrading from a pre-daemon home
 * kept every record and lost every total: the dashboard listed their history while
 * reporting 0 events, 0 denies and no top policy. Verified on a seeded home before
 * and after. Dropping it is still right — the numbers are exactly recomputable
 * because pages are never pruned — but only if something actually recomputes them. The legacy `current.jsonl` is moved under a PAGE name rather than onto
 * the destination's own `current.jsonl`, which may already exist and may be
 * mid-write — a rotated page is exactly what the store would have made of it.
 */
/**
 * Move layout 1's root `spool/` and `failed/` into the daemon's `state/` pair.
 *
 * Both root paths are on the retired list, so the migration DELETES them, and
 * nothing regenerates an undelivered event: once the file is gone the decision it
 * records was never reported and never will be. `HOME_CLASSES` classes the layout-3
 * equivalents `undelivered` with the note "never deleted" — so without this the two
 * halves of the same module contradicted each other and the delete won.
 *
 * It is insurance rather than a live path, and that is worth being precise about:
 * no PUBLISHED version writes a root spool. `fpai-collect` used `home.join("spool")`
 * only on the unmerged daemon branch; the commit that reached `main` already wrote
 * `state/spool`, and the pre-daemon line (0.0.x) has no spool concept at all —
 * checked against the published 0.0.10, 0.0.14, 0.0.15 and 1.0.0-beta.0 tarballs.
 * So on every real machine this finds nothing and costs a single `existsSync`.
 *
 * It exists because "listed for deletion, with no carry and no backup" is a trap
 * regardless of whether anything currently falls into it: the next thing to write a
 * root spool would lose undelivered telemetry silently, and the cost of closing it
 * now is one directory walk.
 *
 * Carried INTO the live spool rather than into the backup, so the events actually
 * ship — `drainSpoolAfterMigrating()` flushes `state/spool` moments later. Safe for
 * an unknown-format file because the uploader quarantines a batch it cannot send
 * into `failed/` rather than failing on it, so the worst case is a preserved file
 * in the place designed to hold preserved files.
 */
function migrateLegacySpool(): string[] {
  const moved: string[] = [];
  for (const [from, to] of [
    [legacy.spoolDir(), spoolDir()],
    [legacy.failedDir(), failedDir()],
  ] as const) {
    if (!existsSync(from)) continue;
    try {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        // Never overwrite: a same-named batch in the destination is a different
        // batch with different events, and losing either defeats the point.
        let name = entry.name;
        let n = 0;
        while (existsSync(resolve(to, name))) name = `legacy-${n++}-${entry.name}`;
        try {
          renameSync(resolve(from, entry.name), resolve(to, name));
          moved.push(name);
        } catch {
          try {
            copyFileSync(resolve(from, entry.name), resolve(to, name));
            moved.push(name);
          } catch {
            // Unreadable. Left where it is; the delete below may remove it, which
            // is the pre-existing behaviour rather than a regression.
          }
        }
      }
    } catch {
      // A spool directory we cannot read is not worth aborting a reset over.
    }
  }
  return moved;
}

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
      } catch {
        // Fall back to a copy on ANY rename failure, not just EXDEV.
        //
        // EXDEV (a rename across filesystems) was the only code handled, on the
        // reasoning that it is the only one a copy can rescue. It is not: a
        // rename needs write permission on the SOURCE DIRECTORY, while a copy
        // needs only read on the file and write on the destination — so EACCES,
        // EPERM and EROFS on `cache/` all fail the rename and all succeed as a
        // copy. Those were silently dropped from the carry with no attempt made.
        //
        // Getting this wrong is permanent rather than deferred. The comment here
        // used to say a page left behind is merely "still there", which is true
        // of the file and false of its fate: `resetHome` stamps VERSION at the
        // end regardless, `detectLayout` then reports `current`, and this
        // function never runs again — so the page is not left for a retry, it is
        // abandoned in the old layout where nothing reads it.
        //
        // The copy leaves the original in place, which is the right trade in the
        // one direction that matters: the store's reader is keyed on the pages it
        // finds under the CURRENT layout, so a duplicate there would double-count
        // and a duplicate left behind is inert.
        try {
          copyFileSync(source, target);
          moved.push(name);
        } catch {
          // Genuinely unreadable. Reported by omission from `activity`, which is
          // the signal `resetHome`'s caller prints.
        }
      }
    }
  } catch {
    // An activity directory we cannot read is not worth aborting a reset over.
  }
  // AFTER the pages are in place, so the rebuild sees the carried history rather
  // than only whatever the new layout already had. Best-effort: a machine whose
  // totals cannot be rewritten still keeps every record, which is the half that
  // matters, and the next append starts accumulating from whatever it managed.
  if (moved.length > 0) {
    try {
      rebuildHookActivityStats();
    } catch {
      // Never fail a migration over a derived number.
    }
  }
  return moved.sort((a, b) => a.localeCompare(b));
}

/**
 * The eight keys the layout-2 carry used to move, kept only as a record.
 *
 * It was an ALLOWLIST, and that was the bug: anything outside these eight names
 * was dropped, including a key a NEWER build had written into a layout-2 file.
 * The carry preserves every key now and deletes only the retired ones
 * (`RETIRED_POLICY_CONFIG_KEYS`), which is the same rule `writeConfig` follows for
 * `config.json` — unowned keys survive, dead ones go.
 *
 * The one exclusion this list existed for is still enforced, by that other
 * constant: layout 1's file also carried a `collector` block, and layout 2 moved
 * collector settings to `config.toml` in snake_case — deliberately, because
 * `fpai-collect`'s `Settings` deserializes them and camelCase keys would make
 * every field silently fall back to its default (see the note on `Settings` in
 * `crates/fpai-collect/src/config.rs`, which records that exact bug). Carrying
 * `collector` forward would put a block into the new file that nothing reads,
 * looking like a preserved setting and behaving like an absent one.
 */

/**
 * Carry the user's policy SELECTION across the layout-1 → layout-2 move.
 *
 * Layout 1 kept it at `~/.failproofai/policies-config.json`; layout 2 keeps it
 * at `policies/local-policies/policies-config.json`, and both were on the reset
 * list. So an upgrade silently emptied `enabledPolicies` — every builtin the
 * user had turned on, every explicit `customPoliciesPaths` entry, and every
 * per-policy parameter. The machine still read as configured afterwards
 * (`isConfigured()` is a union that sees the agent CLIs' untouched settings
 * files), so hooks kept firing against a policy set that had quietly become
 * the default one. That is the same silent enforcement gap
 * `migrateConventionPolicies()` exists to close, by a different route.
 *
 * This is deliberately NARROW. The standing decision for layout 1 is
 * wipe-and-re-setup rather than migrate, because a half-migrated home that
 * reads "no data" is worse than one that says so — see `legacy` in
 * `fp-home.ts`. Everything derived (cursors, spool, health, audit cache) still
 * goes and is rebuilt. What is carried is only what a person typed and nothing
 * regenerates, which is the same test `migrateHookActivity()` applies to the
 * decision log.
 *
 * # Two phases, because the source and the destination are BOTH on the list
 *
 * Unlike the two migrations above, this one cannot run entirely before the
 * deletions. Its source (`legacy.policyConfig()`) is removed by them, and so is
 * its destination (`globalPolicyConfigFile()`) — rightly, since clearing a
 * stale selection on a layout migration is the documented behaviour. Writing
 * first would have the reset delete the carry moments after it happened, which
 * is exactly what the note on `hookActivityDir()` in `resettablePaths()` records
 * happening once already.
 *
 * So: READ before, WRITE after.
 */
/**
 * Keys the policy config used to hold that nothing reads any more.
 *
 * `collector` is the whole list, and it is why the layout-1 carry was an
 * ALLOWLIST rather than a copy: layout 1 kept collector settings here in
 * camelCase, and layout 2 moved them to `config.toml`/`config.json` in
 * snake_case, where `fpai-collect`'s `Settings` deserializes them. A camelCase
 * `collector` block sitting in the layout-3 file reads as a preserved setting and
 * does nothing — the worst of both, because it looks answered.
 *
 * A NAMED list, not "everything outside the keep-list". The file survives the
 * reset now (`HOME_CLASSES` classes it `user-typed`), so dropping by exclusion
 * would delete every key a NEWER build had written — which is the bug Phase 1
 * fixed for `config.json`, arriving here by a different door.
 */
const RETIRED_POLICY_CONFIG_KEYS = ["collector"] as const;

/**
 * Remove the retired keys from the policy config, in place.
 *
 * Runs regardless of which layout we came from: a key is retired or it is not,
 * and a layout-2 home carrying a stray layout-1 root file should be cleaned the
 * same way. Returns what it removed.
 *
 * The file is DELETED if stripping empties it — a `{}` policy config is not a
 * selection, and the old behaviour for a file holding nothing but `collector`
 * was no file at all.
 */
export function retirePolicyConfigKeys(): string[] {
  const at = globalPolicyConfigFile();
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(at, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    parsed = raw as Record<string, unknown>;
  } catch {
    // Absent or unparseable. Not worth aborting a reset over, and there is
    // nothing to retire — the same answer the carry gives for the same input.
    return [];
  }
  const removed = RETIRED_POLICY_CONFIG_KEYS.filter((k) => parsed[k] !== undefined);
  if (removed.length === 0) return [];
  for (const key of removed) delete parsed[key];
  try {
    if (Object.keys(parsed).length === 0) rmSync(at, { force: true });
    else writeFileSync(at, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch {
    // A file we cannot rewrite keeps its dead key. Misleading, but not fatal,
    // and not worth failing the migration over.
    return [];
  }
  return [...removed];
}

export function readCarriedPolicyConfig(): Record<string, unknown> | null {
  // LAYOUT 2's NESTED COPY ONLY — `policies/local-policies/policies-config.json`.
  //
  // This used to prefer that path and fall back to `legacy.policyConfig()`, the
  // layout-1 file at the home root. That fallback is gone because the file is:
  // layout 3 puts the live config back at exactly that path, `HOME_CLASSES`
  // classes it `user-typed`, and it is no longer deleted — so a layout-1 home
  // keeps it untouched, with EVERY key rather than the eight this function knows
  // to carry. Reading it here and writing it back would be the only thing that
  // could still narrow it.
  //
  // Layout 2's copy is different: `legacy.localPoliciesDir()` is on the retired
  // list and really is deleted, so without this it is lost. A home cannot hold
  // both — layout 2 never wrote the root file, and going 1 → 2 removed it.
  const from = resolve(legacy.localPoliciesDir(), "policies-config.json");
  if (!existsSync(from)) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(from, "utf8")) as Record<string, unknown>;
  } catch {
    // Unparseable is not worth aborting a reset over, and there is nothing to
    // carry. The file is removed with the rest of layout 1, which is also what
    // would have happened before this function existed.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // EVERY key except the retired ones. This was an eight-name ALLOWLIST, and it
  // dropped anything outside it — including a key a NEWER build had written into a
  // layout-2 file, which is the same loss Phase 1 fixed for `config.json` arriving
  // by a third door. Caught by a smoke test on a seeded home: a `futureKey` in the
  // nested config was gone after the migration, silently.
  //
  // Retired keys still go, because they are dead rather than unknown — see
  // `RETIRED_POLICY_CONFIG_KEYS` for why leaving `collector` here is worse than
  // deleting it.
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if ((RETIRED_POLICY_CONFIG_KEYS as readonly string[]).includes(key)) continue;
    carried[key] = value;
  }
  // Nothing worth carrying — a file holding only retired fields must not produce
  // an empty config that looks like a real one.
  if (Object.keys(carried).length === 0) return null;

  // `enabledPolicies` is required by the type and by every reader. A layout-1
  // file that somehow lacked it would otherwise produce a layout-2 file that
  // throws on read — worse than the empty default it replaces.
  if (carried.enabledPolicies === undefined) carried.enabledPolicies = [];
  rewriteCarriedCustomPaths(carried);
  return carried;
}

/**
 * Repoint `customPoliciesPaths` at where the files now live, in place.
 *
 * `migrateConventionPolicies()` moves layout 2's `policies/custom-policies/*` up
 * into `policies/`, and nothing rewrote the paths the user had REGISTERED — so
 * every explicit entry still named the directory the migration had just deleted.
 * Reproduced on a seeded layout-2 home: the file was correctly at
 * `policies/acme.mjs`, and the config still said
 * `policies/custom-policies/acme.mjs`, which resolved to nothing.
 *
 * Layout 3 collapses `customPoliciesDir()` onto `policiesDir()`, so a moved file
 * is still discovered BY CONVENTION and usually keeps firing — which is exactly
 * what made this quiet. It is not harmless: a convention-loaded policy gets a
 * different id from an explicitly-pathed one, and `disabledCustomPolicies` records
 * a disable against that id, so a policy the user had switched off can come back.
 * Repointing the path keeps the id it had.
 *
 * Layout-2 shaped on purpose. Layout 1 kept these files in `policies/` already —
 * the same place layout 3 does — so a layout-1 path needs no rewrite, and its
 * config is not carried through here anyway.
 */
function rewriteCarriedCustomPaths(carried: Record<string, unknown>): void {
  const fromDir = legacy.customPoliciesDir();
  const toDir = policiesDir();
  const repoint = (value: unknown): unknown => {
    if (typeof value !== "string" || value === "") return value;
    const abs = resolve(value);
    // `relative()` rather than a prefix test on the string: `policies/custom-policies-old`
    // starts with `policies/custom-policies` and is a DIFFERENT directory the
    // migration never touched, so a prefix match would move a path that is still
    // correct. An entry outside the moved tree is returned untouched.
    const rel = relative(fromDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return value;
    return resolve(toDir, rel);
  };

  if (Array.isArray(carried.customPoliciesPaths)) {
    carried.customPoliciesPaths = carried.customPoliciesPaths.map(repoint);
  }
  // The legacy singular field, still accepted on read.
  if (typeof carried.customPoliciesPath === "string") {
    carried.customPoliciesPath = repoint(carried.customPoliciesPath);
  }
}

/**
 * Second phase of {@link readCarriedPolicyConfig}; runs AFTER the deletions.
 *
 * MERGES onto whatever is at the destination rather than replacing it. The
 * destination is `user-typed` now and survives the reset, so a plain write would
 * truncate a live file down to the keys this carry happens to know about — the
 * same class of loss the carry exists to prevent, arriving by the other door.
 * The carried values still win: they are the ones being migrated.
 */
export function writeCarriedPolicyConfig(carried: Record<string, unknown> | null): string[] {
  if (!carried) return [];
  const to = globalPolicyConfigFile();
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(to, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or unparseable — the carry is the whole file, as before.
  }
  try {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, JSON.stringify({ ...existing, ...carried }, null, 2) + "\n", "utf8");
  } catch {
    // A destination we cannot write is not worth aborting the reset over; the
    // user re-runs setup, which is the pre-existing behaviour.
    return [];
  }
  return Object.keys(carried).sort((a, b) => a.localeCompare(b));
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
/**
 * Carry a telemetry OPT-OUT across a layout-2 upgrade.
 *
 * Layout 2 kept it in `config.toml`, which the reset deletes, and layout 3
 * writes a fresh `config.json` whose default is `telemetry.enabled: true`. So an
 * upgrade silently turned anonymous telemetry back ON for anyone who had turned
 * it off — and that file is the ONLY off-switch that reaches the daemon, because
 * a system-scope service unit does not inherit `FAILPROOFAI_TELEMETRY_DISABLED`
 * from anyone's shell. An opt-out that a routine upgrade revokes is not an
 * opt-out.
 *
 * Deliberately one-directional: only `false` is carried. Everything else in that
 * file is either re-derived by setup or a thing the wizard re-asks, and carrying
 * an ENABLED flag forward would be carrying the default, which is not a choice
 * anyone made. This matches the narrow rule the policy-config carry follows —
 * move only what a person typed and nothing regenerates.
 *
 * A regex rather than a TOML parser, for the reason `readLegacyTomlVersion`
 * gives: the dependency is gone, and this is a flat `key = value` file this
 * codebase wrote. Read BEFORE the deletions, applied after — same two-phase
 * shape, same reason.
 */
export function readCarriedTelemetryOptOut(): boolean {
  const from = legacy.configToml();
  if (!existsSync(from)) return false;
  try {
    const text = readFileSync(from, "utf8");
    // Scoped to the `[telemetry]` table, not the whole file — a stray
    // `enabled = false` under `[collector]` is not a telemetry opt-out.
    //
    // Sliced rather than matched with a single expression: the obvious form ends
    // the section with `(?=^\s*\[|\Z)`, and JavaScript HAS NO `\Z`. It parses as
    // a literal "Z", so the lookahead only ever succeeded via its other branch —
    // meaning the section was found when another table followed it and MISSED
    // whenever `[telemetry]` was last in the file, which is exactly where a
    // hand-added opt-out tends to be. Caught by the test for this function; the
    // live fixture happened to have `[collector]` after it and passed.
    const start = text.search(/^\s*\[telemetry\]\s*$/m);
    if (start === -1) return false;
    const body = text.slice(start).replace(/^\s*\[telemetry\]\s*$/m, "");
    const nextTable = body.search(/^\s*\[/m);
    const section = nextTable === -1 ? body : body.slice(0, nextTable);
    return /^\s*enabled\s*=\s*false\s*$/m.test(section);
  } catch {
    return false;
  }
}

/**
 * Parse the TOML subset layout 2 actually wrote, into the object shape layout 3
 * parses out of JSON.
 *
 * NOT a TOML implementation, and it does not need to be: layout 2's `config.toml`
 * and `credentials.toml` were written by this codebase, by two functions that
 * emitted nothing but `[table]` / `[dotted.table]` headers and `key = <value>`
 * lines where every value went through `JSON.stringify`. So `JSON.parse` on the
 * right-hand side is EXACT rather than approximate — strings, booleans, numbers
 * and the one array (`extra_paths`) all round-trip by construction. Removing the
 * `toml` dependency was half the point of layout 3; adding it back to read two
 * files we wrote ourselves would undo that.
 *
 * The output uses layout 2's own snake_case key names, unchanged, because layout
 * 3's JSON uses exactly the same ones (`hooks_verbosity`, `machine_id`,
 * `interval_days`, `sources.<h>.extra_paths`). That is what lets the carry run
 * `projectConfig` / `projectCredentials` — the SAME projections the JSON readers
 * use — instead of a second reader that would have to be kept in step. The only
 * thing that differs between the two layouts is how bytes become an object.
 *
 * A dotted header nests: `[collector.sources.claude]` lands at
 * `collector.sources.claude`, which is where `readSources` looks for it.
 * Anything unparseable is skipped rather than throwing, because a single
 * malformed line must not cost the user the whole file.
 */
export function parseLegacyToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = root;
      for (const part of header[1].split(".")) {
        const key = part.trim();
        if (!key) break;
        const existing = table[key];
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          table = existing as Record<string, unknown>;
        } else {
          const created: Record<string, unknown> = {};
          table[key] = created;
          table = created;
        }
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    try {
      table[key] = JSON.parse(line.slice(eq + 1).trim()) as unknown;
    } catch {
      // A value this codebase did not write, or a hand-edit that broke it. Skip
      // the line; the projection then falls back to that field's default, which
      // is the same answer an absent key gets.
    }
  }
  return root;
}

/**
 * Carry the whole layout-2 `config.toml` across, not just the telemetry opt-out.
 *
 * `readCarriedTelemetryOptOut()` above rescued one field, and the reason it was
 * only one was that the rest was described as "re-derived by setup or a thing the
 * wizard re-asks". That is true of a machine whose owner is about to re-run
 * setup, and false of every other machine — `config.toml` also holds:
 *
 *   mode                    a machine reverting to `oss` stops reporting entirely
 *   daemon.configured       the flag that makes the machine FAIL CLOSED
 *   collector.*             sessions/hooks/verbosity/redact/environment/machine_id
 *   collector.sources.*     every extra_paths a person typed
 *   audit.auto/interval     the scheduled scan they switched on
 *
 * Losing `daemon.configured` silently downgrades a machine from fail-closed
 * enforcement to the in-process path, and losing `mode` disconnects it from the
 * fleet — neither with any message, and neither re-derivable without a human.
 * Those are the same failures `HOME_CLASSES` stopped for `config.json`; this is
 * the layout-2 leg of the same problem, in the other format.
 *
 * Read BEFORE the deletions (the source is on the retired list), applied after.
 */
export function readCarriedLegacyConfig(): FpConfig | null {
  const from = legacy.configToml();
  if (!existsSync(from)) return null;
  try {
    return projectConfig(parseLegacyToml(readFileSync(from, "utf8")));
  } catch {
    // Unreadable is not worth aborting a reset over, and the telemetry carry
    // below still gets its own chance at the same bytes.
    return null;
  }
}

/**
 * Carry the layout-2 `credentials.toml` across.
 *
 * This is the one that takes a machine off the fleet. `credentials.toml` is on
 * the retired list and NOTHING carried it, so a layout-2 → 3 upgrade deleted the
 * cloud token and the ingest key outright: the machine stops reconciling
 * cloud-managed policy, stops delivering anything it spools, and says nothing —
 * it keeps enforcing whatever it last had and keeps reporting healthy. On a fleet
 * that is every box going quiet at once, with no operator action that caused it.
 *
 * `HOME_CLASSES` classes `credentials.json` `user-typed` so this cannot happen
 * again from layout 3 onwards, but 2 → 3 is the upgrade that actually exists to
 * be run, and it needed this.
 *
 * Written through `writeCredentials`, so the file lands 0600 with the home
 * tightened to 0700 — a token must not arrive here by a path that skips that.
 */
export function readCarriedLegacyCredentials(): FpCredentials | null {
  // NEWEST SOURCE WINS, and both older layouts have to be handled here because
  // BOTH of their credential files are on the retired list with nothing else
  // carrying them:
  //
  //   layout 2 — `credentials.toml`, one file, TOML
  //   layout 1 — `cloud.json` + `ingest.json`, two files, JSON, camelCase
  //
  // Layout 1 is the one that matters most in practice: the published `latest`
  // npm tag is still a pre-daemon 0.0.x release, so "install the current stable,
  // then upgrade" is a LAYOUT-1 → 3 migration, which makes this the upgrade real
  // users actually perform. Losing the token there takes the machine off the
  // fleet exactly as the layout-2 case does — silently, still enforcing whatever
  // it last had, still reporting healthy.
  const toml = legacy.credentialsToml();
  if (existsSync(toml)) {
    try {
      const creds = projectCredentials(parseLegacyToml(readFileSync(toml, "utf8")));
      // An empty object means the file held nothing that passed validation — a
      // cloud table with no token, say. Writing that would create a credentials
      // file that looks present and authenticates nothing.
      if (Object.keys(creds).length > 0) return creds;
    } catch {
      // Fall through to layout 1's files rather than returning: an unreadable
      // layout-2 file is not evidence that a layout-1 one is absent.
    }
  }

  // Layout 1. `machineId` is CAMELCASE in `cloud.json` — layout 2 moved to
  // snake_case — so the raw object is rebuilt in the shape `projectCredentials`
  // reads rather than passed through. Reusing that projection is the point: "a
  // cloud block without a token is not a cloud block" is a security property,
  // and a second validator here is how a half-written credential comes to be
  // treated as live.
  const readJson = (path: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const cloud = readJson(legacy.cloudCredentials());
  const ingest = readJson(legacy.ingestCredentials());
  if (!cloud && !ingest) return null;
  const raw: Record<string, unknown> = {};
  if (cloud) {
    raw.cloud = {
      url: cloud.url,
      machine_id: cloud.machineId,
      token: cloud.token,
      // Layout 1 had no machine label; absent is correct rather than empty.
      ...(typeof cloud.machineLabel === "string" ? { machine_label: cloud.machineLabel } : {}),
    };
  }
  if (ingest) raw.ingest = { url: ingest.url, key: ingest.key };
  const creds = projectCredentials(raw);
  return Object.keys(creds).length > 0 ? creds : null;
}

/**
 * @param to The layout this step LANDS on, which is not always the current one.
 *   Defaults to `LAYOUT_VERSION` for a direct call, but the registry passes the
 *   step's own `to` — see the stamp at the end of this function.
 */
export function resetHome(from: number, to: number = LAYOUT_VERSION): ResetOutcome {
  // BEFORE the deletions, so a file that is mid-move is never one the reset
  // then walks over.
  const migrated = migrateConventionPolicies();
  const activity = migrateHookActivity();
  const pendingPolicyConfig = readCarriedPolicyConfig();
  // Read before the deletions for the same reason as the policy config: their
  // sources (`config.toml`, `credentials.toml`) are both on the list below.
  const pendingConfig = readCarriedLegacyConfig();
  const pendingCredentials = readCarriedLegacyCredentials();
  const telemetryOptOut = readCarriedTelemetryOptOut();
  // BEFORE the deletions, like every other carry here: both source directories are
  // on the retired list below.
  const spooled = migrateLegacySpool();
  const removed: string[] = [];
  for (const path of resettablePaths()) {
    // The guard that stood here skipped `globalPolicyConfigFile()` when the
    // reset was not a layout migration, because clearing a current, valid
    // policy selection is only right when setup is about to re-ask. That path is
    // `user-typed` in `HOME_CLASSES` now and therefore never on this list at
    // all, for either kind of reset — so the special case has nothing left to
    // guard. See the `legacy.policyConfig()` note in `retiredLayoutPaths()`.
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
  const policyConfig = writeCarriedPolicyConfig(pendingPolicyConfig);
  // AFTER the carry, so a layout-2 value that happens to be named `collector`
  // is retired too rather than surviving because it arrived a moment later.
  retirePolicyConfigKeys();
  // After the deletions, onto the fresh files, so the upgrade cannot revoke a
  // choice the user made.
  //
  // The credentials go first and unconditionally: `daemon.configured` below makes
  // the machine fail closed, and a machine that fails closed against a fleet it
  // can no longer authenticate to is worse than either half alone.
  if (pendingCredentials) writeCredentials(pendingCredentials);
  if (pendingConfig) writeConfig(pendingConfig);
  // AFTER the config carry, or a carried `telemetry.enabled: true` — the default,
  // which is not a choice anyone made — would overwrite the opt-out this reads
  // straight out of the same file. Both paths end at the same key, and only one
  // of them represents something a person typed.
  if (telemetryOptOut) updateConfig({ telemetry: { enabled: false } });
  // `packs/` is resettable, but the package's default pack is also the offline
  // enforcement floor. Restore it from the installed package before declaring
  // the migration complete; third-party packs remain explicitly re-fetchable.
  installBundledPack();
  // The step's OWN target, not LAYOUT_VERSION.
  //
  // Every step used to end stamping the current layout, which was harmless
  // while every chain was one hop. On `1 → 3 → 4` it means the first step
  // marks the home layout 4 with its files still at layout 3, and the window
  // between that stamp and the next step completing is a real one: a SIGKILL,
  // an OOM or a power loss inside it leaves a home that reads as `current`
  // forever. `detectLayout()` short-circuits on the marker, so no later
  // command re-examines the landmarks, and `auth.json` sits at the root while
  // layout 4 reads `audit/session.json` — a machine silently signed out with
  // its session on disk and nothing that would ever move it.
  //
  // `runMigrations` also repairs an over-stamp in its `catch`, but a killed
  // process runs no catch. Stamping the truth in the first place is what makes
  // that repair a second line of defence rather than the only one.
  writeVersionFile({ layout: to });
  return { removed, migrated, activity, policyConfig, spooled, from };
}

export interface LayoutCheck {
  state: LayoutState;
  /** Lines to print. Empty when there is nothing to say. */
  lines: string[];
  /** True when the caller should stop rather than continue. */
  fatal: boolean;
  /**
   * True when this call actually migrated the home.
   *
   * **Reporting only. The caller must NOT force setup on it.**
   *
   * It used to mean "force the wizard", and the reason was a real gap: the reset
   * removed the global policy config while `isConfigured()` is a union that also
   * counts the agent CLIs' settings files — which the reset deliberately leaves
   * alone — so the machine read as configured, the wizard was skipped, and
   * `markLauncherSeen()` back-filled the marker so every later run skipped it
   * too. The user was left with hooks firing on every tool call against no
   * policies at all, and nothing ever said so again.
   *
   * That gap is closed at the source. `policies-config.json`, `config.json` and
   * `credentials.json` are `user-typed` in `HOME_CLASSES` and are no longer
   * removed, so after a migration `isConfigured()` is true because the machine
   * genuinely IS configured — its policy selection, its `daemon.configured`
   * flag and its cloud enrolment all survived. Everything the migration still
   * drops (audit cache, cloud deployments, daemon scratch) is re-derived or
   * re-fetched with nobody present.
   *
   * Forcing setup from here would now mean opening an interactive wizard for a
   * machine with nothing to answer — and on the machines that matter most (a
   * fleet box, a CI runner, a headless gateway) there is nobody to answer it. A
   * home that genuinely never finished setup still reaches the wizard by the
   * ordinary route: `isConfigured()` is false for it, so `shouldOfferFirstRun`
   * fires on its own. That is why forcing was redundant even before it was wrong.
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
/**
 * Deliver what is already spooled, immediately AFTER the migration.
 *
 * The order is the whole subtlety here, and the obvious one is wrong. Flushing
 * FIRST reads intuitive — get the events out before touching the disk — and it
 * cannot work: everything a flush needs to run is in a file the stale layout
 * hasn't got. `readConfig()` reads `config.json` and `readIngestCredential()`
 * reads `credentials.json`, both of which are LAYOUT-3 files, and a stale home by
 * definition has neither. Called before the migration, the flush would find no
 * ingest credential on every machine it ever ran on, refuse, and report nothing
 * pending — a step that looks like it protects data and is structurally incapable
 * of doing anything at all.
 *
 * Afterwards, both files exist: `readCarriedLegacyCredentials()` has just put the
 * token back and `readCarriedLegacyConfig()` the mode. So this runs where it can
 * actually succeed.
 *
 * What makes that safe rather than a gamble is that this is NOT the thing
 * protecting the events. `HOME_CLASSES` classes the spool `undelivered`, so it
 * survives the migration whatever happens here — losing it would be permanent,
 * because `cursors/` survives too and the watermark has already advanced past
 * every batch in it. This is the difference between "delivered" and "delivered on
 * the next collector pass", which matters only because the collector is unhurried
 * on purpose (a batch is swept once it is older than two minutes, at most 64 per
 * pass, on a 60-second cadence) and somebody standing at a dashboard cannot tell
 * "not yet" from "not working".
 *
 * BEST-EFFORT BY CONSTRUCTION. `runFlushCommand` refuses, with its own message
 * and a non-zero code, on every machine where a flush cannot work: collection
 * off, no ingest credential, an unsupported platform, no daemon listening. All of
 * those are ordinary here rather than errors, so the result is read for its COUNT
 * and its exit code discarded. Bounded at 30s: this sits in front of a command
 * the user typed, and a spool that will not drain is not a reason to hold their
 * terminal.
 */
async function drainSpoolAfterMigrating(): Promise<number> {
  try {
    // Cheap gates first, so an OSS machine and one that never connected cost
    // nothing at all — no dynamic import, no daemon probe. Read AFTER the
    // migration, so these see the carried values rather than the defaults a
    // missing layout-3 file would have produced.
    const cfg = readConfig();
    if (cfg.mode !== "cloud") return 0;
    if (!cfg.collector.hooks && !cfg.collector.sessions) return 0;
    const { runFlushCommand } = await import("./flush-cli");
    const result = await runFlushCommand({ wait: true, timeoutSecs: 30 });
    return result.pending;
  } catch {
    // A flush that throws is not a migration failure. Reported as "nothing
    // pending" because the number only adds a line to a message, and inventing a
    // count from a failed probe would be worse than saying nothing.
    return 0;
  }
}

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
    // Through the registry, not `resetHome` directly. The two look identical for
    // today's layouts — the chain from 1 or 2 is one step, and that step IS
    // `resetHome` — and they stop being identical the moment a layout 4 exists,
    // at which point this call site needs no change. It also means every
    // migration this machine has ever run is recorded, and the irreplaceable
    // files are copied aside first. See `migrations.ts`.
    const { runMigrations } = await import("./migrations");
    const run = runMigrations(state.found);
    const { removed, migrated, activity } = run.outcome;
    // After, not before — see the function's own note for why the intuitive
    // order cannot work.
    const pending = await drainSpoolAfterMigrating();
    // Read AFTER the migration: on a machine coming from layout 1 or 2 the
    // config this reads is the one the migration just carried across, so asking
    // any earlier would read a file that is about to move.
    const daemonHint = staleDaemonHint();
    return {
      state,
      fatal: false,
      didReset: true,
      lines: [
        `failproofai reorganised ${failproofaiHome()} in this version.`,
        // "activity history" was in this sentence while the reset was deleting
        // it, and "policy config" stayed in it after that file stopped being
        // removed. Both are the same failure: a message describing a delete list
        // it is not derived from. It names the CLASSES now, which is what
        // `HOME_CLASSES` actually decides — so it cannot drift again without the
        // rule itself changing.
        `Removed ${removed.length} item(s) that this version rebuilds — the audit`,
        `cache, cloud deployments (re-fetched on the next poll) and daemon scratch.`,
        `Your settings, cloud enrolment, policy selection, decision history,`,
        `undelivered events and daemon binary were all kept.`,
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
        // Said only when a backlog actually survived the flush. Silence here
        // would be the wrong kind: the events are safe, but "safe" and
        // "delivered" are different states and only one of them shows up on a
        // dashboard. Naming the count is what stops a user reading an incomplete
        // dashboard as data loss.
        ...(pending > 0
          ? [
              ``,
              `${pending} batch(es) were still undelivered and were carried across.`,
              `They ship on the next collector pass — \`failproofai flush --wait\` now if you`,
              `are waiting on a dashboard.`,
            ]
          : []),
        // A step that threw leaves the home marked with the OLD layout, so the
        // next command tries again — which is right, and is also why this must
        // say so rather than let a partial migration pass for a finished one.
        ...(run.failed
          ? [
              ``,
              `Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`,
              `The home is still marked layout ${state.found} and will be retried. Copies of`,
              `your settings and enrolment were saved first, in ${migrationBackupDir(state.found)}.`,
            ]
          : []),
        // No "run `failproofai config` to set up again". There is nothing to set
        // up: the settings, the enrolment and the policy selection all survived,
        // so the machine enforces exactly as it did before this command ran. A
        // home that genuinely never finished setup reaches the wizard through
        // `shouldOfferFirstRun`, which reads `isConfigured()` — see `didReset`.
        //
        // The daemon hint belongs HERE above all, and was missing. This branch
        // is the one that moves the home and stamps the new layout marker — it
        // is the command that CREATES the incompatibility with an unrefreshed
        // daemon, and it was the one command saying nothing about it. Every
        // later command reached the non-stale return below and got the hint;
        // the one where the user is watching the reorganisation happen did not.
        ...(daemonHint.length > 0 ? ["", ...daemonHint] : []),
      ],
    };
  }

  // Write the marker back for a fresh home — and ALSO for one whose layout had
  // to be recovered from a landmark. `inferred` means the home is genuinely on
  // this layout and only `VERSION` is missing; leaving it missing means every
  // later command re-infers it, and `writeVersionFile()` carries the daemon
  // version forward from the file it just failed to read, so the recorded
  // daemon version is erased and `daemonVersionSkew()` goes quiet about a stale
  // daemon. Re-stamping is what "the only thing actually missing is the marker"
  // was supposed to mean.
  if (state.kind === "absent" || (state.kind === "current" && state.inferred)) writeVersionFile();
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
 * What to say when the daemon's version does not match the CLI's.
 *
 * Deliberately NOT on the hook path. CLI commands are where a person is present
 * to act on it, and once per tool call would be noise.
 *
 * Two messages, because the stakes are not the same on both kinds of machine.
 *
 * On a machine that does NOT require the daemon, a stale one is what it looks
 * like: slower to notice an upgrade, still enforcing correctly.
 *
 * On a machine that DOES — `daemon.configured` — it is a scheduled outage.
 * failproofaid calls `refuse_foreign_layout()` before it binds its socket and
 * exits when the home's layout marker is not the one its binary was built
 * against, and a release that moves `~/.failproofai` therefore strands every
 * daemon that has not been refreshed. Nothing looks wrong in the meantime: the
 * running process read the marker once at startup and keeps serving from
 * memory. The failure lands at the next restart — a reboot, a crash,
 * `systemctl restart` — where the unit exits nonzero, `Restart=on-failure`
 * trips the start limit, and the service latches `failed`. From there the
 * machine fails closed and denies every tool call across all 11 CLIs, and
 * `healDaemonFlag()` will not rescue it because a layout-refusing unit reads as
 * `stopped`, which it deliberately excludes.
 *
 * This used to say a stale daemon "is slower to notice an upgrade, not broken"
 * to everybody, and pointed at `failproofai config`. Across a layout bump that
 * is the wrong sentence and the wrong command.
 */
function staleDaemonHint(): string[] {
  try {
    const skew = daemonVersionSkew();
    if (!skew) return [];
    let requiresDaemon = false;
    try {
      requiresDaemon = readConfig().daemon.configured;
    } catch {
      // Unreadable config: fall through to the mild message rather than
      // frightening somebody whose machine may not require the daemon at all.
    }
    if (requiresDaemon) {
      return [
        `[failproofai] daemon is ${skew.installed}, CLI is ${skew.expected}.`,
        `This machine is configured to REQUIRE the daemon. A daemon built against a`,
        `different on-disk layout refuses to start, and this version moved it — so the`,
        // The wrap is load-bearing: "denies every tool call" is the consequence
        // this message exists to state, and splitting it across two lines is
        // what made the test asserting that phrase fail while the text looked
        // perfectly correct to a human reading it.
        `next reboot or restart can leave the service down, which`,
        `denies every tool call until it is fixed.`,
        `Run \`failproofai update\` now to bring the daemon in line.`,
        ``,
      ];
    }
    return [
      `[failproofai] daemon is ${skew.installed}, CLI is ${skew.expected} — ` +
        `run \`failproofai update\` to update it.`,
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
/**
 * Why an UNATTENDED run must not proceed — a different question from the hook's.
 *
 * The hook asks "are global policies unenforced?", and answers it about one
 * file. This asks "is this home on a layout this build understands?", and the
 * answer must not be softened by anything: the scheduled audit runs with nobody
 * watching, and the ordinary CLI path RESETS a stale home — which deletes
 * `config.toml` (revoking a telemetry opt-out and the `[audit] auto` flag that
 * scheduled the run) and `credentials.toml` (dropping cloud enrolment). Doing
 * that on a timer, with the explanation going only to the service journal, is
 * the failure this gate exists to prevent.
 *
 * Sharing `layoutWarningForHook()` for both is what made this subtle: teaching
 * that function to stay quiet when the global policy config IS readable — right
 * for the hook, since layout 1 and layout 3 keep it at the same path — silently
 * turned this gate off for exactly the homes most likely to hit it.
 */
export function layoutBlockerForScheduledRun(): string | null {
  const state = detectLayout();
  if (state.kind === "current" || state.kind === "absent") return null;
  if (state.kind === "future") {
    return (
      `[failproofai] this directory was written by a newer version ` +
      `(layout ${state.found} vs ${LAYOUT_VERSION}) — refusing to run unattended. ` +
      `Upgrade failproofai.`
    );
  }
  return (
    `[failproofai] setup predates this version (layout ${state.found} vs ${LAYOUT_VERSION}) — ` +
    `refusing to run unattended, because completing it would reset this home. ` +
    `Run \`failproofai config\`.`
  );
}

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
  // The claim is about ONE FILE — the global policy config — so ask about that
  // file rather than about the layout number. Layout 1 and layout 3 keep it at
  // the SAME path (`~/.failproofai/policies-config.json`), so a home carrying
  // one is read as layout 1 by the landmark fallback while the hook path loads
  // and enforces it perfectly well. Hand-writing that file is something
  // `docs/configuration.mdx` explicitly tells people to do, and they were told
  // on every single tool call that their policies were not being enforced
  // WHILE THEY WERE — the deny and the warning printed together.
  //
  // A warning that contradicts the behaviour it describes is worse than no
  // warning: it teaches people to ignore the one channel that will matter when
  // enforcement really has stopped.
  if (existsSync(globalPolicyConfigFile())) return null;
  return (
    `[failproofai] setup predates this version — global policies are NOT being enforced. ` +
    `Run \`failproofai config\` to re-create it.`
  );
}
