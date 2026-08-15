/**
 * The migration chain, its ledger, and the backup taken before it runs.
 *
 * The property these exist to protect is the customer case the whole design is
 * keyed on: a machine sits on an old version for months, then jumps several
 * layouts at once, and nothing may be lost on the way. The chain is keyed on the
 * LAYOUT rather than the npm version precisely so skipping thirty releases with no
 * layout change runs nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  LAYOUT_VERSION,
  auditDir,
  auditScheduleFile,
  auditSessionFile,
  configFile,
  credentialsFile,
  globalPolicyConfigFile,
  legacy,
  migrationBackupDir,
  migrationLedgerFile,
  versionFile,
} from "../../src/hooks/fp-home";
import { detectLayout, readVersionFile, writeVersionFile } from "../../src/hooks/fp-config";
import {
  MIGRATIONS,
  backupBeforeMigrating,
  describePlan,
  migrationCoverageGap,
  planMigration,
  pruneMigratedCredentials,
  readLedger,
  restoreBackup,
  runMigrations,
  type Migration,
} from "../../src/hooks/migrations";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-migrations-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("planMigration", () => {
  it("plans a chain from every layout this build can still meet", () => {
    for (let layout = 1; layout < LAYOUT_VERSION; layout += 1) {
      const chain = planMigration(layout);
      expect(chain.length, `layout ${layout}`).toBeGreaterThan(0);
      expect(chain[0].from).toBe(layout);
      expect(chain.at(-1)?.to).toBe(LAYOUT_VERSION);
    }
  });

  it("plans nothing for a home already at this layout", () => {
    expect(planMigration(LAYOUT_VERSION)).toEqual([]);
    // And nothing for a FUTURE one. Refusing a downgrade is `detectLayout`'s job
    // and it happens before this is reached; returning an empty plan here rather
    // than throwing keeps that the single place the decision lives.
    expect(planMigration(LAYOUT_VERSION + 5)).toEqual([]);
  });

  it("composes multiple hops, following `to` rather than counting", () => {
    // The shape that makes the next layout additive: only the new step gets
    // written, and every older home reaches it by composition. `to` is not
    // always `from + 1` — today's steps are real two-hops — so the walk has to
    // follow the link.
    const registry: Migration[] = [
      { from: 1, to: 2, describe: "1→2", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 1 }) },
      { from: 2, to: LAYOUT_VERSION, describe: "2→cur", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 2 }) },
    ];

    expect(planMigration(1, registry).map((m) => `${m.from}->${m.to}`)).toEqual([
      "1->2",
      `2->${LAYOUT_VERSION}`,
    ]);
  });

  it("THROWS rather than returning a short chain when a layout has no step", () => {
    // A partial plan silently leaves a home half-migrated, which `fp-reset.ts`'s
    // header names as worse than refusing.
    const registry: Migration[] = [
      { from: 1, to: 2, describe: "1→2", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 1 }) },
    ];

    expect(() => planMigration(1, registry)).toThrow(/no migration from layout 2/);
  });
});

describe("migrationCoverageGap", () => {
  // THE CI GUARD. Bumping LAYOUT_VERSION without writing a step leaves every
  // older home unable to upgrade, and the symptom appears on a user's machine
  // rather than in a test — nothing in the normal path plans a chain for a layout
  // the developer does not happen to have on disk.
  it("reports no gap for the real registry", () => {
    expect(migrationCoverageGap()).toEqual([]);
  });

  it("catches a layout with no path forward", () => {
    expect(migrationCoverageGap([])).toContain(`layout 1 has no path to ${LAYOUT_VERSION}`);
  });

  it("catches a step that does not move forward, and two steps reading one layout", () => {
    const noop = () => ({ removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 1 });
    const backwards: Migration[] = [{ from: 2, to: 1, describe: "x", run: noop }];
    expect(migrationCoverageGap(backwards).some((p) => p.includes("does not move forward"))).toBe(true);

    const duplicated: Migration[] = [
      { from: 1, to: LAYOUT_VERSION, describe: "a", run: noop },
      { from: 1, to: LAYOUT_VERSION, describe: "b", run: noop },
    ];
    expect(migrationCoverageGap(duplicated)).toContain("two steps read the same layout");
  });

  it("catches a step that overshoots the current layout", () => {
    const noop = () => ({ removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 1 });
    const over: Migration[] = [
      { from: 1, to: LAYOUT_VERSION + 1, describe: "over", run: noop },
      { from: 2, to: LAYOUT_VERSION, describe: "ok", run: noop },
    ];
    expect(over.length).toBe(2);
    expect(migrationCoverageGap(over).some((p) => p.includes("overshoots"))).toBe(true);
  });

  it("every registered step describes itself", () => {
    // `--dry-run` prints these, and a blank line there is a dry run that tells
    // the user nothing about what it is about to do.
    for (const m of MIGRATIONS) {
      expect(m.describe.length, `${m.from} → ${m.to}`).toBeGreaterThan(20);
    }
  });
});

describe("the backup taken before a migration", () => {
  function seedIrreplaceable() {
    mkdirSync(home, { recursive: true });
    writeFileSync(configFile(), '{"mode":{"kind":"cloud"}}');
    writeFileSync(credentialsFile(), '{"cloud":{"url":"u","machine_id":"m","token":"tok"}}');
    writeFileSync(globalPolicyConfigFile(), '{"enabledPolicies":["block-sudo"]}');
    writeFileSync(versionFile(), '{"layout":2,"cli":"old"}');
    writeFileSync(legacy.configToml(), 'layout = 2\n');
    writeFileSync(legacy.credentialsToml(), '[cloud]\ntoken = "tok-legacy"\n');
  }

  it("copies the files nothing regenerates, and only those", () => {
    // Not the whole home: `HOME_CLASSES` already stopped the migration deleting
    // anything irreplaceable by design, so a full copy would insure against a
    // threat that no longer exists while duplicating bin/ and hook-activity/.
    // What is left to insure against is a BUG in a step.
    seedIrreplaceable();

    const saved = backupBeforeMigrating(2);

    expect([...saved].sort()).toEqual([
      "VERSION",
      "config.json",
      "config.toml",
      "credentials.json",
      "credentials.toml",
      "policies-config.json",
    ]);
    // Each name ONCE. `legacy.policyConfig()` and `globalPolicyConfigFile()` are
    // the same file — layout 3 put the policy config back where layout 1 kept it —
    // so a naive list copies it twice and prints it twice.
    expect(saved).toHaveLength(new Set(saved).size);
    expect(existsSync(resolve(migrationBackupDir(2), "credentials.json"))).toBe(true);
  });

  it("copies layout 1's credential files, which the migration deletes", () => {
    // The gap the functional matrix caught. `cloud.json` and `ingest.json` are on
    // the retired list, so the migration removes them, and nothing regenerates a
    // cloud token — they are the definition of what this backup is for. They were
    // absent from it while the carry that reads them was being added, so the
    // layout-1 leg (the one an upgrade from the published `latest` takes) deleted
    // the token with no copy kept.
    mkdirSync(home, { recursive: true });
    writeFileSync(legacy.cloudCredentials(), '{"url":"u","machineId":"m","token":"tok"}');
    writeFileSync(legacy.ingestCredentials(), '{"url":"u","key":"k"}');

    const saved = backupBeforeMigrating(1);

    expect([...saved].sort()).toEqual(["cloud.json", "ingest.json"]);
    expect(
      JSON.parse(readFileSync(resolve(migrationBackupDir(1), "cloud.json"), "utf8")).token,
    ).toBe("tok");
  });

  it("a full layout-1 migration leaves the token recoverable", () => {
    // End to end: the originals are gone afterwards, so the backup is the only
    // copy — assert it is actually there and readable.
    mkdirSync(home, { recursive: true });
    writeFileSync(legacy.cloudCredentials(), '{"url":"u","machineId":"m","token":"tok-live"}');
    writeFileSync(globalPolicyConfigFile(), '{"enabledPolicies":[]}');

    runMigrations(1);

    expect(existsSync(legacy.cloudCredentials())).toBe(false);
    expect(
      JSON.parse(readFileSync(resolve(migrationBackupDir(1), "cloud.json"), "utf8")).token,
    ).toBe("tok-live");
  });

  it("skips what is not there rather than failing", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configFile(), "{}");
    expect(backupBeforeMigrating(1)).toEqual(["config.json"]);
  });

  it("replaces a previous attempt's backup rather than merging into it", () => {
    // Half-old, half-new is not a restorable snapshot of anything.
    seedIrreplaceable();
    backupBeforeMigrating(2);
    rmSync(credentialsFile(), { force: true });

    const saved = backupBeforeMigrating(2);

    expect(saved).not.toContain("credentials.json");
    expect(existsSync(resolve(migrationBackupDir(2), "credentials.json"))).toBe(false);
  });

  it("restores what it saved — the undo for a buggy step", () => {
    seedIrreplaceable();
    backupBeforeMigrating(2);
    // A step "corrupts" the token and drops the selection.
    writeFileSync(credentialsFile(), '{"cloud":{"url":"u","machine_id":"m","token":"WRONG"}}');
    rmSync(globalPolicyConfigFile(), { force: true });

    const restored = restoreBackup(2);

    expect(restored).toContain("credentials.json");
    expect(JSON.parse(readFileSync(credentialsFile(), "utf8")).cloud.token).toBe("tok");
    expect(JSON.parse(readFileSync(globalPolicyConfigFile(), "utf8")).enabledPolicies).toEqual([
      "block-sudo",
    ]);
  });

  it("restores nothing when there is no backup for that layout", () => {
    expect(restoreBackup(2)).toEqual([]);
  });

  it("copies layout 2's policy selection from the NESTED path it actually lives at", () => {
    // The backup's claim to protect a policy selection rested on
    // `legacy.policyConfig()`, the layout-1 ROOT path — which layout 3 reuses and
    // the migration therefore leaves alone, so on a layout-2 home it is usually
    // absent. Layout 2 keeps the selection two levels down, under
    // `legacy.localPoliciesDir()`, which IS deleted. So the one leg where the
    // selection is destroyed was the one leg with no copy of it.
    mkdirSync(home, { recursive: true });
    mkdirSync(legacy.localPoliciesDir(), { recursive: true });
    writeFileSync(
      resolve(legacy.localPoliciesDir(), "policies-config.json"),
      '{"enabledPolicies":["block-sudo"],"policyParams":{"a":1}}',
    );

    const saved = backupBeforeMigrating(2);

    expect(saved).toContain("local-policies-policies-config.json");
    const kept = JSON.parse(
      readFileSync(resolve(migrationBackupDir(2), "local-policies-policies-config.json"), "utf8"),
    );
    expect(kept.enabledPolicies).toEqual(["block-sudo"]);
    expect(kept.policyParams).toEqual({ a: 1 });
  });

  it("a full layout-2 migration leaves the nested selection recoverable", () => {
    // End to end: the nested original is gone afterwards, so the backup is the
    // only copy of what the user had chosen.
    mkdirSync(home, { recursive: true });
    writeFileSync(legacy.configToml(), "layout = 2\n");
    mkdirSync(legacy.localPoliciesDir(), { recursive: true });
    writeFileSync(
      resolve(legacy.localPoliciesDir(), "policies-config.json"),
      '{"enabledPolicies":["block-env-files"]}',
    );

    runMigrations(2);

    expect(existsSync(resolve(legacy.localPoliciesDir(), "policies-config.json"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(resolve(migrationBackupDir(2), "local-policies-policies-config.json"), "utf8"),
      ).enabledPolicies,
    ).toEqual(["block-env-files"]);
  });

  it("the nested and root policy configs do not overwrite each other, either way", () => {
    // They share a BASENAME, and the backup directory is flat. Saved under one
    // name, whichever was copied second would win — and on restore that single
    // survivor would be written back to BOTH paths, putting layout 2's nested
    // selection over layout 3's live config. Hence the explicit distinct name.
    mkdirSync(home, { recursive: true });
    writeFileSync(globalPolicyConfigFile(), '{"enabledPolicies":["root-one"]}');
    mkdirSync(legacy.localPoliciesDir(), { recursive: true });
    writeFileSync(
      resolve(legacy.localPoliciesDir(), "policies-config.json"),
      '{"enabledPolicies":["nested-one"]}',
    );

    const saved = backupBeforeMigrating(2);
    expect(saved).toContain("policies-config.json");
    expect(saved).toContain("local-policies-policies-config.json");

    // Both survive in the backup, each with its own contents.
    expect(
      JSON.parse(readFileSync(resolve(migrationBackupDir(2), "policies-config.json"), "utf8"))
        .enabledPolicies,
    ).toEqual(["root-one"]);
    expect(
      JSON.parse(
        readFileSync(resolve(migrationBackupDir(2), "local-policies-policies-config.json"), "utf8"),
      ).enabledPolicies,
    ).toEqual(["nested-one"]);

    // And a restore puts each back where it came from, not one over both.
    writeFileSync(globalPolicyConfigFile(), '{"enabledPolicies":["CLOBBERED"]}');
    restoreBackup(2);
    expect(
      JSON.parse(readFileSync(globalPolicyConfigFile(), "utf8")).enabledPolicies,
    ).toEqual(["root-one"]);
    expect(
      JSON.parse(
        readFileSync(resolve(legacy.localPoliciesDir(), "policies-config.json"), "utf8"),
      ).enabledPolicies,
    ).toEqual(["nested-one"]);
  });

  // The backup insures a migration that goes wrong. Kept forever on a live
  // credential it stops being insurance and becomes a second copy of the
  // token — one no reset class removes (`migrationsDir` is classed `identity`)
  // and that `deleteAuth()` did not know about, so a dashboard sign-out, a 401
  // auto-delete and `failproofai reset` all left a working bearer and refresh
  // token on disk to be carried into every backup and container image after it.
  describe("the session copy is not kept after a clean migration", () => {
    function seedLayoutThreeWithSession() {
      mkdirSync(home, { recursive: true });
      writeVersionFile({ layout: 3 });
      writeFileSync(
        legacy.authJson(),
        JSON.stringify({ access_token: "at", refresh_token: "rt" }),
      );
    }

    it("removes it once the chain has finished", () => {
      seedLayoutThreeWithSession();

      const run = runMigrations(3);

      expect(run.failed).toBeUndefined();
      // It really was backed up — this is not passing because nothing happened.
      expect(run.backedUp).toContain("auth.json");
      // The session landed where layout 4 reads it…
      expect(existsSync(auditSessionFile())).toBe(true);
      // …and the copy is gone.
      expect(existsSync(resolve(migrationBackupDir(3), "auth.json"))).toBe(false);
    });

    it("KEEPS it when the chain failed, which is what a backup is for", () => {
      seedLayoutThreeWithSession();
      // Make the destination directory un-creatable so the move throws.
      writeFileSync(auditDir(), "not a directory");

      const run = runMigrations(3);

      expect(run.failed).toBeDefined();
      expect(existsSync(resolve(migrationBackupDir(3), "auth.json"))).toBe(true);
      // The source survives a failed move — the step is documented not to roll
      // back, so the next command retries from exactly this state.
      expect(existsSync(legacy.authJson())).toBe(true);
      // And the home is NOT marked current, or nothing would ever retry.
      expect(readVersionFile()?.layout).toBe(3);
    });

    it("prunes nothing when the session never arrived at its new home", () => {
      // Guarded on the destination rather than assumed: dropping the only
      // readable copy of a credential is the loss the backup exists to prevent.
      mkdirSync(migrationBackupDir(3), { recursive: true });
      writeFileSync(resolve(migrationBackupDir(3), "auth.json"), "{}");

      pruneMigratedCredentials(3);

      expect(existsSync(resolve(migrationBackupDir(3), "auth.json"))).toBe(true);
    });
  });
});

describe("layout 3 → 4", () => {
  /** A layout-3 home that has signed in, set a reminder, and been scanned. */
  function seedLayoutThree() {
    mkdirSync(home, { recursive: true });
    mkdirSync(resolve(home, "state"), { recursive: true });
    writeFileSync(configFile(), '{"mode":{"kind":"oss"}}');
    writeFileSync(legacy.authJson(), '{"access_token":"at","refresh_token":"rt"}', { mode: 0o600 });
    writeFileSync(legacy.nextAudit(), '{"next_audit_at":123,"user_email":"a@b.c"}');
    writeFileSync(legacy.auditSchedule(), '{"schema":1,"next_due_at_ms":999}');
    writeFileSync(versionFile(), JSON.stringify({ layout: 3, cli: "1.0.0", daemon: "1.0.0" }));
  }

  it("moves all three files under audit/ and leaves nothing at the root", () => {
    seedLayoutThree();

    runMigrations(3);

    expect(JSON.parse(readFileSync(auditSessionFile(), "utf8")).access_token).toBe("at");
    expect(JSON.parse(readFileSync(legacy.auditReminder(), "utf8")).user_email).toBe("a@b.c");
    expect(JSON.parse(readFileSync(auditScheduleFile(), "utf8")).next_due_at_ms).toBe(999);

    expect(existsSync(legacy.authJson())).toBe(false);
    expect(existsSync(legacy.nextAudit())).toBe(false);
    expect(existsSync(legacy.auditSchedule())).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  it("migrates a FAILPROOFAI_AUTH_DIR home too, instead of signing that user out", () => {
    // The override names a directory OUTSIDE the managed home, and it is a
    // documented env var rather than a test hook. Every other path in the step
    // comes from FAILPROOFAI_HOME, so the override directory was never visited:
    // the file stayed `auth.json`, layout 4 read `session.json`, and the upgrade
    // signed the user out without saying so — scans still running, digests
    // silently stopped.
    seedLayoutThree();
    const override = mkdtempSync(resolve(tmpdir(), "fpai-authdir-"));
    const prev = process.env.FAILPROOFAI_AUTH_DIR;
    process.env.FAILPROOFAI_AUTH_DIR = override;
    try {
      writeFileSync(resolve(override, "auth.json"), '{"access_token":"override-at"}', {
        mode: 0o600,
      });
      writeFileSync(resolve(override, "next-audit.json"), '{"user_email":"o@b.c"}');

      runMigrations(3);

      expect(JSON.parse(readFileSync(resolve(override, "session.json"), "utf8")).access_token).toBe(
        "override-at",
      );
      expect(JSON.parse(readFileSync(resolve(override, "reminder.json"), "utf8")).user_email).toBe(
        "o@b.c",
      );
      // And the old names are gone — a second copy of a bearer credential is
      // the thing this step exists to avoid leaving behind.
      expect(existsSync(resolve(override, "auth.json"))).toBe(false);
      expect(existsSync(resolve(override, "next-audit.json"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FAILPROOFAI_AUTH_DIR;
      else process.env.FAILPROOFAI_AUTH_DIR = prev;
      rmSync(override, { recursive: true, force: true });
    }
  });

  it("does not stamp layout 4 when a stale credential could not be deleted", () => {
    // The destination already exists, so the step drops the layout-3 original.
    // Swallowing a failure there continued to `writeVersionFile()` and marked
    // the home migrated with `auth.json` — a live bearer token — still at the
    // root, where nothing would look at it again and nothing would clean it up.
    // Failing leaves the home at layout 3, which `runMigrations` documents as
    // "the next command retries", and the retry is a no-op plus one more delete.
    seedLayoutThree();
    mkdirSync(resolve(home, "audit"), { recursive: true });
    writeFileSync(auditSessionFile(), '{"access_token":"already-here"}', { mode: 0o600 });

    // A DIRECTORY where the credential file should be: `rmSync(from, {force})`
    // suppresses ENOENT and nothing else, so it throws EISDIR here. A real
    // failure from the real call, rather than a mock of it — the ESM import is
    // bound at load time and a spy on the namespace would never be seen.
    rmSync(legacy.authJson(), { force: true });
    mkdirSync(legacy.authJson(), { recursive: true });
    writeFileSync(resolve(legacy.authJson(), "trapped"), "x");

    const run = runMigrations(3);

    expect(run.failed).toBeDefined();
    expect(readVersionFile()?.layout).toBe(3);
    // The layout-4 file was never clobbered by the failed step.
    expect(JSON.parse(readFileSync(auditSessionFile(), "utf8")).access_token).toBe("already-here");
  });

  it("keeps the daemon version, which nothing on this path touches", () => {
    // The step stamps VERSION through `writeVersionFile()` rather than writing
    // the JSON by hand. Hand-rolling it drops `daemon`, which `daemonVersionSkew()`
    // reads on every CLI command — so the machine would silently stop being told
    // its daemon is behind.
    seedLayoutThree();
    runMigrations(3);
    expect(readVersionFile()?.daemon).toBe("1.0.0");
  });

  it("keeps the session file owner-only", () => {
    // A rename preserves the mode and the copy fallback does not, so the step
    // reasserts it either way. This file's entire content is a bearer credential.
    seedLayoutThree();
    runMigrations(3);
    expect(statSync(auditSessionFile()).mode & 0o777).toBe(0o600);
  });

  it("treats a home that never signed in as a clean no-op", () => {
    // The commonest home there is: `auth.json` and `next-audit.json` are absent
    // on every machine that never logged in, and a scan that never ran leaves no
    // schedule. A missing source is success, not an error to stop the chain on.
    mkdirSync(home, { recursive: true });
    writeFileSync(configFile(), '{"mode":{"kind":"oss"}}');
    writeFileSync(versionFile(), JSON.stringify({ layout: 3, cli: "1.0.0" }));

    const run = runMigrations(3);

    expect(run.failed).toBeUndefined();
    expect(existsSync(auditSessionFile())).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  it("does not copy a stale root file back over a layout-4 one", () => {
    // Re-running the step is exactly what happens when a later step in the same
    // chain throws and the user retries. The layout-4 file is authoritative by
    // then, and clobbering it would restore a session that has since been
    // refreshed — or, worse, one the user had signed out of.
    seedLayoutThree();
    mkdirSync(auditDir(), { recursive: true });
    writeFileSync(auditSessionFile(), '{"access_token":"NEWER"}');

    runMigrations(3);

    expect(JSON.parse(readFileSync(auditSessionFile(), "utf8")).access_token).toBe("NEWER");
    // The stale original is dropped rather than left lying at the root — it is a
    // credential, and a second copy of one is a liability.
    expect(existsSync(legacy.authJson())).toBe(false);
  });

  it("backs the three up before moving them", () => {
    // `auth.json` is a live bearer credential that, unlike every other backed-up
    // file, was never on a delete list — so it has never had a copy taken before
    // a migration touched it. A move is not a deletion, but a move with a bug in
    // it is.
    seedLayoutThree();
    const saved = backupBeforeMigrating(3);
    expect(saved).toContain("auth.json");
    expect(saved).toContain("next-audit.json");
    expect(saved).toContain("audit-schedule.json");
  });
});

describe("runMigrations", () => {
  function seedLayoutTwo() {
    mkdirSync(home, { recursive: true });
    writeFileSync(legacy.configToml(), '[mode]\nkind = "cloud"\n');
    writeFileSync(
      legacy.credentialsToml(),
      '[cloud]\nurl = "https://api.example"\nmachine_id = "m1"\ntoken = "tok-live"\n',
    );
    writeFileSync(versionFile(), 'layout = 2\ncli = "1.0.0-beta.5"\n');
  }

  it("marks the home with each step's OWN target, never the current layout", () => {
    // Every step used to end stamping LAYOUT_VERSION, which was harmless while
    // each chain was one hop. On `2 → 3 → 4` the first step marks the home
    // layout 4 with its files still at layout 3, and the gap between that stamp
    // and the second step completing is a real window: a SIGKILL, an OOM or a
    // power loss inside it leaves a home reading `current` forever, because
    // `detectLayout()` short-circuits on the marker and never re-examines the
    // landmarks. The session then sits at the old path, unread, for good.
    //
    // `runMigrations`' catch repairs an over-stamp, but a killed process runs
    // no catch — so the stamp has to be right as it is written, and this pins
    // the first step's value rather than only the chain's end state.
    seedLayoutTwo();
    const stamps: number[] = [];
    const chain = planMigration(2).map((step) => ({
      ...step,
      run: () => {
        const out = step.run();
        stamps.push(readVersionFile()?.layout ?? -1);
        return out;
      },
    }));

    const run = runMigrations(2, chain);

    expect(run.failed).toBeUndefined();
    // One entry per step, each naming where that step actually landed.
    expect(stamps).toEqual(chain.map((s) => s.to));
    expect(stamps[0]).toBe(3);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  it("records every step in the ledger with the CLI that ran it", () => {
    // The ledger answers "what has this machine actually been through", which is
    // the first question a support conversation asks and the one that was
    // previously answerable only by guessing.
    seedLayoutTwo();

    const run = runMigrations(2);

    // Asserted as the SHAPE of a chain rather than a fixed step count: the chain
    // from 2 was one hop at layout 3 and is two at layout 4, and a hardcoded
    // count turns every future layout bump into a test edit that says nothing.
    // What must hold is that the recorded chain starts where the home was, ends
    // where this build speaks, and links end to end with no gap.
    expect(run.steps.length).toBeGreaterThan(0);
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.steps[0].from).toBe(2);
    expect(run.steps.at(-1)?.to).toBe(LAYOUT_VERSION);
    for (let i = 1; i < run.steps.length; i += 1) {
      expect(run.steps[i].from).toBe(run.steps[i - 1].to);
    }

    const ledger = readLedger();
    expect(ledger).toHaveLength(run.steps.length);
    expect(ledger[0].from).toBe(2);
    expect(ledger.at(-1)?.to).toBe(LAYOUT_VERSION);
    for (const entry of ledger) {
      expect(entry.ok).toBe(true);
      expect(entry.cli).toMatch(/\d+\.\d+\.\d+/);
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("appends rather than replacing, so the history survives a second migration", () => {
    seedLayoutTwo();
    runMigrations(2);
    const afterFirst = readLedger().length;
    expect(afterFirst).toBeGreaterThan(0);

    // A later layout bump on the same machine.
    writeFileSync(versionFile(), 'layout = 1\n');
    runMigrations(1);

    // Grew rather than being replaced. Comparing against the first run's own
    // count instead of a literal keeps this about APPENDING, which is the
    // property under test, rather than about how many hops a chain happens to
    // take in the current layout.
    expect(readLedger().length).toBeGreaterThan(afterFirst);
    expect(readLedger().slice(0, afterFirst).every((e) => e.from === 2 || e.from === 3)).toBe(true);
  });

  it("backs up BEFORE the first step, against the layout actually found", () => {
    seedLayoutTwo();

    const run = runMigrations(2);

    // `credentials.toml` is deleted by the step, so its presence in the backup
    // proves the copy happened first — the whole point of the ordering.
    expect(run.backedUp).toContain("credentials.toml");
    expect(existsSync(resolve(migrationBackupDir(2), "credentials.toml"))).toBe(true);
    expect(existsSync(legacy.credentialsToml())).toBe(false);
  });

  it("STOPS the chain at a failing step and leaves VERSION on the old layout", () => {
    // The property that makes a failed migration safe: `VERSION` is stamped only
    // by a step that completed, so a home that failed part-way is still marked
    // OLD and the next command retries it. No home is ever marked current on the
    // strength of a partial migration.
    seedLayoutTwo();
    const noop = (from: number) => () => ({
      removed: [],
      migrated: [],
      activity: [],
      policyConfig: [], spooled: [],
      from,
    });
    const chain: Migration[] = [
      { from: 2, to: 3, describe: "first, fine", run: noop(2) },
      {
        from: 3,
        to: LAYOUT_VERSION,
        describe: "second, throws",
        run: () => {
          throw new Error("disk full");
        },
      },
    ];

    const run = runMigrations(2, chain);

    expect(run.failed).toEqual({ from: 3, to: LAYOUT_VERSION, error: "disk full" });
    expect(run.steps).toEqual([
      { from: 2, to: 3, ok: true },
      { from: 3, to: LAYOUT_VERSION, ok: false },
    ]);
    // Recorded as failed, not silently omitted — a ledger that only lists
    // successes cannot answer "why is this home still on the old layout".
    expect(readLedger().map((e) => e.ok)).toEqual([true, false]);
    // These steps are stubs that never stamp, so the marker is still layout 2.
    expect(readVersionFile()?.layout).toBe(2);
  });

  it("does not leave a home marked current when a LATER step in the chain throws", () => {
    // The multi-step version of the test above, with the real registry rather
    // than stubs — and the reason it needs the real one. Every step ends at
    // `writeVersionFile()`, which stamps LAYOUT_VERSION rather than the step's
    // own `to`, so on a `2 → 3 → 4` chain the FIRST step already claims the home
    // is current. A `3 → 4` that then throws used to leave exactly that claim
    // standing: `detectLayout()` said `current`, nothing ever retried, and
    // `auth.json` stayed at the root while layout 4 read `audit/session.json` —
    // the machine silently signed out with its own session still on disk.
    seedLayoutTwo();
    writeFileSync(legacy.authJson(), '{"access_token":"at"}', { mode: 0o600 });
    // Make the 3 → 4 step fail for a real reason: the destination already
    // exists, so it deletes the layout-3 original — and a DIRECTORY there makes
    // that delete throw EISDIR (`rmSync(force)` suppresses ENOENT and nothing
    // else).
    mkdirSync(auditDir(), { recursive: true });
    writeFileSync(auditSessionFile(), '{"access_token":"already-here"}', { mode: 0o600 });
    rmSync(legacy.authJson(), { force: true });
    mkdirSync(legacy.authJson(), { recursive: true });
    writeFileSync(resolve(legacy.authJson(), "trapped"), "x");

    const run = runMigrations(2);

    expect(run.failed?.from).toBe(3);
    // Behind this build, so the next command plans the chain again.
    expect(readVersionFile()!.layout).toBeLessThan(LAYOUT_VERSION);
    expect(detectLayout().kind).toBe("stale");
  });

  it("does not run any step after the failing one", () => {
    let thirdRan = false;
    const chain: Migration[] = [
      {
        from: 1,
        to: 2,
        describe: "throws",
        run: () => {
          throw new Error("nope");
        },
      },
      {
        from: 2,
        to: LAYOUT_VERSION,
        describe: "must not run",
        run: () => {
          thirdRan = true;
          return { removed: [], migrated: [], activity: [], policyConfig: [], spooled: [], from: 2 };
        },
      },
    ];

    runMigrations(1, chain);

    // Continuing past a failure would run a step against a home whose
    // preconditions the previous step never established.
    expect(thirdRan).toBe(false);
  });

  it("merges the outcomes of the steps that did run", () => {
    seedLayoutTwo();
    mkdirSync(legacy.customPoliciesDir(), { recursive: true });
    writeFileSync(resolve(legacy.customPoliciesDir(), "team-policies.mjs"), "// mine\n");

    const run = runMigrations(2);

    expect(run.outcome.migrated).toContain("team-policies.mjs");
    expect(run.outcome.removed.length).toBeGreaterThan(0);
    expect(run.outcome.from).toBe(2);
  });

  it("survives a home it cannot write a ledger into", () => {
    // A ledger is the audit trail, not a precondition. Losing a line costs a
    // support conversation; failing the migration costs the machine.
    seedLayoutTwo();
    // A FILE where the migrations directory needs to be.
    writeFileSync(resolve(home, "migrations"), "not a directory");

    const run = runMigrations(2);

    expect(run.failed).toBeUndefined();
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });
});

describe("describePlan", () => {
  it("names each step and the files it would save, and changes nothing", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(legacy.configToml(), '[mode]\nkind = "cloud"\n');
    writeFileSync(versionFile(), "layout = 2\n");

    const lines = describePlan(2).join("\n");

    expect(lines).toContain(`Layout 2 on disk; this build speaks ${LAYOUT_VERSION}`);
    // Derived from the plan rather than hardcoded: the dry run's job is to state
    // the real chain, so asserting a literal count would only pin the test to
    // today's layout while proving nothing about the report being accurate.
    expect(lines).toContain(`${planMigration(2).length} step(s) would run`);
    expect(lines).toContain("config.toml");
    // The promise a dry run makes.
    expect(existsSync(migrationLedgerFile())).toBe(false);
    expect(existsSync(migrationBackupDir(2))).toBe(false);
    expect(readVersionFile()?.layout).toBe(2);
  });

  it("lists each file to be saved EXACTLY ONCE", () => {
    // Seen on a real machine: the dry run printed `policies-config.json` twice
    // while the backup correctly wrote it once, because two places built the same
    // list and only one deduped. The duplicate is structural rather than a typo —
    // `legacy.policyConfig()` and `globalPolicyConfigFile()` are the SAME path,
    // since layout 3 put the policy config back where layout 1 kept it — so any
    // caller that walks both arrays sees it twice.
    //
    // This is the command whose entire job is to state accurately what is about to
    // happen, so a cosmetic-looking defect here is the substance of the feature.
    mkdirSync(home, { recursive: true });
    writeFileSync(globalPolicyConfigFile(), '{"enabledPolicies":[]}');
    writeFileSync(versionFile(), "layout = 1\n");

    // Only the lines after the "would be copied" heading — the indented lines
    // above it are the chain steps.
    const lines = describePlan(1);
    const start = lines.findIndex((l) => l.includes("would be copied to"));
    const listed = lines
      .slice(start + 1)
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim())
      .sort();

    expect(listed).toEqual(["VERSION", "policies-config.json"]);
    // And it agrees with what the backup actually writes — the two built this
    // list separately before, which is exactly how they came to disagree.
    expect(listed).toEqual([...backupBeforeMigrating(1)].sort());
  });

  it("says so plainly when there is nothing to do", () => {
    expect(describePlan(LAYOUT_VERSION).join("\n")).toContain("Nothing to migrate");
  });
});
