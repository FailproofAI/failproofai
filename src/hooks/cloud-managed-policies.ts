/**
 * Reads the daemon-owned active cloud policy deployment for the TypeScript
 * evaluator. The Rust reconciler is responsible for downloading and repairing
 * artifacts; this boundary independently verifies the digest immediately
 * before import so the worker never knowingly executes modified bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cloudPoliciesDir } from "./fp-home";
import { authorityFieldsOf } from "./policy-authority";
import type { PolicyAuthority } from "./policy-types";

/**
 * Active-manifest schema versions this reader accepts.
 *
 * MUST stay in step with `SUPPORTED_SCHEMA_VERSIONS` in `cloud_policies.rs`,
 * which is what WRITES the file this parses. They are two hand-maintained
 * copies of one contract in two languages, and the failure is silent in the
 * worst direction: the daemon reconciles happily, `active.json` is correct on
 * disk, and only the hook path refuses it — so cloud policy stops being
 * enforced while every other signal says the machine is healthy. Reproduced
 * exactly that way while syncing this with AgentEye#559.
 *
 * 1 is accepted for files a pre-rename beta daemon left behind; 2 is what is
 * written now.
 */
const ACCEPTED_ACTIVE_SCHEMA_VERSIONS: readonly number[] = [1, 2];
const SHA256_RE = /^[a-f0-9]{64}$/;
const POLICY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** What an assignment may do. See PolicyEffect in cloud_policies.rs. */
export type PolicyEffect = "enforce" | "observe";

export interface CloudManagedPolicyArtifact {
  id: string;
  version: number;
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
  deployment: number;
  /**
   * Whether Jev may clear this policy's verdict once it is configured, as the
   * ASSIGNMENT declares it — code inside the artifact cannot grant itself this.
   * Absent means `hard`, which is what keeps Jev from weakening central
   * enforcement by default: a cloud policy is only ever reviewable because
   * whoever deployed it said so. Applies to every hook the artifact registers.
   *
   * Read and validated here; the daemon has to carry it into `active.json`
   * (`ActivePolicy` in `cloud_policies.rs`) before a deployment can set it.
   */
  authority?: PolicyAuthority;
  /** The semantic policies that must all be asked and none answer `deny`; see `authority`. */
  reviewedBy?: string[];
}

interface ActiveManifest {
  schemaVersion: number;
  deployment: number;
  policies: Array<{
    id: string;
    version: number;
    effect?: string;
    sha256: string;
    path: string;
    authority?: unknown;
    reviewedBy?: unknown;
  }>;
}

export function cloudManagedPolicyRoot(): string {
  return (
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR ??
    cloudPoliciesDir()
  );
}

/**
 * A version-1 manifest, in the spelling a pre-rename daemon actually wrote.
 *
 * Accepting schema 1 while reading only the version-2 FIELD NAMES made the
 * acceptance unreachable: every genuine v1 file threw "active manifest
 * deployment is invalid". The Rust reader of this same file handles it with
 * `#[serde(alias = "generation")]` / `#[serde(alias = "revision")]`; this is the
 * TypeScript half of that pair, and it was missing.
 */
interface LegacyActiveManifest {
  generation?: number;
  policies?: Array<{ revision?: number }>;
}

function parseManifest(value: unknown): ActiveManifest {
  if (!value || typeof value !== "object") throw new Error("active manifest is not an object");
  const raw = value as Partial<ActiveManifest> & LegacyActiveManifest;
  if (!ACCEPTED_ACTIVE_SCHEMA_VERSIONS.includes(raw.schemaVersion as number)) {
    throw new Error(
      `unsupported active manifest schema ${String(raw.schemaVersion)} ` +
        `(supported: ${ACCEPTED_ACTIVE_SCHEMA_VERSIONS.join(", ")})`,
    );
  }
  // New name wins; the old one is a fallback, not an equal. A file carrying both
  // (written by a mixed-version machine) must resolve to the current field.
  const deployment = raw.deployment ?? raw.generation;
  if (!Number.isSafeInteger(deployment) || (deployment ?? -1) < 0) {
    throw new Error("active manifest deployment is invalid");
  }
  if (!Array.isArray(raw.policies)) throw new Error("active manifest policies is not an array");
  const policies = raw.policies.map((p) => {
    const entry = p as ActiveManifest["policies"][number] & { revision?: number };
    return { ...entry, version: entry.version ?? entry.revision } as ActiveManifest["policies"][number];
  });
  return { schemaVersion: raw.schemaVersion as number, deployment: deployment as number, policies };
}

/**
 * Shared with `pack-manifest.ts` deliberately. This is a path-escape guard on a
 * file that is about to be IMPORTED; two copies of it would be two things to
 * harden and one to forget.
 */
export function resolveManagedPath(root: string, candidate: string): string {
  if (!candidate || isAbsolute(candidate)) throw new Error(`unsafe managed policy path ${JSON.stringify(candidate)}`);
  const absolute = resolve(root, candidate);
  const lexicalRelative = relative(root, absolute);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new Error(`managed policy path escapes its root: ${JSON.stringify(candidate)}`);
  }

  // Reject a symlinked artifact or deployment directory escaping the managed
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
 * Removes `desired-state.json` FIRST, then `active.json` — the manifest that
 * says which deployment is live — both error reports and the Jev budget record.
 * The content-addressed artifacts are left alone: they are large, hash-verified
 * on use, and inert once nothing points at them, so keeping them makes a
 * reconnect cheap.
 *
 * The snapshot has to go, and before the pointer. It is what the daemon's
 * maintenance lane rebuilds a lost `active.json` from, and it used to be left
 * behind: within one interval of `--disconnect` the old org's JS policies and
 * Jev mode were back, on a machine whose owner had left (the daemon
 * also refuses to rebuild on a machine that is not enrolled now, so neither
 * half alone decides it).
 *
 * Called by `--disconnect`, which without it did not disconnect. Clearing the
 * credential stops the daemon REFRESHING policy; every artifact already on disk
 * kept being loaded and enforced on every tool call, so a user who had
 * deliberately left their organisation's cloud went on being governed by
 * whatever deployment happened to be current when they left — indefinitely,
 * with `--status` reporting the machine as unconnected.
 *
 * Returns true when a manifest was actually removed.
 */
export function clearActiveCloudManagedPolicies(): boolean {
  const root = cloudManagedPolicyRoot();
  // The snapshot first, so nothing can rebuild the pointer from it in between.
  // The error reports go too: they describe a deployment this machine no
  // longer has, and a reconnect (possibly to another organisation) must not
  // open by reporting the old one's problems. The Cloud Jev mode lives IN
  // active.json, so removing it clears that too.
  for (const name of [DESIRED_STATE_FILE, CLOUD_POLICY_ERRORS_FILE, DAEMON_POLICY_ERRORS_FILE, JEV_BUDGET_FILE]) {
    try {
      rmSync(resolve(root, name), { force: true });
    } catch {
      // Best-effort, like the manifest below.
    }
  }
  const activePath = resolve(root, "active.json");
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

/** The daemon's snapshot of the last desired state (`PolicyStore::desired_state_path`). */
export const DESIRED_STATE_FILE = "desired-state.json";
/** The CLI's error report, beside `active.json`. See `cloud-policy-errors.ts`. */
export const CLOUD_POLICY_ERRORS_FILE = "errors.json";
/** The daemon's own reconcile error state (`PolicyStore::daemon_errors_path`). */
export const DAEMON_POLICY_ERRORS_FILE = "daemon-errors.json";
/**
 * Installed packs' Jev checks FailproofAI Cloud dropped from a request for the
 * question budget, kept for the deployment they happened under so the report
 * does not flap with each tool call's selection. See `cloud-policy-errors.ts`.
 */
export const JEV_BUDGET_FILE = "jev-budget.json";

// ── FailproofAI Cloud Jev (CONTRACT C10) ─────────────────────────────────────
//
// Jev policies, and the Jev half of `both` policies, live ONLY on FailproofAI
// Cloud: nothing but the MODE reaches this machine. `active.json` carries
// `jevMode` (`off | observe | enforce`, or absent), and a `both` policy's JS
// half carries `authority: "reviewable"` with `reviewedBy` = the names of its
// own Cloud checks. With `observe`/`enforce` the hook path sends every gated
// tool call to FailproofAI Cloud, which asks the checks deployed to this
// machine and returns their verdict (`semantic/cloud-jev.ts`).

/** The Jev modes Cloud may set. `local` never reaches a machine (stored NULL). */
export type CloudJevMode = "off" | "observe" | "enforce";

/** What `errors.json` reports, one entry per problem (CONTRACT C4/C6). */
export type CloudPolicyErrorKind = "regex" | "jev" | "both" | "daemon";
export interface CloudPolicyError {
  id: string;
  version: number | null;
  kind: CloudPolicyErrorKind;
  message: string;
}

/** What this machine knows about FailproofAI Cloud's Jev: the mode, and nothing else. */
export interface CloudJevState {
  /** Cloud's Jev mode, or null when Cloud does not set one (or there is no deployment). */
  jevMode: CloudJevMode | null;
  /** The deployment `active.json` names, or null without one. */
  deployment: number | null;
  /** A `jevMode` this build cannot read, reported rather than guessed at. */
  errors: CloudPolicyError[];
}

const noCloudJev = (): CloudJevState => ({ jevMode: null, deployment: null, errors: [] });

function parseCloudJevMode(raw: unknown): CloudJevMode | null {
  return raw === "off" || raw === "observe" || raw === "enforce" ? raw : null;
}

/** Whether Cloud's mode sends this machine's gated tool calls to FailproofAI Cloud Jev. */
export function cloudJevAsks(mode: CloudJevMode | null): mode is "observe" | "enforce" {
  return mode === "observe" || mode === "enforce";
}

// ── Read once per change ─────────────────────────────────────────────────────
//
// The hook path asks about this deployment several times per event — the JS
// reader, the reviewer set, the Jev mode — and the warm worker does that on
// every tool call of every session. So `active.json` is parsed once per CHANGE
// of the file, keyed on its identity and version: device, inode, mode, size,
// and modification and change times to the nanosecond.
//
// Sound for this file in particular. The daemon writes it by rename, so a new
// deployment is a new inode, and an edit in place moves the change time, which
// nothing short of the system clock can set back.

/** A file's identity and version, or null when it does not exist. Throws on anything else. */
function fileVersion(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

let activeJsonCache: { path: string; version: string; value: unknown } | null = null;

/**
 * `active.json` parsed, once per change of the file — or `undefined` when
 * there is none (a file holding `null` is a bad manifest, not an absent one).
 * Throws on a file that cannot be read or is not JSON (not cached: the next
 * call tries again). Callers must not mutate what it returns.
 */
function readActiveJson(): unknown {
  const path = resolve(cloudManagedPolicyRoot(), "active.json");
  const version = fileVersion(path);
  if (version === null) {
    activeJsonCache = null;
    return undefined;
  }
  if (activeJsonCache && activeJsonCache.path === path && activeJsonCache.version === version) return activeJsonCache.value;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  activeJsonCache = { path, version, value };
  return value;
}

/** Forget every cached read. Tests only: a test that rewrites a file in place can beat the clock's granularity. */
export function _resetCloudManagedCachesForTest(): void {
  activeJsonCache = null;
}

/** `active.json` as untyped JSON, schema-checked, or null when there is none. Throws on a bad one. */
function readActiveRaw(): Record<string, unknown> | null {
  const raw = readActiveJson();
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("active manifest is not an object");
  const record = raw as Record<string, unknown>;
  if (!ACCEPTED_ACTIVE_SCHEMA_VERSIONS.includes(record.schemaVersion as number)) {
    throw new Error(`unsupported active manifest schema ${String(record.schemaVersion)}`);
  }
  return record;
}

/**
 * Cloud's Jev mode from `active.json`, or null — no deployment, no mode, or a
 * file that cannot be read (which is then simply not a mode: the local
 * `jev.json` decides, as it does on a machine Cloud never touched). Cheap and
 * never throws: the hook path asks on every gate event.
 */
export function readCloudJevMode(): CloudJevMode | null {
  try {
    return parseCloudJevMode(readActiveRaw()?.jevMode);
  } catch {
    return null;
  }
}

/**
 * The Cloud Jev state `active.json` carries: the mode, the deployment it came
 * with, and a report of a mode this build cannot read. Never throws; an
 * unreadable manifest is reported by the JS reader (and the handler files it),
 * so it is not reported twice here.
 */
export function readCloudJevState(): CloudJevState {
  let active: Record<string, unknown> | null;
  try {
    active = readActiveRaw();
  } catch {
    return noCloudJev();
  }
  if (!active) return noCloudJev();
  const rawMode = active.jevMode;
  const jevMode = parseCloudJevMode(rawMode);
  const errors: CloudPolicyError[] = [];
  if (rawMode !== undefined && rawMode !== null && jevMode === null) {
    // The daemon refuses such a state, so this is a hand-edited or foreign file.
    errors.push({ id: "jevMode", version: null, kind: "daemon", message: `unknown Jev mode ${JSON.stringify(rawMode)} ignored` });
  }
  const deployment = Number.isSafeInteger(active.deployment) ? (active.deployment as number) : null;
  return { jevMode, deployment, errors };
}

// ── `both` policies: reviewed by their OWN Cloud checks ─────────────────────

/**
 * The reviewer name a FailproofAI Cloud policy's `reviewedBy` entry stands for
 * on this machine: `cloud:<policyId>/<name>`. Pack check names cannot contain
 * `:` or `/`, so this can never be a pack's check — and the Cloud review files
 * a Cloud check's outcome under the same key (`toReview`, `jev-review.ts`),
 * built from the outcome's own `origin.cloudPolicyId`. So a `both` policy's
 * verdict can be cleared by exactly that policy's Cloud checks and nothing
 * else: never by an installed pack's check of the same name (CONTRACT C10.5,
 * C9.4), never by another Cloud policy's.
 */
export function cloudReviewerName(policyId: string, name: string): string {
  return `cloud:${policyId}/${name}`;
}

/** The authority fields of one Cloud JS assignment, as `active.json` carries them. */
export interface CloudAuthorityInput {
  id: string;
  effect?: PolicyEffect;
  authority?: PolicyAuthority;
  reviewedBy?: string[];
}

/** A name {@link cloudReviewerName} already made (a Jev check name can contain neither `:` nor `/`). */
const CLOUD_REVIEWER_RE = /^cloud:[^/]+\/./;

/**
 * The authority a Cloud JS policy registers with on this machine:
 *
 * - declared `hard` (or nothing): as declared;
 * - an `observe` assignment: `hard`, silently. FailproofAI Cloud does not ask
 *   an observe `both` policy's Jev half (C9.3), and an observe policy blocks
 *   nothing anyway;
 * - Cloud's Jev mode is not `observe`/`enforce`: `hard`, silently. Nothing on
 *   this machine can ask a Cloud check, and that is the org's own choice, so
 *   it is not a warning;
 * - otherwise `reviewable`, by its `reviewedBy` names as {@link cloudReviewerName}s
 *   (a name already translated is kept, so applying this twice is harmless).
 *
 * Pure. The handler applies it to every assignment BEFORE the loader merges
 * two assignments that share one artifact — so each name keeps the policy it
 * came from — and the reviewer set (`effective-reviewers.ts`) and the
 * reviewability survey use it too, so none of them can disagree.
 */
export function cloudAuthorityDeclaration(
  policy: CloudAuthorityInput,
  mode: CloudJevMode | null,
): { authority?: PolicyAuthority; reviewedBy?: string[] } {
  if (policy.authority !== "reviewable") return policy.authority ? { authority: policy.authority } : {};
  if (policy.effect === "observe" || !cloudJevAsks(mode)) return { authority: "hard" };
  return {
    authority: "reviewable",
    reviewedBy: (policy.reviewedBy ?? []).map((n) => (CLOUD_REVIEWER_RE.test(n) ? n : cloudReviewerName(policy.id, n))),
  };
}

/**
 * A Cloud JS assignment as this machine registers it: its `authority` and
 * `reviewedBy` replaced by {@link cloudAuthorityDeclaration}'s. Pure.
 */
export function withCloudAuthority<T extends CloudAuthorityInput>(policy: T, mode: CloudJevMode | null): T {
  const { authority: _authority, reviewedBy: _reviewedBy, ...rest } = policy;
  void _authority;
  void _reviewedBy;
  return { ...rest, ...cloudAuthorityDeclaration(policy, mode) } as T;
}

/**
 * Every reviewer name the deployment's `both` policies may be cleared by on
 * this machine — empty unless Cloud's Jev mode asks. Pure.
 */
export function cloudReviewerNames(policies: ReadonlyArray<CloudAuthorityInput>, mode: CloudJevMode | null): string[] {
  const out: string[] = [];
  for (const policy of policies) {
    const declared = cloudAuthorityDeclaration(policy, mode);
    if (declared.authority === "reviewable") out.push(...(declared.reviewedBy ?? []));
  }
  return out;
}

/**
 * The Cloud JS assignments' authority fields, read off the cached `active.json`
 * parse — no artifact is read or hashed, so this is cheap enough for the
 * reviewer set, which is rebuilt on every event. Never throws: an unreadable
 * manifest has no assignments here (the JS reader reports it).
 */
export function readCloudAuthorityInputs(): CloudAuthorityInput[] {
  try {
    const raw = readActiveJson();
    if (raw === undefined) return [];
    return parseManifest(raw).policies.flatMap((policy) =>
      typeof policy.id === "string"
        ? [
            {
              id: policy.id,
              effect: policy.effect === "observe" ? "observe" : "enforce",
              ...authorityFieldsOf(policy as unknown as Record<string, unknown>),
            } satisfies CloudAuthorityInput,
          ]
        : [],
    );
  } catch {
    return [];
  }
}

export function readActiveCloudManagedPolicies(): CloudManagedPolicyArtifact[] {
  const root = cloudManagedPolicyRoot();

  // Parsed once per change of the file (`readActiveJson`). Each JS artifact is
  // still read and hashed HERE, on every call: the loader imports what this
  // returns, and the digest check is kept immediately before that import.
  let raw: unknown;
  try {
    raw = readActiveJson();
  } catch (err) {
    throw new Error(`failed to read cloud-managed active manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === undefined) return [];
  const manifest = parseManifest(raw);
  const seen = new Set<string>();

  return manifest.policies.map((policy) => {
    if (!POLICY_ID_RE.test(policy.id) || policy.id === "." || policy.id === "..") {
      throw new Error(`unsafe cloud-managed policy id ${JSON.stringify(policy.id)}`);
    }
    if (!Number.isSafeInteger(policy.version) || policy.version < 0) {
      throw new Error(`invalid version for cloud-managed policy ${policy.id}`);
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
      // refusing the deployment.
      throw new Error(`unknown effect ${JSON.stringify(policy.effect)} for cloud-managed policy ${policy.id}`);
    }
    return {
      id: policy.id,
      version: policy.version,
      effect: (policy.effect as PolicyEffect | undefined) ?? "enforce",
      sha256: policy.sha256,
      path,
      deployment: manifest.deployment,
      // Unlike `effect`, a malformed authority is dropped rather than refused:
      // dropping it makes this policy `hard`, the default that keeps enforcing,
      // while refusing would take the whole deployment down over an optional
      // field. Absent stays absent.
      ...authorityFieldsOf(policy as unknown as Record<string, unknown>),
    };
  });
}
