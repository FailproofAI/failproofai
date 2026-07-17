// @vitest-environment node
/**
 * Install reporting from the CLI, replacing the postinstall lifecycle script
 * that package managers now block by default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

const FAKE_HOME = "/fake/home";
const LAST_VERSION = resolve(FAKE_HOME, ".failproofai", "last-version");
const HOOKS_CONFIG = resolve(FAKE_HOME, ".failproofai", "policies-config.json");
const USER_SETTINGS = resolve(FAKE_HOME, ".claude", "settings.json");

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => FAKE_HOME),
  platform: vi.fn(() => "linux"),
  arch: vi.fn(() => "x64"),
  release: vi.fn(() => "5.15.0"),
  hostname: vi.fn(() => "test-host"),
}));

vi.mock("../../scripts/install-telemetry.mjs", () => ({
  trackInstallEvent: vi.fn(() => Promise.resolve()),
}));

const CONFIG_WITH_TWO_POLICIES = JSON.stringify({
  enabledPolicies: ["block-sudo", "block-rm-rf"],
});

const SETTINGS_WITH_MARKED_HOOK = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        hooks: [
          { type: "command", command: "failproofai --hook PreToolUse", __failproofai_hook__: true },
        ],
      },
    ],
  },
});

const SETTINGS_WITHOUT_MARKED_HOOK = JSON.stringify({ hooks: {} });

/** Point the mocked fs at a given on-disk state. */
async function setupFs(state: {
  lastVersion?: string | null;
  hooksConfigContent?: string;
  settingsContent?: string;
}) {
  const { existsSync, readFileSync } = await import("node:fs");
  vi.mocked(existsSync).mockImplementation((p) => {
    if (p === LAST_VERSION) return state.lastVersion != null;
    if (p === HOOKS_CONFIG) return state.hooksConfigContent != null;
    if (p === USER_SETTINGS) return state.settingsContent != null;
    return false;
  });
  vi.mocked(readFileSync).mockImplementation(((p: string) => {
    if (p === LAST_VERSION) return state.lastVersion ?? "";
    if (p === HOOKS_CONFIG) return state.hooksConfigContent ?? "";
    if (p === USER_SETTINGS) return state.settingsContent ?? "";
    throw new Error(`unexpected read: ${p}`);
  }) as never);
}

async function eventNames() {
  const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
  return vi.mocked(trackInstallEvent).mock.calls.map((c) => c[0]);
}

describe("maybeReportInstall", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("brand-new install (nothing recorded)", () => {
    it("fires first_install and package_installed, but not version_changed", async () => {
      await setupFs({ lastVersion: null });
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(await eventNames()).toEqual(["first_install", "package_installed"]);
    });

    it("records the version so the next run stays silent", async () => {
      await setupFs({ lastVersion: null });
      const { writeFileSync } = await import("node:fs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(writeFileSync).toHaveBeenCalledWith(LAST_VERSION, "1.0.0", "utf8");
    });

    // Delivery measured at ~1.1s from a cold process against production PostHog,
    // with a 1.85s worst case. The timeout is a ceiling, not a cost, so it needs
    // real headroom over that — a tight budget only ever drops the report.
    it("allows enough time for a cold-start delivery", async () => {
      await setupFs({ lastVersion: null });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      for (const call of vi.mocked(trackInstallEvent).mock.calls) {
        expect((call[2] as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(5000);
      }
    });

    it("stamps the caller's version on the event, never 'unknown'", async () => {
      await setupFs({ lastVersion: null });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("0.0.14-beta.1");

      for (const call of vi.mocked(trackInstallEvent).mock.calls) {
        expect(call[2]).toMatchObject({ version: "0.0.14-beta.1" });
      }
    });
  });

  // The whole point of moving off postinstall: this runs on every CLI
  // invocation, so the steady-state path must cost nothing and stay silent.
  describe("steady state (version already recorded)", () => {
    it("fires no events at all", async () => {
      await setupFs({ lastVersion: "1.0.0" });
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(await eventNames()).toEqual([]);
    });

    it("does not rewrite the version file", async () => {
      await setupFs({ lastVersion: "1.0.0" });
      const { writeFileSync } = await import("node:fs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("version change", () => {
    it("reports an upgrade with from/to versions", async () => {
      await setupFs({ lastVersion: "1.0.0" });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.1.0");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "version_changed",
        expect.objectContaining({
          from_version: "1.0.0",
          to_version: "1.1.0",
          direction: "upgrade",
        }),
        expect.anything(),
      );
    });

    it("reports a downgrade", async () => {
      await setupFs({ lastVersion: "2.0.0" });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "version_changed",
        expect.objectContaining({ direction: "downgrade" }),
        expect.anything(),
      );
    });

    it("treats a prerelease → release move as an upgrade", async () => {
      await setupFs({ lastVersion: "0.0.14-beta.1" });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("0.0.14");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "version_changed",
        expect.objectContaining({ direction: "upgrade" }),
        expect.anything(),
      );
    });
  });

  describe("hook state carried on package_installed", () => {
    it("reports configured + registered with the policy count", async () => {
      await setupFs({
        lastVersion: null,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsContent: SETTINGS_WITH_MARKED_HOOK,
      });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({
          hooks_configured: true,
          hooks_registered: true,
          enabled_policy_count: 2,
        }),
        expect.anything(),
      );
    });

    it("reports configured but NOT registered when the marker is absent", async () => {
      await setupFs({
        lastVersion: null,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsContent: SETTINGS_WITHOUT_MARKED_HOOK,
      });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({ hooks_configured: true, hooks_registered: false }),
        expect.anything(),
      );
    });

    it("reports neither for a user with no config", async () => {
      await setupFs({ lastVersion: null });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({
          hooks_configured: false,
          hooks_registered: false,
          enabled_policy_count: 0,
        }),
        expect.anything(),
      );
    });
  });

  // Reporting sits in front of every CLI command — it must never take one down.
  describe("failure containment", () => {
    it("does not throw when the version file is unwritable", async () => {
      await setupFs({ lastVersion: null });
      const { writeFileSync } = await import("node:fs");
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw new Error("EACCES");
      });
      const { maybeReportInstall } = await import("../../lib/install-check");

      await expect(maybeReportInstall("1.0.0")).resolves.toBeUndefined();
    });

    it("does not throw when telemetry delivery rejects", async () => {
      await setupFs({ lastVersion: null });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      vi.mocked(trackInstallEvent).mockRejectedValue(new Error("network down"));
      const { maybeReportInstall } = await import("../../lib/install-check");

      await expect(maybeReportInstall("1.0.0")).resolves.toBeUndefined();
    });

    it("still records the version when delivery fails, so it is not retried forever", async () => {
      await setupFs({ lastVersion: null });
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      const { writeFileSync } = await import("node:fs");
      vi.mocked(trackInstallEvent).mockRejectedValue(new Error("network down"));
      const { maybeReportInstall } = await import("../../lib/install-check");

      await maybeReportInstall("1.0.0");

      expect(writeFileSync).toHaveBeenCalledWith(LAST_VERSION, "1.0.0", "utf8");
    });

    it("treats a corrupt policies-config as unconfigured rather than failing", async () => {
      await setupFs({ lastVersion: null, hooksConfigContent: "{ not json" });
      const { maybeReportInstall } = await import("../../lib/install-check");

      await expect(maybeReportInstall("1.0.0")).resolves.toBeUndefined();
      expect(await eventNames()).toContain("package_installed");
    });
  });
});

describe("compareSemver", () => {
  it("orders release above the same version's prerelease (semver §11)", async () => {
    const { compareSemver } = await import("../../lib/install-check");
    expect(compareSemver("0.0.14-beta.1", "0.0.14")).toBeLessThan(0);
    expect(compareSemver("0.0.14", "0.0.14-beta.1")).toBeGreaterThan(0);
  });

  it("orders prerelease numbers numerically, not lexically", async () => {
    const { compareSemver } = await import("../../lib/install-check");
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
  });

  // Semver §9: identifiers are dot-separated; a hyphen is legal *inside* one.
  // So `beta-2` is a single non-numeric identifier and compares lexically —
  // making it GREATER than `beta-10` ("2" > "1"), the opposite of the numeric
  // ordering you'd get by splitting on the hyphen.
  it("treats a hyphen inside a prerelease identifier as part of it, not a separator", async () => {
    const { compareSemver } = await import("../../lib/install-check");
    expect(compareSemver("1.0.0-beta-2", "1.0.0-beta-10")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta-10", "1.0.0-beta-2")).toBeLessThan(0);
  });

  it("compares major/minor/patch numerically", async () => {
    const { compareSemver } = await import("../../lib/install-check");
    expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });
});
