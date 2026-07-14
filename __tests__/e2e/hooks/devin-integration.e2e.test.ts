/**
 * E2E: Devin (Cognition) hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated fixture
 * HOME so we don't pollute the user's ~/.config/devin or ~/.devin.
 *
 * Devin is a pure Claude-clone: its deny contract is `{decision:"block",
 * reason}` JSON on stdout at exit 0 for every event (verified live against
 * devin v3000.1.27 — the block overrode `--permission-mode dangerous`). Config
 * uses the standard Claude `"hooks"`-wrapper schema.
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
  assertDevinDeny,
  assertDevinStopBlock,
} from "../helpers/hook-runner";
import { DevinPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createDevinEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-devin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-devin-cwd-"));
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

describe("E2E: Devin integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via {decision:'block'} JSON (exit 0)", () => {
    const env = createDevinEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        DevinPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "devin" },
      );
      assertDevinDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: devin's `exec` tool is canonicalized to Bash", () => {
    const env = createDevinEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      // tool_name: "exec" must map to Bash so block-sudo fires.
      const result = runHook(
        "PreToolUse",
        DevinPayloads.preToolUse.bash("sudo rm -rf /", env.cwd),
        { homeDir: env.home, cli: "devin" },
      );
      assertDevinDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Stop deny emits {decision:'block', reason} with MANDATORY ACTION wording", () => {
    const env = createDevinEnv();
    try {
      writeConfig(env.cwd, ["require-commit-before-stop"]);
      // require-commit-before-stop denies when the cwd has uncommitted changes.
      execSync("git init -q && git config user.email t@t && git config user.name t && touch tracked && git add tracked && git commit -q -m initial && echo dirty > tracked", {
        cwd: env.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const result = runHook(
        "Stop",
        DevinPayloads.stop(env.cwd),
        { homeDir: env.home, cli: "devin" },
      );
      assertDevinStopBlock(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit: allow when no policy matches", () => {
    const env = createDevinEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        DevinPayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "devin" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: devin", () => {
    const env = createDevinEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        DevinPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "devin" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("devin");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Devin integration — install/uninstall", () => {
  it("policies --install --cli devin --scope project writes .devin/config.json with Claude-style hooks wrapper", () => {
    const env = createDevinEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli devin --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const configPath = resolve(env.cwd, ".devin", "config.json");
      expect(existsSync(configPath)).toBe(true);
      const settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
      // Claude-style `hooks` wrapper — event names live under it.
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      const cmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
      expect(cmd).toContain("--cli devin");
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli devin --scope local fails with friendly error", () => {
    const env = createDevinEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli devin --scope local`,
          { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1" }, stdio: "pipe" },
        );
      } catch (e) {
        err = e as { status?: number; stderr?: Buffer };
      }
      expect(err).not.toBeNull();
      const stderr = err?.stderr?.toString() ?? "";
      expect(stderr).toMatch(/local.*not supported.*Devin CLI/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli devin removes hooks but preserves other config keys", () => {
    const env = createDevinEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli devin --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const configPath = resolve(env.cwd, ".devin", "config.json");
      expect(existsSync(configPath)).toBe(true);
      // Simulate an operator's own key surviving uninstall.
      const withOrg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      withOrg.org_id = "acme";
      writeFileSync(configPath, JSON.stringify(withOrg, null, 2));

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli devin --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
      expect(settings.org_id).toBe("acme");
    } finally {
      env.cleanup();
    }
  });
});
