/**
 * Reads the daemon-owned active cloud policy deployment for the TypeScript
 * evaluator. The Rust reconciler is responsible for downloading and repairing
 * artifacts; this boundary independently verifies the digest immediately
 * before import so the worker never knowingly executes modified bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cloudPoliciesDir } from "./fp-home";
import { hookLogWarn } from "./hook-logger";
import { authorityFieldsOf, SEMANTIC_REVIEWER_NAMES } from "./policy-authority";
import type { PolicyAuthority } from "./policy-types";
// A cycle (pack-manifest imports `resolveManagedPath` from here), and a safe
// one: neither module touches the other's exports while it is being evaluated,
// only inside functions. It is the price of the contract's one rule for this
// file — a Cloud Jev declaration is parsed by THE SAME function a pack manifest's
// semantic entries are, never by a second parser that could drift from it.
import { parsePackSemantic, type SemanticManifestEntry } from "./pack-manifest";

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
 * Removes `active.json` only — the manifest that says which deployment is
 * live. The deployment directories and content-addressed artifacts are left
 * alone: they are large, hash-verified on use, and inert once nothing points
 * at them, so keeping them makes a reconnect cheap and offline-safe.
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
  // The error reports go with it: they describe a deployment this machine no
  // longer has, and a reconnect (possibly to another organisation) must not
  // open by reporting the old one's problems. Cloud Jev policies and the Cloud
  // Jev mode live IN active.json, so removing it clears them too.
  for (const name of [CLOUD_POLICY_ERRORS_FILE, DAEMON_POLICY_ERRORS_FILE]) {
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

/** The CLI's error report, beside `active.json`. See `cloud-policy-errors.ts`. */
export const CLOUD_POLICY_ERRORS_FILE = "errors.json";
/** The daemon's own reconcile error state (`PolicyStore::daemon_errors_path`). */
export const DAEMON_POLICY_ERRORS_FILE = "daemon-errors.json";

// ── FailproofAI Cloud Jev policies ───────────────────────────────────────────
//
// A Cloud policy of kind `jev` or `both` carries Jev checks: a JSON array of
// pack-manifest semantic declarations, which the daemon places at
// `artifacts/<sha>.json` and names in `active.json` `semanticPolicies`. They
// arrive in the same atomic write as the JS policies, so a `both` policy's
// regex half and the checks that review it are live together or not at all.
//
// Read FAIL-OPEN, per entry, like a pack's semantic entries and unlike the JS
// reader above: a Jev check is what CLEARS a reviewable regex verdict, so losing
// one leaves the regex deny standing — noisier, never weaker — and one bad
// artifact must not take the rest of the deployment's checks with it. Every
// drop is logged once and returned as an error for `errors.json`.

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

/**
 * One deployed Cloud Jev policy, shaped like a pack so everything that consumes
 * packs' semantic sets — the reviewer set, the question set, the contest, the
 * budget — takes it unchanged.
 */
export interface CloudSemanticPolicySet {
  /** `cloud:<id>`: pack-shaped, and never a valid pack id, so the two cannot collide. */
  id: string;
  /** Pack-shaped: the Cloud version as a string. */
  version: string;
  /**
   * `cloud:<id>@<version>`. NOT first-party (`isFirstPartyPack` wants
   * `github:FailproofAI/`), so FailproofAI's sixteen reserved check names are
   * void here exactly as for any other pack.
   */
  source: string;
  /** Always `enforce`: an observe rollout of Jev is the Jev MODE, not an effect. */
  effect: "enforce";
  /** Every agent. */
  clis: null;
  semantic: SemanticManifestEntry[];
  /** The Cloud policy id and version, for attribution and error reports. */
  policyId: string;
  policyVersion: number;
  /** `both` when the same id also deployed a JS half, else `jev`. */
  kind: "jev" | "both";
  sha256: string;
  deployment: number;
}

export interface CloudJevRead {
  sets: CloudSemanticPolicySet[];
  /** Every policy id `semanticPolicies` names, loaded or not — what makes a JS policy `both`. */
  semanticIds: string[];
  /** Cloud's Jev mode override, or null when Cloud does not set one. */
  jevMode: CloudJevMode | null;
  errors: CloudPolicyError[];
}

const EMPTY_CLOUD_JEV: CloudJevRead = { sets: [], semanticIds: [], jevMode: null, errors: [] };
const warnedCloudJev = new Set<string>();

function warnCloudJevOnce(message: string): void {
  if (warnedCloudJev.has(message)) return;
  warnedCloudJev.add(message);
  hookLogWarn(message);
}

/** Forget which warnings were already said. Tests only. */
export function _resetCloudJevWarningsForTest(): void {
  warnedCloudJev.clear();
}

function parseCloudJevMode(raw: unknown): CloudJevMode | null {
  return raw === "off" || raw === "observe" || raw === "enforce" ? raw : null;
}

/** `active.json` as untyped JSON, schema-checked, or null when there is none. Throws on a bad one. */
function readActiveRaw(): Record<string, unknown> | null {
  const activePath = resolve(cloudManagedPolicyRoot(), "active.json");
  if (!existsSync(activePath)) return null;
  const raw: unknown = JSON.parse(readFileSync(activePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("active manifest is not an object");
  const record = raw as Record<string, unknown>;
  if (!ACCEPTED_ACTIVE_SCHEMA_VERSIONS.includes(record.schemaVersion as number)) {
    throw new Error(`unsupported active manifest schema ${String(record.schemaVersion)}`);
  }
  return record;
}

/**
 * Cloud's Jev mode override from `active.json`, or null — no deployment, no
 * override, or a file that cannot be read (which is then simply not an
 * override: the local `jev.json` decides, as it does on a machine Cloud never
 * touched). Cheap and never throws: `readJevConfig` asks on every gate event.
 */
export function readCloudJevMode(): CloudJevMode | null {
  try {
    return parseCloudJevMode(readActiveRaw()?.jevMode);
  } catch {
    return null;
  }
}

/**
 * The Cloud Jev policies `active.json` names, each artifact read, SHA-256
 * verified and parsed with the pack manifest's own semantic parser. Never
 * throws; see the section note for what a failure costs.
 */
export function readCloudJevPolicies(): CloudJevRead {
  let active: Record<string, unknown> | null;
  try {
    active = readActiveRaw();
  } catch {
    // The JS reader reports an unreadable manifest itself (and the handler files
    // it); saying it twice would be one problem reported as two.
    return EMPTY_CLOUD_JEV;
  }
  if (!active) return EMPTY_CLOUD_JEV;

  const errors: CloudPolicyError[] = [];
  const rawMode = active.jevMode;
  const jevMode = parseCloudJevMode(rawMode);
  if (rawMode !== undefined && rawMode !== null && jevMode === null) {
    // The daemon refuses such a state, so this is a hand-edited or foreign file.
    errors.push({ id: "jevMode", version: null, kind: "daemon", message: `unknown Jev mode ${JSON.stringify(rawMode)} ignored` });
  }
  const deployment = typeof active.deployment === "number" ? active.deployment : 0;
  const jsIds = new Set(
    Array.isArray(active.policies)
      ? active.policies.flatMap((p) => (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string" ? [(p as { id: string }).id] : []))
      : [],
  );
  const entries = active.semanticPolicies;
  if (entries === undefined) return { sets: [], semanticIds: [], jevMode, errors };
  if (!Array.isArray(entries)) {
    errors.push({ id: "semanticPolicies", version: null, kind: "daemon", message: "active manifest semanticPolicies is not an array" });
    return { sets: [], semanticIds: [], jevMode, errors };
  }
  const semanticIds = entries.flatMap((e) =>
    e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" ? [(e as { id: string }).id] : [],
  );

  const root = cloudManagedPolicyRoot();
  const sets: CloudSemanticPolicySet[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : String(entry.id);
    const version = Number.isSafeInteger(entry.version) && (entry.version as number) >= 0 ? (entry.version as number) : null;
    const kind: "jev" | "both" = jsIds.has(id) ? "both" : "jev";
    const fail = (message: string): void => {
      warnCloudJevOnce(`FailproofAI Cloud Jev policy ${id}${version === null ? "" : `@${version}`}: ${message}`);
      errors.push({ id, version, kind, message });
    };
    try {
      if (!POLICY_ID_RE.test(id) || id === "." || id === "..") throw new Error(`unsafe policy id ${JSON.stringify(entry.id)}`);
      if (version === null) throw new Error("invalid version");
      if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) throw new Error("invalid SHA-256");
      if (seen.has(id)) throw new Error("duplicate semantic policy id");
      seen.add(id);
      const path = resolveManagedPath(root, typeof entry.path === "string" ? entry.path : "");
      const bytes = readFileSync(path);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== entry.sha256) {
        throw new Error(`failed integrity verification: expected ${entry.sha256}, got ${actual}`);
      }
      let declarations: unknown;
      try {
        declarations = JSON.parse(bytes.toString("utf8"));
      } catch (err) {
        throw new Error(`artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(declarations)) throw new Error("artifact is not a JSON array of Jev declarations");

      const source = `cloud:${id}@${version}`;
      const dropped: string[] = [];
      // THE manifest parser: the same per-entry rules, the same 24-entry cap and
      // the same duplicate-name refusal a pack's `semantic` gets.
      const semantic = parsePackSemantic(source, declarations, dropped);
      for (const reason of dropped) fail(`declaration dropped: ${reason}`);
      for (const decl of semantic) {
        // Kept (the unchanged reserved-name rule voids it downstream, exactly as
        // for any pack that is not FailproofAI's) and reported, so the org sees
        // why a check it deployed is never asked.
        if (SEMANTIC_REVIEWER_NAMES.has(decl.name)) {
          fail(`${decl.name} is a name reserved for FailproofAI's own Jev checks, so it is never asked here`);
        }
      }
      sets.push({
        id: `cloud:${id}`,
        version: String(version),
        source,
        effect: "enforce",
        clis: null,
        semantic,
        policyId: id,
        policyVersion: version,
        kind,
        sha256: entry.sha256,
        deployment,
      });
    } catch (err) {
      fail(`not loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { sets, semanticIds, jevMode, errors };
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
