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
import { SEMANTIC_POLICIES } from "./semantic/policies";
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
 */
export const SEMANTIC_REVIEWER_NAMES: ReadonlySet<string> = new Set(
  SEMANTIC_POLICIES.map((p) => p.name),
);

/**
 * Judge one declaration.
 *
 * An unknown name makes the whole declaration hard rather than being dropped,
 * for the reason `effectiveAuthority` refuses a malformed entry: `reviewedBy`
 * is a conjunction, so dropping a name the author wrote would let Jev clear the
 * policy on fewer checks than they asked for. It is also the safe direction for
 * version skew — a pack built against a newer semantic set, installed on an
 * older build, enforces as hard rather than as reviewable-by-less.
 */
export function resolvePolicyAuthority(decl: AuthorityDeclaration | undefined): ResolvedAuthority {
  const declaredReviewable = decl?.authority === "reviewable";
  if (!decl || effectiveAuthority(decl) === "hard") {
    if (!declaredReviewable) return { authority: "hard" };
    return { authority: "hard", downgraded: whyHard(decl!) };
  }
  const names = decl.reviewedBy as string[];
  const unknown = names.filter((n) => !SEMANTIC_REVIEWER_NAMES.has(n));
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
export function authorityFieldsOf(
  raw: Record<string, unknown>,
): { authority?: PolicyAuthority; reviewedBy?: string[] } {
  const out: { authority?: PolicyAuthority; reviewedBy?: string[] } = {};
  if (raw.authority === "hard" || raw.authority === "reviewable") out.authority = raw.authority;
  const list = raw.reviewedBy;
  if (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((n) => typeof n === "string" && n.length > 0)
  ) {
    out.reviewedBy = [...(list as string[])];
  }
  return out;
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
 *   does not declare has no entry and is hard.
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
