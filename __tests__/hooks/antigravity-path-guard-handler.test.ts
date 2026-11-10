// @vitest-environment node
//
// Whether the handler registers the guard. The guard's own decision is covered in
// antigravity-path-guard.test.ts, and real payloads in the antigravity e2e suite.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "fp-agy-guard-"));
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
import { ANTIGRAVITY_PATH_GUARD_NAME, antigravityPathGuardActive } from "../../src/hooks/antigravity-path-guard";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";
import { readActivePause } from "../../src/hooks/session-pause";
import { registerPolicy } from "../../src/hooks/policy-registry";

const agy = (args: Record<string, unknown>) =>
  JSON.stringify({
    conversationId: "c1",
    workspacePaths: ["/tmp/p"],
    transcriptPath: "/nonexistent",
    stepIdx: 1,
    modelName: "m",
    toolCall: { name: "read_file", args },
  });
const registered = () =>
  vi.mocked(registerPolicy).mock.calls.some(([name]) => name === ANTIGRAVITY_PATH_GUARD_NAME);
const pause = () => vi.mocked(readActivePause).mockReturnValue({ sessionId: "c1" } as never);
const CLOUD = { id: "org", version: 1, sha256: "a".repeat(64), path: "/x.mjs", deployment: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readActivePause).mockReturnValue(null);
  vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([]);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("handler registration of the Antigravity path guard", () => {
  it("registers for a file call with no recognizable path", async () => {
    await evaluateHookEvent("PreToolUse", "antigravity", agy({ FilePath: "/etc/passwd" }));
    expect(registered()).toBe(true);
  });

  it("does not register for a normal call, so its activity row is unchanged", async () => {
    await evaluateHookEvent("PreToolUse", "antigravity", agy({ Path: "/tmp/p/a" }));
    expect(registered()).toBe(false);
  });

  it("does not register on another CLI", async () => {
    await evaluateHookEvent(
      "PreToolUse",
      "claude",
      JSON.stringify({ session_id: "s", cwd: "/tmp/p", tool_name: "Read", tool_input: {} }),
    );
    expect(registered()).toBe(false);
  });

  it("a pause lifts it when no Cloud policy is deployed", async () => {
    pause();
    await evaluateHookEvent("PreToolUse", "antigravity", agy({ FilePath: "/etc/passwd" }));
    expect(registered()).toBe(false);
  });

  it("a pause does not lift it while an enforcing Cloud policy is deployed", async () => {
    pause();
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([CLOUD] as never);
    await evaluateHookEvent("PreToolUse", "antigravity", agy({ FilePath: "/etc/passwd" }));
    expect(registered()).toBe(true);
  });

  it("a pause lifts it when every Cloud policy only observes", async () => {
    pause();
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([{ ...CLOUD, effect: "observe" }] as never);
    await evaluateHookEvent("PreToolUse", "antigravity", agy({ FilePath: "/etc/passwd" }));
    expect(registered()).toBe(false);
  });
});

describe("antigravityPathGuardActive", () => {
  it.each([
    [false, [], true],
    [false, [{ effect: "observe" }], true],
    [true, [], false],
    [true, [{ effect: "observe" }], false],
    [true, [{}], true],
    [true, [{ effect: "observe" }, { effect: "enforce" }], true],
  ])("paused=%s cloud=%j -> %s", (paused, cloud, want) => {
    expect(antigravityPathGuardActive(paused, cloud)).toBe(want);
  });
});
