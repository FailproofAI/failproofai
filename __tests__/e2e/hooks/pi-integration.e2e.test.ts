/**
 * E2E: Pi (pi-coding-agent) hook integration.
 *
 * Exercises the full install → fire → decide flow using the real failproofai
 * binary as a subprocess (no mocks). Each test runs against an isolated
 * fixture HOME so we don't pollute the user's ~/.pi/.
 *
 * Three groups:
 *   1. Hook protocol (handler-only): synthesize Pi-shaped event payloads and
 *      run them through `bin/failproofai.mjs --hook ... --cli pi`. No Pi
 *      installation required.
 *   2. Install/uninstall: write/read .pi/settings.json directly through the
 *      `policies --install --cli pi` and `--uninstall` flow.
 *   3. Live `pi list` round-trip: confirm Pi recognizes the settings.json we
 *      wrote. Skipped when `pi` is not on PATH (CI runners without pi).
 */
import { describe, it, expect } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runHook,
  assertAllow,
  assertPiDeny,
  assertPiAllow,
} from "../helpers/hook-runner";
import { PiPayloads } from "../helpers/payloads";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");

function createPiEnv(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "fp-e2e-pi-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fp-e2e-pi-cwd-"));
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

function piIsAvailable(): boolean {
  try {
    const probe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

describe("E2E: Pi integration — hook protocol (handler-only)", () => {
  it("tool_call → PreToolUse: block-sudo emits {permission:'deny', reason}", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      const result = runHook(
        "tool_call",
        PiPayloads.toolCall.bash("sudo apt install foo", env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertPiDeny(result);
      expect(result.parsed?.hookSpecificOutput).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("tool_call: allow path returns no permission='deny' field", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "tool_call",
        PiPayloads.toolCall.bash("ls -la", env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertPiAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("user_bash: deny path fires (synthetic PreToolUse with toolName=Bash)", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, ["block-rm-rf"]);
      // `block-rm-rf` only triggers on single-component absolute paths
      // (`/`, `/home`, `/etc`, `/tmp` — see the regex in builtin-policies.ts);
      // multi-component paths like `/tmp/whatever` slip through. `/tmp` is
      // the conventional "destructive target" in tests.
      const result = runHook(
        "user_bash",
        PiPayloads.userBash("rm -rf /tmp", env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertPiDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("input → UserPromptSubmit: allow path when no policy matches", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "input",
        PiPayloads.input("Just a normal user prompt", env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertAllow(result);
    } finally {
      env.cleanup();
    }
  });

  it("session_start → SessionStart: exit 0", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "session_start",
        PiPayloads.sessionStart(env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("session_shutdown → SessionEnd: exit 0 (observation-only on Pi)", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, []);
      const result = runHook(
        "session_shutdown",
        PiPayloads.sessionShutdown(env.cwd, "quit"),
        { homeDir: env.home, cli: "pi" },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("tool_result → PostToolUse: sanitize-jwt fires on tool output containing a JWT", () => {
    const env = createPiEnv();
    try {
      // sanitize-jwt is enabled by default; pin it explicitly to ensure the
      // PostToolUse path is exercised regardless of default-enabled drift.
      writeConfig(env.cwd, ["sanitize-jwt"]);
      // A syntactically valid JWT (3 base64url segments). Embed inside Bash
      // tool output so sanitize-jwt's PostToolUse pattern match fires.
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const result = runHook(
        "tool_result",
        PiPayloads.toolResult(
          "Bash",
          { command: "echo $TOKEN" },
          [{ type: "text", text: `token: ${jwt}` }],
          env.cwd,
        ),
        { homeDir: env.home, cli: "pi" },
      );
      // PostToolUse + sanitize-jwt → deny (the policy treats secret-leak as a
      // hard fail). Pi flat-shape emits {permission: "deny", reason}.
      // Confirms tool_result → PostToolUse canonicalization works AND that
      // the Pi-flat shape is emitted instead of Claude's hookSpecificOutput.
      assertPiDeny(result);
      expect(String(result.parsed?.reason ?? "")).toMatch(/JWT|jwt|sanitize-jwt|secret/i);
    } finally {
      env.cleanup();
    }
  });

  it("agent_end → Stop: handler runs and exits 0 (Pi cannot veto stop)", () => {
    const env = createPiEnv();
    try {
      // No Stop policies are default-enabled; with empty config we just
      // confirm the canonicalization path works end-to-end (snake_case
      // 'agent_end' → PascalCase 'Stop') and the binary exits cleanly.
      writeConfig(env.cwd, []);
      const result = runHook(
        "agent_end",
        PiPayloads.agentEnd(env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("agent_end with require-commit-before-stop in a dirty repo emits MANDATORY ACTION reason", () => {
    const env = createPiEnv();
    try {
      // Make env.cwd a git repo with an uncommitted file so
      // require-commit-before-stop returns deny. This is the bridge to the
      // shim-side handoff: the binary's stdout MUST be a Pi-flat
      // `{permission:"deny", reason}` payload whose reason carries the
      // "MANDATORY ACTION REQUIRED" wrapper. The shim captures that
      // reason on agent_end and re-injects it via before_agent_start (the
      // in-process map handoff is covered by the shim unit tests).
      execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: env.cwd });
      writeFileSync(resolve(env.cwd, "dirty.txt"), "uncommitted\n");
      writeConfig(env.cwd, ["require-commit-before-stop"]);
      const result = runHook(
        "agent_end",
        PiPayloads.agentEnd(env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      // Stop on Pi uses the MANDATORY ACTION wrapping (not the generic
      // `Blocked <displayTool> by failproofai because: …` wording that
      // assertPiDeny matches), so we inline the deny shape checks here.
      expect(result.exitCode).toBe(0);
      expect(result.parsed?.permission).toBe("deny");
      expect(result.parsed?.hookSpecificOutput).toBeUndefined();
      const reason = String(result.parsed?.reason ?? "");
      expect(reason).toMatch(/MANDATORY ACTION REQUIRED/);
      expect(reason).toMatch(/require-commit-before-stop/);
      expect(reason).toMatch(/uncommitted changes/i);
    } finally {
      env.cleanup();
    }
  });

  it("agent-settings guard: Bash read of .pi/settings.json is denied", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.cwd, ".pi", "settings.json");
      const result = runHook(
        "tool_call",
        PiPayloads.toolCall.bash(`cat ${settingsPath}`, env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertPiDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("agent-settings guard: Read of ~/.pi/agent/settings.json is denied", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, ["block-read-outside-cwd"]);
      const settingsPath = resolve(env.home, ".pi", "agent", "settings.json");
      const result = runHook(
        "tool_call",
        PiPayloads.toolCall.read(settingsPath, env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      assertPiDeny(result);
    } finally {
      env.cleanup();
    }
  });

  it("activity entry tags decision with integration: pi", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, ["block-sudo"]);
      runHook(
        "tool_call",
        PiPayloads.toolCall.bash("sudo cat /etc/passwd", env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.integration).toBe("pi");
      expect(last.decision).toBe("deny");
      // Canonical event name lands in the activity entry, not the snake_case wire form.
      expect(last.eventType).toBe("PreToolUse");
    } finally {
      env.cleanup();
    }
  });

  it("permission-mode resolves to 'default' for cli=pi", () => {
    const env = createPiEnv();
    try {
      writeConfig(env.cwd, []);
      runHook(
        "session_start",
        PiPayloads.sessionStart(env.cwd),
        { homeDir: env.home, cli: "pi" },
      );
      const activityPath = resolve(env.home, ".failproofai", "cache", "hook-activity", "current.jsonl");
      expect(existsSync(activityPath)).toBe(true);
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(last.permissionMode).toBe("default");
    } finally {
      env.cleanup();
    }
  });
});

describe("E2E: Pi integration — install/uninstall", () => {
  it("policies --install --cli pi --scope project writes .pi/settings.json with packages array", () => {
    const env = createPiEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const settingsPath = resolve(env.cwd, ".pi", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const packages = settings.packages as string[];
      expect(Array.isArray(packages)).toBe(true);
      expect(packages.length).toBe(1);
      // The entry references failproofai's pi-extension package directory.
      expect(packages[0]).toContain("pi-extension");
      expect(packages[0]).toContain("failproofai");
    } finally {
      env.cleanup();
    }
  });

  it("policies --install --cli pi --scope user writes ~/.pi/agent/settings.json", () => {
    const env = createPiEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope user`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      const settingsPath = resolve(env.home, ".pi", "agent", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const packages = settings.packages as string[];
      expect(packages.length).toBe(1);
      expect(packages[0]).toContain("pi-extension");
    } finally {
      env.cleanup();
    }
  });

  it("policies --uninstall --cli pi removes the failproofai entry from .pi/settings.json", () => {
    const env = createPiEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settingsPath = resolve(env.cwd, ".pi", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      // Empty packages array drops to undefined; user entries are preserved if present.
      expect(settings.packages).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("re-install is idempotent: running install twice leaves exactly one failproofai entry", () => {
    const env = createPiEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const settings = JSON.parse(
        readFileSync(resolve(env.cwd, ".pi", "settings.json"), "utf-8"),
      ) as { packages: string[] };
      const failproofaiEntries = settings.packages.filter((p) => p.includes("pi-extension"));
      expect(failproofaiEntries.length).toBe(1);
    } finally {
      env.cleanup();
    }
  });

  it("install preserves existing user packages alongside the failproofai entry", () => {
    const env = createPiEnv();
    try {
      // Pre-populate .pi/settings.json with a user-owned package
      const settingsPath = resolve(env.cwd, ".pi", "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ packages: ["npm:@user/other-extension"] }, null, 2),
      );

      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages: string[] };
      expect(settings.packages.length).toBe(2);
      expect(settings.packages).toContain("npm:@user/other-extension");
      expect(settings.packages.some((p) => p.includes("pi-extension"))).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Live Pi roundtrip — gated behind `which pi` so CI without Pi installed
// passes. When run on a developer machine with Pi installed, these confirm
// Pi actually parses the settings.json failproofai writes.
// ──────────────────────────────────────────────────────────────────────────

const piPresent = piIsAvailable();
const describePi = piPresent ? describe : describe.skip;

describePi("E2E: Pi integration — live `pi list` roundtrip (real binary)", () => {
  it("after policies --install, `pi list` shows the failproofai entry", () => {
    const env = createPiEnv();
    try {
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH } },
      );
      // Run `pi list` under the fixture HOME so it doesn't pick up the
      // developer's real ~/.pi/agent/settings.json state.
      const result = spawnSync("pi", ["list"], {
        cwd: env.cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: env.home },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("pi-extension");
    } finally {
      env.cleanup();
    }
  });

  it("after policies --uninstall, `pi list` no longer shows the failproofai entry", () => {
    const env = createPiEnv();
    try {
      const baseEnv = { ...process.env, HOME: env.home, FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH };
      execSync(
        `bun ${BINARY_PATH} policies --install block-sudo --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      execSync(
        `bun ${BINARY_PATH} policies --uninstall --cli pi --scope project`,
        { cwd: env.cwd, env: baseEnv },
      );
      const result = spawnSync("pi", ["list"], {
        cwd: env.cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: env.home },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("pi-extension");
    } finally {
      env.cleanup();
    }
  });
});
