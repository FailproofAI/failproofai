// @vitest-environment node
/**
 * `CLAUDE_CONFIG_DIR=~/.claude-work failproofai policies --install --cli claude`
 * must hook the `.claude-work` profile, not `~/.claude` (B14), and the same for
 * `CODEX_HOME`. The file it writes is the one the hook resolves at run time
 * (`runtimeAgentSettingsPath`), so the roster's sighting and the install name
 * the same profile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/src/hooks/codex-system-hooks", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/src/hooks/codex-system-hooks")>();
  return {
    ...real,
    // No root here: user-scope Codex hooks go to the profile's hooks.json.
    installCodexSystemHooks: () => ({ ok: false, reason: "no-root" }),
    removeCodexSystemHooks: () => ({ ok: true, removed: 0 }),
    codexSystemHooksPresent: () => false,
    codexHookTrust: () => ({ kind: "none" }),
  };
});

const KEYS = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_BINARY_OVERRIDE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
let root: string;
let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-profile-install-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = join(root, "packs");
  process.env.FAILPROOFAI_BINARY_OVERRIDE = join(root, "bin", "fp-bin");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function install(cli: "claude" | "codex"): Promise<void> {
  const { installHooks } = await import("@/src/hooks/manager");
  await installHooks(undefined, "user", home, false, undefined, undefined, false, [cli], { quiet: true });
}

async function uninstall(cli: "claude" | "codex"): Promise<void> {
  const { removeHooks } = await import("@/src/hooks/manager");
  await removeHooks(undefined, "user", home, { cli: [cli], silent: true });
}

describe("install and uninstall follow the agent profile's env", () => {
  it("CLAUDE_CONFIG_DIR: writes and removes the profile's settings.json, never ~/.claude", async () => {
    const profile = join(home, ".claude-work");
    process.env.CLAUDE_CONFIG_DIR = profile;
    await install("claude");
    const settings = join(profile, "settings.json");
    expect(readFileSync(settings, "utf8")).toContain("--hook PreToolUse");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);

    const { runtimeAgentSettingsPath } = await import("@/src/hooks/agent-roster");
    expect(runtimeAgentSettingsPath("claude", home, home, "user")).toBe(settings);
    const { claudeCode } = await import("@/src/hooks/integrations");
    expect(claudeCode.hooksInstalledInSettings("user", home)).toBe(true);

    await uninstall("claude");
    expect(readFileSync(settings, "utf8")).not.toContain("--hook");
  });

  it("CODEX_HOME: writes and removes the profile's hooks.json, never ~/.codex", async () => {
    const profile = join(home, ".codex-work");
    process.env.CODEX_HOME = profile;
    await install("codex");
    const hooks = join(profile, "hooks.json");
    expect(readFileSync(hooks, "utf8")).toContain("--hook pre_tool_use --cli codex");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);

    const { runtimeAgentSettingsPath } = await import("@/src/hooks/agent-roster");
    expect(runtimeAgentSettingsPath("codex", home, home, "user")).toBe(hooks);

    await uninstall("codex");
    expect(readFileSync(hooks, "utf8")).not.toContain("--hook");
  });

  it("without the env, the default profile is the one written", async () => {
    await install("claude");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".claude-work"))).toBe(false);
  });
});
