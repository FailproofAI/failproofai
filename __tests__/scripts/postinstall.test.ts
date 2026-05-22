// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

const FAKE_HOME = "/fake/home";
const FAKE_CWD = "/fake/project";
const HOOKS_CONFIG = resolve(FAKE_HOME, ".failproofai", "policies-config.json");
const USER_SETTINGS = resolve(FAKE_HOME, ".claude", "settings.json");
const SERVER_JS = resolve(FAKE_CWD, ".next", "standalone", "server.js");

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

vi.mock("../../scripts/install-diagnosis.mjs", () => ({
  diagnoseShadow: vi.fn(() => ({ shadowed: false })),
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

describe("postinstall script", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(FAKE_CWD);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
      throw new Error("process.exit called");
    });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Must differ from cwd so the dev-context guard doesn't early-exit
    process.env.INIT_CWD = "/some/other/dir";
  });

  afterEach(() => {
    delete process.env.INIT_CWD;
    cwdSpy.mockRestore();
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  async function runPostinstall(fs: {
    hooksConfigExists?: boolean;
    settingsExists?: boolean;
    hooksConfigContent?: string;
    settingsContent?: string;
  }) {
    const { existsSync, readFileSync } = await import("node:fs");
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SERVER_JS) return true;
      if (p === HOOKS_CONFIG) return fs.hooksConfigExists ?? false;
      if (p === USER_SETTINGS) return fs.settingsExists ?? false;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation(((p: string) => {
      if (p === HOOKS_CONFIG) return fs.hooksConfigContent ?? "";
      if (p === USER_SETTINGS) return fs.settingsContent ?? "";
      // package.json read for shadow diagnosis — return a minimal stub
      return JSON.stringify({ version: "0.0.0-test" });
    }) as never);

    await import("../../scripts/postinstall.mjs");
  }

  const allLogs = () =>
    consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");

  describe("brand-new user (no config, no settings)", () => {
    it("prints the Next steps block", async () => {
      await runPostinstall({ hooksConfigExists: false });
      expect(allLogs()).toContain("Next steps");
      expect(allLogs()).toContain("failproofai policies --install");
      expect(allLogs()).toContain("FAILPROOFAI_NO_FIRST_RUN=1");
    });

    it("does NOT print the existing hooks-not-registered warning", async () => {
      await runPostinstall({ hooksConfigExists: false });
      expect(allLogs()).not.toContain("hooks config exists with enabled policies");
    });

    it("fires package_installed with hooks_configured=false, hooks_registered=false", async () => {
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      await runPostinstall({ hooksConfigExists: false });
      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({
          hooks_configured: false,
          hooks_registered: false,
          enabled_policy_count: 0,
        }),
      );
    });
  });

  describe("fully installed user (config + settings + registered)", () => {
    it("prints nothing — no warning, no Next steps", async () => {
      await runPostinstall({
        hooksConfigExists: true,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsExists: true,
        settingsContent: SETTINGS_WITH_MARKED_HOOK,
      });
      expect(allLogs()).not.toContain("Next steps");
      expect(allLogs()).not.toContain("hooks config exists with enabled policies");
    });

    it("fires package_installed with hooks_configured=true, hooks_registered=true", async () => {
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      await runPostinstall({
        hooksConfigExists: true,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsExists: true,
        settingsContent: SETTINGS_WITH_MARKED_HOOK,
      });
      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({
          hooks_configured: true,
          hooks_registered: true,
          enabled_policy_count: 2,
        }),
      );
    });
  });

  describe("config exists but hooks not registered", () => {
    it("prints printHooksWarning, NOT the Next steps block", async () => {
      await runPostinstall({
        hooksConfigExists: true,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsExists: true,
        settingsContent: SETTINGS_WITHOUT_MARKED_HOOK,
      });
      expect(allLogs()).toContain("hooks config exists with enabled policies");
      expect(allLogs()).not.toContain("Next steps");
    });

    it("fires package_installed with hooks_configured=true, hooks_registered=false", async () => {
      const { trackInstallEvent } = await import("../../scripts/install-telemetry.mjs");
      await runPostinstall({
        hooksConfigExists: true,
        hooksConfigContent: CONFIG_WITH_TWO_POLICIES,
        settingsExists: true,
        settingsContent: SETTINGS_WITHOUT_MARKED_HOOK,
      });
      expect(trackInstallEvent).toHaveBeenCalledWith(
        "package_installed",
        expect.objectContaining({
          hooks_configured: true,
          hooks_registered: false,
          enabled_policy_count: 2,
        }),
      );
    });
  });
});
