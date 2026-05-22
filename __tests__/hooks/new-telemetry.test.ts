// @vitest-environment node
/**
 * Coverage for telemetry events added as part of the gap-closing audit.
 * Each test stubs trackHookEvent and asserts the right event name + props
 * fire at the trigger site. Keep one focused case per event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../../src/hooks/install-prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/hooks/install-prompt")>(
    "../../src/hooks/install-prompt",
  );
  return {
    ...actual,
    promptPolicySelection: vi.fn(() => Promise.resolve(["block-sudo"])),
  };
});

vi.mock("../../src/hooks/integrations", () => ({
  detectInstalledClis: vi.fn(() => ["claude"]),
  getIntegration: vi.fn((id: string) => ({
    displayName: id,
    scopes: id === "codex" ? ["user", "project"] : ["user", "project", "local"],
    eventTypes: [],
    getSettingsPath: vi.fn(),
    hooksInstalledInSettings: vi.fn(),
    readSettings: vi.fn(() => ({})),
    writeSettings: vi.fn(),
    writeHookEntries: vi.fn(),
    removeHooksFromFile: vi.fn(() => 0),
  })),
  claudeCode: {
    getSettingsPath: vi.fn(() => "/tmp/.claude/settings.json"),
    hooksInstalledInSettings: vi.fn(() => false),
  },
  listIntegrations: vi.fn(() => []),
}));

vi.mock("../../src/hooks/hooks-config", () => ({
  readHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  writeHooksConfig: vi.fn(),
  readScopedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  writeScopedHooksConfig: vi.fn(),
  findProjectConfigDir: vi.fn((cwd: string) => cwd),
  getConfigPathForScope: vi.fn(() => "/tmp/policies-config.json"),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/telemetry-id", () => ({
  getInstanceId: vi.fn(() => "test-instance-id"),
  hashToId: vi.fn((raw: string) => `hashed:${raw}`),
}));

vi.mock("../../src/hooks/custom-hooks-loader", async () => {
  const actual = await vi.importActual<typeof import("../../src/hooks/custom-hooks-loader")>(
    "../../src/hooks/custom-hooks-loader",
  );
  return {
    ...actual,
    loadCustomHooks: vi.fn(() => Promise.resolve([])),
    discoverPolicyFiles: vi.fn(() => []),
  };
});

describe("new telemetry events — manager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(execSync).mockReturnValue("/usr/local/bin/failproofai\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires scope_validation_failed when scope is unsupported for the CLI", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{}");

    const { installHooks } = await import("../../src/hooks/manager");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    // codex does not support the "local" scope (see src/hooks/integrations.ts)
    await expect(installHooks(["block-sudo"], "local" as never, undefined, false, undefined, undefined, false, [
      "codex",
    ])).rejects.toThrow(/Scope "local" is not supported/);

    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "scope_validation_failed",
      expect.objectContaining({
        cli: "codex",
        scope: "local",
        supported_scopes: expect.any(Array),
      }),
    );
  });

  it("fires custom_policy_validation_failed when the custom file throws", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{}");
    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    vi.mocked(loadCustomHooks).mockRejectedValueOnce(new Error("Custom hooks file not found: /tmp/missing.js"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: string | number | null | undefined) => undefined as never) as never);

    const { installHooks } = await import("../../src/hooks/manager");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    await installHooks(["block-sudo"], "user", undefined, false, undefined, "/tmp/missing.js");

    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "custom_policy_validation_failed",
      expect.objectContaining({
        scope: "user",
        error_type: "file_not_found",
      }),
    );
    exitSpy.mockRestore();
  });

  it("fires policy_params_validation_warning when an unknown key is in policyParams", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
    vi.mocked(readMergedHooksConfig).mockReturnValue({
      enabledPolicies: [],
      policyParams: { "nonexistent-policy": { hint: "test" } },
    });

    const { listHooks } = await import("../../src/hooks/manager");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    await listHooks();

    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "policy_params_validation_warning",
      expect.objectContaining({
        unknown_keys_count: 1,
        unknown_keys: ["nonexistent-policy"],
      }),
    );
  });

  it("respects FAILPROOFAI_TELEMETRY_DISABLED — the underlying helper is mocked, but the call still happens (test verifies the trigger fires unconditionally)", async () => {
    // The helper itself short-circuits when FAILPROOFAI_TELEMETRY_DISABLED=1
    // (verified in __tests__/lib/telemetry.test.ts). Here we just confirm the
    // trigger call site still runs — the env-var check lives in the helper.
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{}");

    try {
      const { installHooks } = await import("../../src/hooks/manager");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await installHooks(["block-sudo"], "user");

      // The call site fires; the helper internally no-ops. This is the same
      // contract as the existing hooks_installed test.
      expect(trackHookEvent).toHaveBeenCalled();
    } finally {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
    }
  });
});

describe("new telemetry events — install-prompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fires cli_detection_summary with resolution_mode=explicit when --cli is passed", async () => {
    const { resolveTargetClis } = await import("../../src/hooks/install-prompt");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    const result = await resolveTargetClis(["codex"], "install");
    expect(result).toEqual(["codex"]);
    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "cli_detection_summary",
      expect.objectContaining({
        action: "install",
        explicit_clis: ["codex"],
        selected_clis: ["codex"],
        resolution_mode: "explicit",
      }),
    );
  });
});
