// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/src/hooks/hooks-config", () => ({
  readHooksConfig: () => ({ enabledPolicies: [] }),
}));

vi.mock("@/src/hooks/manager", () => ({
  hooksInstalledInSettings: () => false,
  getSettingsPath: () => "/tmp/.claude/settings.json",
}));

const installedFlags: Record<string, boolean> = {
  claude: true,
  codex: false,
  copilot: false,
  cursor: false,
  opencode: false,
  pi: false,
};

const detectedFlags: Record<string, boolean> = {
  claude: true,
  codex: true,
  copilot: false,
  cursor: false,
  opencode: false,
  pi: false,
};

vi.mock("@/src/hooks/integrations", () => {
  const ids = ["claude", "codex", "copilot", "cursor", "opencode", "pi"] as const;
  const make = (id: (typeof ids)[number]) => ({
    id,
    displayName: id,
    hooksInstalledInSettings: () => installedFlags[id],
    getSettingsPath: () => `/tmp/${id}/settings.json`,
    detectInstalled: () => detectedFlags[id],
  });
  return {
    listIntegrations: () => ids.map(make),
  };
});

import { getHooksConfigAction } from "@/app/actions/get-hooks-config";

describe("getHooksConfigAction — clis payload", () => {
  beforeEach(() => {
    // reset to baseline
    Object.assign(installedFlags, {
      claude: true, codex: false, copilot: false, cursor: false,
      opencode: false, pi: false,
    });
    Object.assign(detectedFlags, {
      claude: true, codex: true, copilot: false, cursor: false,
      opencode: false, pi: false,
    });
  });

  it("returns one entry per CLI in registry order", async () => {
    const config = await getHooksConfigAction();
    expect(config.clis.map((c) => c.id)).toEqual([
      "claude", "codex", "copilot", "cursor", "opencode", "pi",
    ]);
  });

  it("reflects installed and detected flags from each integration", async () => {
    const config = await getHooksConfigAction();
    const claude = config.clis.find((c) => c.id === "claude")!;
    const codex = config.clis.find((c) => c.id === "codex")!;

    expect(claude.installed).toBe(true);
    expect(claude.detected).toBe(true);
    expect(codex.installed).toBe(false);
    expect(codex.detected).toBe(true);
  });

  it("carries the per-CLI user-scope settingsPath", async () => {
    const config = await getHooksConfigAction();
    expect(config.clis.find((c) => c.id === "codex")!.settingsPath).toBe(
      "/tmp/codex/settings.json",
    );
    expect(config.clis.find((c) => c.id === "pi")!.settingsPath).toBe(
      "/tmp/pi/settings.json",
    );
  });

  it("uses cli-registry display labels (not raw ids)", async () => {
    const config = await getHooksConfigAction();
    expect(config.clis.find((c) => c.id === "claude")!.label).toBe("Claude Code");
    expect(config.clis.find((c) => c.id === "codex")!.label).toBe("OpenAI Codex");
  });
});
