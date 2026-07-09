// @vitest-environment node
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
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../../src/hooks/install-prompt", () => ({
  promptPolicySelection: vi.fn(() =>
    Promise.resolve(["block-sudo", "block-env-files", "sanitize-jwt"]),
  ),
}));

vi.mock("../../src/hooks/hooks-config", () => ({
  readHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  writeHooksConfig: vi.fn(),
  readScopedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
  writeScopedHooksConfig: vi.fn(),
  getConfigPathForScope: vi.fn((scope: string, cwd?: string) => {
    if (scope === "user") return resolve(homedir(), ".failproofai", "policies-config.json");
    if (scope === "local") return `${cwd ?? process.cwd()}/.failproofai/policies-config.local.json`;
    return `${cwd ?? process.cwd()}/.failproofai/policies-config.json`;
  }),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/telemetry-id", () => ({
  getInstanceId: vi.fn(() => "test-instance-id"),
  hashToId: vi.fn((raw: string) => `hashed:${raw}`),
}));

vi.mock("../../src/hooks/custom-hooks-loader", () => ({
  loadCustomHooks: vi.fn(() => Promise.resolve([])),
  discoverPolicyFiles: vi.fn(() => []),
}));

const USER_SETTINGS_PATH = resolve(homedir(), ".claude", "settings.json");
const PROJECT_SETTINGS_PATH = resolve(process.cwd(), ".claude", "settings.json");
const LOCAL_SETTINGS_PATH = resolve(process.cwd(), ".claude", "settings.local.json");

describe("hooks/manager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(execSync).mockReturnValue("/usr/local/bin/failproofai\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("installHooks", () => {
    it("installs hooks for all 29 event types into empty settings", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(USER_SETTINGS_PATH);

      const written = JSON.parse(content as string);
      expect(Object.keys(written.hooks)).toHaveLength(29);

      for (const [eventType, matchers] of Object.entries(written.hooks)) {
        expect(matchers).toHaveLength(1);
        const hook = (matchers as Array<{ hooks: Array<Record<string, unknown>> }>)[0].hooks[0];
        expect(hook.__failproofai_hook__).toBe(true);
        expect(hook.type).toBe("command");
        expect(hook.timeout).toBe(60);
        expect(hook.command).toBe(`"/usr/local/bin/failproofai" --hook ${eventType}`);
      }
    });

    it("calls promptPolicySelection and writeHooksConfig in interactive mode", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      const { promptPolicySelection } = await import("../../src/hooks/install-prompt");
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");

      await installHooks();

      expect(promptPolicySelection).toHaveBeenCalledOnce();
      expect(writeScopedHooksConfig).toHaveBeenCalledWith(
        { enabledPolicies: ["block-sudo", "block-env-files", "sanitize-jwt"] },
        "user",
        undefined,
      );
    });

    it("non-interactive: --install-hooks all enables all policies", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      const { promptPolicySelection } = await import("../../src/hooks/install-prompt");

      await installHooks(["all"]);

      expect(promptPolicySelection).not.toHaveBeenCalled();
      expect(writeScopedHooksConfig).toHaveBeenCalledWith(
        { enabledPolicies: expect.arrayContaining(["block-sudo", "block-rm-rf", "sanitize-jwt"]) },
        "user",
        undefined,
      );
    });

    it("non-interactive: --install-hooks with specific names", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");

      await installHooks(["block-sudo", "block-rm-rf"]);

      expect(writeScopedHooksConfig).toHaveBeenCalledWith(
        { enabledPolicies: ["block-sudo", "block-rm-rf"] },
        "user",
        undefined,
      );
    });

    it("non-interactive: rejects unknown policy names", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");

      await expect(installHooks(["block-sudo", "fake-policy"])).rejects.toThrow("Unknown policy name");
    });

    it("pre-loads current config in interactive mode", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({ enabledPolicies: ["block-sudo"] });

      const { installHooks } = await import("../../src/hooks/manager");
      const { promptPolicySelection } = await import("../../src/hooks/install-prompt");

      await installHooks();

      expect(promptPolicySelection).toHaveBeenCalledWith(["block-sudo"], { includeBeta: false });
    });

    it("preserves existing non-failproofai hooks", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const existingSettings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "my-custom-hook", timeout: 5000 },
              ],
            },
          ],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingSettings));

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks();

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      expect(written.hooks.PreToolUse).toHaveLength(2);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe("my-custom-hook");
      expect(written.hooks.PreToolUse[1].hooks[0].__failproofai_hook__).toBe(true);
    });

    it("re-install updates existing failproofai hooks without duplicating", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const existingSettings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/old/path/failproofai --hook PreToolUse",
                  timeout: 10_000,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingSettings));

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks();

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      expect(written.hooks.PreToolUse).toHaveLength(1);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(
        '"/usr/local/bin/failproofai" --hook PreToolUse',
      );
    });

    it("creates settings file when none exists", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);
      expect(Object.keys(written.hooks)).toHaveLength(29);
    });

    it("uses 'where' on Windows and handles multi-line output", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      vi.mocked(execSync).mockReturnValue("C:\\Program Files\\failproofai\\failproofai.exe\nC:\\other\\failproofai.exe\n");
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks();

      expect(execSync).toHaveBeenCalledWith("where failproofai", { encoding: "utf8" });

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);
      const hook = written.hooks.PreToolUse[0].hooks[0];
      expect(hook.command).toBe('"C:\\Program Files\\failproofai\\failproofai.exe" --hook PreToolUse');

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("throws when failproofai binary is not found", async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("not found");
      });

      const { installHooks } = await import("../../src/hooks/manager");
      await expect(installHooks()).rejects.toThrow("failproofai binary not found");
    });

    it("default scope is user", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"]);

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(USER_SETTINGS_PATH);
    });

    it("install at project scope writes to {cwd}/.claude/settings.json", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "project");

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(PROJECT_SETTINGS_PATH);
    });

    it("project scope uses portable npx -y failproofai command for all event types", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "project");

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      for (const [eventType, matchers] of Object.entries(written.hooks)) {
        const hook = (matchers as Array<{ hooks: Array<Record<string, unknown>> }>)[0].hooks[0];
        expect(hook.command).toBe(`npx -y failproofai --hook ${eventType}`);
      }
    });

    it("user scope uses absolute binary path, not npx", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "user");

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      const hook = written.hooks.PreToolUse[0].hooks[0];
      expect(hook.command).toBe('"/usr/local/bin/failproofai" --hook PreToolUse');
    });

    it("local scope uses absolute binary path, not npx", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "local");

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      const hook = written.hooks.PreToolUse[0].hooks[0];
      expect(hook.command).toBe('"/usr/local/bin/failproofai" --hook PreToolUse');
    });

    it("re-install on project scope migrates absolute-path hooks to npx format", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const existingSettings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: '"/old/path/failproofai" --hook PreToolUse',
                  timeout: 10_000,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingSettings));

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "project");

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(
        "npx -y failproofai --hook PreToolUse",
      );
    });

    it("detects npx-format hooks as failproofai hooks (legacy fallback without marker)", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const settings = {
        hooks: {
          PreToolUse: [{
            hooks: [{
              type: "command",
              command: "npx -y failproofai --hook PreToolUse",
              timeout: 60000,
            }],
          }],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));

      const { hooksInstalledInSettings } = await import("../../src/hooks/manager");
      expect(hooksInstalledInSettings("project")).toBe(true);
    });

    it("project scope console output shows portable command info", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "project");

      const logs = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      expect(logs.some((l: unknown) => typeof l === "string" && (l as string).includes("npx -y failproofai"))).toBe(true);
      expect(logs.some((l: unknown) => typeof l === "string" && (l as string).includes("committed to git"))).toBe(true);
      expect(logs.some((l: unknown) => typeof l === "string" && (l as string).includes("Binary:"))).toBe(false);
    });

    it("install at local scope writes to {cwd}/.claude/settings.local.json", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "local");

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(LOCAL_SETTINGS_PATH);
    });

    it("install with cwd writes to that directory's .claude/settings.json", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "project", "/tmp/my-project");

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(resolve("/tmp/my-project", ".claude", "settings.json"));
    });

    it("install with cwd at local scope writes to that directory", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "local", "/tmp/my-project");

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(resolve("/tmp/my-project", ".claude", "settings.local.json"));
    });

    it("install with cwd at user scope ignores cwd", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "user", "/tmp/my-project");

      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(USER_SETTINGS_PATH);
    });

    it("warns when hooks exist in another scope", async () => {
      // Mock: project scope has existing hooks, installing to user scope
      vi.mocked(existsSync).mockImplementation((p) => {
        return p === PROJECT_SETTINGS_PATH || p === USER_SETTINGS_PATH;
      });
      const projectSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === PROJECT_SETTINGS_PATH) return JSON.stringify(projectSettings);
        return "{}";
      });

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "user");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Failproof AI hooks are also installed"),
      );
    });

    it("fires hooks_installed telemetry with correct properties", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { installHooks } = await import("../../src/hooks/manager");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await installHooks(["block-sudo", "block-rm-rf"], "user");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hooks_installed",
        expect.objectContaining({
          scope: "user",
          policies: ["block-sudo", "block-rm-rf"],
          policy_count: 2,
          platform: expect.any(String),
          arch: expect.any(String),
          os_release: expect.any(String),
          hostname_hash: expect.any(String),
        }),
      );
    });

    it("saves resolved absolute customPoliciesPath when customPoliciesPath provided", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");

      const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadCustomHooks).mockResolvedValue([
        { name: "test-hook", fn: async () => ({ decision: "allow" as const }) },
      ]);

      const { installHooks } = await import("../../src/hooks/manager");
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");

      await installHooks(["block-sudo"], "user", undefined, false, undefined, "/tmp/my-hooks.js");

      expect(writeScopedHooksConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          customPoliciesPath: resolve("/tmp/my-hooks.js"),
        }),
        "user",
        undefined,
      );
      const logs = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      expect(logs.some((l: unknown) => typeof l === "string" && l.includes(resolve("/tmp/my-hooks.js")))).toBe(true);
    });

    it("clears customPoliciesPath when removeCustomHooks is true", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("{}");
      const { readScopedHooksConfig, writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
        customPoliciesPath: "/tmp/old-hooks.js",
      });

      const { installHooks } = await import("../../src/hooks/manager");

      await installHooks(["block-sudo"], "user", undefined, false, undefined, undefined, true);

      const [[written]] = vi.mocked(writeScopedHooksConfig).mock.calls;
      expect((written as unknown as Record<string, unknown>).customPoliciesPath).toBeUndefined();
      const logs = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      expect(logs.some((l: unknown) => typeof l === "string" && l.includes("Custom hooks path cleared"))).toBe(true);
    });
  });

  describe("removeHooks", () => {
    it("removes only failproofai hooks, preserving others", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const settings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "my-custom-hook", timeout: 5000 },
              ],
            },
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/failproofai --hook PreToolUse",
                  timeout: 10_000,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/failproofai --hook SessionStart",
                  timeout: 10_000,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
        },
        someOtherSetting: true,
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks();

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      expect(written.hooks.PreToolUse).toHaveLength(1);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe("my-custom-hook");
      expect(written.hooks.SessionStart).toBeUndefined();
      expect(written.someOtherSetting).toBe(true);
    });

    it("removes legacy failproofai hooks that lack the __failproofai_hook__ marker", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const settings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "other-tool --check", timeout: 5000 },
                // Legacy entry: command matches but no marker
                { type: "command", command: "/usr/local/bin/failproofai --hook PreToolUse", timeout: 60_000 },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "failproofai --hook SessionStart", timeout: 60_000 },
              ],
            },
          ],
        },
        someOtherSetting: true,
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks();

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      // Legacy failproofai hook removed; other-tool hook preserved
      expect(written.hooks.PreToolUse).toHaveLength(1);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe("other-tool --check");

      // SessionStart fully removed (was only legacy failproofai hook)
      expect(written.hooks.SessionStart).toBeUndefined();
      expect(written.someOtherSetting).toBe(true);
    });

    it("removes hooks object when empty after cleanup", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const settings = {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/failproofai --hook SessionStart",
                  timeout: 10_000,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
        },
        someOtherSetting: true,
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks();

      const [, content] = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(content as string);

      expect(written.hooks).toBeUndefined();
      expect(written.someOtherSetting).toBe(true);
    });

    it("handles missing settings file gracefully", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("No settings file found"),
      );
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("handles settings with no hooks key", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{"someOtherSetting": true}');

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("No hooks found"),
      );
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("removes specific policies from config when names provided", async () => {
      const { readScopedHooksConfig, writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo", "block-rm-rf", "sanitize-jwt"],
      });

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks(["block-sudo"]);

      expect(writeScopedHooksConfig).toHaveBeenCalledWith(
        { enabledPolicies: ["block-rm-rf", "sanitize-jwt"] },
        "user",
        undefined,
      );
      // Should NOT write to settings file
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("warns about policies not currently enabled", async () => {
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({ enabledPolicies: ["block-sudo"] });

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks(["block-rm-rf"]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("not currently enabled"),
      );
    });

    it("remove with scope: 'all' removes from all files", async () => {
      const hooksPayload = (event: string) => ({
        hooks: {
          [event]: [{
            hooks: [{
              type: "command",
              command: `/usr/local/bin/failproofai --hook ${event}`,
              timeout: 10_000,
              __failproofai_hook__: true,
            }],
          }],
        },
      });

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === USER_SETTINGS_PATH) return JSON.stringify(hooksPayload("SessionStart"));
        if (p === PROJECT_SETTINGS_PATH) return JSON.stringify(hooksPayload("PreToolUse"));
        if (p === LOCAL_SETTINGS_PATH) return JSON.stringify(hooksPayload("PostToolUse"));
        return "{}";
      });

      // Mock scoped config reads so the clear-all logic finds something to clear
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({ enabledPolicies: ["block-sudo"] });

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks(undefined, "all");

      // Should write to all three settings files
      expect(writeFileSync).toHaveBeenCalledTimes(3);

      // Verify all files had hooks removed
      for (const call of vi.mocked(writeFileSync).mock.calls) {
        const written = JSON.parse(call[1] as string);
        expect(written.hooks).toBeUndefined();
      }

      // Should clear policy config across scopes
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      expect(writeScopedHooksConfig).toHaveBeenCalled();
    });
    it("removeHooks with cwd targets that directory", async () => {
      const customProjectPath = resolve("/tmp/my-project", ".claude", "settings.json");
      vi.mocked(existsSync).mockImplementation((p) => p === customProjectPath);
      const settings = {
        hooks: {
          PreToolUse: [{
            hooks: [{
              type: "command",
              command: "/usr/local/bin/failproofai --hook PreToolUse",
              timeout: 10_000,
              __failproofai_hook__: true,
            }],
          }],
        },
      };
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === customProjectPath) return JSON.stringify(settings);
        return "{}";
      });

      const { removeHooks } = await import("../../src/hooks/manager");
      await removeHooks(undefined, "project", "/tmp/my-project");

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(customProjectPath);
    });

    it("fires hooks_removed telemetry for policy-only removal", async () => {
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo", "block-rm-rf", "sanitize-jwt"],
      });

      const { removeHooks } = await import("../../src/hooks/manager");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await removeHooks(["block-sudo"]);

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hooks_removed",
        expect.objectContaining({
          scope: "user",
          removal_mode: "policies",
          policies_removed: ["block-sudo"],
          removed_count: 1,
          platform: expect.any(String),
          arch: expect.any(String),
          os_release: expect.any(String),
          hostname_hash: expect.any(String),
        }),
      );
    });

    it("fires hooks_removed telemetry for full hooks removal", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const settings = {
        hooks: {
          SessionStart: [{
            hooks: [{
              type: "command",
              command: "/usr/local/bin/failproofai --hook SessionStart",
              timeout: 60_000,
              __failproofai_hook__: true,
            }],
          }],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settings));

      // readScopedHooksConfig is module-mocked; configure it to return the policies that
      // were enabled before removal (used in the telemetry policies_removed field).
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readScopedHooksConfig).mockReturnValue({ enabledPolicies: ["sanitize-jwt", "block-sudo"] });

      const { removeHooks } = await import("../../src/hooks/manager");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await removeHooks(undefined, "user");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hooks_removed",
        expect.objectContaining({
          scope: "user",
          removal_mode: "hooks",
          policies_removed: ["sanitize-jwt", "block-sudo"],
          removed_count: expect.any(Number),
          platform: expect.any(String),
          arch: expect.any(String),
          os_release: expect.any(String),
          hostname_hash: expect.any(String),
        }),
      );
    });
  });

  describe("listHooks", () => {
    it("compact output when no hooks installed", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({ enabledPolicies: [] });
      vi.mocked(existsSync).mockReturnValue(false);

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");

      // Should show "not installed" title
      expect(output).toContain("not installed");
      // Policy names as comma-separated text
      expect(output).toContain("sanitize-jwt");
      expect(output).toContain("block-sudo");
      // Should NOT contain scope column headers
      const headerLine = calls.find(
        (c: unknown) => typeof c === "string" && c.includes("User") && c.includes("Project") && c.includes("Local"),
      );
      expect(headerLine).toBeUndefined();
      // Should show get started hint
      expect(output).toContain("policies --install");
    });

    it("compact output hints to activate when config exists but not installed", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo", "sanitize-jwt"],
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      expect(output).toContain("Policies — not installed");
      expect(output).toContain("policies --install");
    });

    it("single scope shows checkmark list", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
      });

      // Only user scope has hooks installed
      vi.mocked(existsSync).mockImplementation((p) => p === USER_SETTINGS_PATH);
      const userSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === USER_SETTINGS_PATH) return JSON.stringify(userSettings);
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");

      // Scope name in title, not in columns
      expect(output).toContain("(user)");
      // Checkmark for enabled policy
      expect(output).toContain("\u2713");
      // Should NOT contain scope column headers
      const headerLine = calls.find(
        (c: unknown) => typeof c === "string" && c.includes("User") && c.includes("Project"),
      );
      expect(headerLine).toBeUndefined();
      // Policy names present
      expect(output).toContain("block-sudo");
    });

    it("warns when hooks exist in multiple scopes", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
      });

      const hookSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };

      // Both user and project scopes have hooks
      vi.mocked(existsSync).mockImplementation((p) => {
        return p === USER_SETTINGS_PATH || p === PROJECT_SETTINGS_PATH;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === USER_SETTINGS_PATH || p === PROJECT_SETTINGS_PATH) {
          return JSON.stringify(hookSettings);
        }
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");

      // Multi-scope warning present
      expect(output).toContain("multiple scopes");
      // Scope columns should appear
      const headerLine = calls.find(
        (c: unknown) => typeof c === "string" && c.includes("User") && c.includes("Project"),
      );
      expect(headerLine).toBeDefined();
    });

    it("multi-scope shows only installed scope columns", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
      });

      const hookSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };

      // User + project scopes have hooks, local does not
      vi.mocked(existsSync).mockImplementation((p) => {
        return p === USER_SETTINGS_PATH || p === PROJECT_SETTINGS_PATH;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === USER_SETTINGS_PATH || p === PROJECT_SETTINGS_PATH) {
          return JSON.stringify(hookSettings);
        }
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const headerLine = calls.find(
        (c: unknown) => typeof c === "string" && c.includes("User") && c.includes("Project"),
      );
      expect(headerLine).toBeDefined();
      // Local column should NOT appear
      expect(headerLine).not.toContain("Local");
    });

    it("listHooks with cwd reads from that directory", async () => {
      const customProjectPath = resolve("/tmp/my-project", ".claude", "settings.json");
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
      });

      const hookSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };

      // Only the custom project path has hooks
      vi.mocked(existsSync).mockImplementation((p) => p === customProjectPath);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === customProjectPath) return JSON.stringify(hookSettings);
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks("/tmp/my-project");

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      // Should detect hooks in the project scope via the custom directory
      expect(output).toContain("(project)");
    });

    it("does not show multi-scope warning when cwd is home directory", async () => {
      const home = homedir();
      const homeSettingsPath = resolve(home, ".claude", "settings.json");

      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
      });

      const hookSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };

      // user and project scopes resolve to the same file when cwd === home
      vi.mocked(existsSync).mockImplementation((p) => p === homeSettingsPath);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === homeSettingsPath) return JSON.stringify(hookSettings);
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks(home);

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");

      // Should show single-scope layout, not multi-scope warning
      expect(output).toContain("(user)");
      expect(output).not.toContain("multiple scopes");
    });

    it("prints param summary below policy row when policyParams configured", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: ["block-sudo"],
        policyParams: {
          "block-sudo": { allowPatterns: ["sudo systemctl status"] },
        },
      });

      vi.mocked(existsSync).mockImplementation((p) => p === USER_SETTINGS_PATH);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === USER_SETTINGS_PATH) return JSON.stringify({
          hooks: {
            PreToolUse: [{
              hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
            }],
          },
        });
        return "{}";
      });

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      expect(output).toContain("allowPatterns");
      expect(output).toContain("sudo systemctl status");
    });

    it("warns about unknown policyParams keys", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: [],
        policyParams: {
          "not-a-real-policy": { someParam: 42 },
        },
      });

      vi.mocked(existsSync).mockReturnValue(false);

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      expect(output).toContain("unknown policyParams key");
      expect(output).toContain("not-a-real-policy");
    });

    it("shows Custom Policies section with loaded hooks when customPoliciesPath is set", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: [],
        customPoliciesPath: "/tmp/my-hooks.js",
      });

      vi.mocked(existsSync).mockImplementation((p) => p === "/tmp/my-hooks.js");

      const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadCustomHooks).mockResolvedValue([
        { name: "my-hook", description: "does something", fn: async () => ({ decision: "allow" as const }) },
      ]);

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      expect(output).toContain("Custom Policies");
      expect(output).toContain("/tmp/my-hooks.js");
      expect(output).toContain("my-hook");
      expect(output).toContain("does something");
    });

    it("shows error row when customPoliciesPath file exists but fails to load", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValue({
        enabledPolicies: [],
        customPoliciesPath: "/tmp/broken-hooks.js",
      });

      vi.mocked(existsSync).mockImplementation((p) => p === "/tmp/broken-hooks.js");

      const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadCustomHooks).mockResolvedValue([]);

      const { listHooks } = await import("../../src/hooks/manager");
      await listHooks();

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");
      expect(output).toContain("ERR");
      expect(output).toContain("failed to load");
    });

    it("installHooks does not warn about duplicates when cwd is home directory", async () => {
      const home = homedir();
      const homeSettingsPath = resolve(home, ".claude", "settings.json");

      vi.mocked(existsSync).mockImplementation((p) => p === homeSettingsPath);

      const hookSettings = {
        hooks: {
          PreToolUse: [{
            hooks: [{ type: "command", command: "failproofai --hook PreToolUse", timeout: 10000, __failproofai_hook__: true }],
          }],
        },
      };
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (p === homeSettingsPath) return JSON.stringify(hookSettings);
        return "{}";
      });

      const { installHooks } = await import("../../src/hooks/manager");
      await installHooks(["all"], "user", home);

      const calls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
      const output = calls.join("\n");

      expect(output).not.toContain("Warning: Failproof AI hooks are also installed");
    });
  });
});
