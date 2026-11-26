// @vitest-environment node
//
// Whether the handler moves typed shell text into `command` and registers the
// refusal guard. The text's reading is covered in typed-shell-input.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "fp-typed-input-"));
process.env.FAILPROOFAI_HOME = scratch;

vi.mock("../../src/hooks/policy-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/policy-registry")>()),
  clearPolicies: vi.fn(),
  registerPolicy: vi.fn(),
  getPoliciesForEvent: vi.fn(() => []),
}));
vi.mock("../../src/hooks/custom-hooks-loader", () => ({
  loadAllCustomHooks: vi.fn(async () => ({ hooks: [], conventionSources: [] })),
}));
vi.mock("../../src/hooks/cloud-managed-policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/cloud-managed-policies")>()),
  readActiveCloudManagedPolicies: vi.fn(() => []),
  readCloudJevMode: vi.fn(() => null),
  readCloudJevState: vi.fn(() => ({ jevMode: null, deployment: null, errors: [] })),
  readCloudAuthorityInputs: vi.fn(() => []),
}));
vi.mock("../../src/hooks/session-pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/session-pause")>()),
  readActivePause: vi.fn(() => null),
}));
vi.mock("../../src/hooks/hook-activity-store", () => ({ persistHookActivity: vi.fn() }));
vi.mock("../../src/hooks/policy-evaluator", () => ({
  evaluatePolicies: vi.fn(() => ({ exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" })),
}));
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/hook-logger", () => ({ hookLogInfo: vi.fn(), hookLogWarn: vi.fn(), hookLogError: vi.fn() }));
vi.mock("../../src/hooks/untraced-note", () => ({ noteUntracedAgent: vi.fn(() => false) }));
vi.mock("../../src/hooks/pack-manifest", () => ({
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
  hasInstalledPacks: vi.fn(() => false),
  hasInstalledRegexPacks: vi.fn(() => false),
}));

import { evaluateHookEvent } from "../../src/hooks/handler";
import { TYPED_INPUT_GUARD_NAME } from "../../src/hooks/typed-shell-input";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";
import { readActivePause } from "../../src/hooks/session-pause";
import { registerPolicy } from "../../src/hooks/policy-registry";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";

const codex = (tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({ session_id: "s1", cwd: "/tmp/p", hook_event_name: "PreToolUse", tool_name, tool_input });
const registered = () => vi.mocked(registerPolicy).mock.calls.some(([name]) => name === TYPED_INPUT_GUARD_NAME);
const evaluatedInput = () => (vi.mocked(evaluatePolicies).mock.calls[0]?.[1] as Record<string, unknown>)?.tool_input as Record<string, unknown>;
const CLOUD = { id: "org", version: 1, sha256: "a".repeat(64), path: "/x.mjs", deployment: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readActivePause).mockReturnValue(null);
  vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([]);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("handler: text typed into a running shell", () => {
  it("hands Codex write_stdin's chars to the shell policies as the command", async () => {
    await evaluateHookEvent("pre_tool_use", "codex", codex("write_stdin", { session_id: 7, chars: "rm -rf ~/.failproofai\n" }));
    expect(evaluatedInput()).toMatchObject({ command: "rm -rf ~/.failproofai", chars: "rm -rf ~/.failproofai\n" });
    expect(registered()).toBe(false);
  });

  it("hands Copilot write_bash's input to the shell policies as the command", async () => {
    await evaluateHookEvent(
      "PreToolUse",
      "copilot",
      JSON.stringify({ session_id: "s1", cwd: "/tmp/p", tool_name: "write_bash", tool_input: { shellId: "a", input: "sudo ls\n" } }),
    );
    expect(evaluatedInput()).toMatchObject({ command: "sudo ls" });
  });

  it("registers the guard for a partial line", async () => {
    await evaluateHookEvent("pre_tool_use", "codex", codex("write_stdin", { session_id: 7, chars: "rm -rf ~/.fail" }));
    expect(registered()).toBe(true);
  });

  it("does not register it for an empty poll or an ordinary command", async () => {
    await evaluateHookEvent("pre_tool_use", "codex", codex("write_stdin", { session_id: 7, chars: "" }));
    await evaluateHookEvent("pre_tool_use", "codex", codex("Bash", { command: "ls" }));
    expect(registered()).toBe(false);
  });

  it("a pause lifts it unless an enforcing Cloud policy is deployed", async () => {
    vi.mocked(readActivePause).mockReturnValue({ sessionId: "s1" } as never);
    await evaluateHookEvent("pre_tool_use", "codex", codex("write_stdin", { session_id: 7, chars: "x" }));
    expect(registered()).toBe(false);
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([CLOUD] as never);
    await evaluateHookEvent("pre_tool_use", "codex", codex("write_stdin", { session_id: 7, chars: "x" }));
    expect(registered()).toBe(true);
  });
});
