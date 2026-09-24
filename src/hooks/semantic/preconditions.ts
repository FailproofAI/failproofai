/**
 * The predicates behind {@link PACK_PRECONDITION_NAMES} — the half of the
 * split that may import the semantic modules.
 *
 * Imported only from the semantic path (the pack→policy resolver, which runs
 * once Jev is configured and a request is being prepared). The parser that
 * VALIDATES a name imports `precondition-names.ts` instead, and the header
 * there says why that separation is load-bearing.
 *
 * Every body reuses the helper the builtin semantic policies use rather than
 * restating the rule. A pack's `paths_outside_project` and the builtin
 * `read-outside-workspace` have to mean the same thing: the whole point of the
 * precondition is to decide whether the paired regex deny gets a question at
 * all, and two spellings of "outside the project" would leave a class of denies
 * permanently unclearable — the failure `outsideProject` was written to fix.
 */
import { PROTECTED_BRANCHES, outsideProject } from "./policies";
import { PACK_PRECONDITION_NAMES, type PackPreconditionName } from "./precondition-names";
import type { Facts } from "./types";

/**
 * Name → predicate, with `always` mapped to `null`.
 *
 * Null rather than `() => true`: `selectPolicies` already treats an absent
 * precondition as "ask about this call", so a policy that says `always` and one
 * that omits the field must produce the IDENTICAL `SemanticPolicy`, or the two
 * spellings differ in the compiled request and a pack's author cannot tell why.
 */
export const PACK_PRECONDITIONS: Readonly<Record<PackPreconditionName, ((facts: Facts) => boolean) | null>> = {
  always: null,
  protected_branch: (facts) => facts.currentGitBranch !== null && PROTECTED_BRANCHES.has(facts.currentGitBranch),
  in_git_repo: (facts) => facts.currentGitBranch !== null,
  has_paths: (facts) => facts.paths.length > 0,
  paths_outside_project: (facts) => facts.paths.some((p) => outsideProject(facts, p)),
  system_or_root_paths: (facts) => facts.paths.some((p) => p.relation === "system" || p.relation === "root"),
};

/**
 * The predicate for a name the parser has already accepted, or `null` for
 * `always`.
 *
 * Throws on an unknown name, and that is not defensive: reaching here with one
 * means `PACK_PRECONDITION_NAMES` and this map have drifted apart, which is a
 * name that validates at install and then gates nothing — the silent failure
 * the two-file split exists to make impossible. The resolver catches it and
 * drops the one policy.
 */
export function preconditionFor(name: PackPreconditionName): ((facts: Facts) => boolean) | null {
  if (!(name in PACK_PRECONDITIONS)) {
    throw new Error(`precondition ${JSON.stringify(name)} has no predicate in this build`);
  }
  return PACK_PRECONDITIONS[name];
}

/** Every name that has a predicate (or is `always`). Pinned against the name list by a test. */
export const IMPLEMENTED_PRECONDITION_NAMES: ReadonlyArray<string> = PACK_PRECONDITION_NAMES.filter(
  (name) => name in PACK_PRECONDITIONS,
);
