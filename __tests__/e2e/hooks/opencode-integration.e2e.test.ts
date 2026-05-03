/**
 * E2E: OpenCode CLI hook integration.
 *
 * Exercises the full install → fire → decide → uninstall flow using the
 * real failproofai binary as a subprocess (no mocks). Each test runs
 * against an isolated fixture HOME so we don't pollute the user's
 * ~/.config/opencode/.
 *
 * Note: opencode's plugin model is fundamentally different from
 * Claude/Codex/Copilot/Cursor — there's no external-command hook.
 * The plugin shim file (.opencode/plugins/failproofai.mjs) is what
 * translates plugin events into the Claude-shape JSON the binary
 * already understands. This file therefore:
 *   • verifies install/uninstall writes both the shim file AND the
 *     opencode.json plugin-array registration
 *   • drives the binary directly with `--cli opencode` to confirm
 *     it accepts the cli flag and tags activity correctly
 * The shim's plugin-side translation is unit-tested separately in
 * __tests__/hooks/opencode-plugin-shim.test.ts.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runHook,
  assertAllow,
  assertPreToolUseDeny,
} from "../helpers/hook-runner";
import { OpenCodePayloads } from "../helpers/payloads";
import { FAILPROOFAI_HOOK_MARKER } from "../../../src/hooks/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createOpenCodeEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-opencode-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-opencode-cwd-"));
  // Pre-create the .failproofai dir under cwd so the parent-walk finds it.
  mkdirSync(resolve(cwd, ".failproofai"), { recursive: true });
  return {
    home,
    cwd,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function writeConfig(cwd: string, enabledPolicies: string[]): void {
  const configPath = resolve(cwd, ".failproofai", "policies-config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ enabledPolicies }, null, 2));
}

/**
 * Run the failproofai binary's install command in the given cwd, with HOME
 * pointing at the fixture so we don't write to the real ~/.config/.
 */
function installInto(env: { home: string; cwd: string }, scope: "project" | "user", extraArgs: string[] = []): void {
  execSync(`bun ${BINARY_PATH} policies --install --cli opencode --scope ${scope} ${extraArgs.join(" ")}`, {
    cwd: env.cwd,
    env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH },
    stdio: "pipe",
  });
}

function uninstallFrom(env: { home: string; cwd: string }, scope: "project" | "user"): void {
  execSync(`bun ${BINARY_PATH} policies --uninstall --cli opencode --scope ${scope}`, {
    cwd: env.cwd,
    env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH },
    stdio: "pipe",
  });
}

describe("E2E: OpenCode integration — install / uninstall", () => {
  it("install --scope project writes plugin file + opencode.json registration", () => {
    const env = createOpenCodeEnv();
    try {
      installInto(env, "project");
      const pluginPath = resolve(env.cwd, ".opencode", "plugins", "failproofai.mjs");
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      expect(existsSync(pluginPath)).toBe(true);
      expect(readFileSync(pluginPath, "utf8")).toContain(FAILPROOFAI_HOOK_MARKER);
      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.plugin).toContain("./plugins/failproofai.mjs");
    } finally {
      env.cleanup();
    }
  });

  it("install is idempotent — second install yields identical bytes for both files", () => {
    const env = createOpenCodeEnv();
    try {
      installInto(env, "project");
      const pluginPath = resolve(env.cwd, ".opencode", "plugins", "failproofai.mjs");
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      const firstPlugin = readFileSync(pluginPath, "utf8");
      const firstJson = readFileSync(jsonPath, "utf8");
      installInto(env, "project");
      expect(readFileSync(pluginPath, "utf8")).toBe(firstPlugin);
      expect(readFileSync(jsonPath, "utf8")).toBe(firstJson);
    } finally {
      env.cleanup();
    }
  });

  it("install merges into a pre-existing opencode.json without losing other plugins", () => {
    const env = createOpenCodeEnv();
    try {
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["@some/npm-plugin"],
        agent: { mine: { prompt: "hi" } },
      }, null, 2));
      installInto(env, "project");
      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.plugin).toContain("@some/npm-plugin");
      expect(json.plugin).toContain("./plugins/failproofai.mjs");
      expect(json.$schema).toBe("https://opencode.ai/config.json");
      expect(json.agent).toEqual({ mine: { prompt: "hi" } });
    } finally {
      env.cleanup();
    }
  });

  it("install --scope user writes ~/.config/opencode/{opencode.json,plugins/failproofai.mjs} under HOME=fixture", () => {
    const env = createOpenCodeEnv();
    try {
      installInto(env, "user");
      const pluginPath = resolve(env.home, ".config", "opencode", "plugins", "failproofai.mjs");
      const jsonPath = resolve(env.home, ".config", "opencode", "opencode.json");
      expect(existsSync(pluginPath)).toBe(true);
      expect(existsSync(jsonPath)).toBe(true);
      expect(readFileSync(pluginPath, "utf8")).toContain(FAILPROOFAI_HOOK_MARKER);
    } finally {
      env.cleanup();
    }
  });

  it("uninstall removes BOTH the plugin file AND the registration entry", () => {
    const env = createOpenCodeEnv();
    try {
      installInto(env, "project");
      const pluginPath = resolve(env.cwd, ".opencode", "plugins", "failproofai.mjs");
      expect(existsSync(pluginPath)).toBe(true);
      uninstallFrom(env, "project");
      expect(existsSync(pluginPath)).toBe(false);
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.plugin ?? []).not.toContain("./plugins/failproofai.mjs");
    } finally {
      env.cleanup();
    }
  });

  it("uninstall preserves user's other plugin entries", () => {
    const env = createOpenCodeEnv();
    try {
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, JSON.stringify({ plugin: ["@some/npm-plugin"] }));
      installInto(env, "project");
      uninstallFrom(env, "project");
      const json = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(json.plugin).toContain("@some/npm-plugin");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: OpenCode integration — hook protocol", () => {
  it("PreToolUse: block-sudo emits Claude-shape deny envelope", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      assertPreToolUseDeny(result);
      const out = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
      expect(out?.permissionDecisionReason).toMatch(/sudo/i);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: harmless ls allows", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash("ls -la", env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .opencode/plugins/failproofai.mjs is denied by the agent-settings guard", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".opencode", "plugins", "failproofai.mjs");
      const result = runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      assertPreToolUseDeny(result);
      const out = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
      expect(out?.permissionDecisionReason).toMatch(/settings/i);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .opencode/opencode.json is denied by the agent-settings guard", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const jsonPath = resolve(env.cwd, ".opencode", "opencode.json");
      const result = runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash(`cat ${jsonPath}`, env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit canonicalization: allow when no policy matches", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        OpenCodePayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: opencode", () => {
    const env = createOpenCodeEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash("sudo rm -rf /", env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      // Activity log path: $HOME/.failproofai/cache/hook-activity/current.jsonl
      // (per src/hooks/hook-activity-store.ts:30 — DEFAULT_STORE_DIR uses
      // homedir(), and the test's runHook overrides HOME=env.home).
      // Fail explicitly if missing so an OpenCode activity-tagging regression
      // can't silently slip through with a no-op assertion.
      const logPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l));
      const opencodeEntries = entries.filter((e) => e.integration === "opencode");
      expect(opencodeEntries.length).toBeGreaterThan(0);
    } finally {
      env.cleanup();
    }
  });

  it("--cli opencode without an installed plugin still works for direct binary invocation", () => {
    // The binary doesn't need the plugin file present — the plugin file is
    // for the OpenCode-side hook discovery, not for the binary itself.
    const env = createOpenCodeEnv();
    try {
      const result = runHook(
        "PreToolUse",
        OpenCodePayloads.preToolUse.bash("ls", env.cwd),
        { homeDir: env.home, cli: "opencode" },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});
