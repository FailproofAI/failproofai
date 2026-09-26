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
import { version as cliVersion } from "../../package.json";
import { packsDir, packsInstalledFile } from "./fp-home";
import { resolveManagedPath } from "./cloud-managed-policies";
import { authorityFieldsOf } from "./policy-authority";
import { compareVersions } from "./semver-precedence";
// Strings only, and the one semantic module this file may touch: it runs on
// every hook event, and the predicate bodies pull in all sixteen of Jev's
// prompts. See the header of `semantic/precondition-names.ts`.
import { isPackPreconditionName, PACK_PRECONDITION_NAMES } from "./semantic/precondition-names";
import type { SemanticPolicyDeclaration, SemanticProbeDeclaration, PolicyCatalogEntry } from "./policy-types";
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

/**
 * A semantic probe's id. Lowercase and underscore only, because it is half of a
 * Jev question id (`<policy>.<probe>`) that `decide.ts` reads answers back by.
 */
const PROBE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Probe ids `decide.ts` has already taken in the answer map: `<policy>.exempt`
 * is the documented-exception question and `<policy>.user_asked` is the "did the
 * human ask for this" one. A probe claiming either name would not collide
 * loudly — it would OVERWRITE that question in the compiled request, so the
 * exemption or the override silently becomes whatever the pack wrote.
 */
const RESERVED_PROBE_IDS: ReadonlySet<string> = new Set(["exempt", "user_asked"]);

const SEMANTIC_TOOL_CLASSES: ReadonlySet<string> = new Set(["shell", "write", "read", "network", "other"]);

/**
 * Cheap count guards on the question set, applied where the manifest is read.
 *
 * They are NOT the real budget. Every probe is a question in one Jev request,
 * and what that request has to fit is a character budget
 * (`MAX_REQUEST_CHARS - MAX_STATE_CHARS`) — which these counts cannot express,
 * because a probe is between a sentence and a paragraph long. Counting to 24
 * and 6 here rejects the obviously abusive shapes for free, on the hook path,
 * without reaching a semantic module; `semantic/pack-policies.ts` owns the
 * budget that actually decides, measured the way `compile.ts` measures it.
 *
 * There is deliberately no total probe count across packs. An earlier draft had
 * one (80), and at the real average probe length that ceiling permits a question
 * set 23,032 characters over what one request can carry — a cap that reads as a
 * guarantee and is not one.
 */
export const MAX_SEMANTIC_POLICIES_PER_PACK = 24;
/** Per-policy conjunction width. The builtin set's widest policy uses three probes. */
export const MAX_PROBES_PER_POLICY = 6;
const MAX_TITLE_CHARS = 120;
const MAX_INSTRUCTIONS_CHARS = 600;
const MAX_CRITERION_CHARS = 300;
const MAX_GUIDANCE_CHARS = 600;

/** A semantic policy as a manifest carries it: validated, normalized, code-free. */
export type SemanticManifestEntry = SemanticPolicyDeclaration & {
  probes: SemanticProbeDeclaration[];
};

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
   * The pack's semantic (Jev) policies, as the manifest declared them.
   *
   * `unknown` like `policies`, and optional like it is not: a pack published
   * before this field existed carries none, and every one of them must keep
   * parsing. A pack that declares at least one REPLACES the compiled-in
   * semantic set wholesale — see `semantic/pack-policies.ts`.
   */
  semantic?: unknown;
  /**
   * The oldest CLI that may run this pack, as a semver string.
   *
   * Optional, and the ordering of its release is the reason it has to exist at
   * all: a CLI with no support for this field ignores it AND ignores `semantic`,
   * so it installs a pack whose Jev half does nothing and says so nowhere. A
   * publisher can only protect against that by naming a minimum that the old
   * CLI cannot read — which is why this ships before any pack declares one.
   */
  minCliVersion?: string;
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
  /**
   * The pack's semantic policies, in declared order — EMPTY when it declared
   * none, which is what every pack published before this release says. Entries
   * that failed validation are not here; they were dropped, and the reason is in
   * `PackReadResult.warnings`.
   *
   * `readInstalledPacks` always sets it, so on a record that came from a
   * manifest this is an array. It is optional only so that a hand-built record —
   * the loader fixtures, `pack-failclosed`'s guards — does not have to name a
   * field it has no opinion about. Read it through {@link packSemantic} rather
   * than `?? []` at each site, so "absent" and "empty" cannot come to mean
   * different things.
   */
  semantic?: SemanticManifestEntry[];
  /** The minimum CLI this pack declared, once it has been checked against ours. */
  minCliVersion?: string;
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
  /**
   * The record's regex `policies` list was readable and empty: a Jev-checks-only
   * pack. It guards nothing in the regex tier, so its refusal has nothing to
   * fail closed on. Read from the RAW list, never from `declared`: a list whose
   * entries are all malformed also filters to nothing, and that must widen.
   */
  semanticOnly?: true;
}

export interface PackReadResult {
  packs: ResolvedPack[];
  /** Every pack that was declared and refused, and why. Never silently dropped. */
  errors: PackError[];
  /**
   * What was dropped from a pack that LOADED anyway, and why: a malformed
   * semantic policy, an unknown precondition name, one entry past the cap, a
   * `minCliVersion` nobody can compare.
   *
   * A SEPARATE channel from `errors`, and it has to be. An entry in `errors`
   * means a pack was refused, and `pack-failclosed.ts` turns that into a deny
   * for every event the missing policies claimed. Everything here is the
   * opposite situation: the pack's regex policies are registered and enforcing,
   * and what was lost is a reviewer (so a deny can no longer be CLEARED) or an
   * unreadable version claim. Filing either as a pack failure would deny a
   * machine over a typo in the half of the system whose job is to let more real
   * work through.
   *
   * Absent rather than an empty array when there is nothing to say, so the
   * common result stays the exact shape it has always been.
   */
  warnings?: string[];
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

export function installedFilePath(): string {
  return process.env.FAILPROOFAI_PACK_DIR
    ? resolve(process.env.FAILPROOFAI_PACK_DIR, "installed.json")
    : packsInstalledFile();
}


/** The param types a schema may declare. Mirrors {@link PolicyParamsSchema}. */
const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "string[]", "pattern[]"]);

/**
 * Why a `params` schema cannot be used, or `undefined` when it can.
 *
 * A pack's schema is what `registerPolicy` stores and `evaluatePolicies` merges
 * the user's configured values ON TOP OF, so a malformed one is not cosmetic: it
 * decides what `ctx.params` contains, and a policy reading a param that is not
 * there falls back to whatever its own code says — usually the stricter thing.
 *
 * Validated as a whole rather than per param. A partial schema would leave one
 * param live and another silently absent inside the same policy, which is the
 * hardest version of this to diagnose from the outside.
 */
function paramsSchemaProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "params is not an object";
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) return "params has an empty parameter name";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `params.${name} is not an object`;
    const spec = raw as Record<string, unknown>;
    if (typeof spec.type !== "string" || !PARAM_TYPES.has(spec.type)) {
      return `params.${name} has type ${JSON.stringify(spec.type)}, which is not one of ${[...PARAM_TYPES].join(", ")}`;
    }
    if (typeof spec.description !== "string" || spec.description.length === 0) {
      return `params.${name} is missing a description`;
    }
    // The KEY has to be there, whatever it holds: an absent default and a
    // `default: undefined` merge the same way, but only one of them says the
    // author thought about it, and the merge is what the user's own value lands on.
    if (!("default" in spec)) return `params.${name} is missing a default`;
  }
  return undefined;
}

/** Validate one serialized catalog entry carried by a pack. */
export function parsePackPolicy(
  packId: string,
  value: unknown,
  index: number,
  /** Where a DROPPED field is reported. Optional: most callers only care that the entry parsed. */
  warnings?: string[],
): PolicyCatalogEntry {
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
  // Authority: whether Jev may clear this policy's verdict. Unlike `match`, a
  // malformed value is DROPPED rather than refused — refusing the pack fails it
  // closed and denies every tool call it covers, while dropping the field makes
  // this one policy `hard`, which is what an unreadable declaration means
  // anyway. A pack can only describe its OWN policies this way: the name above
  // cannot contain `/`, so no entry can reach a builtin or another pack's
  // policy. Absent fields stay absent, valid ones stay where they were, and an
  // entry with nothing to drop is returned as is.
  const valid = authorityFieldsOf(raw);
  const invalid = (["authority", "reviewedBy"] as const).filter((k) => k in raw && !(k in valid));
  // `params` follows the same rule, and is dropped for the same reason: refusing
  // the pack fails it closed and denies every tool call it covers, while dropping
  // the schema leaves the policy running on its own internal fallbacks. Recorded
  // rather than silent, because the drop is a change to what the policy DOES —
  // `block-sudo` without its `allowPatterns` is stricter than the user asked for,
  // and stricter is the direction nobody reports as a bug.
  if ("params" in raw) {
    const problem = paramsSchemaProblem(raw.params);
    if (problem) {
      warnings?.push(`${where} declares a params schema that was dropped: ${problem}`);
      invalid.push("params" as never);
    }
  }
  if (invalid.length > 0) {
    return Object.fromEntries(
      Object.entries(raw).filter(([k]) => !(invalid as readonly string[]).includes(k)),
    ) as unknown as PolicyCatalogEntry;
  }
  return raw as unknown as PolicyCatalogEntry;
}

/**
 * Why a `params` schema cannot be PUBLISHED, or `undefined` when it can.
 *
 * The build-time half of the rule above: at build time nothing is installed, so
 * refusing costs nobody anything, while shipping the schema means every machine
 * that installs the pack runs the policy without its parameters and says so only
 * in its own log.
 */
export function packParamsProblem(params: unknown): string | undefined {
  return params === undefined ? undefined : paramsSchemaProblem(params);
}

/**
 * What this build makes of a pack's declared `minCliVersion`.
 *
 * Three outcomes, not two, because "the pack states no requirement" and "the
 * pack states one nobody can read" are different facts and only one of them is
 * worth saying out loud.
 */
export type MinCliVerdict =
  /** Satisfied, or nothing was claimed. `declared` is present only when it was. */
  | { kind: "satisfied"; declared?: string }
  /** The field was there and unusable. It is DROPPED; the pack still loads. */
  | { kind: "unreadable"; reason: string }
  /** This CLI is genuinely older than the pack requires. The pack is refused. */
  | { kind: "too-old"; reason: string };

/**
 * Judge one pack's `minCliVersion` against the running CLI — the ONE place that
 * decision is written down.
 *
 * ## Absent satisfies
 *
 * Every pack published before this release declares nothing, and those packs
 * work. Treating silence as an unmet requirement would refuse them all, and a
 * refused `enforce` pack denies every tool call its policies cover
 * (`pack-failclosed.ts`) — a machine-wide lockout produced by an upgrade.
 *
 * ## Unreadable also satisfies, and says so
 *
 * The rule `parsePackPolicy` already applies to a malformed `authority`: drop
 * the field, record it, do not refuse the pack. A publisher's typo in a version
 * string must not be able to fail somebody's machine closed. It is recorded
 * rather than ignored, because a requirement that quietly evaporates is how a
 * pack ends up enforcing less than its README says.
 *
 * This is the one place the two differ from each other, which is why neither is
 * a boolean: a caller reading `false` to refuse would ignore the typo, and one
 * reading `!== true` would refuse the world.
 *
 * ## Too old refuses, and that is the field's entire purpose
 *
 * A CLI too old to know this field ignores it AND ignores `semantic` with it,
 * installing a pack whose Jev half does nothing on a machine that reports
 * healthy. Only a build new enough to have this check can act on the
 * requirement, so here it acts. It rides the ordinary `PackError` path, which
 * carries `effect` and `clis`, so refusing an `observe` pack does not make the
 * machine deny on its behalf.
 */
export function checkPackMinCliVersion(
  packId: string,
  declared: unknown,
  current: string = cliVersion,
): MinCliVerdict {
  if (declared === undefined) return { kind: "satisfied" };
  const ordered = compareVersions(current, declared);
  if (ordered === null) {
    return {
      kind: "unreadable",
      reason:
        `pack ${packId} declares minCliVersion ${JSON.stringify(declared)}, which is not a version this CLI can ` +
        `compare against its own (${current}) — the requirement was ignored`,
    };
  }
  if (ordered < 0) {
    return {
      kind: "too-old",
      reason:
        `pack ${packId} needs failproofai ${String(declared)} or newer and this is ${current} — ` +
        "run `npm i -g failproofai && failproofai update`",
    };
  }
  return { kind: "satisfied", declared: declared as string };
}

/** A bounded, non-empty string field. The cap is part of the envelope budget, not taste. */
function boundedString(where: string, field: string, value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where} is missing ${field}`);
  }
  if (value.length > max) {
    throw new Error(`${where} has a ${field} of ${value.length} characters, over the ${max}-character cap`);
  }
  return value;
}

/**
 * One probe (or the `exempt` question), validated.
 *
 * `forcedId` is how `exempt` gets its id: the answer map keys it
 * `<policy>.exempt` whatever the manifest wrote, so the field is overwritten
 * rather than checked. Refusing a mismatch there would fail a pack over a
 * value that has no effect.
 */
function parseSemanticProbe(where: string, value: unknown, forcedId: string | null): SemanticProbeDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is not an object`);
  const raw = value as Record<string, unknown>;

  let id: string;
  if (forcedId !== null) {
    id = forcedId;
  } else {
    if (typeof raw.id !== "string" || !PROBE_ID_RE.test(raw.id)) {
      throw new Error(`${where} has an unsafe id ${JSON.stringify(raw.id)}`);
    }
    if (RESERVED_PROBE_IDS.has(raw.id)) {
      throw new Error(`${where} uses the reserved probe id ${JSON.stringify(raw.id)}`);
    }
    id = raw.id;
  }

  const instructions = boundedString(where, "instructions", raw.instructions, MAX_INSTRUCTIONS_CHARS);
  if (raw.criteria === undefined) return { id, instructions };
  if (!raw.criteria || typeof raw.criteria !== "object" || Array.isArray(raw.criteria)) {
    throw new Error(`${where} has criteria that is not an object`);
  }
  const criteria = raw.criteria as Record<string, unknown>;
  // Both halves or neither. Jev answers the question as written, and a `true`
  // description with no `false` one is a question with only one side explained —
  // the authoring mistake the criteria exist to prevent.
  return {
    id,
    instructions,
    criteria: {
      true: boundedString(where, "criteria.true", criteria.true, MAX_CRITERION_CHARS),
      false: boundedString(where, "criteria.false", criteria.false, MAX_CRITERION_CHARS),
    },
  };
}

/**
 * Validate one serialized SEMANTIC policy carried by a pack. Sibling of
 * {@link parsePackPolicy}, and the rules are its rules where they overlap.
 *
 * It THROWS on every violation and the CALLER decides what a throw costs.
 * `readInstalledPacks` drops the one entry and records why, because a semantic
 * policy is what CLEARS a reviewable regex verdict: losing one leaves the regex
 * block standing, which is noisier and never weaker. `failproofai publish`
 * fails the whole build on the same throw, because nothing is installed yet and
 * refusing there costs nobody anything.
 *
 * The returned entry is NORMALIZED, unlike a regex entry — which is returned
 * as-is so a field this build does not know about survives into `params`. There
 * is no equivalent here: the entry's entire use is to be compiled into a
 * question set, so a field nothing reads is a field that would be published,
 * digest-pinned and then ignored.
 */
export function parsePackSemanticPolicy(packId: string, value: unknown, index: number): SemanticManifestEntry {
  const where = `${packId} semantic policy #${index}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is not an object`);
  const raw = value as Record<string, unknown>;

  const name = raw.name;
  if (typeof name !== "string" || !PACK_POLICY_NAME_RE.test(name)) {
    throw new Error(`${where} has an unsafe name ${JSON.stringify(name)}`);
  }
  if ("alwaysOn" in raw) {
    // The same refusal `parsePackPolicy` makes, for the same reason, and it has
    // to be restated rather than inherited: nothing else stops a semantic entry
    // from carrying the field, and a reader that ever honoured it would be
    // honouring it on a downloaded file no local command can switch off.
    throw new Error(`${where} declares alwaysOn, which packs may not set`);
  }
  const title = boundedString(`${packId} semantic policy ${name}`, "title", raw.title, MAX_TITLE_CHARS);
  const scope = `${packId} semantic policy ${name}`;

  if (!Array.isArray(raw.appliesTo) || raw.appliesTo.length === 0) {
    throw new Error(`${scope} has no appliesTo tool classes`);
  }
  const unknownClass = raw.appliesTo.find((c) => typeof c !== "string" || !SEMANTIC_TOOL_CLASSES.has(c));
  if (unknownClass !== undefined) {
    throw new Error(
      `${scope} applies to ${JSON.stringify(unknownClass)}, which is not a tool class ` +
        `(${[...SEMANTIC_TOOL_CLASSES].join(", ")})`,
    );
  }

  if (raw.mode !== "deny" && raw.mode !== "instruct") {
    throw new Error(`${scope} has mode ${JSON.stringify(raw.mode)}, which must be "deny" or "instruct"`);
  }
  // REQUIRED, with no default. It decides whether a prompt injection that talks
  // the human's words back at us can clear the policy, so a default here would
  // be a security decision made by absence — and the direction it fell would
  // depend on which of the two engines read the entry.
  if (typeof raw.userCanOverride !== "boolean") {
    throw new Error(`${scope} is missing userCanOverride, which has no default`);
  }

  if (!Array.isArray(raw.probes) || raw.probes.length === 0) {
    throw new Error(`${scope} declares no probes`);
  }
  if (raw.probes.length > MAX_PROBES_PER_POLICY) {
    throw new Error(`${scope} declares ${raw.probes.length} probes, over the cap of ${MAX_PROBES_PER_POLICY}`);
  }
  const probes = raw.probes.map((p, i) => parseSemanticProbe(`${scope} probe #${i}`, p, null));
  const ids = new Set<string>();
  for (const probe of probes) {
    if (ids.has(probe.id)) throw new Error(`${scope} declares probe ${probe.id} twice`);
    ids.add(probe.id);
  }

  const exempt = raw.exempt === undefined ? undefined : parseSemanticProbe(`${scope} exempt`, raw.exempt, "exempt");

  if (raw.precondition !== undefined && !isPackPreconditionName(raw.precondition)) {
    throw new Error(
      `${scope} names precondition ${JSON.stringify(raw.precondition)}, which this build does not have ` +
        `(${PACK_PRECONDITION_NAMES.join(", ")})`,
    );
  }

  const guidance = boundedString(scope, "guidance", raw.guidance, MAX_GUIDANCE_CHARS);

  return {
    name,
    title,
    appliesTo: raw.appliesTo as SemanticManifestEntry["appliesTo"],
    mode: raw.mode,
    userCanOverride: raw.userCanOverride,
    probes,
    ...(exempt ? { exempt } : {}),
    ...(raw.precondition !== undefined ? { precondition: raw.precondition } : {}),
    guidance,
  };
}

/** A pack's semantic entries. Absent and empty are the same answer: it declares none. */
export function packSemantic(pack: Pick<ResolvedPack, "semantic">): ReadonlyArray<SemanticManifestEntry> {
  return pack.semantic ?? [];
}

/** The questions one entry compiles to: one per probe, plus one for the exemption. */
export function semanticQuestions(
  entry: Pick<SemanticManifestEntry, "probes" | "exempt">,
): ReadonlyArray<SemanticProbeDeclaration> {
  return entry.exempt ? [...entry.probes, entry.exempt] : entry.probes;
}

/**
 * The semantic entries a pack declared, with the unusable ones dropped.
 *
 * Per ENTRY, not per pack: one malformed question set must not take the rest of
 * a publisher's semantic policies with it, for the same reason one malformed
 * pack does not take the other packs with it.
 */
function parsePackSemantic(packId: string, value: unknown, warnings: string[]): SemanticManifestEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`pack ${packId} semantic is not an array, so none of it was loaded`);
    return [];
  }
  const entries: SemanticManifestEntry[] = [];
  const names = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (entries.length >= MAX_SEMANTIC_POLICIES_PER_PACK) {
      warnings.push(
        `pack ${packId} declares more than ${MAX_SEMANTIC_POLICIES_PER_PACK} semantic policies; ` +
          `the ${value.length - MAX_SEMANTIC_POLICIES_PER_PACK} past that cap were dropped`,
      );
      break;
    }
    try {
      const entry = parsePackSemanticPolicy(packId, raw, index);
      if (names.has(entry.name)) throw new Error(`pack ${packId} declares semantic policy ${entry.name} twice`);
      names.add(entry.name);
      entries.push(entry);
    } catch (err) {
      warnings.push(errText(err));
    }
  }
  return entries;
}

function parsePack(root: string, value: unknown, warnings: string[]): ResolvedPack {
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

  // Checked before the artifact is read: there is no point hashing bytes this
  // build may have just been told it must not run.
  const minCli = checkPackMinCliVersion(identity.id, raw.minCliVersion);
  if (minCli.kind === "too-old") throw new Error(minCli.reason);
  if (minCli.kind === "unreadable") warnings.push(minCli.reason);

  const path = resolveManagedPath(root, raw.entry);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== raw.sha256) {
    throw new Error(
      `pack ${raw.id} failed integrity verification: expected ${raw.sha256}, got ${actual}`,
    );
  }

  if (!Array.isArray(raw.policies)) throw new Error(`pack ${raw.id} policies is not an array`);
  const policies = raw.policies.map((p, i) => parsePackPolicy(raw.id, p, i, warnings));
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
    semantic: parsePackSemantic(identity.id, raw.semantic, warnings),
    ...(minCli.kind === "satisfied" && minCli.declared ? { minCliVersion: minCli.declared } : {}),
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
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.packs) {
    const declaredId =
      entry && typeof entry === "object" && typeof (entry as InstalledPackRecord).id === "string"
        ? (entry as InstalledPackRecord).id
        : null;
    // Collected per pack and merged only on success. A pack that throws after
    // some of its semantic entries were dropped is refused whole, and reporting
    // the drops as well would describe a policy set that is not loaded at all.
    const packWarnings: string[] = [];
    try {
      const pack = parsePack(root, entry, packWarnings);
      if (seen.has(pack.id)) throw new Error(`duplicate pack id ${pack.id}`);
      seen.add(pack.id);
      packs.push(pack);
      warnings.push(...packWarnings);
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
        ...(Array.isArray(rec?.policies) && rec.policies.length === 0 ? { semanticOnly: true as const } : {}),
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
  return { packs, errors, ...(warnings.length > 0 ? { warnings } : {}) };
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
