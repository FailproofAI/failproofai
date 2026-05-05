/**
 * E2E: GitHub Copilot CLI hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated
 * fixture HOME so we don't pollute the user's ~/.copilot/.
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
} from "../helpers/hook-runner";
import { CopilotPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createCopilotEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-copilot-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-copilot-cwd-"));
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

describe("E2E: Copilot integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via hookSpecificOutput.permissionDecision", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        CopilotPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .github/hooks/failproofai.json is denied by the agent-settings guard", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".github", "hooks", "failproofai.json");
      const result = runHook(
        "PreToolUse",
        CopilotPayloads.preToolUse.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .copilot/hooks/failproofai.json is denied by the agent-settings guard", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".copilot", "hooks", "failproofai.json");
      const result = runHook(
        "PreToolUse",
        CopilotPayloads.preToolUse.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PostToolUse: deny emits additionalContext (Claude-compatible JSON shape)", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["sanitize-jwt"]);
      // Build a JWT-shaped string at runtime to avoid embedding a contiguous
      // JWT literal in the source — secret scanners (and this repo's own
      // sanitize-jwt detector) flag committed JWTs even in test fixtures.
      // Each segment must be 10+ base64url chars to satisfy JWT_RE in
      // src/hooks/builtin-policies.ts.
      const jwtLike = [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
        Buffer.from('{"sub":"123456"}').toString("base64url"),
        Buffer.from("not-a-real-signature").toString("base64url"),
      ].join(".");
      const result = runHook(
        "PostToolUse",
        CopilotPayloads.postToolUse.bash(
          "echo done",
          `JWT=${jwtLike}`,
          env.cwd,
        ),
        { homeDir: env.home, cli: "copilot" },
      );
      assertPostToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("UserPromptSubmit: allow when no policy matches", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "UserPromptSubmit",
        CopilotPayloads.userPromptSubmit("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: copilot", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        CopilotPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("copilot");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });

  // Regression for #293: Copilot's tool registry uses lowercase IDs (`bash`),
  // but builtin policies match PascalCase (`Bash`) via case-sensitive
  // Array.includes. Without canonicalization in handler.ts every Bash builtin
  // silently no-ops under Copilot. The user reported that
  // `ls -la --almost-all $HOME | sed -n '1,200p'` ran successfully with
  // block-read-outside-cwd enabled; this test pins the fix.
  it("blocks Bash listing of $HOME outside cwd under Copilot (regression for #293)", () => {
    const env = createCopilotEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      // Use /tmp as a path guaranteed to be outside env.cwd — env.cwd is
      // itself under /tmp via mkdtempSync, so any sibling path works.
      const outsidePath = "/etc";
      const result = runHook(
        "PreToolUse",
        CopilotPayloads.preToolUse.bash(`ls -la ${outsidePath}`, env.cwd),
        { homeDir: env.home, cli: "copilot" },
      );
      assertPreToolUseDeny(result);
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Copilot integration — install/uninstall", () => {
  it("policies --install --cli copilot --scope project writes .github/hooks/failproofai.json with PascalCase keys", () => {
    const env = createCopilotEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli copilot --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".github", "hooks", "failproofai.json");
      expect(existsSync(hooksPath)).toBe(true);
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.version).toBe(1);
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Copilot stores under PascalCase keys (VS Code-compatible mode)
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.SessionStart).toBeDefined();
      expect(hooks.SessionEnd).toBeDefined();
      expect(hooks.UserPromptSubmit).toBeDefined();
      expect(hooks.Stop).toBeDefined();
      // camelCase keys should not be present
      expect(hooks.preToolUse).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("hook entries use bash + powershell keys with --cli copilot suffix", () => {
    const env = createCopilotEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli copilot --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".github", "hooks", "failproofai.json");
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
      const preToolMatcher = hooks.PreToolUse[0];
      const entry = preToolMatcher.hooks[0];
      expect(entry.type).toBe("command");
      expect(typeof entry.bash).toBe("string");
      expect(typeof entry.powershell).toBe("string");
      expect(entry.bash).toContain("--cli copilot");
      expect(entry.powershell).toContain("--cli copilot");
      expect(entry.bash).toContain("--hook PreToolUse");
      expect(typeof entry.timeoutSec).toBe("number");
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli copilot --scope local fails with friendly error", () => {
    const env = createCopilotEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli copilot --scope local`,
          {
            cwd: env.cwd,
            env: {
              ...process.env,
              HOME: env.home,
              FAILPROOFAI_TELEMETRY_DISABLED: "1",
              // Pass override so resolveFailproofaiBinary() doesn't probe PATH
              // — the test must reach the scope-validation deny, not crash on
              // a missing global install.
              FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH,
            },
            stdio: "pipe",
          },
        );
      } catch (e) {
        err = e as { status?: number; stderr?: Buffer };
      }
      expect(err).not.toBeNull();
      const stderr = err?.stderr?.toString() ?? "";
      expect(stderr).toMatch(/local.*not supported.*GitHub Copilot/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli copilot removes hooks from the file", () => {
    const env = createCopilotEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli copilot --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const hooksPath = resolve(env.cwd, ".github", "hooks", "failproofai.json");
      expect(existsSync(hooksPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli copilot --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
