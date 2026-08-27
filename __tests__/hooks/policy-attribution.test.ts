// @vitest-environment node
/**
 * Attribution on the activity row.
 *
 * The design doc's requirement is that FailproofAI Cloud can tie a decision to
 * the exact rollout that produced it. Until now the only trace of a version
 * was a substring of a display name ("cloud/org-guard@7/…"), which nothing can
 * query and which re-parsing our own label would be the only way to read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/hooks/hooks-config", () => ({
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: ["block-sudo"] })),
}));
vi.mock("../../src/hooks/builtin-policies", () => ({ registerBuiltinPolicies: vi.fn() }));
vi.mock("../../src/hooks/policy-registry", () => ({
  clearPolicies: vi.fn(),
  registerPolicy: vi.fn(),
  getPoliciesForEvent: vi.fn(() => []),
}));
vi.mock("../../src/hooks/custom-hooks-loader", () => ({ loadAllCustomHooks: vi.fn() }));
vi.mock("../../src/hooks/cloud-managed-policies", () => ({ readActiveCloudManagedPolicies: vi.fn(() => []) }));
vi.mock("../../src/hooks/hook-activity-store", () => ({ persistHookActivity: vi.fn() }));
vi.mock("../../src/hooks/policy-evaluator", () => ({ evaluatePolicies: vi.fn() }));
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogInfo: vi.fn(), hookLogWarn: vi.fn(), hookLogError: vi.fn(),
}));
vi.mock("../../src/hooks/pack-manifest", () => ({
  // Isolation, not convenience: unmocked, `readInstalledPacks` reads the REAL
  // ~/.failproofai/policies/packs of whoever runs the suite, so these tests would
  // pass on a clean machine and behave differently on one with a pack installed.
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
  // The handler asks this per event to decide whether the migration shim
  // still applies. Mirrors the mocked readInstalledPacks above.
  hasInstalledPacks: vi.fn(() => false),
}));

import { evaluateHookEvent } from "../../src/hooks/handler";
import { loadAllCustomHooks } from "../../src/hooks/custom-hooks-loader";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";
import { persistHookActivity } from "../../src/hooks/hook-activity-store";
import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { registerPolicy } from "../../src/hooks/policy-registry";

const hook = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(
    { name, description: "", match: {}, fn: async () => ({ decision: "allow" }) },
    extra,
  );

const CLOUD = { id: "org-guard", version: 7, sha256: "a".repeat(64), path: "/x.mjs", deployment: 184 };

function decidedBy(policyName: string | null, decision: "allow" | "deny" = "deny") {
  vi.mocked(evaluatePolicies).mockReturnValue({
    exitCode: 0, stdout: "", stderr: "", policyName, reason: null, decision,
  } as never);
}

const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", tool_name: "Bash", tool_input: {} });
const row = () => vi.mocked(persistHookActivity).mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([]);
  vi.mocked(loadAllCustomHooks).mockResolvedValue({ hooks: [], conventionSources: [] } as never);
  decidedBy(null, "allow");
});

describe("policy attribution", () => {
  it("marks a builtin decider as builtin — absence from the map is meaningful", async () => {
    decidedBy("block-sudo");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBe("builtin");
    expect(row().cloudPolicyId).toBeUndefined();
  });

  it("marks a local custom decider", async () => {
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [hook("guard", { __policyId: "custom:/p.mjs:guard" })], conventionSources: [],
    } as never);
    decidedBy("custom/guard");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBe("custom");
  });

  it("marks a convention decider", async () => {
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [hook("guard", { __conventionScope: "project" })], conventionSources: [],
    } as never);
    decidedBy(".failproofai-project/guard");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBe("convention");
  });

  it("attributes a cloud decision to its exact policy id and version", async () => {
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([CLOUD] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [hook("org-guard", { __cloudManaged: CLOUD })], conventionSources: [],
    } as never);
    decidedBy("cloud/org-guard@7/org-guard");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBe("cloud");
    expect(row().cloudPolicyId).toBe("org-guard");
    expect(row().cloudVersion).toBe(7);
    expect(row().cloudDeployment).toBe(184);
  });

  it("records the active deployment even when a LOCAL policy decided", async () => {
    // "What was deployed here" is a different question from "what decided" —
    // and only the former separates a rollout that changed no outcomes from
    // one that never reached the machine.
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([CLOUD] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [hook("local", { __policyId: "custom:/p.mjs:local" })], conventionSources: [],
    } as never);
    decidedBy("custom/local");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBe("custom");
    expect(row().cloudDeployment).toBe(184);
    expect(row().cloudPolicyId).toBeUndefined();
  });

  it("leaves attribution off entirely on a plain allow, where nothing decided", async () => {
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().policySource).toBeUndefined();
    expect(row().cloudVersion).toBeUndefined();
  });

  it("omits the deployment on an unmanaged machine rather than writing 0", async () => {
    // A literal 0 would read as "deployment zero is deployed"; absent reads as
    // "not managed", which is the truth.
    decidedBy("block-sudo");
    await evaluateHookEvent("PreToolUse", "claude", stdin);
    expect(row().cloudDeployment).toBeUndefined();
  });
});

describe("filtering by source", () => {
  it("selects only rows the named source decided, and excludes unattributed ones", async () => {
    const { _resetForTest, persistHookActivity: persist, searchHookActivity } =
      await vi.importActual<typeof import("../../src/hooks/hook-activity-store")>(
        "../../src/hooks/hook-activity-store",
      );
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const dir = mkdtempSync(resolve(tmpdir(), "fpai-attr-"));
    _resetForTest(dir);
    try {
      const base = { eventType: "PreToolUse", toolName: "Bash", reason: null, durationMs: 1 };
      persist({ ...base, timestamp: 1, policyName: "block-sudo", decision: "deny", policySource: "builtin" });
      persist({ ...base, timestamp: 2, policyName: "cloud/org@7/g", decision: "deny", policySource: "cloud" });
      // Written before attribution existed — must not be guessed into a bucket.
      persist({ ...base, timestamp: 3, policyName: "legacy", decision: "deny" });

      const cloud = searchHookActivity({ source: "cloud" }, 1);
      expect(cloud.entries.map((e) => e.policyName)).toEqual(["cloud/org@7/g"]);
      const builtin = searchHookActivity({ source: "builtin" }, 1);
      expect(builtin.entries.map((e) => e.policyName)).toEqual(["block-sudo"]);
      expect(searchHookActivity({}, 1).entries).toHaveLength(3);
    } finally {
      _resetForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("observe mode", () => {
  const OBSERVED = { ...CLOUD, effect: "observe" as const };

  /** The fn the handler actually registered for a given policy name. */
  async function registeredFn(namePart: string) {
    const call = vi.mocked(registerPolicy).mock.calls.find(([n]) => String(n).includes(namePart));
    expect(call, `no policy registered matching ${namePart}`).toBeDefined();
    return call![2] as (ctx: unknown) => Promise<{ decision: string }>;
  }

  it("runs the policy for real but discards its verdict", async () => {
    // Evaluating and discarding IS the feature. A policy that did not actually
    // run would measure nothing about the rollout being trialled.
    let ran = false;
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([OBSERVED] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [{
        name: "org-guard", description: "", match: {},
        fn: async () => { ran = true; return { decision: "deny", reason: "would block" }; },
        __cloudManaged: OBSERVED,
      }],
      conventionSources: [],
    } as never);

    await evaluateHookEvent("PreToolUse", "claude", stdin);
    const result = await (await registeredFn("org-guard"))({});

    expect(ran).toBe(true);
    expect(result.decision).toBe("allow");
  });

  it("still lets an ENFORCING cloud policy act", async () => {
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([CLOUD] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [{
        name: "org-guard", description: "", match: {},
        fn: async () => ({ decision: "deny", reason: "blocked" }),
        __cloudManaged: { ...CLOUD, effect: "enforce" },
      }],
      conventionSources: [],
    } as never);

    await evaluateHookEvent("PreToolUse", "claude", stdin);
    const result = await (await registeredFn("org-guard"))({});
    expect(result.decision).toBe("deny");
  });

  it("records an observed deny as allow when the policy throws", async () => {
    // A policy that times out or throws is an ALLOW in enforce mode, so observe
    // mode must record it as one — not as a would-deny that never was.
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValue([OBSERVED] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [{
        name: "org-guard", description: "", match: {},
        fn: async () => { throw new Error("boom"); },
        __cloudManaged: OBSERVED,
      }],
      conventionSources: [],
    } as never);

    await evaluateHookEvent("PreToolUse", "claude", stdin);
    const result = await (await registeredFn("org-guard"))({});
    expect(result.decision).toBe("allow");
  });
});

describe("pack attribution", () => {
  it("files a pack decision as 'pack', with the pack's id and version", async () => {
    // Without this the row said "custom" — which is also what a user's own local
    // .mjs gets, so the two were indistinguishable unless something re-parsed
    // the `pack/` prefix off our own display name.
    vi.mocked(loadAllCustomHooks).mockResolvedValue({
      hooks: [Object.assign(
        { name: "block-refunds", description: "d", match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "deny", reason: "no" }) },
        { __pack: { id: "acme/finance", version: "1.2.0", effect: "enforce", policies: [], enabled: null, path: "/x", sha256: "s", source: "github:acme/finance@v1.2.0" } },
      )],
      conventionSources: [],
    } as never);
    vi.mocked(evaluatePolicies).mockReturnValue({
      exitCode: 0, stdout: "", stderr: "", decision: "deny",
      policyName: "pack/acme/finance@1.2.0/block-refunds", reason: "no",
    } as never);

    await evaluateHookEvent("PreToolUse", "claude", stdin);

    const written = row();
    expect(written.policySource).toBe("pack");
    expect(written.packId).toBe("acme/finance");
    expect(written.packVersion).toBe("1.2.0");
    expect(written.cloudPolicyId).toBeUndefined();
  });
});
