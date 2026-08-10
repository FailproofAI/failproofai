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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  LAYOUT_VERSION,
  configFile,
  credentialsFile,
  globalPolicyConfigFile,
  legacy,
  migrationBackupDir,
  migrationLedgerFile,
  versionFile,
} from "../../src/hooks/fp-home";
import { readVersionFile } from "../../src/hooks/fp-config";
import {
  MIGRATIONS,
  backupBeforeMigrating,
  describePlan,
  migrationCoverageGap,
  planMigration,
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
      { from: 1, to: 2, describe: "1→2", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], from: 1 }) },
      { from: 2, to: LAYOUT_VERSION, describe: "2→cur", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], from: 2 }) },
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
      { from: 1, to: 2, describe: "1→2", run: () => ({ removed: [], migrated: [], activity: [], policyConfig: [], from: 1 }) },
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
    const noop = () => ({ removed: [], migrated: [], activity: [], policyConfig: [], from: 1 });
    const backwards: Migration[] = [{ from: 2, to: 1, describe: "x", run: noop }];
    expect(migrationCoverageGap(backwards).some((p) => p.includes("does not move forward"))).toBe(true);

    const duplicated: Migration[] = [
      { from: 1, to: LAYOUT_VERSION, describe: "a", run: noop },
      { from: 1, to: LAYOUT_VERSION, describe: "b", run: noop },
    ];
    expect(migrationCoverageGap(duplicated)).toContain("two steps read the same layout");
  });

  it("catches a step that overshoots the current layout", () => {
    const noop = () => ({ removed: [], migrated: [], activity: [], policyConfig: [], from: 1 });
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

  it("records every step in the ledger with the CLI that ran it", () => {
    // The ledger answers "what has this machine actually been through", which is
    // the first question a support conversation asks and the one that was
    // previously answerable only by guessing.
    seedLayoutTwo();

    const run = runMigrations(2);

    expect(run.steps).toEqual([{ from: 2, to: LAYOUT_VERSION, ok: true }]);
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].from).toBe(2);
    expect(ledger[0].to).toBe(LAYOUT_VERSION);
    expect(ledger[0].ok).toBe(true);
    expect(ledger[0].cli).toMatch(/\d+\.\d+\.\d+/);
    expect(ledger[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends rather than replacing, so the history survives a second migration", () => {
    seedLayoutTwo();
    runMigrations(2);
    // A later layout bump on the same machine.
    writeFileSync(versionFile(), 'layout = 1\n');
    runMigrations(1);

    expect(readLedger()).toHaveLength(2);
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
      policyConfig: [],
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
          return { removed: [], migrated: [], activity: [], policyConfig: [], from: 2 };
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
    expect(lines).toContain("1 step(s) would run");
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
