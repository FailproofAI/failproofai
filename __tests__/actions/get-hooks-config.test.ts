// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── Convention policies ──────────────────────────────────────────────────────
//
// These are registered by the filesystem, never by policies-config.json, so a
// dashboard that only reads config renders nothing and a working policy looks
// absent. That was the reported bug: `failproofai policies` listed four
// convention files while the dashboard's configure view showed none.
describe("getHooksConfigAction — convention policies", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fp-convention-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function writePolicyDir(root: string, files: Record<string, string>) {
    const dir = join(root, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, "utf8");
    }
    return dir;
  }

  const POLICY_SRC = `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({
      name: "enforce-formal-review",
      description: "Require a formal review",
      match: { events: ["PreToolUse", "Stop"] },
      fn: async () => allow(),
    });
  `;

  it("discovers project-scope policy files and parses their hooks", async () => {
    writePolicyDir(tmp, { "enforce-formal-review-policies.mjs": POLICY_SRC });
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      const config = await getHooksConfigAction();
      const entry = config.conventionPolicies.find(
        (e) => e.file === "enforce-formal-review-policies.mjs",
      );
      expect(entry).toBeDefined();
      expect(entry!.scope).toBe("project");
      expect(entry!.policies).toEqual([
        {
          name: "enforce-formal-review",
          description: "Require a formal review",
          eventScope: "PreToolUse, Stop",
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips files that do not match the *policies.{js,mjs,ts} convention", async () => {
    writePolicyDir(tmp, {
      "enforce-formal-review-policies.mjs": POLICY_SRC,
      // Silently skipped by the loader too — listing it would tell the user a
      // file is active when it enforces nothing.
      "block-foo.mjs": POLICY_SRC,
    });
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      const config = await getHooksConfigAction();
      const files = config.conventionPolicies.map((e) => e.file);
      expect(files).toContain("enforce-formal-review-policies.mjs");
      expect(files).not.toContain("block-foo.mjs");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns an empty list when no policy directory exists", async () => {
    // HOME must be isolated too, or the developer's own user-scope policies
    // leak into the assertion.
    const emptyHome = mkdtempSync(join(tmpdir(), "fp-home-"));
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.stubEnv("HOME", emptyHome);
    vi.stubEnv("USERPROFILE", emptyHome);
    try {
      const config = await getHooksConfigAction();
      expect(config.conventionPolicies).toEqual([]);
    } finally {
      spy.mockRestore();
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("does not list the same file twice when cwd is the home directory", async () => {
    writePolicyDir(tmp, { "team-policies.mjs": POLICY_SRC });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.stubEnv("HOME", tmp);
    try {
      const config = await getHooksConfigAction();
      const matching = config.conventionPolicies.filter((e) => e.file === "team-policies.mjs");
      expect(matching).toHaveLength(1);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
