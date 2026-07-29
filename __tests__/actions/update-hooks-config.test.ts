// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { config, scopedConfigs, writeHooksConfig, writeScopedHooksConfig } = vi.hoisted(() => ({
  config: { enabledPolicies: [] as string[], disabledCustomPolicies: [] as string[] },
  scopedConfigs: {
    project: { enabledPolicies: [] as string[], disabledCustomPolicies: [] as string[] },
    local: { enabledPolicies: [] as string[], disabledCustomPolicies: [] as string[] },
    user: { enabledPolicies: [] as string[], disabledCustomPolicies: [] as string[] },
  },
  writeHooksConfig: vi.fn(),
  writeScopedHooksConfig: vi.fn(),
}));

vi.mock("@/src/hooks/hooks-config", () => ({
  readHooksConfig: () => config,
  readScopedHooksConfig: (scope: "project" | "local" | "user") => scopedConfigs[scope],
  writeHooksConfig,
  writeScopedHooksConfig,
}));
vi.mock("@/src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn() }));
vi.mock("@/lib/telemetry-id", () => ({ getInstanceId: () => "test" }));

import { toggleCustomPolicyAction } from "@/app/actions/update-hooks-config";

describe("toggleCustomPolicyAction", () => {
  beforeEach(() => {
    config.disabledCustomPolicies = [];
    for (const scoped of Object.values(scopedConfigs)) scoped.disabledCustomPolicies = [];
    writeHooksConfig.mockClear();
    writeScopedHooksConfig.mockClear();
  });

  it("stores a source-qualified ID when disabling a custom policy", async () => {
    await toggleCustomPolicyAction("custom:/tmp/team.js:deny-all", false);
    expect(writeHooksConfig).toHaveBeenCalledWith({
      enabledPolicies: [],
      disabledCustomPolicies: ["custom:/tmp/team.js:deny-all"],
    });
  });

  it("removes the field when the final disabled policy is enabled", async () => {
    scopedConfigs.user.disabledCustomPolicies = ["convention:project:team-policies.mjs:deny-all"];
    await toggleCustomPolicyAction("convention:project:team-policies.mjs:deny-all", true);
    expect(writeScopedHooksConfig).toHaveBeenCalledWith(
      { enabledPolicies: [] },
      "user",
      expect.any(String),
    );
  });

  it("removes an effective disable from every contributing scope", async () => {
    const id = "custom:/tmp/team.js:deny-all";
    scopedConfigs.project.disabledCustomPolicies = [id, "custom:/tmp/team.js:other"];
    scopedConfigs.user.disabledCustomPolicies = [id];

    await toggleCustomPolicyAction(id, true);

    expect(writeScopedHooksConfig).toHaveBeenCalledWith(
      { enabledPolicies: [], disabledCustomPolicies: ["custom:/tmp/team.js:other"] },
      "project",
      expect.any(String),
    );
    expect(writeScopedHooksConfig).toHaveBeenCalledWith(
      { enabledPolicies: [] },
      "user",
      expect.any(String),
    );
    expect(writeScopedHooksConfig).toHaveBeenCalledTimes(2);
  });

  it("rejects IDs outside custom policy namespaces", async () => {
    await expect(toggleCustomPolicyAction("block-sudo", false)).rejects.toThrow("Invalid custom policy ID");
  });
});
