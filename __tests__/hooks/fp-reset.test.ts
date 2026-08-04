import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LAYOUT_VERSION, binDir, runDir, hookActivityDir, cursorsDir, legacy } from "../../src/hooks/fp-home";
import { detectLayout, readVersionFile, writeVersionFile } from "../../src/hooks/fp-config";
import { resetHome, checkLayoutForCli, layoutWarningForHook } from "../../src/hooks/fp-reset";

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
    expect(existsSync(legacy.policyConfig())).toBe(false);
    expect(existsSync(legacy.cacheDir())).toBe(false);
    expect(existsSync(legacy.ingestCredentials())).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
    expect(detectLayout().kind).toBe("current");
  });

  it("removes cursors too — that was the explicit decision", () => {
    // Keeping watermarks would avoid a one-off re-ship of the last 7 days, but
    // the call was one rule with no exceptions. Pinned so a later "kindness"
    // does not quietly reintroduce a special case nobody asked for.
    seedLayoutOne();
    resetHome(1);
    expect(existsSync(cursorsDir())).toBe(false);
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
});

describe("checkLayoutForCli", () => {
  it("resets a stale home and explains what happened", () => {
    seedLayoutOne();
    const check = checkLayoutForCli();
    expect(check.fatal).toBe(false);
    expect(check.lines.join("\n")).toContain("failproofai config");
    expect(existsSync(legacy.policyConfig())).toBe(false);
  });

  it("REFUSES a future layout instead of deleting it", () => {
    // The two failures are not symmetric: an older home can be rebuilt by
    // re-running setup, but a newer one holds data this build cannot read and
    // an upgrade could. Resetting it would destroy something recoverable.
    writeFileSync(resolve(home, "VERSION"), 'layout = 99\ncli = "9.9.9"\n');
    writeFileSync(resolve(home, "config.toml"), "[mode]\nkind = \"cloud\"\n");

    const check = checkLayoutForCli();

    expect(check.fatal).toBe(true);
    expect(check.lines.join("\n")).toMatch(/newer version/i);
    expect(check.lines.join("\n")).toContain("npm install -g failproofai@latest");
    // Nothing removed.
    expect(existsSync(resolve(home, "config.toml"))).toBe(true);
  });

  it("stamps VERSION on a fresh home and says nothing", () => {
    const check = checkLayoutForCli();
    expect(check.lines).toEqual([]);
    expect(check.fatal).toBe(false);
    expect(readVersionFile()?.layout).toBe(LAYOUT_VERSION);
  });

  it("says nothing on an already-current home", () => {
    writeVersionFile();
    mkdirSync(hookActivityDir(), { recursive: true });
    expect(checkLayoutForCli().lines).toEqual([]);
  });
});

describe("layoutWarningForHook", () => {
  it("warns on a stale layout — silence would mean unenforced policies", () => {
    // The failure being guarded: a stale home resolves to no global config, so
    // every builtin quietly stops firing and the machine looks protected.
    seedLayoutOne();
    const warning = layoutWarningForHook();
    expect(warning).toContain("NOT being enforced");
    expect(warning).toContain("failproofai config");
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
    writeFileSync(resolve(home, "VERSION"), 'layout = 99\ncli = "9.9.9"\n');
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

    const check = checkLayoutForCli();

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
    checkLayoutForCli();

    expect(readConfig().daemon.configured).toBe(true);
    spyPlat.mockRestore();
    spyStat.mockRestore();
  });
});
