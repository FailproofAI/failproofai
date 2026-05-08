/**
 * E2E: Cursor Agent CLI hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated
 * fixture HOME so we don't pollute the user's ~/.cursor/.
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
  assertCursorDeny,
  assertCursorStopBlock,
} from "../helpers/hook-runner";
import { CursorPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createCursorEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-cursor-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-cursor-cwd-"));
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

describe("E2E: Cursor integration — hook protocol", () => {
  it("preToolUse: block-sudo emits Cursor's flat {permission:'deny', user_message, agent_message} shape", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "preToolUse",
        CursorPayloads.preToolUse.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertCursorDeny(result);
      // No hookSpecificOutput wrapper for Cursor — confirm we used the flat shape.
      expect(result.parsed?.hookSpecificOutput).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("postToolUse: deny still emits Cursor's flat shape (no additionalContext wrapper)", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, ["sanitize-jwt"]);
      // Build a JWT-shaped string at runtime so secret scanners don't flag the source.
      const jwtLike = [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
        Buffer.from('{"sub":"123456"}').toString("base64url"),
        Buffer.from("not-a-real-signature").toString("base64url"),
      ].join(".");
      const result = runHook(
        "postToolUse",
        CursorPayloads.postToolUse.bash("echo done", `JWT=${jwtLike}`, env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertCursorDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("Bash read of .cursor/hooks.json is denied by the agent-settings guard", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".cursor", "hooks.json");
      const result = runHook(
        "preToolUse",
        CursorPayloads.preToolUse.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertCursorDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("beforeSubmitPrompt → UserPromptSubmit canonicalization: allow when no policy matches", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "beforeSubmitPrompt",
        CursorPayloads.beforeSubmitPrompt("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: cursor and persists cwd", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "preToolUse",
        CursorPayloads.preToolUse.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("cursor");
      expect(last.decision).toBe("deny");
      // Canonical event name lands in the activity entry, not the camelCase wire form.
      expect(last.eventType).toBe("PreToolUse");
      // preToolUse carries top-level cwd in Cursor's payload — passthrough.
      expect(last.cwd).toBe(env.cwd);
    } finally {
      env.cleanup();
    }
  });

  it("sessionStart resolves cwd from workspace_roots when top-level cwd is absent", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "sessionStart",
        CursorPayloads.sessionStart(env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertAllow(result);

      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("cursor");
      expect(last.eventType).toBe("SessionStart");
      // No top-level cwd in Cursor's sessionStart payload — handler must
      // fall back to workspace_roots[0] via resolveCwd().
      expect(last.cwd).toBe(env.cwd);
    } finally {
      env.cleanup();
    }
  });

  it("beforeSubmitPrompt resolves cwd from workspace_roots when top-level cwd is absent", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "beforeSubmitPrompt",
        CursorPayloads.beforeSubmitPrompt("normal prompt", env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertAllow(result);

      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.cwd).toBe(env.cwd);
    } finally {
      env.cleanup();
    }
  });

  // Stop hook on Cursor honors `{followup_message}` JSON, NOT `{permission:
  // "deny"}` (which is a tool-event-only shape) and NOT exit-2+stderr (which
  // Cursor surfaces as a warning but ignores for retry). Per
  // https://cursor.com/docs/hooks the followup_message text is auto-submitted
  // as the next user message, capped at `loop_limit` (default 5). The
  // `cli === "cursor" && eventType in {Stop, SubagentStop}` branch in
  // policy-evaluator.ts emits this shape; without it the 5
  // require-*-before-stop builtins were observation-only on Cursor.
  it("stop deny emits {followup_message} JSON (Cursor stop force-retry shape)", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, ["require-commit-before-stop"]);
      // require-commit-before-stop denies when the cwd has uncommitted changes.
      // env.cwd has no .git/ at all, so the policy short-circuits to allow —
      // we need to plant uncommitted state. Same pattern as the Copilot Stop
      // e2e in copilot-integration.e2e.test.ts.
      execSync(
        "git init -q && git config user.email t@t && git config user.name t && touch tracked && git add tracked && git commit -q -m initial && echo dirty > tracked",
        { cwd: env.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      const result = runHook(
        "stop",
        CursorPayloads.stop(env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertCursorStopBlock(result);
      // The flat {permission: "deny"} shape MUST NOT leak through on Stop —
      // Cursor would ignore it and the agent would stop cleanly.
      expect(result.parsed?.permission).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  // SubagentStop is a sibling of stop with the same payload + response
  // contract per Cursor docs; we subscribe to it (CURSOR_HOOK_EVENT_TYPES,
  // CURSOR_EVENT_MAP) so custom policies matching SubagentStop are reachable
  // from Cursor subagent boundaries — parity with Copilot's #299 widening.
  // Builtin require-*-before-stop policies still match Stop only by design,
  // so we exercise SubagentStop with a custom policy via a small inline shim:
  // assert allow when no SubagentStop policy is enabled but the hook fires
  // and is canonicalized correctly (event lands in activity store as
  // SubagentStop, not as an unknown camelCase form).
  it("subagentStop canonicalizes to SubagentStop and reaches the activity store", () => {
    const env = createCursorEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "subagentStop",
        CursorPayloads.subagentStop(env.cwd),
        { homeDir: env.home, cli: "cursor" },
      );
      assertAllow(result);

      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("cursor");
      expect(last.eventType).toBe("SubagentStop");
      expect(last.cwd).toBe(env.cwd);
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Cursor integration — install/uninstall", () => {
  it("policies --install --cli cursor --scope project writes .cursor/hooks.json with camelCase keys + flat array", () => {
    const env = createCursorEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli cursor --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const hooksPath = resolve(env.cwd, ".cursor", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.version).toBe(1);
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Cursor stores under camelCase keys (native form) per cursor.com/docs/hooks.
      expect(hooks.preToolUse).toBeDefined();
      expect(hooks.postToolUse).toBeDefined();
      expect(hooks.sessionStart).toBeDefined();
      expect(hooks.sessionEnd).toBeDefined();
      expect(hooks.beforeSubmitPrompt).toBeDefined();
      expect(hooks.stop).toBeDefined();
      // subagentStop subscribed since #NEW for Copilot-parity: custom policies
      // matching SubagentStop are reachable on Cursor subagent boundaries.
      expect(hooks.subagentStop).toBeDefined();
      // PascalCase keys should not be present.
      expect(hooks.PreToolUse).toBeUndefined();
      // Flat array — each entry IS the hook, no `{hooks: [...]}` matcher wrapper.
      const preEntries = hooks.preToolUse as Array<Record<string, unknown>>;
      expect(preEntries[0].type).toBe("command");
      expect(typeof preEntries[0].command).toBe("string");
      expect(preEntries[0].hooks).toBeUndefined();
      expect((preEntries[0].command as string)).toContain("--cli cursor");
      expect((preEntries[0].command as string)).toContain("--hook preToolUse");
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli cursor --scope local fails with friendly error", () => {
    const env = createCursorEnv();
    try {
      let err: { status?: number; stderr?: Buffer } | null = null;
      try {
        execSync(
          `bun ${BINARY_PATH} policies --install block-sudo --cli cursor --scope local`,
          {
            cwd: env.cwd,
            env: {
              ...process.env,
              HOME: env.home,
              FAILPROOFAI_TELEMETRY_DISABLED: "1",
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
      expect(stderr).toMatch(/local.*not supported.*Cursor/i);
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli cursor removes hooks from the file", () => {
    const env = createCursorEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli cursor --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const hooksPath = resolve(env.cwd, ".cursor", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli cursor --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
