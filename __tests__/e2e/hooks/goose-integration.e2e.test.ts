/**
 * E2E: Goose (codename goose, Block) hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated fixture
 * HOME/cwd so we don't pollute the user's ~/.agents/plugins/.
 *
 * Goose's deny contract is `{decision:"block", reason}` JSON on stdout at exit 0,
 * honored on PreToolUse ONLY (goose has no Stop event). Its stdin uses `event` /
 * `working_dir` (normalized in handler.ts) and BARE tool names mapped via
 * GOOSE_TOOL_MAP. Verified live against goose v1.43.0.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, assertAllow, assertGooseDeny } from "../helpers/hook-runner";
import { GoosePayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createGooseEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-goose-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-goose-cwd-"));
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

describe("E2E: Goose integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via {decision:'block'} JSON (goose's shell → Bash)", () => {
    const env = createGooseEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      // tool_name "shell" must canonicalize to Bash so block-sudo fires.
      const result = runHook(
        "PreToolUse",
        GoosePayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "goose" },
      );
      assertGooseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: write's `path` is canonicalized to file_path so block-env-files fires", () => {
    const env = createGooseEnv();
    try {
      writeConfig(env.cwd, ["block-env-files"]);
      // goose `write` delivers the path as `path`; without the input map,
      // block-env-files (which reads file_path) would silently no-op.
      const result = runHook(
        "PreToolUse",
        GoosePayloads.preToolUse.write(resolve(env.cwd, ".env"), "SECRET=abc123", env.cwd),
        { homeDir: env.home, cli: "goose" },
      );
      assertGooseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit: allow when no policy matches", () => {
    const env = createGooseEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        GoosePayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "goose" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: allow when the command is harmless", () => {
    const env = createGooseEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        GoosePayloads.preToolUse.bash("echo hello", env.cwd),
        { homeDir: env.home, cli: "goose" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: goose", () => {
    const env = createGooseEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        GoosePayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "goose" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("goose");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Goose integration — install/uninstall", () => {
  it("policies --install --cli goose --scope project writes the Open Plugins hooks.json", () => {
    const env = createGooseEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli goose --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".agents", "plugins", "failproofai", "hooks", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, any>;
      // Open Plugins schema: top-level "hooks" wrapper, matcher OMITTED.
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.PreToolUse[0].matcher).toBeUndefined();
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("--cli goose");
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli goose removes hooks from the plugin hooks.json", () => {
    const env = createGooseEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli goose --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const hooksPath = resolve(env.cwd, ".agents", "plugins", "failproofai", "hooks", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli goose --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
