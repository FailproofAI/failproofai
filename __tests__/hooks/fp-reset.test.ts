import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  LAYOUT_VERSION,
  binDir,
  runDir,
  hookActivityDir,
  cursorsDir,
  customPoliciesDir,
  policiesDir,
  globalPolicyConfigFile,
  cloudPoliciesDir,
  legacy,
} from "../../src/hooks/fp-home";
import { detectLayout, readConfig, readVersionFile, writeVersionFile } from "../../src/hooks/fp-config";
import {
  resetHome,
  checkLayoutForCli,
  layoutWarningForHook,
  layoutBlockerForScheduledRun,
} from "../../src/hooks/fp-reset";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-reset-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

/** A believable layout-1 home. */
function seedLayoutOne() {
  mkdirSync(legacy.hookActivityDir(), { recursive: true });
  writeFileSync(resolve(legacy.hookActivityDir(), "current.jsonl"), "{}\n");
  mkdirSync(legacy.auditCacheDir(), { recursive: true });
  writeFileSync(legacy.policyConfig(), '{"enabledPolicies":["block-sudo"]}');
  writeFileSync(legacy.ingestCredentials(), '{"url":"https://x","key":"k"}');
  writeFileSync(legacy.auditDashboard(), "{}");
  writeFileSync(legacy.launcherMarker(), "1");
  mkdirSync(resolve(home, "cursors", "claude"), { recursive: true });
  writeFileSync(resolve(home, "cursors", "claude", "cursors.json"), "{}");
}

describe("resetHome", () => {
  it("removes layout-1 state and stamps the current VERSION", () => {
    seedLayoutOne();
    const out = resetHome(1);

    expect(out.from).toBe(1);
    expect(out.removed.length).toBeGreaterThan(0);
    // NOT absent: layout 3 keeps the policy config at this exact path and the
    // carry rewrites it with the user's selection. What must be gone is the
    // layout-1 state around it.
    expect(existsSync(legacy.policyConfig())).toBe(true);
    // `cache/` itself survives now — it contains the decision log, which is
    // carried across — but everything else inside it goes.
    expect(existsSync(legacy.auditCacheDir())).toBe(false);
    expect(existsSync(legacy.ingestCredentials())).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
    expect(detectLayout().kind).toBe("current");
  });

  it("KEEPS cursors — the decision was reversed deliberately", () => {
    // This asserted the opposite, with a comment warning that a later
    // "kindness" must not quietly reintroduce a special case. The reversal is
    // not a kindness and is not quiet: layout 1's decision log is now MOVED
    // into layout 2 rather than deleted, and a move preserves the inode
    // precisely so the cursors keyed on `(device, inode)` still resume it.
    // Delete the cursors and every carried page reads as new and re-ships in
    // full — which is the outcome the move exists to prevent, so keeping the
    // log and dropping the watermarks would be half a feature.
    //
    // The original call — one rule, no exceptions — bought simplicity at the
    // price of a one-off re-ship. That price is now paid by users who have
    // real history, which is the case this exists to serve.
    seedLayoutOne();
    resetHome(1);
    expect(existsSync(cursorsDir())).toBe(true);
  });

  it("NEVER removes the downloaded daemon binary", () => {
    // It is large, version-pinned and SHA-verified on use. Deleting it only
    // forces a needless refetch — on a machine that may be offline.
    mkdirSync(binDir(), { recursive: true });
    writeFileSync(resolve(binDir(), "failproofaid-1.0.0"), "ELF");
    seedLayoutOne();
    resetHome(1);
    expect(existsSync(resolve(binDir(), "failproofaid-1.0.0"))).toBe(true);
  });

  it("NEVER removes run/ — those sockets may belong to a live daemon", () => {
    mkdirSync(runDir(), { recursive: true });
    writeFileSync(resolve(runDir(), "failproofaid.lock"), "");
    seedLayoutOne();
    resetHome(1);
    expect(existsSync(resolve(runDir(), "failproofaid.lock"))).toBe(true);
  });

  it("is idempotent", () => {
    seedLayoutOne();
    resetHome(1);
    const second = resetHome(LAYOUT_VERSION);
    expect(second.removed).toEqual([]);
    expect(detectLayout().kind).toBe("current");
  });

  // `~/.failproofai/policies/` is where layout 1 DOCUMENTED personal policies
  // (`docs/configuration.mdx`: "User | ~/.failproofai/policies/ | Personal,
  // applies to all projects"). They are hand-written source: nothing
  // regenerates them and nothing backs them up, so an unconditional
  // `rmSync(recursive, force)` on the parent was silent, permanent data loss —
  // and the printed message named only "policy config, activity history and
  // audit cache".
  describe("hand-written policies in the layout-1 policies/ directory", () => {
    function seedUserPolicies() {
      mkdirSync(resolve(home, "policies"), { recursive: true });
      writeFileSync(resolve(home, "policies", "my-policies.mjs"), "// mine\n");
      writeFileSync(resolve(home, "policies", "team-policies.js"), "// team\n");
      // Misses the *policies.{js,mjs,ts} convention, so it never loaded — but
      // it is still source somebody wrote, and deleting it is the same harm.
      writeFileSync(resolve(home, "policies", "block-foo.mjs"), "// skipped\n");
    }

    it("leaves them exactly where they are — layout 3 already loads them there", () => {
      // Layout 2 MOVED these down into `policies/custom-policies/`. Layout 3
      // reads `policies/` directly, which is where layout 1 put them, so the
      // right migration is no migration: the files must not move, and must not
      // be deleted.
      seedLayoutOne();
      seedUserPolicies();
      resetHome(1);
      expect(existsSync(resolve(home, "policies", "my-policies.mjs"))).toBe(true);
      expect(existsSync(resolve(home, "policies", "team-policies.js"))).toBe(true);
      // Including the one that misses the naming convention: still somebody's
      // source, and deleting it is the same harm.
      expect(existsSync(resolve(home, "policies", "block-foo.mjs"))).toBe(true);
      expect(existsSync(resolve(customPoliciesDir(), "my-policies.mjs"))).toBe(true);
    });

    it("carries layout 2's policies back UP out of custom-policies/", () => {
      // The other direction, and the one that matters for anyone upgrading from
      // layout 2: `policies/custom-policies/` is in `resettablePaths()`, so a
      // file left there is a file the reset deletes.
      seedLayoutOne();
      mkdirSync(legacy.customPoliciesDir(), { recursive: true });
      writeFileSync(resolve(legacy.customPoliciesDir(), "from-two-policies.mjs"), "// v2\n");

      const out = resetHome(2);

      expect(out.migrated).toEqual(["from-two-policies.mjs"]);
      expect(existsSync(resolve(policiesDir(), "from-two-policies.mjs"))).toBe(true);
      expect(existsSync(legacy.customPoliciesDir())).toBe(false);
    });

    it("carries the helpers and data files a policy imports, not just sources", () => {
      // `custom-policies/` is deleted by the reset, so anything the migration
      // leaves behind is DESTROYED, not merely stranded. Moving only
      // `*.{js,mjs,ts}` took out precisely what a real policy depends on — a
      // `lib/` of shared helpers and the `.json` it reads its rules from — and
      // the policy that DID survive then imported a file that no longer
      // existed. A broken policy plus deleted source, from a migration whose
      // message says it kept the user's files.
      seedLayoutOne();
      const from = legacy.customPoliciesDir();
      mkdirSync(resolve(from, "lib"), { recursive: true });
      writeFileSync(resolve(from, "team-policies.mjs"), 'import "./lib/rules.mjs";\n');
      writeFileSync(resolve(from, "lib", "rules.mjs"), "export const RULES = [];\n");
      writeFileSync(resolve(from, "blocklist.json"), '{"deny":["curl"]}');

      resetHome(2);

      // Relative imports still resolve because every entry keeps its position
      // relative to every other.
      expect(existsSync(resolve(policiesDir(), "team-policies.mjs"))).toBe(true);
      expect(existsSync(resolve(policiesDir(), "lib", "rules.mjs"))).toBe(true);
      expect(existsSync(resolve(policiesDir(), "blocklist.json"))).toBe(true);
      expect(existsSync(from)).toBe(false);
    });

    it("merges a colliding directory instead of discarding it", () => {
      // `lib/` is the likeliest collision of all: the layout-1 → 2 migration
      // moved only `*.{js,mjs,ts}`, so a stale `policies/lib/` is exactly what it
      // left behind. Skipping the whole directory on a name match threw away
      // every file inside it — and because `custom-policies/` was on the reset
      // list, "skipped" meant DELETED. The policy that did move was then left
      // importing a `./lib/rules.mjs` that no longer existed anywhere.
      seedLayoutOne();
      const from = legacy.customPoliciesDir();
      mkdirSync(resolve(from, "lib"), { recursive: true });
      mkdirSync(resolve(policiesDir(), "lib"), { recursive: true });
      writeFileSync(resolve(policiesDir(), "lib", "leftover.mjs"), "export const a = 1;\n");
      writeFileSync(resolve(from, "my-policies.mjs"), 'import "./lib/rules.mjs";\n');
      writeFileSync(resolve(from, "lib", "rules.mjs"), "export const RULES = [];\n");

      resetHome(2);

      expect(existsSync(resolve(policiesDir(), "my-policies.mjs"))).toBe(true);
      expect(existsSync(resolve(policiesDir(), "lib", "rules.mjs"))).toBe(true);
      // The directory that was already there is untouched, not replaced.
      expect(existsSync(resolve(policiesDir(), "lib", "leftover.mjs"))).toBe(true);
    });

    it("keeps what it could not move, rather than deleting it", () => {
      // A genuine leaf collision: same name, and the destination wins. The
      // layout-2 copy is the user's hand-written source and nothing regenerates
      // it, so it must still be on disk afterwards — `custom-policies/` is
      // deliberately NOT in resettablePaths() for exactly this reason.
      seedLayoutOne();
      const from = legacy.customPoliciesDir();
      mkdirSync(from, { recursive: true });
      writeFileSync(resolve(from, "beta-policies.mjs"), "// LAYOUT 2 COPY\n");
      writeFileSync(resolve(policiesDir(), "beta-policies.mjs"), "// LAYOUT 3 COPY\n");

      resetHome(2);

      // The destination is never overwritten...
      expect(readFileSync(resolve(policiesDir(), "beta-policies.mjs"), "utf8")).toContain("LAYOUT 3 COPY");
      // ...and the source it refused to overwrite with is still there to look at.
      expect(readFileSync(resolve(from, "beta-policies.mjs"), "utf8")).toContain("LAYOUT 2 COPY");
    });

    it("reports nothing moved, because nothing needed to move", () => {
      // Layout 2's loader opened `policies/custom-policies/`, so layout 1's
      // files had to be carried down into it. Layout 3's loader opens
      // `policies/` — where they already are — so the honest report is an empty
      // migration, not a move to the same place dressed up as one.
      seedLayoutOne();
      seedUserPolicies();
      const out = resetHome(1);

      expect(out.migrated).toEqual([]);
      expect(existsSync(resolve(policiesDir(), "my-policies.mjs"))).toBe(true);
      expect(existsSync(resolve(policiesDir(), "team-policies.js"))).toBe(true);
      expect(existsSync(resolve(policiesDir(), "block-foo.mjs"))).toBe(true);
    });

    it("removes layout 2's credentials.toml — a live token nothing will read again", () => {
      // The worst thing a layout migration can leave behind. `credentials.toml`
      // holds the org-scoped `policies:pull` bearer token and the ingest key;
      // layout 3 stops reading it, so if this entry ever regresses the token
      // sits on disk indefinitely — unread, unrotatable through the CLI, and
      // invisible to `failproofai config --status`. Untested until now, on a
      // list where "it is in the array" and "it is actually deleted" are
      // different claims.
      seedLayoutOne();
      writeFileSync(legacy.credentialsToml(), '[cloud]\ntoken = "LIVE-TOKEN"\n');
      writeFileSync(legacy.configToml(), 'mode = "cloud"\n');
      mkdirSync(legacy.localPoliciesDir(), { recursive: true });
      writeFileSync(resolve(legacy.localPoliciesDir(), "policies-config.json"), "{}");

      resetHome(2);

      expect(existsSync(legacy.credentialsToml())).toBe(false);
      expect(existsSync(legacy.configToml())).toBe(false);
      expect(existsSync(legacy.localPoliciesDir())).toBe(false);
    });

    it("carries a telemetry opt-out out of config.toml", () => {
      // config.toml is deleted by the reset and the fresh config.json defaults
      // telemetry ON, so the upgrade silently revoked the opt-out. That file is
      // the only off-switch that reaches the daemon — a system-scope service
      // unit inherits no FAILPROOFAI_TELEMETRY_DISABLED from anyone's shell.
      seedLayoutOne();
      writeFileSync(legacy.configToml(), '[mode]\nkind = "oss"\n\n[telemetry]\nenabled = false\n');

      resetHome(2);

      expect(readConfig().telemetry.enabled).toBe(false);
    });

    it("does not invent an opt-out nobody asked for", () => {
      // Only `false` is carried. Carrying an enabled flag forward would be
      // carrying the DEFAULT, which is not a choice anyone made.
      seedLayoutOne();
      writeFileSync(legacy.configToml(), '[mode]\nkind = "oss"\n\n[telemetry]\nenabled = true\n');

      resetHome(2);

      expect(readConfig().telemetry.enabled).toBe(true);
    });

    it("still clears the machine-owned policy state", () => {
      // Narrowing the reset must not turn it into a no-op: both of these are
      // re-derived (the config by setup, cloud by the next daemon poll) and a
      // stale one is exactly what the reset exists to remove.
      seedLayoutOne();
      writeFileSync(globalPolicyConfigFile(), "{}");
      mkdirSync(cloudPoliciesDir(), { recursive: true });
      writeFileSync(resolve(cloudPoliciesDir(), "active.json"), "{}");
      mkdirSync(legacy.cloudManagedPolicies(), { recursive: true });

      resetHome(1);

      expect(existsSync(globalPolicyConfigFile())).toBe(false);
      expect(existsSync(cloudPoliciesDir())).toBe(false);
      expect(existsSync(legacy.cloudManagedPolicies())).toBe(false);
    });

    it("leaves a layout-1 home's policy files exactly where they are", () => {
      // This test used to seed `customPoliciesDir()` as the DESTINATION and
      // `policies/` as the source and assert that neither was overwritten —
      // but layout 3 aliased `customPoliciesDir = policiesDir`, so those became
      // the SAME FILE. It wrote "// mine" then "// newer" over one path and
      // asserted the survivor was "// newer", which is true of any code at all.
      // It never ran the migration it named — `legacy.customPoliciesDir()` does
      // not exist on a layout-1 home, so the function returns at its first
      // guard. The never-overwrite invariant is covered for real by "keeps what
      // it could not move", which fails when that behaviour is reverted.
      //
      // What IS worth asserting here is layout 1's own property: the files are
      // already in the directory layout 3 loads, so the migration must not
      // touch them at all — not move them, not rewrite them, not report them.
      seedLayoutOne();
      seedUserPolicies();
      writeFileSync(resolve(policiesDir(), "my-policies.mjs"), "// exactly this\n");

      const out = resetHome(1);

      expect(out.migrated).toEqual([]);
      expect(readFileSync(resolve(policiesDir(), "my-policies.mjs"), "utf8")).toBe("// exactly this\n");
    });
  });
});

describe("checkLayoutForCli", () => {
  it("resets a stale home and explains what happened", async () => {
    seedLayoutOne();
    const check = await checkLayoutForCli();
    expect(check.fatal).toBe(false);
    expect(check.lines.join("\n")).toContain("failproofai config");
    // NOT absent: layout 3 keeps the policy config at this exact path and the
    // carry rewrites it with the user's selection. What must be gone is the
    // layout-1 state around it.
    expect(existsSync(legacy.policyConfig())).toBe(true);
  });

  it("REFUSES a future layout instead of deleting it", async () => {
    // The two failures are not symmetric: an older home can be rebuilt by
    // re-running setup, but a newer one holds data this build cannot read and
    // an upgrade could. Resetting it would destroy something recoverable.
    writeFileSync(resolve(home, "VERSION"), JSON.stringify({ layout: 99, cli: "9.9.9" }));
    writeFileSync(resolve(home, "config.json"), JSON.stringify({ mode: { kind: "cloud" } }));

    const check = await checkLayoutForCli();

    expect(check.fatal).toBe(true);
    expect(check.lines.join("\n")).toMatch(/newer version/i);
    expect(check.lines.join("\n")).toContain("npm install -g failproofai@latest");
    // Nothing removed.
    expect(existsSync(resolve(home, "config.json"))).toBe(true);
  });

  it("stamps VERSION on a fresh home and says nothing", async () => {
    const check = await checkLayoutForCli();
    expect(check.lines).toEqual([]);
    expect(check.fatal).toBe(false);
    expect(check.didReset).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  // A reset removes the global policy config but deliberately leaves the agent
  // CLIs' settings files alone — so `isConfigured()` still reads true off
  // `hasGlobalHooks`, the wizard is skipped, and `markLauncherSeen()` back-fills
  // the marker so every LATER run skips it too. Without this flag the user is
  // left with hooks firing on every tool call against an empty policy set, and
  // nothing ever says so again.
  it("reports didReset so the caller can force setup", async () => {
    seedLayoutOne();
    const check = await checkLayoutForCli();
    expect(check.didReset).toBe(true);
  });

  it("names the policy files it moved rather than counting them", async () => {
    // Seeded in LAYOUT 2's position, because that is the only upgrade that
    // still moves anything — a layout-1 home's policies already sit where
    // layout 3 reads them.
    seedLayoutOne();
    mkdirSync(legacy.customPoliciesDir(), { recursive: true });
    writeFileSync(resolve(legacy.customPoliciesDir(), "my-policies.mjs"), "// mine\n");

    const text = (await checkLayoutForCli()).lines.join("\n");

    expect(text).toContain("my-policies.mjs");
    expect(text).toContain(policiesDir());
  });

  it("says nothing on an already-current home", async () => {
    writeVersionFile();
    mkdirSync(hookActivityDir(), { recursive: true });
    expect((await checkLayoutForCli()).lines).toEqual([]);
  });
});

describe("layoutWarningForHook", () => {
  it("warns when the global config really is where nothing reads it", () => {
    // The failure being guarded: a stale home resolves to no global config, so
    // every builtin quietly stops firing and the machine looks protected.
    //
    // Layout 2 is that case — it nested the file at
    // `policies/local-policies/policies-config.json`, which layout 3 never
    // reads — so the warning is TRUE here and must fire.
    writeFileSync(legacy.configToml(), 'mode = "oss"\n');
    mkdirSync(legacy.localPoliciesDir(), { recursive: true });
    writeFileSync(
      resolve(legacy.localPoliciesDir(), "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );
    const warning = layoutWarningForHook();
    expect(warning).toContain("NOT being enforced");
    expect(warning).toContain("failproofai config");
  });

  it("still blocks an UNATTENDED run on that same layout-1 home", () => {
    // The two questions are different and must not share an answer. The hook
    // asks "are policies unenforced?" — no, so it stays quiet. The scheduled
    // audit asks "would completing this run reset the home?" — yes, and a reset
    // on a timer deletes the cloud credential and the `[audit] auto` flag that
    // scheduled it, with the explanation going only to the service journal.
    //
    // Teaching one function to answer both is what turned this gate off: the
    // silence added for the hook silently disabled the unattended guard for
    // exactly the homes most likely to hit it.
    seedLayoutOne();
    expect(layoutWarningForHook()).toBeNull();
    expect(layoutBlockerForScheduledRun()).toContain("refusing to run unattended");
  });

  it("stays silent on a layout-1 home, whose config layout 3 DOES read", () => {
    // Layout 3 put `policies-config.json` back at the home root — layout 1's
    // exact path. So a layout-1 home is detected as stale while its global
    // config loads and enforces perfectly well, and the hook printed
    // "global policies are NOT being enforced" on every single tool call
    // WHILE DENYING. Verified against the real hook path: the deny and the
    // warning came out together.
    //
    // A warning that contradicts the behaviour it describes is worse than no
    // warning — it teaches people to ignore the one channel that will matter
    // when enforcement really has stopped.
    seedLayoutOne();
    expect(layoutWarningForHook()).toBeNull();
  });

  it("NEVER deletes anything from the hook path", () => {
    // A hook runs unattended, once per tool call, with an agent waiting. It is
    // the wrong place to remove a user's history.
    seedLayoutOne();
    layoutWarningForHook();
    expect(existsSync(legacy.policyConfig())).toBe(true);
    expect(existsSync(legacy.hookActivityDir())).toBe(true);
  });

  it("warns on a future layout too", () => {
    writeFileSync(resolve(home, "VERSION"), JSON.stringify({ layout: 99, cli: "9.9.9" }));
    expect(layoutWarningForHook()).toMatch(/newer version/i);
  });

  it("is silent on current and on absent", () => {
    expect(layoutWarningForHook()).toBeNull(); // absent
    writeVersionFile();
    expect(layoutWarningForHook()).toBeNull(); // current
  });
});

describe("daemon flag self-heal", () => {
  // The exact combination that bricked a real machine during development:
  // the service was removed while daemonConfigured stayed true, so every hook
  // failed closed — including UserPromptSubmit, which locked the user out of
  // their agent with no CLI route back.
  it("clears daemonConfigured when the service is gone", async () => {
    const { writeConfig, DEFAULT_CONFIG, readConfig } = await import("../../src/hooks/fp-config");
    const svc = await import("../../src/hooks/daemon-service");
    const spyPlat = vi.spyOn(svc, "isDaemonSupportedPlatform").mockReturnValue(true);
    const spyStat = vi.spyOn(svc, "daemonServiceStatus").mockReturnValue("not-installed");

    writeConfig({ ...DEFAULT_CONFIG, daemon: { configured: true } });
    writeVersionFile();

    const check = await checkLayoutForCli();

    expect(readConfig().daemon.configured).toBe(false);
    expect(check.lines.join("\n")).toContain("denies every tool call");
    spyPlat.mockRestore();
    spyStat.mockRestore();
  });

  it("does NOT clear it merely because the service is stopped", async () => {
    // A stopped unit is usually a restart in progress. Clearing there would
    // silently downgrade a healthy machine to the in-process path — a quiet
    // wrong answer traded for a loud correct one.
    const { writeConfig, DEFAULT_CONFIG, readConfig } = await import("../../src/hooks/fp-config");
    const svc = await import("../../src/hooks/daemon-service");
    const spyPlat = vi.spyOn(svc, "isDaemonSupportedPlatform").mockReturnValue(true);
    const spyStat = vi.spyOn(svc, "daemonServiceStatus").mockReturnValue("stopped");

    writeConfig({ ...DEFAULT_CONFIG, daemon: { configured: true } });
    writeVersionFile();
    await checkLayoutForCli();

    expect(readConfig().daemon.configured).toBe(true);
    spyPlat.mockRestore();
    spyStat.mockRestore();
  });
});

// ── the policy selection a person typed ──────────────────────────────────
//
// Layout 1 kept the user policy config at `~/.failproofai/policies-config.json`;
// layout 2 keeps it at `policies/local-policies/policies-config.json`. BOTH were
// on the reset list, so an upgrade silently emptied `enabledPolicies` — and the
// machine still read as configured afterwards (`isConfigured()` is a union that
// sees the agent CLIs' untouched settings files), so hooks kept firing against a
// policy set that had quietly become the default one.
describe("resetHome carries the layout-1 policy selection", () => {
  const layoutOneConfig = {
    enabledPolicies: ["block-sudo", "block-env-files", "require-tests-before-stop"],
    customPoliciesPaths: ["/home/u/team/policies.mjs"],
    disabledCustomPolicies: ["team/noisy-rule"],
    policyParams: { "block-sudo": { allowlist: ["sudo -n true"] } },
    llm: { baseUrl: "https://llm.internal/v1", model: "gpt-4o-mini" },
    // Layout 1 also kept collector settings HERE, in camelCase. Layout 2 moved
    // them to config.toml in snake_case, where `fpai-collect`'s `Settings`
    // deserializes them — so carrying this block forward would put a key into
    // the new file that nothing reads, looking preserved and behaving absent.
    collector: { hooksVerbosity: "all", machineId: "m-legacy" },
  };

  function seedLayoutOnePolicyConfig() {
    writeFileSync(legacy.policyConfig(), JSON.stringify(layoutOneConfig, null, 2));
  }

  it("carries the fields layout 2 still means", () => {
    seedLayoutOne();
    seedLayoutOnePolicyConfig();

    const out = resetHome(1);

    const carried = JSON.parse(
      readFileSync(globalPolicyConfigFile(), "utf8"),
    );
    expect(carried.enabledPolicies).toEqual([
      "block-sudo",
      "block-env-files",
      "require-tests-before-stop",
    ]);
    expect(carried.customPoliciesPaths).toEqual(["/home/u/team/policies.mjs"]);
    expect(carried.disabledCustomPolicies).toEqual(["team/noisy-rule"]);
    expect(carried.policyParams).toEqual({ "block-sudo": { allowlist: ["sudo -n true"] } });
    expect(carried.llm).toEqual({ baseUrl: "https://llm.internal/v1", model: "gpt-4o-mini" });
    expect(out.policyConfig).toContain("enabledPolicies");
  });

  // The one exclusion, and the reason the carry is an allowlist rather than a
  // copy. A camelCase `collector` block in the new file reads as a preserved
  // setting and does nothing.
  it("does NOT carry the collector block, which moved to config.toml", () => {
    seedLayoutOne();
    seedLayoutOnePolicyConfig();

    const out = resetHome(1);

    const carried = JSON.parse(
      readFileSync(globalPolicyConfigFile(), "utf8"),
    );
    expect(carried.collector).toBeUndefined();
    expect(out.policyConfig).not.toContain("collector");
  });

  // A home already set up on layout 2 has a NEWER answer than the layout-1 file
  // beside it, and a stale file winning would UNDO configuration rather than
  // preserve it. The reset still CLEARS that layout-2 config on a layout
  // migration (see "still clears the machine-owned children of policies/") —
  // what must never happen is layout 1's values taking its place.
  it("never lets a newer config be overwritten by the layout-1 file", () => {
    // In layout 2 the source and destination were different files, and this
    // guard protected the newer one. Layout 3 collapsed them onto a single path,
    // so the case worth defending is a home that still carries LAYOUT 2's nested
    // config: that is the newer answer, and the layout-1 file must not win.
    seedLayoutOne();
    seedLayoutOnePolicyConfig();
    mkdirSync(legacy.localPoliciesDir(), { recursive: true });
    writeFileSync(
      resolve(legacy.localPoliciesDir(), "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["current-choice"] }),
    );

    const out = resetHome(2);

    // Layout 2's answer wins and lands at the layout-3 path. The layout-1 file
    // sitting at that same path is the OLDER one, and carrying it would undo
    // whatever the user chose after upgrading to layout 2.
    expect(out.policyConfig).toContain("enabledPolicies");
    const after = JSON.parse(readFileSync(globalPolicyConfigFile(), "utf8"));
    expect(after.enabledPolicies).toEqual(["current-choice"]);
    expect(after.enabledPolicies).not.toContain("block-sudo");
  });

  it("is a no-op when there is no layout-1 config", () => {
    seedLayoutOne();
    // `seedLayoutOne()` writes one; this case is the home that never had it.
    rmSync(legacy.policyConfig(), { force: true });
    const out = resetHome(1);
    expect(out.policyConfig).toEqual([]);
    expect(existsSync(globalPolicyConfigFile())).toBe(false);
  });

  // Unparseable is not worth aborting a reset over, and there is nothing to
  // carry — which is exactly what happened before this function existed.
  it("survives an unparseable layout-1 config without aborting the reset", () => {
    seedLayoutOne();
    writeFileSync(legacy.policyConfig(), "{ this is not json");
    const out = resetHome(1);
    expect(out.policyConfig).toEqual([]);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  // A file carrying only a collector block has nothing to carry, and must not
  // produce an empty layout-2 file that looks like a real one.
  it("writes nothing when only excluded fields are present", () => {
    seedLayoutOne();
    writeFileSync(legacy.policyConfig(), JSON.stringify({ collector: { hooksVerbosity: "all" } }));
    const out = resetHome(1);
    expect(out.policyConfig).toEqual([]);
    expect(existsSync(globalPolicyConfigFile())).toBe(false);
  });

  // The whole point: after the reset, the carried file is what the loader reads.
  it("leaves the carried config exactly where the loader reads it", () => {
    // LAYOUT 3 PUT THE CONFIG BACK AT LAYOUT 1'S PATH, so `legacy.policyConfig()`
    // and `globalPolicyConfigFile()` are now the SAME file. "The original is
    // gone" stopped being the right assertion: the carry rewrites that exact
    // path, and a home with no policy config after a reset is a home that lost
    // the user's selection.
    seedLayoutOne();
    seedLayoutOnePolicyConfig();
    resetHome(1);

    expect(existsSync(globalPolicyConfigFile())).toBe(true);
    const after = JSON.parse(readFileSync(globalPolicyConfigFile(), "utf8"));
    expect(after.enabledPolicies).toContain("block-sudo");
  });
});
