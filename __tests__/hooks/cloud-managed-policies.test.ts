// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearActiveCloudManagedPolicies,
  readActiveCloudManagedPolicies,
} from "../../src/hooks/cloud-managed-policies";

const roots: string[] = [];

function fixture(policyBytes = Buffer.from("export default 'managed';\n")) {
  const root = mkdtempSync(join(tmpdir(), "fpai-cloud-managed-test-"));
  roots.push(root);
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = root;
  const sha256 = createHash("sha256").update(policyBytes).digest("hex");
  const generationDir = join(root, "deployments", "12");
  mkdirSync(generationDir, { recursive: true });
  const policyPath = join(generationDir, "guard.mjs");
  writeFileSync(policyPath, policyBytes);
  writeFileSync(
    join(root, "active.json"),
    JSON.stringify({
      schemaVersion: 1,
      deployment: 12,
      policies: [{ id: "guard", version: 3, sha256, path: "deployments/12/guard.mjs" }],
    }),
  );
  return { root, policyPath, sha256 };
}

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_POLICY_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloud-managed policy active deployment", () => {
  it("returns only hash-verified artifacts from active.json", () => {
    const { policyPath, sha256 } = fixture();
    expect(readActiveCloudManagedPolicies()).toEqual([
      // `effect` defaults to enforce: a manifest written before observe mode
      // existed must not silently downgrade a machine to observation.
      { id: "guard", version: 3, sha256, path: policyPath, deployment: 12, effect: "enforce" },
    ]);
  });

  it("returns an empty set when no cloud deployment is active", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-cloud-managed-empty-"));
    roots.push(root);
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = root;
    expect(readActiveCloudManagedPolicies()).toEqual([]);
  });

  it("rejects modified policy bytes", () => {
    const { policyPath } = fixture();
    writeFileSync(policyPath, "tampered");
    expect(() => readActiveCloudManagedPolicies()).toThrow(/failed integrity verification/);
  });

  it("rejects paths and symlinks escaping the managed root", () => {
    const { root, sha256 } = fixture();
    const outside = join(tmpdir(), `fpai-cloud-managed-outside-${process.pid}.mjs`);
    writeFileSync(outside, "export default 'managed';\n");
    const link = join(root, "deployments", "12", "escape.mjs");
    symlinkSync(outside, link);
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        deployment: 12,
        policies: [{ id: "guard", version: 3, sha256, path: "deployments/12/escape.mjs" }],
      }),
    );
    try {
      expect(() => readActiveCloudManagedPolicies()).toThrow(/symlink escapes/);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("policy effect", () => {
  it("reads an explicit observe effect", () => {
    const { root, policyPath, sha256 } = fixture();
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        deployment: 12,
        policies: [{ id: "guard", version: 3, sha256, path: "deployments/12/guard.mjs", effect: "observe" }],
      }),
    );
    expect(readActiveCloudManagedPolicies()[0]).toMatchObject({ path: policyPath, effect: "observe" });
  });

  it("refuses a manifest whose effect it cannot interpret", () => {
    // Guessing means either enforcing something meant to be watched, or
    // watching something meant to be enforced. Both are worse than refusing.
    const { root, sha256 } = fixture();
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        deployment: 12,
        policies: [{ id: "guard", version: 3, sha256, path: "deployments/12/guard.mjs", effect: "sometimes" }],
      }),
    );
    expect(() => readActiveCloudManagedPolicies()).toThrow(/unknown effect/);
  });
});

describe("clearActiveCloudManagedPolicies", () => {
  it("stops enforcement while leaving the verified artifacts on disk", () => {
    // `--disconnect` cleared the credential, which ends POLLING. Every artifact
    // already on disk stayed referenced by active.json and kept being loaded on
    // every tool call — so a machine that had deliberately left its
    // organisation went on being governed by whatever deployment was current
    // when it left, indefinitely, while `--status` called it unconnected.
    const { policyPath } = fixture();
    expect(readActiveCloudManagedPolicies()).toHaveLength(1);

    expect(clearActiveCloudManagedPolicies()).toBe(true);

    expect(readActiveCloudManagedPolicies()).toEqual([]);
    // The artifacts themselves stay: large, hash-verified on use, and inert
    // once nothing points at them — so a reconnect is cheap and works offline.
    expect(existsSync(policyPath)).toBe(true);
  });

  it("reports nothing removed when no deployment was active", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-cloud-managed-clear-"));
    roots.push(root);
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = root;
    expect(clearActiveCloudManagedPolicies()).toBe(false);
  });
});

