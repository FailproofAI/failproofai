/**
 * E2E: OpenAI Codex hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated
 * fixture HOME so we don't pollute the user's ~/.codex/.
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
  assertPostToolUseDeny,
  assertStopInstruct,
  assertPermissionRequestDeny,
} from "../helpers/hook-runner";
import { CodexPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createCodexEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-codex-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-codex-cwd-"));
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

describe("E2E: Codex integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via hookSpecificOutput.permissionDecision", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        CodexPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: snake_case --hook value (pre_tool_use) is canonicalized", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "pre_tool_use",
        CodexPayloads.preToolUse.bash("sudo rm -rf /", env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      // Same deny output regardless of which casing the agent passed.
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .codex/hooks.json is denied by the generalized agent-settings guard", () => {
    const env = createCodexEnv();
    try {
      // block-read-outside-cwd checks isAgentSettingsFile, which now covers
      // both .claude/settings*.json and .codex/hooks.json.
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".codex", "hooks.json");
      const result = runHook(
        "PreToolUse",
        CodexPayloads.preToolUse.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PostToolUse: deny emits additionalContext (Claude-compatible JSON shape)", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, ["sanitize-jwt"]);
      const result = runHook(
        "PostToolUse",
        CodexPayloads.postToolUse.bash(
          "echo done",
          "JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          env.cwd,
        ),
        { homeDir: env.home, cli: "codex" },
      );
      assertPostToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PermissionRequest: deny uses hookSpecificOutput.decision.behavior shape", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PermissionRequest",
        CodexPayloads.permissionRequest.bash("sudo rm /", env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      assertPermissionRequestDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit: allow when no policy matches", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        CodexPayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: codex", () => {
    const env = createCodexEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        CodexPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "codex" },
      );
      // Activity store path resolves against $HOME → env.home/.failproofai/cache/hook-activity/current.jsonl
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("codex");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Codex integration — install/uninstall", () => {
  it("policies --install --cli codex --scope project writes .codex/hooks.json with PascalCase keys", () => {
    const env = createCodexEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli codex --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.version).toBeUndefined();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Codex stores under PascalCase keys
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.PermissionRequest).toBeDefined();
      expect(hooks.SessionStart).toBeDefined();
      expect(hooks.Stop).toBeDefined();
      expect(hooks.UserPromptSubmit).toBeDefined();
      // Snake-case keys should not be present
      expect(hooks.pre_tool_use).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli codex --scope local fails with friendly error", () => {
    const env = createCodexEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli codex --scope local`,
          { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1" }, stdio: "pipe" },
        );
      } catch (e) {
        err = e as { status?: number; stderr?: Buffer };
      }
      expect(err).not.toBeNull();
      const stderr = err?.stderr?.toString() ?? "";
      expect(stderr).toMatch(/local.*not supported.*OpenAI Codex/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli codex removes hooks from .codex/hooks.json", () => {
    const env = createCodexEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli codex --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const hooksPath = resolve(env.cwd, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli codex --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
