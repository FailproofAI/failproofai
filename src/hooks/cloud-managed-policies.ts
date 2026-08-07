/**
 * Reads the daemon-owned active cloud policy generation for the TypeScript
 * evaluator. The Rust reconciler is responsible for downloading and repairing
 * artifacts; this boundary independently verifies the digest immediately
 * before import so the worker never knowingly executes modified bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cloudPoliciesDir } from "./fp-home";

const ACTIVE_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const POLICY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** What an assignment may do. See PolicyEffect in cloud_policies.rs. */
export type PolicyEffect = "enforce" | "observe";

export interface CloudManagedPolicyArtifact {
  id: string;
  revision: number;
  /**
   * `observe` policies are evaluated exactly like any other and then have their
   * verdict discarded, so a rollout can be measured against real traffic before
   * it can break anyone's work. Absent means `enforce`: the default has to be
   * the one that keeps enforcing, or a manifest written before observe mode
   * would silently downgrade a machine to observation.
   */
  effect: PolicyEffect;
  sha256: string;
  path: string;
  generation: number;
}

interface ActiveManifest {
  schemaVersion: number;
  generation: number;
  policies: Array<{
    id: string;
    revision: number;
    effect?: string;
    sha256: string;
    path: string;
  }>;
}

export function cloudManagedPolicyRoot(): string {
  return (
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR ??
    cloudPoliciesDir()
  );
}

function parseManifest(value: unknown): ActiveManifest {
  if (!value || typeof value !== "object") throw new Error("active manifest is not an object");
  const manifest = value as Partial<ActiveManifest>;
  if (manifest.schemaVersion !== ACTIVE_SCHEMA_VERSION) {
    throw new Error(`unsupported active manifest schema ${String(manifest.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(manifest.generation) || (manifest.generation ?? -1) < 0) {
    throw new Error("active manifest generation is invalid");
  }
  if (!Array.isArray(manifest.policies)) throw new Error("active manifest policies is not an array");
  return manifest as ActiveManifest;
}

function resolveManagedPath(root: string, candidate: string): string {
  if (!candidate || isAbsolute(candidate)) throw new Error(`unsafe managed policy path ${JSON.stringify(candidate)}`);
  const absolute = resolve(root, candidate);
  const lexicalRelative = relative(root, absolute);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new Error(`managed policy path escapes its root: ${JSON.stringify(candidate)}`);
  }

  // Reject a symlinked artifact or generation directory escaping the managed
  // root. The current daemon is same-user, but following an arbitrary path is
  // still unnecessary ambient authority and becomes dangerous if its service
  // identity is hardened later.
  const realRoot = realpathSync(root);
  const realFile = realpathSync(absolute);
  const physicalRelative = relative(realRoot, realFile);
  if (physicalRelative.startsWith("..") || isAbsolute(physicalRelative)) {
    throw new Error(`managed policy symlink escapes its root: ${JSON.stringify(candidate)}`);
  }
  return realFile;
}

/**
 * Stop enforcing cloud-managed policies on this machine.
 *
 * Removes `active.json` only — the manifest that says which generation is
 * live. The generation directories and content-addressed artifacts are left
 * alone: they are large, hash-verified on use, and inert once nothing points
 * at them, so keeping them makes a reconnect cheap and offline-safe.
 *
 * Called by `--disconnect`, which without it did not disconnect. Clearing the
 * credential stops the daemon REFRESHING policy; every artifact already on disk
 * kept being loaded and enforced on every tool call, so a user who had
 * deliberately left their organisation's cloud went on being governed by
 * whatever generation happened to be current when they left — indefinitely,
 * with `--status` reporting the machine as unconnected.
 *
 * Returns true when a manifest was actually removed.
 */
export function clearActiveCloudManagedPolicies(): boolean {
  const activePath = resolve(cloudManagedPolicyRoot(), "active.json");
  if (!existsSync(activePath)) return false;
  try {
    rmSync(activePath, { force: true });
    return true;
  } catch {
    // Best-effort: `--disconnect` still clears the credentials, and reporting
    // a failure to remove one file would obscure that the rest succeeded.
    return false;
  }
}

export function readActiveCloudManagedPolicies(): CloudManagedPolicyArtifact[] {
  const root = cloudManagedPolicyRoot();
  const activePath = resolve(root, "active.json");
  if (!existsSync(activePath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(activePath, "utf8"));
  } catch (err) {
    throw new Error(`failed to read cloud-managed active manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  const manifest = parseManifest(raw);
  const seen = new Set<string>();

  return manifest.policies.map((policy) => {
    if (!POLICY_ID_RE.test(policy.id) || policy.id === "." || policy.id === "..") {
      throw new Error(`unsafe cloud-managed policy id ${JSON.stringify(policy.id)}`);
    }
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0) {
      throw new Error(`invalid revision for cloud-managed policy ${policy.id}`);
    }
    if (!SHA256_RE.test(policy.sha256)) {
      throw new Error(`invalid SHA-256 for cloud-managed policy ${policy.id}`);
    }
    if (seen.has(policy.id)) throw new Error(`duplicate cloud-managed policy id ${policy.id}`);
    seen.add(policy.id);

    const path = resolveManagedPath(root, policy.path);
    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== policy.sha256) {
      throw new Error(
        `cloud-managed policy ${policy.id} failed integrity verification: expected ${policy.sha256}, got ${actual}`,
      );
    }
    if (policy.effect !== undefined && policy.effect !== "enforce" && policy.effect !== "observe") {
      // Guessing would mean either enforcing something cloud did not ask to
      // enforce, or observing something it wanted enforced. Both are worse than
      // refusing the generation.
      throw new Error(`unknown effect ${JSON.stringify(policy.effect)} for cloud-managed policy ${policy.id}`);
    }
    return {
      id: policy.id,
      revision: policy.revision,
      effect: (policy.effect as PolicyEffect | undefined) ?? "enforce",
      sha256: policy.sha256,
      path,
      generation: manifest.generation,
    };
  });
}
