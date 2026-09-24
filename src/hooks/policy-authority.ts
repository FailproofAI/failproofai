/**
 * Policy authority: who has the last word on a policy's deny or instruct once
 * Jev is configured. See {@link PolicyAuthority} for the two values and
 * `docs/policies/authority.mdx` for the builtin table.
 *
 * Every route a policy arrives by — a builtin, the user's own policy file, an
 * installed pack, a cloud assignment — declares its authority somewhere
 * different. This module is the one place those declarations are read and
 * judged, so the rule cannot drift between them:
 *
 * - `hard` is the default and the answer to anything unclear. Absent, a value
 *   that is not one of the two, a `reviewedBy` that is empty or malformed or
 *   names a check this build does not have, or an `alwaysOn` policy: all hard.
 * - `reviewable` means Jev may clear the policy's verdict — and only through the
 *   semantic policies it names, every one of which must have been asked.
 *
 * Nothing here decides anything at evaluation time. It resolves a declaration
 * once, at registration, and `registerPolicy` stores the result, so what sits in
 * the registry is already the effective authority.
 */
import { existsSync } from "node:fs";
import { jevConfigFile } from "./fp-home";
import { hookLogWarn } from "./hook-logger";
import { effectiveAuthority } from "./policy-types";
import type { CustomHook, PolicyAuthority, PolicyCatalogEntry } from "./policy-types";

/**
 * A declaration as it arrives, before anything has vouched for it. Fields are
 * `unknown` because three of the four sources are files on disk written by
 * somebody else.
 */
export interface AuthorityDeclaration {
  authority?: unknown;
  reviewedBy?: unknown;
  /** The self-protection guard. Always hard, whatever else it says. */
  alwaysOn?: boolean;
}

/** The shape-valid authority fields a parsed record (a pack entry, a cloud assignment) carries. */
export interface AuthorityFields {
  authority?: PolicyAuthority;
  reviewedBy?: string[];
}

/** What a registered policy carries: already judged, and honest to its type. */
export interface ResolvedAuthority {
  authority: PolicyAuthority;
  /** Present exactly when `authority` is `reviewable`. Deduplicated, in declared order. */
  reviewedBy?: string[];
  /**
   * Why a `reviewable` declaration was not honored, for a warning. Absent when
   * nothing asked for `reviewable` — a policy that is simply hard is not news.
   */
  downgraded?: string;
}

/**
 * The names `reviewedBy` may use: the semantic policies in
 * `src/hooks/semantic/policies.ts`. Not the probes (`INJECTION_PROBE`,
 * `SCOPE_PROBE`, the task probes) — those are inputs to Jev's decision, not
 * checks a regex verdict can be cleared by.
 *
 * Written out rather than read off `SEMANTIC_POLICIES`, and pinned to it by
 * `policy-authority.test.ts`. The registry imports this module, so a runtime
 * import of the semantic policies would load all sixteen of Jev's prompts on
 * every hook event of a machine that never configured Jev, and bundle them into
 * every pack artifact that registers a policy.
 */
export const SEMANTIC_POLICY_NAMES = [
  "destructive-deletion",
  "production-infra-change",
  "git-history-rewrite",
  "push-to-protected-branch",
  "commit-on-protected-branch",
  "secret-exposure",
  "credential-exfiltration",
  "remote-code-execution",
  "privilege-escalation",
  "database-destruction",
  "read-outside-workspace",
  "agent-config-tampering",
  "system-modification",
  "env-secrets-dump",
  "external-destructive-action",
  "external-data-egress",
] as const;

/**
 * The compiled-in reviewer set, and the DEFAULT rather than the only one.
 *
 * A pack that declares its own `semantic` entries replaces
 * `SEMANTIC_POLICIES` wholesale on the machine that installed it, so the names
 * a `reviewedBy` may use there are the pack's. Callers that know which set is
 * live pass it (`effectiveReviewerNames()` in `pack-manifest.ts`, which reads
 * the manifest and imports nothing from `semantic/`); everyone else gets this
 * one, which is what a machine with no pack runs.
 */
export const SEMANTIC_REVIEWER_NAMES: ReadonlySet<string> = new Set(SEMANTIC_POLICY_NAMES);

const isName = (n: unknown): n is string => typeof n === "string" && n.length > 0;

/**
 * Judge one declaration.
 *
 * Stricter than `effectiveAuthority`, which is the §7 contract and needs only
 * one usable name: here EVERY entry must be a semantic policy this build has,
 * and anything else makes the whole declaration hard rather than being dropped.
 * `reviewedBy` is a conjunction, so dropping a name the author wrote — a typo, a
 * stray `7` — would let Jev clear the policy on fewer checks than they asked
 * for. It is also the safe direction for version skew: a pack built against a
 * newer semantic set, installed on an older build, enforces as hard rather than
 * as reviewable-by-less.
 *
 * What this returns is what `registerPolicy` stores, so a registered policy's
 * `reviewedBy` is always clean and the two functions agree on it.
 *
 * @param knownReviewers - the semantic policies that CAN be asked on this
 *   machine. Defaults to the compiled-in set, which is what runs until a pack
 *   ships its own; see {@link SEMANTIC_REVIEWER_NAMES}. It is a parameter rather
 *   than a lookup because this module is imported by the registry, and reading
 *   which set is live means reading a file — a cost registration is willing to
 *   pay once and this judgement must not pay per call.
 */
export function resolvePolicyAuthority(
  decl: AuthorityDeclaration | undefined,
  knownReviewers: ReadonlySet<string> = SEMANTIC_REVIEWER_NAMES,
): ResolvedAuthority {
  const declaredReviewable = decl?.authority === "reviewable";
  if (!decl || effectiveAuthority(decl) === "hard") {
    if (!declaredReviewable) return { authority: "hard" };
    return { authority: "hard", downgraded: whyHard(decl!) };
  }
  const names = decl.reviewedBy as unknown[];
  if (!names.every(isName)) {
    return { authority: "hard", downgraded: "reviewedBy is not a list of semantic policy names" };
  }
  const unknown = names.filter((n) => !knownReviewers.has(n));
  if (unknown.length > 0) {
    return {
      authority: "hard",
      downgraded:
        `reviewedBy names ${unknown.map((n) => JSON.stringify(n)).join(", ")}, ` +
        `which ${unknown.length === 1 ? "is not a semantic policy" : "are not semantic policies"} in this build`,
    };
  }
  return { authority: "reviewable", reviewedBy: [...new Set(names)] };
}

function whyHard(decl: AuthorityDeclaration): string {
  if (decl.alwaysOn === true) return "it is alwaysOn, and the self-protection guard is never reviewable";
  if (!Array.isArray(decl.reviewedBy) || decl.reviewedBy.length === 0) {
    return "reviewedBy does not name any semantic policy";
  }
  return "reviewedBy is not a list of semantic policy names";
}

/**
 * The shape-valid authority fields of a serialized policy entry, for parsers.
 *
 * Invalid fields are DROPPED, never thrown on. A pack or cloud deployment that
 * is refused over a typo in an optional field fails closed and denies every
 * tool call its policies cover; dropping the field makes that one policy hard,
 * which is the default the typo would have produced at registration anyway.
 * Names are not checked against the semantic set here — that is a property of
 * the build reading the entry, not of the entry, and is judged at registration.
 */
export function authorityFieldsOf(raw: Record<string, unknown>): AuthorityFields {
  const out: AuthorityFields = {};
  if (raw.authority === "hard" || raw.authority === "reviewable") out.authority = raw.authority;
  const list = raw.reviewedBy;
  if (Array.isArray(list) && list.length > 0 && list.every(isName)) {
    out.reviewedBy = [...(list as string[])];
  }
  return out;
}

/**
 * Why a declaration cannot be PUBLISHED as written, or `undefined` when it can.
 *
 * For build steps — `scripts/build-policy-pack.mjs` and `failproofai publish`.
 * The loaders drop a malformed field and registration downgrades a refused
 * `reviewable`, both toward hard and both only as a warning, because by then the
 * pack is installed and refusing it would fail it closed. At build time nothing
 * is installed yet, so refusing costs nobody anything, while shipping the
 * declaration would make the policy silently hard on every machine that
 * installs it — a decision its author made, quietly not taking effect.
 *
 * An empty `reviewedBy` on a hard policy is not a problem: it says nothing.
 */
export function authorityProblem(
  decl: AuthorityDeclaration,
  /**
   * The reviewers the pack being built will SHIP WITH — its own `semantic`
   * entries when it declares any, this build's set otherwise. A pack that
   * carries both halves of the two-tier set names its own checks, and refusing
   * that would make the feature unpublishable by the tool that implements it.
   */
  knownReviewers: ReadonlySet<string> = SEMANTIC_REVIEWER_NAMES,
): string | undefined {
  if (decl.authority !== undefined && decl.authority !== "hard" && decl.authority !== "reviewable") {
    const t = typeof decl.authority;
    return `authority must be "hard" or "reviewable", and is ${t === "string" ? JSON.stringify(decl.authority) : `${/^[aeiou]/.test(t) ? "an" : "a"} ${t}`}`;
  }
  if (decl.reviewedBy !== undefined && !(Array.isArray(decl.reviewedBy) && decl.reviewedBy.every(isName))) {
    return "reviewedBy must be a list of semantic policy names";
  }
  const { downgraded } = resolvePolicyAuthority(decl, knownReviewers);
  return downgraded ? `authority "reviewable" was refused — ${downgraded}` : undefined;
}

/**
 * The authority fields a pack MANIFEST should carry for one entry: resolved, as
 * the registry will store them, so the manifest says exactly what takes effect.
 * Throws, naming the entry, on anything {@link authorityProblem} refuses.
 */
export function manifestAuthority(
  entry: AuthorityDeclaration & { name: string },
  knownReviewers: ReadonlySet<string> = SEMANTIC_REVIEWER_NAMES,
): {
  authority: PolicyAuthority;
  reviewedBy?: string[];
} {
  const problem = authorityProblem(entry, knownReviewers);
  if (problem) throw new Error(`${entry.name}: ${problem}`);
  const { authority, reviewedBy } = resolvePolicyAuthority(entry, knownReviewers);
  return reviewedBy ? { authority, reviewedBy } : { authority };
}

/**
 * One authority for several declarations that land on ONE registration.
 *
 * Artifacts are content-addressed, so two cloud assignments or two packs whose
 * code is byte-identical load as one policy (the collapse in
 * `custom-hooks-loader.ts`). Keeping one of their declarations would let the
 * order of `active.json` or `installed.json` decide — and let one pack's
 * manifest, or one team's assignment, make another's policy reviewable.
 *
 * So it resolves toward HARD, the way the collapse resolves the effect toward
 * enforce: reviewable only when EVERY declaration resolves to reviewable, and
 * then through the UNION of their checks (more checks that must all come back
 * clear is stricter, never weaker).
 *
 * ## What the merged record may carry, and why it is the RESOLUTION
 *
 * Nothing here copies a declaration through. It used to keep the first one that
 * was not reviewable, so that a refused `reviewable` would be reported again at
 * registration — and that was the hole: a declaration is only ever resolved
 * against the reviewer set of whoever is looking, so a `reviewable` naming a
 * PACK's own check resolved to hard here, against the builtin set, and was
 * copied forward verbatim. `registerPolicy` then resolved that same raw
 * declaration against `effectiveReviewerNames()`, which does have the pack's
 * check — and the policy registered reviewable, with a hard peer behind the same
 * artifact overruled by nothing more than which pack was listed first.
 *
 * Two changes close it. The reviewer set is now a PARAMETER, so the merge judges
 * by the same names registration will; and a non-reviewable merge emits
 * `{ authority: "hard" }` — the resolved value — rather than the fields it was
 * asked for. Either alone would have been enough for the case above; both,
 * because the first is an agreement between two callers and the second holds
 * whether or not they agree.
 *
 * The reason a refused declaration carried is not lost: it comes back as
 * `refused`, for the caller to say through {@link refusedAuthorityWarning} at
 * the point where it knows which artifact and which packs are involved.
 *
 * Returns `record` itself when its own fields already say that, and a copy with
 * only the two authority fields replaced otherwise. `overruled` is true when
 * some declaration asked for reviewable, validly, and did not get it.
 *
 * @param knownReviewers - the checks that can be asked on this machine. Callers
 *   that merge what will be REGISTERED must pass `effectiveReviewerNames()`;
 *   the default is this build's compiled-in set, which is what a machine with no
 *   pack runs.
 */
export function withMergedAuthority<T extends AuthorityFields>(
  record: T,
  declarations: ReadonlyArray<AuthorityFields>,
  knownReviewers: ReadonlySet<string> = SEMANTIC_REVIEWER_NAMES,
): { merged: T; overruled: boolean; refused?: string } {
  const resolved = declarations.map((d) => resolvePolicyAuthority(d, knownReviewers));
  const allReviewable = resolved.length > 0 && resolved.every((r) => r.authority === "reviewable");
  // The declaration that decided it is hard. Its own fields are not carried —
  // only whether it said anything at all, because a record that declared
  // nothing is already hard and rewriting it to say so would touch a record the
  // collapse has no business touching.
  const decided = declarations[resolved.findIndex((r) => r.authority !== "reviewable")] ?? {};
  const fields: AuthorityFields = allReviewable
    ? { authority: "reviewable", reviewedBy: [...new Set(resolved.flatMap((r) => r.reviewedBy ?? []))] }
    : decided.authority === undefined
      ? {}
      : { authority: "hard" };
  const overruled = !allReviewable && resolved.some((r) => r.authority === "reviewable");
  const refused = resolved.find((r) => r.downgraded !== undefined)?.downgraded;
  const extra = refused === undefined ? {} : { refused };
  const same =
    record.authority === fields.authority &&
    JSON.stringify(record.reviewedBy) === JSON.stringify(fields.reviewedBy);
  if (same) return { merged: record, overruled, ...extra };
  const { authority: _a, reviewedBy: _r, ...rest } = record;
  return { merged: { ...rest, ...fields } as T, overruled, ...extra };
}

/**
 * The warning for a `reviewable` declaration that was not honored. One
 * phrasing, wherever it is noticed — registration for a policy that reaches it
 * with its declaration intact, and the loader for one the collapse hardened
 * before it got there.
 */
export function refusedAuthorityWarning(subject: string, reason: string): string {
  return `${subject} asks to be reviewable, but ${reason} — it stays hard`;
}

const warnedAuthority = new Set<string>();

/**
 * Say that an authority declaration was not honored — once per process, and
 * only once Jev is configured (a global `jev.json` exists).
 *
 * Without Jev, authority decides nothing, so there is nothing to tell anyone —
 * and a warning is not free: it goes to the hook's stderr, which some CLIs show
 * as the deny text itself, on every event, for every machine that installed a
 * pack built against a newer semantic set. Once per process keeps the daemon's
 * warm worker from repeating it for every tool call. Authors are told at build
 * time as well: `failproofai publish` refuses what this would warn about.
 *
 * Presence of the file rather than a validated load: a machine where someone
 * has started configuring Jev is where the answer to "why does Jev never clear
 * this policy" is wanted, and a stat keeps the semantic modules unloaded.
 */
export function warnAuthority(message: string): void {
  try {
    if (!existsSync(jevConfigFile())) return;
  } catch {
    return;
  }
  if (warnedAuthority.has(message)) return;
  warnedAuthority.add(message);
  hookLogWarn(message);
}

/**
 * Where a loaded hook's authority is declared, by the route it arrived on.
 *
 * - **Cloud-managed:** the artifact record in the active deployment. A cloud
 *   policy's authority is a central decision, so code inside the artifact
 *   cannot grant itself `reviewable`.
 * - **Pack:** the pack's own manifest entry for that policy, matched by name —
 *   the same place its `params` schema is read from. A pack can only ever
 *   describe its own policies this way: its names cannot contain `/`, and they
 *   register under `pack/<id>@<version>/`, so no manifest can reach a builtin
 *   or another pack's policy. A policy the artifact registers but the manifest
 *   does not declare has no entry and is hard. When packs share one artifact,
 *   the loader has already merged their entries toward hard
 *   ({@link withMergedAuthority}), so no one of them decides for the others.
 * - **The user's own file:** the hook itself.
 */
export function authorityDeclarationFor(
  hook: Pick<CustomHook, "name" | "authority" | "reviewedBy">,
  source: {
    cloudManaged?: { authority?: unknown; reviewedBy?: unknown };
    pack?: { policies: PolicyCatalogEntry[] };
  },
): AuthorityDeclaration {
  if (source.cloudManaged) {
    return { authority: source.cloudManaged.authority, reviewedBy: source.cloudManaged.reviewedBy };
  }
  if (source.pack) {
    const entry = source.pack.policies.find((p) => p.name === hook.name);
    return { authority: entry?.authority, reviewedBy: entry?.reviewedBy };
  }
  return { authority: hook.authority, reviewedBy: hook.reviewedBy };
}
