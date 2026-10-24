// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforcingPolicyCount, listHooks, notEnforcingReason } from "../../src/hooks/manager";

const ARTIFACT = "throw new Error('status must not import Cloud policy code');\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

describe("manager Cloud Jev enforcement status", () => {
  let home: string;
  let project: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fpai-manager-jev-home-"));
    project = mkdtempSync(join(tmpdir(), "fpai-manager-jev-project-"));
    root = join(home, "cloud-policies");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("FAILPROOFAI_HOME", home);
    vi.stubEnv("FAILPROOFAI_PACK_DIR", join(home, "packs"));
    vi.stubEnv("FAILPROOFAI_CLOUD_POLICY_DIR", root);
    mkdirSync(join(root, "artifacts"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "*",
          hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }],
        }],
      },
    }));
    writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true });
  });

  function deploy(
    jevMode: string | null,
    jevPolicies: unknown,
    policies: Array<{ id: string; effect: "enforce" | "observe" }> = [],
  ): void {
    writeFileSync(join(root, "active.json"), JSON.stringify({
      schemaVersion: 3,
      deployment: 12,
      jevMode,
      jevPolicies,
      policies: policies.map((policy) => ({
        ...policy, version: 1, sha256: DIGEST, path: `artifacts/${DIGEST}.mjs`,
      })),
    }));
  }

  function expectStatus(reason: "no-hooks" | "no-policies" | "observe-only" | null, count: number): void {
    expect(notEnforcingReason(project)).toBe(reason);
    expect(enforcingPolicyCount(project)).toEqual({ count, custom: false });
  }

  it("counts enforce Jev-only assignments, including scoped and default-effect assignments", () => {
    deploy("enforce", [
      { id: "jev-only", version: 1, effect: "enforce" },
      { id: "scoped-jev", version: 2, agentTargets: [{ integration: "codex" }] },
      { id: "watch-jev", version: 1, effect: "observe" },
    ]);
    expectStatus(null, 2);
  });

  it("keeps observe-effect Jev-only assignments watching in enforce mode", () => {
    deploy("enforce", [{ id: "watch-jev", version: 1, effect: "observe" }]);
    expectStatus("observe-only", 0);
  });

  it.each(["enforce", "observe"] as const)("watches Jev-only assignments in observe mode regardless of %s effect", (effect) => {
    deploy("observe", [{ id: "jev-only", version: 1, effect }]);
    expectStatus("observe-only", 0);
  });

  it.each(["enforce", "observe"] as const)("neither enforces nor watches a Jev-only %s assignment when off", (effect) => {
    deploy("off", [{ id: "jev-only", version: 1, effect }]);
    expectStatus("no-policies", 0);
  });

  it.each([null, "future-mode"])("does not infer Jev enforcement from mode %s", (mode) => {
    deploy(mode, [{ id: "jev-only", version: 1, effect: "enforce" }]);
    expectStatus("no-policies", 0);
  });

  it.each(["off", "observe", "enforce"])("counts both policies once and keeps JS enforcement independent of mode %s", (mode) => {
    deploy(mode, [
      { id: "both", version: 1, effect: "enforce" },
      { id: "jev-only", version: 1, effect: "enforce" },
    ], [{ id: "both", effect: "enforce" }]);
    expectStatus(null, mode === "enforce" ? 2 : 1);
  });

  it("does not upgrade an observe JS policy through a duplicate Jev ID", () => {
    deploy("enforce", [{ id: "both", version: 1, effect: "enforce" }], [{ id: "both", effect: "observe" }]);
    expectStatus("observe-only", 0);
  });

  it.each([undefined, [], [{ id: "invalid id", version: 1 }]])("counts no Jev policies for an absent, empty or unreadable assignment list %#", (assignments) => {
    deploy("enforce", assignments);
    expectStatus("no-policies", 0);
  });

  it("still requires wired hooks for Jev-only enforcement", () => {
    deploy("enforce", [{ id: "jev-only", version: 1, effect: "enforce" }]);
    rmSync(join(home, ".claude", "settings.json"));
    expectStatus("no-hooks", 1);
  });

  it.each([
    ["enforce", false],
    ["observe", true],
    ["off", true],
  ] as const)("keeps the policies screen warning consistent in mode %s", async (mode, warning) => {
    deploy(mode, [{ id: "jev-only", version: 1, effect: "enforce" }]);
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    await listHooks(project);
    const text = output.join("").replace(/\x1B\[[0-9;]*m/g, "");
    expect(text).toContain("jev-only");
    expect(text.includes("Policies are not enforcing yet.")).toBe(warning);
  });
});
