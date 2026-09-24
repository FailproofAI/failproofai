/**
 * The precondition NAMES a pack's semantic policy may use — strings, and
 * nothing else.
 *
 * ## Why a name and not an expression
 *
 * A JSON manifest cannot carry a function, and the alternative — a small
 * expression language evaluated here — would mean a downloaded artifact
 * deciding, per tool call, what this process computes. A precondition gates
 * every hook event, so it is the last place to accept publisher-authored code.
 * So the manifest names one of a fixed, compiled-in set and
 * `preconditions.ts` owns the bodies. Only 2 of the 16 builtin semantic
 * policies use a precondition at all, so the closed set costs nothing real.
 *
 * ## Why this file exists apart from `preconditions.ts`
 *
 * `pack-manifest.ts` imports THIS to validate a name, and `pack-manifest.ts`
 * runs on every hook event of every machine. `8b9ca9ac` on this branch exists
 * specifically to stop the semantic modules loading on a machine that never
 * configured Jev — it stats `jev.json` before importing the config — and
 * importing a predicate module from the parser would undo that: the bodies
 * reach `policies.ts` for `PROTECTED_BRANCHES`, which pulls in all sixteen of
 * Jev's prompts. Hence zero imports here, type-only exports, and no code the
 * parser can reach.
 *
 * Adding a name is therefore two edits, and the second one is the point: a name
 * with no predicate behind it validates and then silently never gates anything,
 * so `__tests__/hooks/semantic/pack-preconditions.test.ts` pins the two lists
 * to each other.
 */

export const PACK_PRECONDITION_NAMES = [
  /** No precondition; identical to omitting the field. Spelled out so a manifest can say it. */
  "always",
  /** `currentGitBranch` is one of the protected names (`PROTECTED_BRANCHES`). */
  "protected_branch",
  /**
   * `currentGitBranch !== null`.
   *
   * Which is narrower than its name: `facts.ts` reads the branch out of
   * `.git/HEAD` and returns null for a detached HEAD, so a bisect or a checked-
   * out tag reads as "not in a repository". That is the safe direction for what
   * this gates — a question that is not asked leaves the regex verdict standing
   * — and it is the same fact `protected_branch` is built on, so the two cannot
   * disagree about where they are.
   */
  "in_git_repo",
  /** `facts.paths.length > 0` — the call names at least one path. */
  "has_paths",
  /** Some path is outside the project, by the same test `read-outside-workspace` uses. */
  "paths_outside_project",
  /** Some path has relation `system` or `root`. */
  "system_or_root_paths",
] as const;

export type PackPreconditionName = (typeof PACK_PRECONDITION_NAMES)[number];

export function isPackPreconditionName(value: unknown): value is PackPreconditionName {
  return typeof value === "string" && (PACK_PRECONDITION_NAMES as ReadonlyArray<string>).includes(value);
}
