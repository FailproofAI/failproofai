// @vitest-environment node
/**
 * What a pause actually does to evaluation. The load-bearing assertion is the
 * cloud one: if a locally-issued pause could suspend a centrally assigned
 * policy, cloud enforcement would be decorative and any user could opt out of
 * their organization's controls with one command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/hooks-config", () => ({
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: ["block-sudo", "block-rm-rf"] })),
}));
vi.mock("../../src/hooks/builtin-policies", () => ({ registerBuiltinPolicies: vi.fn() }));
vi.mock("../../src/hooks/policy-evaluator", () => ({
  evaluatePolicies: vi.fn(() => ({
    exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
  })),
}));
vi.mock("../../src/hooks/policy-registry", () => ({
  clearPolicies: vi.fn(),
  registerPolicy: vi.fn(),
  getPoliciesForEvent: vi.fn(() => []),
}));
vi.mock("../../src/hooks/custom-hooks-loader", () => ({ loadAllCustomHooks: vi.fn() }));
vi.mock("../../src/hooks/hook-activity-store", () => ({ persistHookActivity: vi.fn() }));
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-instance-id") }));
vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogInfo: vi.fn(), hookLogWarn: vi.fn(), hookLogError: vi.fn(),
}));
vi.mock("../../src/hooks/pack-manifest", () => ({
  // Isolation, not convenience: unmocked, `readInstalledPacks` reads the REAL
  // ~/.failproofai/policies/packs of whoever runs the suite, so these tests would
  // pass on a clean machine and behave differently on one with a pack installed.
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
}));

import { evaluateHookEvent } from "../../src/hooks/handler";
import { registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { registerPolicy } from "../../src/hooks/policy-registry";
import { loadAllCustomHooks } from "../../src/hooks/custom-hooks-loader";
import { persistHookActivity } from "../../src/hooks/hook-activity-store";
import { writePause } from "../../src/hooks/session-pause";

const SESSION = "session-under-test";

let stateDir: string;

function stdinPayload(sessionId = SESSION): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: "/tmp/project",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
  });
}

/** One ordinary local policy and one cloud-assigned policy, as the loader tags them. */
function twoHooks() {
  return Promise.resolve({
    hooks: [
      Object.assign(
        { name: "local-guard", description: "", match: {}, fn: async () => ({ decision: "allow" }) },
        { __policyId: "custom:/tmp/p.mjs:local-guard" },
      ),
      Object.assign(
        { name: "org-guard", description: "", match: {}, fn: async () => ({ decision: "allow" }) },
        {
          __policyId: "cloud:org-guard@7:org-guard",
          __cloudManaged: { id: "org-guard", version: 7, sha256: "a".repeat(64), path: "/x.mjs", deployment: 4 },
        },
      ),
    ],
    conventionSources: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = mkdtempSync(resolve(tmpdir(), "fpai-pause-enf-"));
  process.env.FAILPROOFAI_STATE_DIR = stateDir;
  vi.mocked(loadAllCustomHooks).mockImplementation(twoHooks as never);
});

afterEach(() => {
  delete process.env.FAILPROOFAI_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

const registeredNames = () => vi.mocked(registerPolicy).mock.calls.map((c) => c[0] as string);

describe("session pause and evaluation", () => {
  it("with no pause, builtins and every custom policy register normally", async () => {
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    expect(registerBuiltinPolicies).toHaveBeenCalledWith(["block-sudo", "block-rm-rf"]);
    const names = registeredNames();
    expect(names.some((n) => n.includes("local-guard"))).toBe(true);
    expect(names.some((n) => n.includes("org-guard"))).toBe(true);
  });

  it("a pause suspends builtins", async () => {
    writePause({ sessionId: SESSION, durationMs: 600_000 });
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    expect(registerBuiltinPolicies).toHaveBeenCalledWith([]);
  });

  it("a pause suspends local custom policies but NOT cloud-managed ones", async () => {
    writePause({ sessionId: SESSION, durationMs: 600_000 });
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    const names = registeredNames();
    expect(names.some((n) => n.includes("local-guard"))).toBe(false);
    expect(names.some((n) => n.includes("org-guard"))).toBe(true);
  });

  it("a pause on another session does not affect this one", async () => {
    writePause({ sessionId: "some-other-session", durationMs: 600_000 });
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    expect(registerBuiltinPolicies).toHaveBeenCalledWith(["block-sudo", "block-rm-rf"]);
    expect(registeredNames().some((n) => n.includes("local-guard"))).toBe(true);
  });

  it("an expired pause enforces again, with nothing to clean up first", async () => {
    writePause({ sessionId: SESSION, durationMs: 1_000, now: Date.now() - 60_000 });
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    expect(registerBuiltinPolicies).toHaveBeenCalledWith(["block-sudo", "block-rm-rf"]);
    expect(registeredNames().some((n) => n.includes("local-guard"))).toBe(true);
  });

  it("records the pause on the activity row, so the log cannot imply a clean window", async () => {
    const pause = writePause({ sessionId: SESSION, durationMs: 600_000, setBy: "cli" });
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    const entry = vi.mocked(persistHookActivity).mock.calls[0][0];
    expect(entry.pausedBy).toBe("cli");
    expect(entry.pauseExpiresAt).toBe(pause.expiresAt);
  });

  it("leaves no pause markers on an ordinary row", async () => {
    await evaluateHookEvent("PreToolUse", "claude", stdinPayload());
    const entry = vi.mocked(persistHookActivity).mock.calls[0][0];
    expect(entry.pausedBy).toBeUndefined();
    expect(entry.pauseExpiresAt).toBeUndefined();
  });

  it("an event with no session id is never treated as paused", async () => {
    // Several CLIs omit session_id on some events. Matching a pause loosely
    // there would silently disable enforcement for unrelated traffic.
    writePause({ sessionId: SESSION, durationMs: 600_000 });
    await evaluateHookEvent("PreToolUse", "claude", JSON.stringify({ cwd: "/tmp/project", tool_name: "Bash" }));
    expect(registerBuiltinPolicies).toHaveBeenCalledWith(["block-sudo", "block-rm-rf"]);
  });
});
