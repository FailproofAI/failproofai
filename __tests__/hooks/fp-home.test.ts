import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
      H.policiesDir(), H.localPoliciesDir(), H.globalPolicyConfigFile(),
      H.cloudPoliciesDir(), H.customPoliciesDir(), H.cursorsDir(),
      H.auditDir(), H.auditDashboardFile(), H.auditCacheDir(),
      H.hookActivityDir(), H.customAgentsEventsDir(), H.runDir(),
      H.stateDir(), H.spoolDir(), H.failedDir(), H.collectorHealthFile(),
      H.sessionPauseDir(), H.launcherMarker(), H.onboardingLockFile(),
    ];
    for (const p of paths) expect(p.startsWith(home + "/")).toBe(true);
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

  it("separates the three policy kinds", () => {
    // Layout 1 mixed user *.mjs and cloud-managed/ in one policies/ dir.
    expect(H.localPoliciesDir()).not.toBe(H.customPoliciesDir());
    expect(H.cloudPoliciesDir()).not.toBe(H.customPoliciesDir());
    expect(H.globalPolicyConfigFile()).toBe(
      resolve(H.localPoliciesDir(), "policies-config.json"),
    );
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
    expect(paths).toContain(H.legacy.cacheDir());
    expect(paths).toContain(H.legacy.policyConfig());
    expect(paths).toContain(H.hookActivityDir());
    expect(paths).toContain(H.credentialsFile());
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

  it("distinguishes a FUTURE layout from a stale one", () => {
    // Telling someone to reset a home written by a newer CLI would delete data
    // a simple upgrade would have read fine.
    writeFileSync(resolve(home, "VERSION"), 'layout = 99\ncli = "9.9.9"\n');
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
      daemon: { configured: true, installedVersion: "1.2.3" },
      collector: {
        sessions: true, hooks: true, hooksVerbosity: "all" as const,
        redact: "off" as const, environment: "prod", machineId: "box-1",
      },
      telemetry: { enabled: true },
    };
    writeConfig(cfg);
    expect(readConfig()).toEqual(cfg);
  });

  it("telemetry is on by default and the file says nothing about it", () => {
    // The shipped posture: on, and not advertised in the config a user cat's.
    writeConfig(DEFAULT_CONFIG);
    expect(readConfig().telemetry.enabled).toBe(true);
    expect(readFileSync(H.configFile(), "utf8")).not.toContain("[telemetry]");
  });

  it("a telemetry opt-out SURVIVES a rewrite", () => {
    // writeConfig regenerates the whole file, so a key it does not emit is a key
    // it silently deletes. Switching telemetry back on under someone who turned
    // it off would be the worst possible bug in this feature.
    writeConfig({ ...DEFAULT_CONFIG, telemetry: { enabled: false } });
    expect(readConfig().telemetry.enabled).toBe(false);
    expect(readFileSync(H.configFile(), "utf8")).toContain("enabled = false");

    // A later unrelated write must not resurrect it.
    writeConfig({ ...readConfig(), collector: { ...DEFAULT_CONFIG.collector, environment: "ci" } });
    expect(readConfig().telemetry.enabled).toBe(false);
  });

  it("only an explicit false disables telemetry", () => {
    writeFileSync(H.configFile(), '[telemetry]\nenabled = "no"\n');
    expect(readConfig().telemetry.enabled).toBe(true);
    writeFileSync(H.configFile(), "[telemetry]\nenabled = false\n");
    expect(readConfig().telemetry.enabled).toBe(false);
  });

  it("the mode comment no longer claims nothing is EVER sent", () => {
    // It used to read "fully local. Nothing is sent anywhere, ever." — untrue
    // while four telemetry dispatchers exist. Not mentioning telemetry is fine;
    // asserting the opposite is not.
    writeConfig(DEFAULT_CONFIG);
    const written = readFileSync(H.configFile(), "utf8");
    expect(written).not.toContain("Nothing is sent anywhere, ever");
    expect(written).toContain("No transcripts, hook activity or policy leave");
  });

  it("a corrupt config reads as OSS, never as cloud", () => {
    // Failure direction: a damaged file must not be able to switch reporting
    // ON. Silent-and-local is the only safe way to fail here.
    writeFileSync(H.configFile(), "mode = { kind = broken");
    expect(readConfig().mode).toBe("oss");
  });

  it("an unrecognised mode reads as OSS", () => {
    writeFileSync(H.configFile(), '[mode]\nkind = "enterprise"\n');
    expect(readConfig().mode).toBe("oss");
  });

  it("updateConfig merges rather than replacing", () => {
    writeConfig({ ...DEFAULT_CONFIG, collector: { ...DEFAULT_CONFIG.collector, environment: "ci" } });
    updateConfig({ daemon: { configured: true } });
    const after = readConfig();
    expect(after.daemon.configured).toBe(true);
    expect(after.collector.environment).toBe("ci"); // untouched
  });

  it("stays hand-editable: comments survive a read", () => {
    writeConfig(DEFAULT_CONFIG);
    const text = readFileSync(H.configFile(), "utf8");
    expect(text).toContain("#");
    expect(text).toContain("[mode]");
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
    writeFileSync(H.credentialsFile(), '[ingest]\nurl = "https://x"\nkey = ""\n');
    expect(readCredentials().ingest).toBeUndefined();
  });

  it("never puts a token in config.toml", () => {
    writeCredentials({ ingest: { url: "https://x/events", key: "SUPERSECRET" } });
    writeConfig({ ...DEFAULT_CONFIG, mode: "cloud" });
    expect(readFileSync(H.configFile(), "utf8")).not.toContain("SUPERSECRET");
  });
});
