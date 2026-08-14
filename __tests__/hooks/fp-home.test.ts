import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as H from "../../src/hooks/fp-home";
import {
  detectLayout,
  readConfig,
  writeConfig,
  updateConfig,
  readCredentials,
  writeCredentials,
  readVersionFile,
  writeVersionFile,
  DEFAULT_CONFIG,
} from "../../src/hooks/fp-config";
import { discoverPolicyFiles, findSkippedPolicyFiles } from "../../src/hooks/custom-hooks-loader";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-home-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("fp-home layout", () => {
  it("derives every path from FAILPROOFAI_HOME", () => {
    // The whole point of the module: relocating the home relocates everything
    // atomically, so a test or a container never touches a real machine.
    const paths = [
      H.versionFile(), H.configFile(), H.credentialsFile(), H.binDir(),
      H.policiesDir(), H.globalPolicyConfigFile(),
      H.cloudPoliciesDir(), H.customPoliciesDir(), H.cursorsDir(),
      H.auditDir(), H.auditDashboardFile(), H.auditCacheDir(),
      H.hookActivityDir(), H.customAgentsEventsDir(), H.runDir(),
      H.stateDir(), H.spoolDir(), H.failedDir(), H.collectorHealthFile(),
      H.sessionPauseDir(), H.launcherMarker(), H.onboardingLockFile(),
      H.auditScheduleFile(), H.telemetryIdFile(),
    ];
    for (const p of paths) expect(p.startsWith(home + "/")).toBe(true);
  });

  it("puts the telemetry id exactly where the daemon reads it", () => {
    // The mirror image of the audit schedule below: the CLI is the sole writer
    // and failproofaid only reads, through telemetry_id_path() in
    // crates/failproofaid/src/paths.rs. A divergence does not fail — the daemon
    // simply never finds the file, falls back to a tier it can recompute, and
    // files this machine under a second PostHog person that is indistinguishable
    // from a second machine. Kept next to the Rust literal so the pair has to be
    // changed together.
    expect(H.telemetryIdFile()).toBe(resolve(home, "state", "telemetry-id"));
  });

  it("puts the audit schedule exactly where the daemon writes it", () => {
    // The daemon is this file's sole writer and resolves it independently in
    // crates/failproofaid/src/paths.rs. A divergence does not fail, it just
    // means the dashboard's last-run / next-due readout reads a path nothing
    // writes — and an absent file is indistinguishable from a lane that has
    // never run. Kept next to the Rust literal so the pair has to be changed
    // together.
    expect(H.auditScheduleFile()).toBe(resolve(home, "audit", "schedule.json"));
  });

  it("keeps run/ shallow — sockets must fit in SUN_LEN", () => {
    // A Unix socket path caps at ~108 bytes and we hit that ceiling twice
    // during development. run/ is deliberately NOT nested under state/.
    delete process.env.FAILPROOFAI_DAEMON_SOCKET;
    const rel = H.daemonSocket().slice(home.length);
    expect(rel).toBe("/run/failproofaid.sock");
    // Budget check against a realistic home, not the temp path.
    expect(("/home/somebody/.failproofai" + rel).length).toBeLessThan(108);
  });

  it("honours FAILPROOFAI_DAEMON_SOCKET over the derived path", () => {
    process.env.FAILPROOFAI_DAEMON_SOCKET = "/tmp/x/y.sock";
    expect(H.daemonSocket()).toBe("/tmp/x/y.sock");
    delete process.env.FAILPROOFAI_DAEMON_SOCKET;
  });

  it("puts every policy under policies/ and the config outside it", () => {
    // Layout 3: `policies/` is where policies live, whoever wrote them — the
    // user's `*.mjs` sit in it directly, the fleet's under `cloud-policies/`.
    // Configuration is NOT a policy and stays at the root, because burying the
    // one file a user must not hand-edit among the ones they should is how it
    // gets hand-edited.
    expect(H.customPoliciesDir()).toBe(H.policiesDir());
    expect(H.cloudPoliciesDir()).toBe(resolve(H.policiesDir(), "cloud-policies"));
    expect(H.globalPolicyConfigFile()).toBe(
      resolve(H.failproofaiHome(), "policies-config.json"),
    );
    expect(H.globalPolicyConfigFile().startsWith(`${H.policiesDir()}/`)).toBe(false);
  });

  it("hides cloud artifacts from the convention loader", () => {
    // THE property that makes nesting the fleet's policies inside the user's
    // directory safe. `discoverPolicyFiles` walking subdirectories would turn
    // every cloud artifact into a convention policy — loaded with NO digest
    // check, which is the single thing `cloud-managed-policies.ts` exists to
    // prevent — and `findSkippedPolicyFiles` would warn about each one as a
    // misnamed policy. Both filter `isFile()`; this proves it against a real
    // directory rather than trusting the filter to stay.
    const artifacts = resolve(H.cloudPoliciesDir(), "artifacts");
    mkdirSync(artifacts, { recursive: true });
    // Named to be maximally attractive to both: the convention suffix AND a
    // loadable extension, so only the non-recursion keeps them out.
    writeFileSync(resolve(artifacts, "aaa-policies.mjs"), "export default {}");
    writeFileSync(resolve(H.cloudPoliciesDir(), "active-policies.mjs"), "export default {}");
    // DIRECTORIES named exactly like the files each filter hunts for. Without
    // these the test passed with both `isFile()` filters deleted — the name
    // regexes excluded `cloud-policies` on their own, so it proved nothing about
    // the property its comment claims to prove. `x-policies.mjs` matches the
    // convention regex and `stray.mjs` matches the loadable-extension regex, so
    // now only `isFile()` can keep either one out.
    mkdirSync(resolve(H.policiesDir(), "x-policies.mjs"), { recursive: true });
    mkdirSync(resolve(H.policiesDir(), "stray.mjs"), { recursive: true });

    const mine = resolve(H.policiesDir(), "mine-policies.mjs");
    writeFileSync(mine, "export default {}");

    expect(discoverPolicyFiles(H.policiesDir())).toEqual([mine]);
    expect(findSkippedPolicyFiles(H.policiesDir())).toEqual([]);
  });

  it("gives each collector source its own cursor directory", () => {
    // Two sources sharing a cursor file clobber each other's watermark and
    // the loser re-reads from zero after every restart.
    expect(H.cursorsDir("claude")).not.toBe(H.cursorsDir("codex"));
    expect(H.cursorsDir()).toBe(resolve(home, "cursors"));
  });

  it("never lists bin/ or run/ as resettable", () => {
    // bin/ is a large, version-pinned, re-verified download — deleting it only
    // forces a needless refetch. run/ belongs to a LIVE daemon; removing its
    // sockets breaks a running process rather than resetting configuration.
    const paths = H.resettablePaths();
    expect(paths).not.toContain(H.binDir());
    expect(paths).not.toContain(H.runDir());
  });

  it("resettablePaths covers both layouts", () => {
    const paths = H.resettablePaths();
    // `cache/` is no longer removed as a unit — it CONTAINS layout 1's decision
    // log, which is now carried across — so its other children are named
    // individually and must still be here.
    expect(paths).not.toContain(H.legacy.cacheDir());
    expect(paths).toContain(H.legacy.auditCacheDir());
    expect(paths).toContain(H.legacy.codexSessionPaths());
    // Retired layout-2 files, by their layout-2 names: without them an upgraded
    // home keeps a stale config beside the new one, and a live token in a file
    // nothing reads and nothing will clean up.
    expect(paths).toContain(H.legacy.configToml());
    expect(paths).toContain(H.legacy.credentialsToml());
    // The decision log and the cursors that resume it are the two things a
    // reset must NOT take. See `hook-activity-migration.test.ts`.
    expect(paths).not.toContain(H.hookActivityDir());
    expect(paths).not.toContain(H.cursorsDir());
    // `credentialsFile()` and `legacy.policyConfig()` were asserted PRESENT here.
    // Both are off the list on purpose now — see the classification tests below,
    // which assert the rule rather than the two instances.
    expect(paths).not.toContain(H.credentialsFile());
    expect(paths).not.toContain(H.legacy.policyConfig());
  });
});

// The guard that makes `HOME_CLASSES` a mechanism rather than a comment. A path
// added to the home with no class is not merely undocumented — the delete list is
// a filter over this table, so an unclassified path silently opts out of the one
// question that decides whether an upgrade may throw it away.
//
// This is the same shape as the two other cross-list guards in this repo:
// `HARNESS_KEYS` is checked by reading `main.rs`, and `paths.rs` imports this
// module in a child process to compare every mirrored path. A required TS field
// cannot do it — these are ~34 standalone exported functions that every other
// module imports by name, and turning them into table rows would rewrite every
// import and break the Rust parity test.
describe("HOME_CLASSES", () => {
  // Paths that live INSIDE something already classified. Each names its parent,
  // so this list cannot be used to quietly excuse a genuinely unclassified path.
  const COVERED_BY_PARENT: Record<string, keyof typeof H> = {
    customPoliciesDir: "policiesDir",
    customAgentsEventsDir: "customAgentsDir",
    customAgentsFailedDir: "customAgentsDir",
    // `auditDir` maps to ITSELF, the second entry to do so after `stateDir` and
    // for the same reason: layout 4 made it MIXED. It holds `session.json` (a
    // credential) and `machine.json` (an identity) alongside three derived
    // caches, so it is classified per-file and the parent is deliberately absent
    // from `HOME_CLASSES`. Its children are therefore classified directly and no
    // longer appear here.
    auditDir: "auditDir",
    daemonSocket: "runDir",
    workerSocket: "runDir",
    daemonLock: "runDir",
    auditLockFile: "runDir",
    daemonBinary: "binDir",
    migrationLedgerFile: "migrationsDir",
    migrationBackupDir: "migrationsDir",
    stateDir: "stateDir",
  };

  /** Every exported function that returns a path inside the home. */
  function pathExports(): { name: string; call: () => string }[] {
    const out: { name: string; call: () => string }[] = [];
    for (const [name, value] of Object.entries(H)) {
      if (typeof value !== "function") continue;
      if (name === "failproofaiHome" || name === "resettablePaths") continue;
      // `daemonBinary` needs a version; everything else takes an optional home.
      const call = () => (value as (a?: string) => unknown)(name === "daemonBinary" ? "1.2.3" : undefined);
      try {
        const result = call();
        if (typeof result === "string" && result.startsWith(H.failproofaiHome())) {
          out.push({ name, call: call as () => string });
        }
      } catch {
        // Not a path accessor — a helper that needs different arguments.
      }
    }
    return out;
  }

  it("classifies every exported path, or covers it by a classified parent", () => {
    const classified = new Set(H.HOME_CLASSES.map((e) => e.path()));
    const unclassified = pathExports()
      .filter((e) => !(e.name in COVERED_BY_PARENT))
      .filter((e) => !classified.has(e.call()))
      .map((e) => e.name);

    expect(unclassified).toEqual([]);
  });

  it("every COVERED_BY_PARENT entry names a parent that is really classified", () => {
    // Without this the escape hatch above would be a way to skip the question.
    const classified = new Set(H.HOME_CLASSES.map((e) => e.path()));
    for (const [child, parent] of Object.entries(COVERED_BY_PARENT)) {
      const parentFn = H[parent] as (h?: string) => string;
      // `stateDir` and `auditDir` map to themselves: both are deliberately NOT
      // classified, because both are MIXED — `spool/` and `telemetry-id` must
      // never be dropped while a dozen scratch files under `state/` should be,
      // and `audit/` holds a session token and a machine identity next to two
      // caches. Listing the parent is exactly how a reset came to delete
      // undelivered events, and is what would have deleted the token here.
      if (child === parent) {
        expect(classified.has(parentFn())).toBe(false);
        continue;
      }
      expect(classified.has(parentFn()), `${child} → ${parent}`).toBe(true);
    }
  });

  it("classifies no path twice", () => {
    const seen = H.HOME_CLASSES.map((e) => e.path());
    expect(seen.length).toBe(new Set(seen).size);
  });

  it("never puts a user-typed, undelivered or identity path on the delete list", () => {
    // The rule the classes exist to encode, asserted as a rule. Each of the five
    // paths this newly protects was a real deletion: the cloud token, the whole of
    // config.json (including the extra paths a user typed), the undelivered
    // spool, the SDK spool, and the machine's telemetry identity.
    const paths = H.resettablePaths();
    for (const entry of H.HOME_CLASSES) {
      if (entry.class === "derived" || entry.class === "refetchable") continue;
      expect(paths, `${entry.path()} is ${entry.class}`).not.toContain(entry.path());
    }
  });

  it("puts every derived and refetchable path on the delete list", () => {
    // The other direction: narrowing the reset must not turn it into a no-op.
    const paths = H.resettablePaths();
    for (const entry of H.HOME_CLASSES) {
      if (entry.class !== "derived" && entry.class !== "refetchable") continue;
      expect(paths, `${entry.path()} is ${entry.class}`).toContain(entry.path());
    }
  });

  it("protects the spool and the telemetry id under a state/ dir it does not classify", () => {
    // The mixed-parent case, spelled out because it is the one that bit.
    const paths = H.resettablePaths();
    expect(paths).not.toContain(H.stateDir());
    expect(paths).not.toContain(H.spoolDir());
    expect(paths).not.toContain(H.failedDir());
    expect(paths).not.toContain(H.telemetryIdFile());
    // …while the scratch beside them still goes.
    expect(paths).toContain(H.shimsDir());
    expect(paths).toContain(H.collectorHealthFile());
    expect(paths).toContain(H.sessionPauseDir());
  });
});

describe("detectLayout", () => {
  it("reports absent for an empty home", () => {
    // A fresh install must never be mistaken for a stale one — that would
    // present a reset prompt to somebody who has nothing to reset.
    expect(detectLayout()).toEqual({ kind: "absent" });
  });

  it("reports current once VERSION is written", () => {
    writeVersionFile();
    const state = detectLayout();
    expect(state.kind).toBe("current");
    if (state.kind === "current") expect(state.version.layout).toBe(H.LAYOUT_VERSION);
  });

  it("recognises a layout-1 home by its landmarks", () => {
    writeFileSync(resolve(home, "policies-config.json"), "{}");
    expect(detectLayout()).toEqual({ kind: "stale", found: 1 });
  });

  it("recognises layout 1 from the cache dir alone", () => {
    mkdirSync(resolve(home, "cache", "hook-activity"), { recursive: true });
    expect(detectLayout()).toEqual({ kind: "stale", found: 1 });
  });

  it("reads a layout-3 home that lost its VERSION as current, not stale", () => {
    // Layout 3 put policies-config.json BACK at the home root, which is exactly
    // layout 1's landmark. Without disambiguation a layout-3 home that lost its
    // VERSION reads as layout 1 — and resetHome(1) runs layout-1 MIGRATIONS,
    // which move policies/*.mjs assuming layout-1 positions. In layout 3 those
    // are the user's own convention policies, already where they belong.
    //
    // Reporting `stale` instead was not a safe middle answer either:
    // resettablePaths() lists configFile() and credentialsFile(), so the reset
    // deleted the machine's live cloud token AND `daemon.configured` — the flag
    // that makes it fail closed. `config.json` is layout 3's own file (layout 2
    // wrote config.toml, layout 1 had neither), so it identifies the layout and
    // the only thing missing is the marker.
    writeFileSync(H.globalPolicyConfigFile(), "{}");
    writeConfig(DEFAULT_CONFIG);
    // No VERSION on purpose.
    expect(detectLayout().kind).toBe("current");
  });

  it("reads a layout-2 VERSION even though it is TOML", () => {
    // Layout 2 wrote this file as TOML and layout 3 reads JSON, so `JSON.parse`
    // throws on every layout-2 home. "Unreadable" is not a safe answer: it falls
    // through to the landmarks, and a layout-2 home whose owner never completed
    // setup has no `config.toml` to match and no root `policies-config.json`
    // either (layout 2 nested it) — so it reads as ABSENT, a fresh install. The
    // CLI then stamps it layout 3 with no reset and no migration, orphaning the
    // user's enabled-policy selection and every one of their own policy files,
    // permanently and silently.
    writeFileSync(resolve(home, "VERSION"), 'layout = 2\ncli = "1.0.0-beta.12"\n');
    expect(readVersionFile()).toEqual({ layout: 2, cli: "1.0.0-beta.12" });
    const state = detectLayout();
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.found).toBe(2);
  });

  it("still reports genuinely corrupt VERSION content as unreadable", () => {
    // The TOML fallback must not turn "I cannot tell" into a confident wrong
    // answer: no `layout` line means no layout, and the landmarks decide.
    writeFileSync(resolve(home, "VERSION"), "\u0000\u0001 not a version file");
    expect(readVersionFile()).toBeNull();
  });

  it("still resets a real layout-2 home that has no VERSION", () => {
    // The other side of the same check: config.toml with no config.json is
    // genuinely layout 2, and there a reset is right — those files ARE the ones
    // being replaced. Asserted so the fix above cannot quietly become "any home
    // with a config file is current", which would strand layout-2 machines.
    writeFileSync(H.legacy.configToml(), 'mode = "oss"\n');
    writeFileSync(H.globalPolicyConfigFile(), "{}");
    const state = detectLayout();
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.found).toBe(2);
  });

  it("reports a layout-2 home as 2, never as 'one behind whatever this build is'", () => {
    // The landmark identifies ONE layout. `found: LAYOUT_VERSION - 1` read
    // correctly while current was 3 and silently became data loss at 4: a real
    // layout-2 home was reported as 3, so only the 3 → 4 step ran — which finds
    // none of layout 3's files, moves nothing, and stamps the home current.
    // config.toml and credentials.toml would never be carried into JSON, leaving
    // the cloud token and `daemon.configured` orphaned on a machine that now
    // reads as fully migrated.
    writeFileSync(H.legacy.configToml(), 'mode = "oss"\n');
    const state = detectLayout();
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.found).toBe(2);
  });

  it("calls a config.json home with layout-3 audit files still at the root stale, not current", () => {
    // `config.json` proves "3 or later" and cannot separate them, so the audit
    // files' POSITION is the discriminator. Getting this wrong skips the 3 → 4
    // move: auth.json stays at the root, `audit/session.json` never appears, and
    // the user is silently signed out with the file still sitting on disk.
    writeFileSync(H.configFile(), "{}");
    writeFileSync(H.legacy.authJson(), "{}");
    const state = detectLayout();
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.found).toBe(3);
  });

  it("calls a config.json home with no layout-3 audit files current", () => {
    // The other direction: with none of those three present the two layouts are
    // identical on disk — the step would move nothing — so reporting stale would
    // run a migration to achieve exactly nothing, on the commonest home there is
    // (one that has never signed in).
    writeFileSync(H.configFile(), "{}");
    expect(detectLayout().kind).toBe("current");
  });

  it("distinguishes a FUTURE layout from a stale one", () => {
    // Telling someone to reset a home written by a newer CLI would delete data
    // a simple upgrade would have read fine.
    writeFileSync(resolve(home, "VERSION"), JSON.stringify({ layout: 99, cli: "9.9.9" }));
    expect(detectLayout()).toEqual({ kind: "future", found: 99 });
  });

  it("treats a corrupt VERSION with no landmarks as absent", () => {
    writeFileSync(resolve(home, "VERSION"), "this is not toml {{{");
    expect(detectLayout()).toEqual({ kind: "absent" });
  });
});

describe("VERSION file", () => {
  it("round-trips and preserves the daemon version across writes", () => {
    writeVersionFile({ daemon: "1.0.0-beta.5" });
    expect(readVersionFile()).toMatchObject({ layout: H.LAYOUT_VERSION, daemon: "1.0.0-beta.5" });
    // A CLI-only rewrite must not drop the daemon version it did not touch.
    writeVersionFile({ cli: "2.0.0" });
    expect(readVersionFile()).toMatchObject({ cli: "2.0.0", daemon: "1.0.0-beta.5" });
  });
});

describe("config.toml", () => {
  it("defaults to OSS when absent", () => {
    expect(readConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips every field", () => {
    const cfg = {
      mode: "cloud" as const,
      // No version field here on purpose — the installed daemon version lives
      // in VERSION, so one copy cannot disagree with another.
      daemon: { configured: true },
      collector: {
        sessions: true, hooks: true, hooksVerbosity: "all" as const,
        redact: "off" as const, environment: "prod", machineId: "box-1",
      },
      telemetry: { enabled: true },
      audit: { auto: true, intervalDays: 14 },
    };
    writeConfig(cfg);
    expect(readConfig()).toEqual(cfg);
  });

  it("telemetry is on by default and the file says nothing about it", () => {
    // The shipped posture: on, and not advertised in the config a user cat's.
    writeConfig(DEFAULT_CONFIG);
    expect(readConfig().telemetry.enabled).toBe(true);
    expect(JSON.parse(readFileSync(H.configFile(), "utf8")).telemetry).toBeUndefined();
  });

  it("a telemetry opt-out SURVIVES a rewrite", () => {
    // writeConfig regenerates the whole file, so a key it does not emit is a key
    // it silently deletes. Switching telemetry back on under someone who turned
    // it off would be the worst possible bug in this feature.
    writeConfig({ ...DEFAULT_CONFIG, telemetry: { enabled: false } });
    expect(readConfig().telemetry.enabled).toBe(false);
    expect(JSON.parse(readFileSync(H.configFile(), "utf8")).telemetry).toEqual({
      enabled: false,
    });

    // A later unrelated write must not resurrect it.
    writeConfig({ ...readConfig(), collector: { ...DEFAULT_CONFIG.collector, environment: "ci" } });
    expect(readConfig().telemetry.enabled).toBe(false);
  });

  it("only an explicit false disables telemetry", () => {
    writeFileSync(H.configFile(), JSON.stringify({ telemetry: { enabled: "no" } }));
    expect(readConfig().telemetry.enabled).toBe(true);
    writeFileSync(H.configFile(), JSON.stringify({ telemetry: { enabled: false } }));
    expect(readConfig().telemetry.enabled).toBe(false);
  });

  it("the scheduled audit is OFF by default and says so in the file", () => {
    // The opposite posture to telemetry directly above: off, and deliberately
    // visible, because it is a switch the user is meant to find and flip. It is
    // off because the scan reads the contents of every transcript on disk.
    expect(DEFAULT_CONFIG.audit).toEqual({ auto: false, intervalDays: 7 });
    writeConfig(DEFAULT_CONFIG);
    // Both keys on disk, unconditionally. The layout-2 file made this visible
    // with a comment block; JSON cannot carry one, so what survives is the
    // weaker but still real guarantee: every field the struct holds is written,
    // so no later regeneration can silently drop one.
    const written = JSON.parse(readFileSync(H.configFile(), "utf8"));
    expect(written.audit).toEqual({ auto: false, interval_days: 7 });
  });

  it("an enabled auto-audit SURVIVES a rewrite", () => {
    // writeConfig regenerates the whole file, so a key it does not emit is a key
    // it silently deletes — the failure that would turn somebody's weekly audit
    // off the next time any unrelated setting changed.
    writeConfig({ ...DEFAULT_CONFIG, audit: { auto: true, intervalDays: 30 } });
    expect(readConfig().audit).toEqual({ auto: true, intervalDays: 30 });

    writeConfig({ ...readConfig(), collector: { ...DEFAULT_CONFIG.collector, environment: "ci" } });
    // `emailEnabled` is asserted alongside `auto` deliberately: it is the switch
    // that makes anything leave the machine, so a rewrite silently dropping it
    // would turn emailed reports off with no notice — the same class of failure
    // this test was written for, on the newer of the two keys.
    expect(readConfig().audit).toEqual({ auto: true, intervalDays: 30 });
  });

  it("only an explicit true switches the auto-audit on", () => {
    writeFileSync(H.configFile(), JSON.stringify({ audit: { auto: "yes" } }));
    expect(readConfig().audit.auto).toBe(false);
    writeFileSync(H.configFile(), JSON.stringify({ audit: { auto: true } }));
    expect(readConfig().audit.auto).toBe(true);
  });

  it("resolves a nonsense interval to the default rather than to a daily scan", () => {
    // 0 almost certainly means "off", and reading it as a DAILY 104-second scan
    // of every transcript on the machine is the loudest way to misread it.
    for (const raw of ["0", "-3", "0.5", '"weekly"', "true"]) {
      writeFileSync(H.configFile(), JSON.stringify({ audit: { auto: true, interval_days: raw } }));
      expect(readConfig().audit.intervalDays).toBe(7);
    }
  });

  it("clamps a too-large interval DOWN rather than falling back", () => {
    // Falling back to 7 for `3650` would scan an order of magnitude more often
    // than was asked for; 90 is the conservative direction of the two.
    writeFileSync(H.configFile(), JSON.stringify({ audit: { auto: true, interval_days: 3650 } }));
    expect(readConfig().audit.intervalDays).toBe(90);
    writeFileSync(H.configFile(), JSON.stringify({ audit: { auto: true, interval_days: 1 } }));
    expect(readConfig().audit.intervalDays).toBe(1);
  });

  it("updateConfig patches the audit block without touching the rest", () => {
    writeConfig({ ...DEFAULT_CONFIG, telemetry: { enabled: false } });
    updateConfig({ audit: { auto: true } });
    const after = readConfig();
    expect(after.audit).toEqual({ auto: true, intervalDays: 7 });
    expect(after.telemetry.enabled).toBe(false); // untouched
  });

  // A test stood here asserting the layout-2 file's mode COMMENT — that it no
  // longer claimed "Nothing is sent anywhere, ever", which was untrue while
  // telemetry dispatchers exist. JSON cannot carry a comment, so the property
  // is gone along with the text. That guidance now lives in
  // `failproofai config --status` and the docs, which is a worse home for it:
  // this is the file someone opens when something looks wrong.
  //
  // What survives is structural, and asserted here instead.

  it("round-trips every field, so a rewrite cannot silently drop one", () => {
    // writeConfig regenerates the file wholesale, so a field it fails to emit
    // is a field it deletes — and the user finds out when a setting they chose
    // quietly reverts. This is the half of the comments' job that JSON keeps.
    const config = {
      ...DEFAULT_CONFIG,
      mode: "cloud" as const,
      daemon: { configured: true },
      telemetry: { enabled: false },
      audit: { auto: true, intervalDays: 30 },
      collector: { ...DEFAULT_CONFIG.collector, environment: "ci", machineId: "m-1" },
    };
    writeConfig(config);
    expect(readConfig()).toEqual(config);
  });

  it("a corrupt config reads as OSS, never as cloud", () => {
    // Failure direction: a damaged file must not be able to switch reporting
    // ON. Silent-and-local is the only safe way to fail here.
    writeFileSync(H.configFile(), "{ not json");
    expect(readConfig().mode).toBe("oss");
  });

  it("an unrecognised mode reads as OSS", () => {
    // Written as JSON on purpose. With a TOML body in a .json file the parse
    // failed and readConfig returned its defaults — so this passed while the
    // mode branch it names was never reached, and would have kept passing if
    // that branch had been deleted. The unrecognised value must be REACHED and
    // rejected: `oss` is a hard gate, and anything that is not a mode we know
    // must land on the side that stays silent.
    writeFileSync(H.configFile(), JSON.stringify({ mode: { kind: "enterprise" } }));
    expect(readConfig().mode).toBe("oss");
  });

  it("updateConfig merges rather than replacing", () => {
    writeConfig({ ...DEFAULT_CONFIG, collector: { ...DEFAULT_CONFIG.collector, environment: "ci" } });
    updateConfig({ daemon: { configured: true } });
    const after = readConfig();
    expect(after.daemon.configured).toBe(true);
    expect(after.collector.environment).toBe("ci"); // untouched
  });

  it("stays hand-editable: indented JSON, one trailing newline", () => {
    // The layout-2 version of this asserted that comments survived a read.
    // They cannot in JSON, so what is defended now is the rest of
    // hand-editability: a file a person can open, understand and change without
    // a formatter, and that a text editor will not mangle.
    writeConfig(DEFAULT_CONFIG);
    const text = readFileSync(H.configFile(), "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain("\n  "); // indented, not minified onto one line
    expect(text.endsWith("\n")).toBe(true);
    expect(() => readConfig()).not.toThrow();
  });
});

describe("credentials.toml", () => {
  it("is written owner-only, and tightens the home", () => {
    writeCredentials({ ingest: { url: "https://x/events", key: "k123456789" } });
    const { statSync } = require("node:fs");
    expect(statSync(H.credentialsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o077).toBe(0);
  });

  it("re-tightens an existing over-permissive file", () => {
    const { chmodSync, statSync } = require("node:fs");
    writeCredentials({ ingest: { url: "https://x/events", key: "k1" } });
    chmodSync(H.credentialsFile(), 0o644);
    // mode: on writeFileSync applies only at CREATE, so the rewrite must chmod.
    writeCredentials({ ingest: { url: "https://x/events", key: "k2" } });
    expect(statSync(H.credentialsFile()).mode & 0o777).toBe(0o600);
  });

  it("round-trips all three credential kinds", () => {
    const creds = {
      cloud: { url: "https://c", machineId: "m1", token: "t1" },
      ingest: { url: "https://c/events", key: "k1" },
      auth: { baseUrl: "https://c", sessionToken: "s1", expiresAt: 123, email: "a@b.c" },
    };
    writeCredentials(creds);
    expect(readCredentials()).toEqual(creds);
  });

  it("ignores partial/blank credential blocks", () => {
    // A half-written credential is worse than none: --status would report a
    // connection the machine does not have.
    // JSON, so the empty-key filter is the thing being tested. A TOML body here
    // failed to parse, which also yields `undefined` — the same answer for the
    // opposite reason, and no coverage of the filter at all.
    writeFileSync(H.credentialsFile(), JSON.stringify({ ingest: { url: "https://x", key: "" } }));
    expect(readCredentials().ingest).toBeUndefined();
  });

  it("never puts a token in config.json", () => {
    writeCredentials({ ingest: { url: "https://x/events", key: "SUPERSECRET" } });
    writeConfig({ ...DEFAULT_CONFIG, mode: "cloud" });
    expect(readFileSync(H.configFile(), "utf8")).not.toContain("SUPERSECRET");
  });
});
