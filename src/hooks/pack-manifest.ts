/**
 * Reads the installed policy packs a machine has on disk.
 *
 * A pack is the delivery unit for policies that did not ship compiled into this
 * build: `failproofai policies add` writes the artifact and records it here, and the
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
 * and a recorded error — this READER does not deny.
 *
 * That used to be defensible because the builtin policies shipped compiled in
 * and kept enforcing underneath. They no longer do: the builtins ARE a pack now,
 * so a silent zero here would be zero enforcement at exit 0 on a machine that
 * reports healthy — exactly what the comment that stood here warned about.
 *
 * What makes it sound now is that the denying moved rather than disappeared:
 * `pack-failclosed.ts` reads these same `errors` and refuses the events the
 * missing policies declared. So this stays a pure reader that reports what it
 * found, and the layer above decides what a failure means. Do not add a throw
 * here — per-pack isolation is the reason one bad third-party pack cannot
 * switch off every other pack on the machine.
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
export const PACK_ID_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/;
/** A version string, kept loose enough for semver and a tag. */
export const PACK_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/**
 * The git commit a pack was built from — PROVENANCE, and deliberately not the
 * same thing as `sha256`.
 *
 * `sha256` is the digest of the entry artifact: the security pin, re-verified
 * before every import, and the reason a pack cannot change under a machine
 * after it was installed. This answers a different question — WHICH SOURCE
 * produced that artifact — which no digest can, because the digest is of the
 * bundled output and the output names no input.
 *
 * Always optional. A pack published from a directory that is not a git checkout
 * has no commit, and that is a supported way to publish, so every surface that
 * reads this must render its absence rather than treat it as a defect.
 *
 * Abbreviated forms are accepted from 7 characters, which is what `git log`
 * prints and therefore what somebody copying one will have.
 */
export const PACK_COMMIT_RE = /^[0-9a-f]{7,40}$/;
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
  /** The git commit this pack was built from, when its publisher had one. */
  commit?: string;
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
  /**
   * Which agent CLIs this pack guards. Absent means ALL of them.
   *
   * Setup wires hooks into every supported agent, because hooks alone enforce
   * nothing — so "which agents" stopped being a setup question and became a
   * per-pack one, asked where the user is looking at a real list. A team may
   * want its deploy guards on the agent that ships and not on the one used for
   * scratch work, and that is a property of the PACK, not of the machine.
   *
   * Absent rather than "all twelve" for packs installed before this existed:
   * a machine upgrading must not silently narrow what it enforces.
   */
  clis?: string[];
}

export interface ResolvedPack {
  id: string;
  version: string;
  source: string;
  /** Absolute, real, verified-to-be-inside-the-root path to the entry module. */
  path: string;
  sha256: string;
  /** The git commit this pack was built from, when its publisher had one. */
  commit?: string;
  effect: PolicyEffect;
  /** The pack's own catalog, in declared order. */
  policies: PolicyCatalogEntry[];
  /** Selected policy names, or null when the user took the whole pack. */
  enabled: string[] | null;
  /** Agent CLIs this pack guards, or null for all of them. */
  clis: string[] | null;
}

export interface PackError {
  /** The pack's id when it was readable enough to have one. */
  id: string | null;
  reason: string;
  /**
   * The effect the failed pack asked for, when it got far enough to say.
   *
   * Carried because an `observe` pack that fails to load must NOT make the
   * machine deny: an observe pack evaluates and discards by construction, so
   * denying on its behalf denies for something that would have allowed. Effect
   * is validated BEFORE the digest check, so for every failure at or after that
   * point it was already known — and was previously thrown away with the
   * exception.
   */
  effect?: PolicyEffect;
  /**
   * Policy names the entry declared, when it parsed far enough to list them.
   * Lets the deny name what is missing instead of being blanket.
   */
  declared?: PolicyCatalogEntry[];
  /**
   * The agents this pack was scoped to, when the manifest got far enough to say.
   *
   * Carried for the same reason `effect` is. A pack scoped to one CLI that fails
   * to load must not deny on the others: they were never guarded by it, so a
   * deny on their behalf locks an agent out over enforcement it never had.
   */
  clis?: string[] | null;
}

export interface PackReadResult {
  packs: ResolvedPack[];
  /** Every pack that was declared and refused, and why. Never silently dropped. */
  errors: PackError[];
}

export function packsRoot(): string {
  return process.env.FAILPROOFAI_PACK_DIR ?? packsDir();
}

/** Validate the identity fields shared by installed and incoming manifests. */
export function parsePackIdentity(value: {
  id?: unknown;
  version?: unknown;
  effect?: unknown;
  commit?: unknown;
}): { id: string; version: string; effect: PolicyEffect; commit?: string } {
  if (typeof value.id !== "string" || !PACK_ID_RE.test(value.id)) {
    throw new Error(`unsafe pack id ${JSON.stringify(value.id)}`);
  }
  if (typeof value.version !== "string" || !PACK_VERSION_RE.test(value.version)) {
    throw new Error(`invalid version for pack ${value.id}`);
  }
  if (value.effect !== undefined && value.effect !== "enforce" && value.effect !== "observe") {
    throw new Error(`unknown effect ${JSON.stringify(value.effect)} for pack ${value.id}`);
  }
  // Malformed provenance is DROPPED, never fatal. It is a label on the artifact,
  // not part of what makes it safe to run — so a publisher who wrote something
  // odd here gets a pack that installs and simply says nothing about its
  // origin, rather than a pack nobody can install. The digest still decides
  // whether the bytes are the ones that were published.
  const commit =
    typeof value.commit === "string" && PACK_COMMIT_RE.test(value.commit.trim().toLowerCase())
      ? value.commit.trim().toLowerCase()
      : undefined;
  return {
    id: value.id,
    version: value.version,
    effect: (value.effect as PolicyEffect | undefined) ?? "enforce",
    ...(commit ? { commit } : {}),
  };
}

/**
 * Whether this machine has any pack installed at all.
 *
 * Cheap on purpose — the hook path asks this on every event to decide whether it
 * still needs the migration shim, and reading + verifying every artifact digest
 * to answer "is there one" would be the wrong price.
 */
export function hasInstalledPacks(): boolean {
  try {
    const raw = JSON.parse(readFileSync(installedFilePath(), "utf8")) as { packs?: unknown };
    return Array.isArray(raw.packs) && raw.packs.length > 0;
  } catch {
    return false;
  }
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
  // The SHAPE, not just the presence. `match` was accepted as any object, so a
  // manifest declaring `events: "PreToolUse"` installed cleanly and then
  // narrowed the fail-closed deny to the letters of that string — a guard
  // matching no event that exists. Refused at install now, where the publisher
  // can still fix it, rather than surviving as metadata nothing can read.
  const matchShape = raw.match as { events?: unknown; toolNames?: unknown };
  for (const key of ["events", "toolNames"] as const) {
    const value = matchShape[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((e) => typeof e !== "string" || e.length === 0)) {
      throw new Error(`${where} has a match.${key} that is not a list of names`);
    }
  }
  return raw as unknown as PolicyCatalogEntry;
}

function parsePack(root: string, value: unknown): ResolvedPack {
  if (!value || typeof value !== "object") throw new Error("pack entry is not an object");
  const raw = value as InstalledPackRecord;

  const identity = parsePackIdentity(raw);
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(`pack ${raw.id} has no source`);
  }
  if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) {
    throw new Error(`invalid SHA-256 for pack ${raw.id}`);
  }
  // Recorded before anything that can fail, so a later throw can still say what
  // this pack was for.
  const effect = identity.effect;

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

  // Validated but NOT filtered against the known integration list. An unknown
  // name means this record was written by a newer build that supports an agent
  // this one does not; dropping it would silently widen the pack back to every
  // CLI, which is the one direction a narrowing choice must never move.
  let clis: string[] | null = null;
  if (raw.clis !== undefined) {
    if (!Array.isArray(raw.clis) || raw.clis.some((c) => typeof c !== "string")) {
      throw new Error(`pack ${raw.id} clis is not an array of agent names`);
    }
    clis = raw.clis;
  }

  return {
    clis,
    id: identity.id,
    version: identity.version,
    source: raw.source,
    path,
    sha256: raw.sha256,
    effect,
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
      const rec = entry as InstalledPackRecord | null;
      const declaredEffect =
        rec && (rec.effect === "observe" || rec.effect === "enforce") ? rec.effect : "enforce";
      errors.push({
        id: declaredId,
        reason: errText(err),
        effect: declaredEffect,
        // Best effort: an entry too malformed to list policies yields nothing
        // here, and a deny built from it is unavoidably blanket.
        ...(Array.isArray(rec?.policies) ? { declared: safeDeclared(rec.policies) } : {}),
        // A list of names, or nothing. Anything else is unreadable scope, and
        // unreadable scope has to mean "every agent" — the same reasoning that
        // widens an unreadable `match`: a narrowing nobody can parse says
        // nothing true, and here the narrowing would be the thing that lets an
        // unguarded agent through.
        ...(Array.isArray(rec?.clis) && rec.clis.every((c) => typeof c === "string")
          ? { clis: rec.clis }
          : {}),
      });
    }
  }
  return { packs, errors };
}

/** Policy entries that at least carry a name and a match, for narrowing a deny. */
function safeDeclared(raw: unknown[]): PolicyCatalogEntry[] {
  const out: PolicyCatalogEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const p = value as Record<string, unknown>;
    if (typeof p.name !== "string" || !p.match || typeof p.match !== "object") continue;
    out.push(p as unknown as PolicyCatalogEntry);
  }
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
