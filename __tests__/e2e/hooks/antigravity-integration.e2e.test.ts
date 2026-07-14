/**
 * E2E: Antigravity (agy) hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Antigravity has its OWN response contract
 * (NOT Claude's), verified live against agy v1.1.2:
 *   • tool/prompt deny  → `{decision:"deny", reason}` on stdout (exit 0)
 *   • Stop deny/instruct → `{decision:"continue", reason}` (re-enters the loop)
 *   • PreInvocation (→ UserPromptSubmit) instruct → `{injectSteps:[{ephemeralMessage}]}`
 * The camelCase `toolCall:{name,args}` payload is normalized to snake_case by
 * the handler before policies run. hooks.json uses a NAMED-hook schema.
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
  assertAntigravityDeny,
  assertAntigravityStopContinue,
  assertAntigravityInjectSteps,
} from "../helpers/hook-runner";
import { AntigravityPayloads } from "../helpers/payloads";
import { createFixtureEnv } from "../helpers/fixture-env";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createAntigravityEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-antigravity-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-antigravity-cwd-"));
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

describe("E2E: Antigravity integration — hook protocol", () => {
  it("PreToolUse: block-sudo denies via {decision:'deny'} JSON (exit 0)", () => {
    const env = createAntigravityEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "PreToolUse",
        AntigravityPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "antigravity" },
      );
      assertAntigravityDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreToolUse: camelCase toolCall{name:run_command} is normalized + canonicalized to Bash", () => {
    const env = createAntigravityEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      // toolCall.name "run_command" → tool_name → Bash; args.CommandLine → command.
      const result = runHook(
        "PreToolUse",
        AntigravityPayloads.preToolUse.bash("sudo rm -rf /", env.cwd),
        { homeDir: env.home, cli: "antigravity" },
      );
      assertAntigravityDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Stop deny emits {decision:'continue', reason} with MANDATORY ACTION wording", () => {
    const env = createAntigravityEnv();
    try {
      writeConfig(env.cwd, ["require-commit-before-stop"]);
      // require-commit-before-stop denies when the cwd has uncommitted changes.
      execSync(
        "git init -q && git config user.email t@t && git config user.name t && touch tracked && git add tracked && git commit -q -m initial && echo dirty > tracked",
        { cwd: env.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      const result = runHook(
        "Stop",
        AntigravityPayloads.stop(env.cwd),
        { homeDir: env.home, cli: "antigravity" },
      );
      assertAntigravityStopContinue(result);
    } finally {
      env.cleanup();
    }
  });

  it("PreInvocation (→ UserPromptSubmit) instruct emits {injectSteps:[{ephemeralMessage}]}", () => {
    const env = createFixtureEnv();
    const hookPath = env.writeHook("instruct-prompt.mjs", `
      import { customPolicies, instruct } from "failproofai";
      customPolicies.add({
        name: "instruct-on-prompt",
        description: "Always instruct on prompt submit",
        match: { events: ["UserPromptSubmit"] },
        fn: async () => instruct("review the plan before acting"),
      });
    `);
    env.writeConfig({ enabledPolicies: [], customPoliciesPath: hookPath });
    const result = runHook(
      "PreInvocation",
      AntigravityPayloads.preInvocation(env.cwd),
      { homeDir: env.home, cli: "antigravity" },
    );
    assertAntigravityInjectSteps(result);
    const steps = result.parsed?.injectSteps as Array<Record<string, unknown>>;
    expect(String(steps[0].ephemeralMessage)).toContain("review the plan before acting");
  });

  it("PreInvocation: allow when no policy matches", () => {
    const env = createAntigravityEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "PreInvocation",
        AntigravityPayloads.preInvocation(env.cwd),
        { homeDir: env.home, cli: "antigravity" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: antigravity", () => {
    const env = createAntigravityEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "PreToolUse",
        AntigravityPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "antigravity" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("antigravity");
      expect(last.decision).toBe("deny");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Antigravity integration — install/uninstall", () => {
  it("policies --install --cli antigravity --scope project writes .agents/hooks.json with named-hook schema", () => {
    const env = createAntigravityEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli antigravity --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const configPath = resolve(env.cwd, ".agents", "hooks.json");
      expect(existsSync(configPath)).toBe(true);
      const settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
      // Named-hook schema: our events live under the "failproofai" key.
      expect(settings.failproofai).toBeDefined();
      // Tool events → {matcher:"*", hooks:[…]} wrapper.
      expect(settings.failproofai.PreToolUse[0].matcher).toBe("*");
      const toolCmd = settings.failproofai.PreToolUse[0].hooks[0].command as string;
      expect(toolCmd).toContain("--cli antigravity");
      // PreInvocation / Stop → flat handler objects (no wrapper).
      expect(settings.failproofai.PreInvocation[0].type).toBe("command");
      expect(settings.failproofai.PreInvocation[0].hooks).toBeUndefined();
      expect(settings.failproofai.Stop[0].command).toContain("--cli antigravity");
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli antigravity --scope local fails with friendly error", () => {
    const env = createAntigravityEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli antigravity --scope local`,
          { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1" }, stdio: "pipe" },
        );
      } catch (e) {
        err = e as { status?: number; stderr?: Buffer };
      }
      expect(err).not.toBeNull();
      const stderr = err?.stderr?.toString() ?? "";
      expect(stderr).toMatch(/local.*not supported.*Antigravity CLI/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli antigravity removes the failproofai named hook but preserves other named hooks", () => {
    const env = createAntigravityEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli antigravity --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const configPath = resolve(env.cwd, ".agents", "hooks.json");
      expect(existsSync(configPath)).toBe(true);
      // Simulate an operator's own named hook surviving uninstall.
      const withOther = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      withOther["lint-checker"] = { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }] };
      writeFileSync(configPath, JSON.stringify(withOther, null, 2));

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli antigravity --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
      expect(settings.failproofai).toBeUndefined();
      expect(settings["lint-checker"]).toBeDefined();
    } finally {
      env.cleanup();
    }
  });
});
