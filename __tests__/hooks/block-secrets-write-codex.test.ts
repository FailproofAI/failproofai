// @vitest-environment node
/**
 * Issue #814: Codex apply_patch must hit block-secrets-write.
 *
 * Drives the real evaluateHookEvent path (canonicalize apply_patch → Edit,
 * then policy match + path extraction from tool_input.command). Telemetry and
 * pack reads are isolated; builtins are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/hooks/pack-manifest", () => ({
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
  hasInstalledPacks: vi.fn(() => false),
}));

import { evaluateHookEvent } from "../../src/hooks/handler";

let homeDir: string;
let projectDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "fpai-secrets-write-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fpai-secrets-write-proj-"));
  process.env.FAILPROOFAI_HOME = homeDir;
  mkdirSync(join(homeDir), { recursive: true });
  writeFileSync(
    join(homeDir, "policies-config.json"),
    JSON.stringify({ enabledPolicies: ["block-secrets-write"], customPoliciesEnabled: false }),
  );
});

afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function codexApplyPatch(command: string): string {
  return JSON.stringify({
    session_id: "issue-814",
    cwd: projectDir,
    hook_event_name: "pre_tool_use",
    tool_name: "apply_patch",
    tool_input: { command },
  });
}

describe("block-secrets-write × Codex apply_patch (#814)", () => {
  it("denies apply_patch that adds .ssh/id_rsa (real Codex payload shape)", async () => {
    const result = await evaluateHookEvent(
      "pre_tool_use",
      "codex",
      codexApplyPatch(
        "*** Begin Patch\n*** Add File: .ssh/id_rsa\n+FAKESECRET_test_only\n*** End Patch",
      ),
      { awaitTelemetryFlush: false },
    );
    expect(result.evaluation?.toolName).toBe("Edit");
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.policyName).toBe("failproofai/block-secrets-write");
    expect(result.evaluation?.matchedPolicies).toContain("failproofai/block-secrets-write");
  });

  it("allows apply_patch that only touches a safe path", async () => {
    const result = await evaluateHookEvent(
      "pre_tool_use",
      "codex",
      codexApplyPatch(
        "*** Begin Patch\n*** Add File: src/safe.ts\n+export const ok = 1;\n*** End Patch",
      ),
      { awaitTelemetryFlush: false },
    );
    expect(result.evaluation?.toolName).toBe("Edit");
    expect(result.evaluation?.decision).toBe("allow");
    expect(result.evaluation?.policyName).not.toBe("failproofai/block-secrets-write");
  });

  it("denies multi-file apply_patch when a protected path follows a safe path", async () => {
    const result = await evaluateHookEvent(
      "pre_tool_use",
      "codex",
      codexApplyPatch(
        [
          "*** Begin Patch",
          "*** Add File: src/safe.ts",
          "+export const ok = 1;",
          "*** Add File: .ssh/id_rsa",
          "+FAKESECRET_test_only",
          "*** End Patch",
        ].join("\n"),
      ),
      { awaitTelemetryFlush: false },
    );
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.policyName).toBe("failproofai/block-secrets-write");
  });
});
