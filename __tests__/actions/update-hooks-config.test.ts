// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { config, writeHooksConfig } = vi.hoisted(() => ({
  config: { enabledPolicies: [] as string[], disabledCustomPolicies: [] as string[] },
  writeHooksConfig: vi.fn(),
}));

vi.mock("@/src/hooks/hooks-config", () => ({
  readHooksConfig: () => config,
  writeHooksConfig,
}));
vi.mock("@/src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn() }));
vi.mock("@/lib/telemetry-id", () => ({ getInstanceId: () => "test" }));

import { toggleCustomPolicyAction } from "@/app/actions/update-hooks-config";

describe("toggleCustomPolicyAction", () => {
  beforeEach(() => {
    config.disabledCustomPolicies = [];
    writeHooksConfig.mockClear();
  });

  it("stores a source-qualified ID when disabling a custom policy", async () => {
    await toggleCustomPolicyAction("custom:deny-all", false);
    expect(writeHooksConfig).toHaveBeenCalledWith({
      enabledPolicies: [],
      disabledCustomPolicies: ["custom:deny-all"],
    });
  });

  it("removes the config field when the final disabled policy is enabled", async () => {
    config.disabledCustomPolicies = ["convention:project:team-policies.mjs:deny-all"];
    await toggleCustomPolicyAction("convention:project:team-policies.mjs:deny-all", true);
    expect(writeHooksConfig).toHaveBeenCalledWith({ enabledPolicies: [] });
  });

  it("rejects IDs outside custom policy namespaces", async () => {
    await expect(toggleCustomPolicyAction("block-sudo", false)).rejects.toThrow("Invalid custom policy ID");
  });
});
