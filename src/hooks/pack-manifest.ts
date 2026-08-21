/**
 * Reads the installed policy packs a machine has on disk.
 *
 * A pack is the delivery unit for policies that did not ship compiled into this
 * build: `failproofai pack add` writes the artifact and records it here, and the
 * loader imports it through the same path custom policies already use.
 *
 * ## Why this is not `cloud-managed-policies.ts`
 *
 * It is modelled on it closely — same content-addressed artifacts, same
 * verify-immediately-before-import boundary, same shared `resolveManagedPath`.
 * Three things differ, each for a reason:
 *
 * - **Failure is PER PACK, not per manifest.** The cloud reader throws on the
 *   first bad entry, which is right for a fleet deployment: a manifest the
 *   server sent is one unit and half of it is not a deployment. Packs come from
 *   unrelated publishers, so one malformed third-party pack must not switch off
 *   every other pack on the machine.
 * - **It never throws.** A caller gets `{packs, errors}`. See the fail-open note
 *   below — it is a load-bearing assumption, not a convenience.
 * - **Two refusals cloud does not need**, both closing silent failures:
 *   a pack may not claim `alwaysOn`, and a pack policy name may not contain `/`.
 *
 * ## Fail-open, and the condition that makes it sound
 *
 * An unreadable manifest, a bad digest or a corrupt artifact yields zero packs
 * and a recorded error — it does not deny. That is only defensible **while the
 * builtin policies still ship compiled into the package and keep enforcing
 * underneath**. The day builtins become a fetched pack, this exact behaviour
 * becomes "zero enforcement on a machine reporting healthy", and this comment is
 * the reason that must be revisited rather than inherited.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packsDir, packsInstalledFile } from "./fp-home";
import { resolveManagedPath } from "./cloud-managed-policies";
import type { PolicyCatalogEntry } from "./policy-types";
import type { PolicyEffect } from "./cloud-managed-policies";

/** Manifest schemas this reader accepts. */
const ACCEPTED_PACK_SCHEMA_VERSIONS: readonly number[] = [1];

const SHA256_RE = /^[a-f0-9]{64}$/;
/** `<publisher>/<name>`, the shape a marketplace id takes. */
const PACK_ID_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/;
/** A version string, kept loose enough for semver and a tag. */
const PACK_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/**
 * A pack policy's own name. `/` is REFUSED, and that is the important character:
 * `normalizePolicyName` passes any name containing one straight through, and
 * `registerPolicy` REPLACES by canonical name — so a pack shipping a policy
 * literally called `failproofai/block-sudo` would silently overwrite the
 * compiled builtin with its own code. Names here are prefixed by the loader
 * instead, which is what keeps a pack unable to reach the builtin namespace.
 */
const PACK_POLICY_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface InstalledPackRecord {
  id: string;
  version: string;
  /** Where it came from, verbatim, e.g. `github:acme/pack@v2.1.0`. */
  source: string;
  /** Path to the single entry artifact, relative to `packsDir()`. */
  entry: string;
  sha256: string;
  effect?: string;
  policies?: unknown;
  /**
   * Which of the pack's policies to register. Absent means ALL of them.
   *
   * Stored here rather than as `disabledCustomPolicies` entries because those
   * are keyed by `pack:<id>@<version>:<name>` — so an upgrade to a new version
   * stops matching and everything the user opted out of silently comes back on.
   * A choice about what to take from a pack has to outlive the version it was
   * made against.
   */
  enabled?: string[];
}

export interface ResolvedPack {
  id: string;
  version: string;
  source: string;
  /** Absolute, real, verified-to-be-inside-the-root path to the entry module. */
  path: string;
  sha256: string;
  effect: PolicyEffect;
  /** The pack's own catalog, in declared order. */
  policies: PolicyCatalogEntry[];
  /** Selected policy names, or null when the user took the whole pack. */
  enabled: string[] | null;
}

export interface PackError {
  /** The pack's id when it was readable enough to have one. */
  id: string | null;
  reason: string;
}

export interface PackReadResult {
  packs: ResolvedPack[];
  /** Every pack that was declared and refused, and why. Never silently dropped. */
  errors: PackError[];
}

export function packsRoot(): string {
  return process.env.FAILPROOFAI_PACK_DIR ?? packsDir();
}

function installedFilePath(): string {
  return process.env.FAILPROOFAI_PACK_DIR
    ? resolve(process.env.FAILPROOFAI_PACK_DIR, "installed.json")
    : packsInstalledFile();
}

/** Validate one serialized catalog entry carried by a pack. */
export function parsePackPolicy(packId: string, value: unknown, index: number): PolicyCatalogEntry {
  const where = `${packId} policy #${index}`;
  if (!value || typeof value !== "object") throw new Error(`${where} is not an object`);
  const raw = value as Record<string, unknown>;

  const name = raw.name;
  if (typeof name !== "string" || !PACK_POLICY_NAME_RE.test(name)) {
    throw new Error(`${where} has an unsafe name ${JSON.stringify(name)}`);
  }
  if ("alwaysOn" in raw) {
    // `alwaysOn` means "registers regardless of the enabled set, and cannot be
    // disabled or paused". It is reserved for the guard that stops an agent
    // switching failproofai off, which ships compiled in. A pack granting it to
    // itself would be a downloaded file that no local command can turn off.
    throw new Error(`${where} declares alwaysOn, which packs may not set`);
  }
  if (typeof raw.description !== "string" || raw.description.length === 0) {
    throw new Error(`${where} is missing a description`);
  }
  if (typeof raw.category !== "string" || raw.category.length === 0) {
    throw new Error(`${where} is missing a category`);
  }
  if (typeof raw.defaultEnabled !== "boolean") {
    throw new Error(`${where} is missing defaultEnabled`);
  }
  if (!raw.match || typeof raw.match !== "object") {
    throw new Error(`${where} is missing a match`);
  }
  return raw as unknown as PolicyCatalogEntry;
}

function parsePack(root: string, value: unknown): ResolvedPack {
  if (!value || typeof value !== "object") throw new Error("pack entry is not an object");
  const raw = value as InstalledPackRecord;

  if (typeof raw.id !== "string" || !PACK_ID_RE.test(raw.id)) {
    throw new Error(`unsafe pack id ${JSON.stringify(raw.id)}`);
  }
  if (typeof raw.version !== "string" || !PACK_VERSION_RE.test(raw.version)) {
    throw new Error(`invalid version for pack ${raw.id}`);
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(`pack ${raw.id} has no source`);
  }
  if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) {
    throw new Error(`invalid SHA-256 for pack ${raw.id}`);
  }
  if (raw.effect !== undefined && raw.effect !== "enforce" && raw.effect !== "observe") {
    // Same reasoning as cloud: guessing means either enforcing what was not
    // asked for, or observing what was meant to enforce.
    throw new Error(`unknown effect ${JSON.stringify(raw.effect)} for pack ${raw.id}`);
  }

  const path = resolveManagedPath(root, raw.entry);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== raw.sha256) {
    throw new Error(
      `pack ${raw.id} failed integrity verification: expected ${raw.sha256}, got ${actual}`,
    );
  }

  if (!Array.isArray(raw.policies)) throw new Error(`pack ${raw.id} policies is not an array`);
  const policies = raw.policies.map((p, i) => parsePackPolicy(raw.id, p, i));
  const names = new Set<string>();
  for (const p of policies) {
    if (names.has(p.name)) throw new Error(`pack ${raw.id} declares ${p.name} twice`);
    names.add(p.name);
  }

  let enabled: string[] | null = null;
  if (raw.enabled !== undefined) {
    if (!Array.isArray(raw.enabled) || raw.enabled.some((n) => typeof n !== "string")) {
      throw new Error(`pack ${raw.id} enabled is not an array of names`);
    }
    // A name here that the pack no longer declares is not an error — a publisher
    // may have removed a policy between versions — but it must not silently
    // become "select nothing", so unknown names are simply dropped.
    enabled = raw.enabled.filter((n) => names.has(n));
  }

  return {
    id: raw.id,
    version: raw.version,
    source: raw.source,
    path,
    sha256: raw.sha256,
    effect: (raw.effect as PolicyEffect | undefined) ?? "enforce",
    policies,
    enabled,
  };
}

/**
 * Read every installed pack, verifying each artifact's digest immediately before
 * its path is handed to a caller that will import it.
 *
 * Never throws. A pack that fails any check is omitted and recorded in `errors`;
 * a manifest that cannot be read at all yields no packs and one error.
 */
export function readInstalledPacks(): PackReadResult {
  const manifestPath = installedFilePath();
  if (!existsSync(manifestPath)) return { packs: [], errors: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      packs: [],
      errors: [{ id: null, reason: `unreadable pack manifest: ${errText(err)}` }],
    };
  }
  if (!raw || typeof raw !== "object") {
    return { packs: [], errors: [{ id: null, reason: "pack manifest is not an object" }] };
  }
  const manifest = raw as { schemaVersion?: unknown; packs?: unknown };
  if (!ACCEPTED_PACK_SCHEMA_VERSIONS.includes(manifest.schemaVersion as number)) {
    return {
      packs: [],
      errors: [
        {
          id: null,
          reason:
            `unsupported pack manifest schema ${String(manifest.schemaVersion)} ` +
            `(supported: ${ACCEPTED_PACK_SCHEMA_VERSIONS.join(", ")})`,
        },
      ],
    };
  }
  if (!Array.isArray(manifest.packs)) {
    return { packs: [], errors: [{ id: null, reason: "pack manifest packs is not an array" }] };
  }

  const root = packsRoot();
  const packs: ResolvedPack[] = [];
  const errors: PackError[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.packs) {
    const declaredId =
      entry && typeof entry === "object" && typeof (entry as InstalledPackRecord).id === "string"
        ? (entry as InstalledPackRecord).id
        : null;
    try {
      const pack = parsePack(root, entry);
      if (seen.has(pack.id)) throw new Error(`duplicate pack id ${pack.id}`);
      seen.add(pack.id);
      packs.push(pack);
    } catch (err) {
      errors.push({ id: declaredId, reason: errText(err) });
    }
  }
  return { packs, errors };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
