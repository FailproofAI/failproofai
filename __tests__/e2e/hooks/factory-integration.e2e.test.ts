/**
 * E2E: Factory (droid) hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated fixture
 * HOME so we don't pollute the user's ~/.factory/.
 *
 * Factory's deny contract is EXIT CODE 2 + stderr (droid ignores JSON decisions
 * on tool events); Stop is the exception — droid honors `{decision:"block"}`.
 * Verified live against droid v0.171.0.
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
  assertFactoryDeny,
  assertFactoryStopBlock,
} from "../helpers/hook-runner";
import { FactoryPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createFactoryEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-factory-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-factory-cwd-"));
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

describe("E2E: Factory integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via EXIT CODE 2 + stderr (not JSON)", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        FactoryPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "factory" },
      );
      assertFactoryDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: droid's `Execute` tool is canonicalized to Bash", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      // tool_name: "Execute" must map to Bash so block-sudo fires.
      const result = runHook(
        "PreToolUse",
        FactoryPayloads.preToolUse.bash("sudo rm -rf /", env.cwd),
        { homeDir: env.home, cli: "factory" },
      );
      assertFactoryDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PostToolUse: deny also uses exit-2 + stderr", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, ["sanitize-jwt"]);
      const result = runHook(
        "PostToolUse",
        FactoryPayloads.postToolUse.bash(
          "echo done",
          "JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          env.cwd,
        ),
        { homeDir: env.home, cli: "factory" },
      );
      assertFactoryDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Stop deny emits {decision:'block', reason} JSON (droid's turn-end retry shape)", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, ["require-commit-before-stop"]);
      // require-commit-before-stop denies when the cwd has uncommitted changes.
      execSync("git init -q && git config user.email t@t && git config user.name t && touch tracked && git add tracked && git commit -q -m initial && echo dirty > tracked", {
        cwd: env.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const result = runHook(
        "Stop",
        FactoryPayloads.stop(env.cwd),
        { homeDir: env.home, cli: "factory" },
      );
      assertFactoryStopBlock(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit: allow when no policy matches", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        FactoryPayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "factory" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: factory", () => {
    const env = createFactoryEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        FactoryPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "factory" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("factory");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Factory integration — install/uninstall", () => {
  it("policies --install --cli factory --scope project writes .factory/hooks.json with TOP-LEVEL event keys", () => {
    const env = createFactoryEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli factory --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".factory", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, any>;
      // No `hooks` wrapper — event names live at the top level.
      expect(settings.hooks).toBeUndefined();
      expect(settings.PreToolUse).toBeDefined();
      expect(settings.PostToolUse).toBeDefined();
      expect(settings.Stop).toBeDefined();
      expect(settings.SessionStart).toBeDefined();
      // Tool events carry matcher:"*"; Stop does not.
      expect(settings.PreToolUse[0].matcher).toBe("*");
      expect(settings.Stop[0].matcher).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli factory --scope local fails with friendly error", () => {
    const env = createFactoryEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli factory --scope local`,
          { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1" }, stdio: "pipe" },
        );
      } catch (e) {
        err = e as { status?: number; stderr?: Buffer };
      }
      expect(err).not.toBeNull();
      const stderr = err?.stderr?.toString() ?? "";
      expect(stderr).toMatch(/local.*not supported.*Factory Droid/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli factory removes hooks from .factory/hooks.json", () => {
    const env = createFactoryEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli factory --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const hooksPath = resolve(env.cwd, ".factory", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli factory --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.PreToolUse).toBeUndefined();
      expect(settings.Stop).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
