/**
 * The Stage-1 acceptance gate: the TypeScript hook client against the real
 * Rust daemon.
 *
 * Everything else in the suite tests one side. `daemon-client.test.ts` drives
 * the client against a hand-written mock server; `crates/failproofaid/tests/
 * daemon_e2e.rs` drives the daemon from a hand-written Rust client. Both can
 * pass while the two disagree — which is exactly what happens when two
 * independent implementations are written from one prose spec, and it is the
 * failure `crates/PROTOCOL.md` exists to prevent and cannot prevent by itself.
 *
 * So this file connects the two real implementations and asserts that the bytes
 * a harness receives are **identical** to what the legacy in-process evaluator
 * would have produced. That is the Stage-1 exit criterion stated verbatim in
 * 01-stages.md:
 *
 * > one Claude `PreToolUse` deny byte-identical to legacy
 *
 * plus the `=off` half of it:
 *
 * > `FAILPROOFAI_DAEMON_MODE=off` and an unset socket must both produce output
 * > identical to `main` across the entire e2e suite.
 *
 * Skipped, loudly, when `cargo` is unavailable or the daemon fails to build —
 * a skipped test that says why is honest; one that silently passes is not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { tryDaemonEvaluate } from "../../../src/hooks/daemon-client";
import { buildLocalEnvelope } from "../../../src/hooks/request-envelope";
import { readLocalHostFacts } from "../../../src/hooks/local-host";
import { clearPolicies } from "../../../src/hooks/policy-registry";
import { registerBuiltinPolicies } from "../../../src/hooks/builtin-policies";
import { evaluatePolicies } from "../../../src/hooks/policy-evaluator";
import type { HookEventType, IntegrationType } from "../../../src/hooks/types";

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..");
/** Kept inside the repo: the dogfood policies block writes outside it. */
const SCRATCH = resolvePath(REPO_ROOT, "target", "daemon-e2e");
const SOCKET = resolvePath(SCRATCH, "failproofaid.sock");
const INSTALL_JSON = resolvePath(SCRATCH, "install.json");

/**
 * The enabled set sent to both sides.
 *
 * The daemon has no policy list of its own — it evaluates whatever the client
 * sends, which is the fix for the defect where it enforced 11 builtin defaults
 * regardless of the user's 30 enabled policies. So this list is the *client's*
 * resolved set, handed identically to the daemon and to the legacy evaluator;
 * anything else would make the comparison measure configuration rather than
 * implementation.
 *
 * It happens to be the default-enabled set, which keeps the comparison
 * representative of a stock install.
 */
const DAEMON_POLICY_SET = [
  "sanitize-jwt",
  "sanitize-api-keys",
  "sanitize-connection-strings",
  "sanitize-private-key-content",
  "sanitize-bearer-tokens",
  "protect-env-vars",
  "block-env-files",
  "block-sudo",
  "block-curl-pipe-sh",
  "block-failproofai-commands",
  "block-push-master",
];

let daemon: ChildProcess | undefined;
let available = false;
let skipReason = "";

const originalEnv = {
  mode: process.env.FAILPROOFAI_DAEMON_MODE,
  socket: process.env.FAILPROOFAI_DAEMON_SOCKET,
  install: process.env.FAILPROOFAI_INSTALL_JSON,
};

beforeAll(async () => {
  const build = spawnSync("cargo", ["build", "-p", "failproofaid"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  if (build.status !== 0) {
    skipReason = `cargo build failed: ${(build.stderr || build.error?.message || "").slice(-600)}`;
    return;
  }

  const binary = resolvePath(REPO_ROOT, "target/debug/failproofaid");
  if (!existsSync(binary)) {
    skipReason = `built, but ${binary} is missing`;
    return;
  }

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  // The client verifies the socket's owner against `service_uid`. In the real
  // install that is the `_failproofai` account; here the daemon runs as us, so
  // the honest value is our own uid. Writing anything else would make the test
  // pass for the wrong reason.
  writeFileSync(
    INSTALL_JSON,
    JSON.stringify({ service_uid: userInfo().uid, version: "test" }, null, 2),
  );

  daemon = spawn(binary, ["--socket", SOCKET], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr?.on("data", () => {
    /* drained so the pipe cannot fill and block the daemon */
  });

  // Poll rather than sleep a fixed amount: the bundle load dominates startup
  // and varies with machine load.
  for (let i = 0; i < 100; i++) {
    if (existsSync(SOCKET)) {
      available = true;
      break;
    }
    if (daemon.exitCode !== null) {
      skipReason = `daemon exited during startup with code ${daemon.exitCode}`;
      return;
    }
    await delay(100);
  }
  if (!available) skipReason = "daemon did not bind its socket within 10s";

  process.env.FAILPROOFAI_DAEMON_SOCKET = SOCKET;
  process.env.FAILPROOFAI_INSTALL_JSON = INSTALL_JSON;
}, 16 * 60_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const [key, value] of [
    ["FAILPROOFAI_DAEMON_MODE", originalEnv.mode],
    ["FAILPROOFAI_DAEMON_SOCKET", originalEnv.socket],
    ["FAILPROOFAI_INSTALL_JSON", originalEnv.install],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function envelopeFor(
  cli: IntegrationType,
  eventType: HookEventType,
  payload: Record<string, unknown>,
) {
  return buildLocalEnvelope({
    cli,
    eventType,
    rawEventType: eventType,
    payload,
    cwd: "/home/u/project",
    sessionId: "sess-cross",
    permissionMode: "default",
    hookEventName: eventType,
    host: readLocalHostFacts(),
  });
}

/** The legacy in-process answer for the same event and the same policy set. */
async function legacyAnswer(
  cli: IntegrationType,
  eventType: HookEventType,
  payload: Record<string, unknown>,
) {
  clearPolicies();
  registerBuiltinPolicies(DAEMON_POLICY_SET);
  const facts = readLocalHostFacts();
  return evaluatePolicies(eventType, payload, {
    cli,
    cwd: "/home/u/project",
    home: facts.home,
    permissionMode: "default",
    sessionId: "sess-cross",
    hookEventName: eventType,
  }, { enabledPolicies: DAEMON_POLICY_SET });
}

describe("TypeScript client ↔ Rust daemon", () => {
  it("the daemon is running (otherwise every assertion below is vacuous)", () => {
    expect(available, skipReason || "daemon unavailable").toBe(true);
  });

  it("denies sudo byte-identically to the legacy evaluator", async () => {
    if (!available) return;
    process.env.FAILPROOFAI_DAEMON_MODE = "enforce";

    const payload = { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } };
    const viaDaemon = await tryDaemonEvaluate(
      envelopeFor("claude", "PreToolUse", payload),
      5000,
      DAEMON_POLICY_SET,
    );
    expect(viaDaemon, "the daemon must answer, not fall back").not.toBeNull();

    const viaLegacy = await legacyAnswer("claude", "PreToolUse", payload);

    // Byte-exact on every field a harness observes. Not `toMatchObject` — a
    // missing field would pass that.
    expect(viaDaemon!.exitCode).toBe(viaLegacy.exitCode);
    expect(viaDaemon!.stdout).toBe(viaLegacy.stdout);
    expect(viaDaemon!.stderr).toBe(viaLegacy.stderr);
    expect(viaDaemon!.decision).toBe(viaLegacy.decision);
    expect(viaDaemon!.policyName).toBe(viaLegacy.policyName);
    expect(viaDaemon!.reason).toBe(viaLegacy.reason);
  });

  /**
   * A cross-section rather than the whole matrix: this spawns no processes but
   * does cross a socket per row, so the full 5,568-fixture corpus belongs in
   * the Stage-2 parity harness. These are the shapes most likely to diverge —
   * the two sanitizers that stringify the whole payload, a params-driven
   * allowlist, and one row per response family.
   */
  const CASES: Array<{
    name: string;
    cli: IntegrationType;
    event: HookEventType;
    payload: Record<string, unknown>;
  }> = [
    { name: "claude deny", cli: "claude", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "claude allow", cli: "claude", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "echo hi" } } },
    { name: "cursor deny (flat shape)", cli: "cursor", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "factory deny (exit 2)", cli: "factory", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "goose deny (block json)", cli: "goose", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "antigravity deny", cli: "antigravity", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "copilot permission request", cli: "copilot", event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "sudo id" } } },
    { name: "env file read", cli: "claude", event: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "/home/u/project/.env" } } },
    { name: "api key in output", cli: "claude", event: "PostToolUse", payload: { tool_name: "Bash", tool_input: { command: "x" }, tool_response: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" } },
    { name: "push to main", cli: "claude", event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "git push origin main" } } },
  ];

  for (const c of CASES) {
    it(`agrees with legacy: ${c.name}`, async () => {
      if (!available) return;
      process.env.FAILPROOFAI_DAEMON_MODE = "enforce";

      const viaDaemon = await tryDaemonEvaluate(envelopeFor(c.cli, c.event, c.payload), 5000, DAEMON_POLICY_SET);
      expect(viaDaemon, `${c.name}: daemon fell back instead of answering`).not.toBeNull();

      const viaLegacy = await legacyAnswer(c.cli, c.event, c.payload);
      expect({
        exitCode: viaDaemon!.exitCode,
        stdout: viaDaemon!.stdout,
        stderr: viaDaemon!.stderr,
        decision: viaDaemon!.decision,
        policyName: viaDaemon!.policyName,
        reason: viaDaemon!.reason,
      }).toEqual({
        exitCode: viaLegacy.exitCode,
        stdout: viaLegacy.stdout,
        stderr: viaLegacy.stderr,
        decision: viaLegacy.decision,
        policyName: viaLegacy.policyName,
        reason: viaLegacy.reason,
      });
    });
  }

  it("is dead code with the mode unset, even with a live daemon", async () => {
    if (!available) return;
    delete process.env.FAILPROOFAI_DAEMON_MODE;
    const result = await tryDaemonEvaluate(
      envelopeFor("claude", "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "sudo id" },
      }),
      5000,
      DAEMON_POLICY_SET,
    );
    expect(result).toBeNull();
  });

  it("falls back when the mode is explicitly off", async () => {
    if (!available) return;
    process.env.FAILPROOFAI_DAEMON_MODE = "off";
    const result = await tryDaemonEvaluate(
      envelopeFor("claude", "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "sudo id" },
      }),
      5000,
      DAEMON_POLICY_SET,
    );
    expect(result).toBeNull();
  });

  it("falls back when the socket path is wrong, without throwing", async () => {
    if (!available) return;
    process.env.FAILPROOFAI_DAEMON_MODE = "enforce";
    const saved = process.env.FAILPROOFAI_DAEMON_SOCKET;
    process.env.FAILPROOFAI_DAEMON_SOCKET = resolvePath(SCRATCH, "nope.sock");
    try {
      const result = await tryDaemonEvaluate(
        envelopeFor("claude", "PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "sudo id" },
        }),
        5000,
      DAEMON_POLICY_SET,
      );
      expect(result).toBeNull();
    } finally {
      process.env.FAILPROOFAI_DAEMON_SOCKET = saved;
    }
  });

  it("stays consistent across many round trips on a warm daemon", async () => {
    if (!available) return;
    process.env.FAILPROOFAI_DAEMON_MODE = "enforce";
    const envelope = envelopeFor("claude", "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "cat /etc/passwd /etc/shadow" },
    });
    const first = await tryDaemonEvaluate(envelope, 5000, DAEMON_POLICY_SET);
    expect(first).not.toBeNull();
    for (let i = 0; i < 100; i++) {
      const again = await tryDaemonEvaluate(envelope, 5000, DAEMON_POLICY_SET);
      expect(again, `diverged at round trip ${i}`).toEqual(first);
    }
  }, 60_000);
});
