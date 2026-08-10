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
  const deploymentDir = join(root, "deployments", "12");
  mkdirSync(deploymentDir, { recursive: true });
  const policyPath = join(deploymentDir, "guard.mjs");
  writeFileSync(policyPath, policyBytes);
  writeFileSync(
    join(root, "active.json"),
    JSON.stringify({
      schemaVersion: 2,
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


describe("a manifest written BEFORE the rename", () => {
  // The reader accepts schemaVersion 1 so a pre-rename beta daemon's active.json
  // still parses. That acceptance was unreachable: it read only the v2 field
  // names, so every genuine v1 file threw "active manifest deployment is
  // invalid" — the daemon reconciling happily while the hook path alone refused,
  // which is the exact drift this module's header warns about.
  //
  // These bytes are the real v1 spelling, matching the fixture the Rust test
  // `active_json_written_before_the_rename_still_parses` uses.
  const seedV1 = () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-cloud-v1-"));
    roots.push(root);
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = root;
    const bytes = "export default {};\n";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = join(root, "generations", "1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guard.mjs"), bytes);
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation: 7,
        policies: [{ id: "guard", revision: 3, sha256, path: "generations/1/guard.mjs" }],
      }),
    );
    return sha256;
  };

  it("parses, instead of throwing on the field names it was accepted for", () => {
    seedV1();
    const active = readActiveCloudManagedPolicies();
    expect(active).toHaveLength(1);
    expect(active[0].deployment).toBe(7);
    expect(active[0].version).toBe(3);
  });

  it("prefers the new names when a manifest carries both", () => {
    const root = mkdtempSync(join(tmpdir(), "fpai-cloud-both-"));
    roots.push(root);
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = root;
    const bytes = "export default {};\n";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(root, "deployments", "9"), { recursive: true });
    writeFileSync(join(root, "deployments", "9", "guard.mjs"), bytes);
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        generation: 1,
        deployment: 9,
        policies: [
          { id: "guard", revision: 1, version: 4, sha256, path: "deployments/9/guard.mjs" },
        ],
      }),
    );
    const active = readActiveCloudManagedPolicies();
    expect(active[0].deployment).toBe(9);
    expect(active[0].version).toBe(4);
  });
});
