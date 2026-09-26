/**
 * The semantic checks a `reviewedBy` may name ON THIS MACHINE.
 *
 * ## Why this is not simply `SEMANTIC_REVIEWER_NAMES`
 *
 * A pack that declares its own `semantic` entries replaces the compiled-in
 * `SEMANTIC_POLICIES` wholesale (`semantic/pack-policies.ts`). So on that
 * machine the sixteen builtin names are checks that will never be asked, and the
 * pack's own names are the only ones that will — while
 * `resolvePolicyAuthority`, judging against the builtin set, would read the
 * pack's `reviewedBy: ["its-own-check"]` as naming a check "this build does not
 * have" and downgrade the policy to `hard` with nothing but a warning in the
 * hook log. That is a rewritten policy set arriving with its reviewability
 * quietly removed: the deny half of the two-tier evaluator working exactly as
 * documented while the clearing half cannot fire once — the failure
 * `policy-reviewability.ts` was written to make audible, reintroduced one layer
 * down.
 *
 * The names come from the MANIFEST, which is already where `authority` and
 * `reviewedBy` themselves are read from, so this adds no new trust and imports
 * no semantic module.
 *
 * ## Why it is a module of its own, and cached the way it is
 *
 * `registerPolicy` asks this for every policy that declares an authority — forty
 * times per hook event — and the honest answer costs a digest verification per
 * installed pack. So it is cached, and the cache is dropped by `clearPolicies()`:
 * one read per registration pass, and the answer's lifetime is exactly the
 * registry's. That is the right coupling rather than a convenient one — this set
 * describes the policies sitting in the registry, and the handler rebuilds both
 * together, so they cannot come to describe different machines.
 *
 * It lives beside `policy-registry.ts` rather than inside `pack-manifest.ts`
 * because the registry may not depend on the whole manifest reader: several
 * tests isolate themselves from the running machine's real packs by mocking
 * `pack-manifest` down to `readInstalledPacks` and `hasInstalledPacks`, and a
 * registration path reaching for a third export of that module breaks them all
 * — loudly here, but it is the shape of a change that would later break them
 * silently.
 */
import { readInstalledPacks, type ResolvedPack } from "./pack-manifest";
import { SEMANTIC_REVIEWER_NAMES } from "./policy-authority";

let cached: ReadonlySet<string> | null = null;
/** The agent the current registration pass is for; see {@link forgetEffectiveReviewerNames}. */
let reviewerCli: string | undefined;

/**
 * The packs whose Jev checks take part for `cli`, filtered the way the regex
 * half already is: an `observe` pack blocks nothing, and a pack scoped to other
 * agents guards none here. Its checks would otherwise replace the questions and
 * supply reviewers that clear enforce packs' denies on every agent. Both the
 * reviewer set and the question set start from this list, so they agree.
 */
export function jevPacks<T extends Pick<ResolvedPack, "effect" | "clis">>(packs: ReadonlyArray<T>, cli?: string): T[] {
  return packs.filter(
    (p) => p.effect !== "observe" && !(cli && Array.isArray(p.clis) && p.clis.length > 0 && !p.clis.includes(cli)),
  );
}

/**
 * A stable serialization, for comparing two declarations of the same name.
 * Key order is a manifest's business, not a difference in what is asked.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The semantic check names that more than one installed pack claims, with
 * declarations that are not the same check — and which this machine must
 * therefore honour for nobody. Keyed by name, valued with the packs that
 * claimed it, for the warning.
 *
 * ## Why a contested name has to be refused rather than resolved
 *
 * The reviewer set is the whole protection: a policy is `reviewable` only when
 * every name its `reviewedBy` lists is a check this machine can actually ask.
 * The union across packs is deliberate and must keep working — the shipped
 * configuration is exactly that, `FailproofAI/policies` naming checks that live
 * in `FailproofAI/jev-policies` — but the union was AMBIGUOUS. Two packs may be
 * installed at once, `semanticPoliciesFromPacks` keeps the first declaration of
 * a duplicated name and drops the later one, and nothing tied a name to the pack
 * that meant it. So a second pack declaring `production-infra-change` with a
 * question that answers "no concern" to everything supplies the reviewer for the
 * FIRST pack's policies: install it, and every policy reviewable by that name is
 * cleared on every call. The pack doing it never declares a regex policy, and
 * scoping reviewers per pack is not the fix — that would break the pairing the
 * product ships.
 *
 * So the name leaves the set. The policies naming it resolve to `hard`, the
 * question is not asked, and the pack that tried it gains nothing: stricter than
 * either author asked for, with the regex deny simply standing. Nothing is
 * failed closed over it — one policy being hard is a cost; a pack that denies
 * every tool call is a different order of failure (`pack-failclosed.ts`).
 *
 * ## Why identical declarations are not a contest
 *
 * Content-addressed artifacts mean a fork or a re-publish arrives as two packs
 * carrying the same semantic entries, and `custom-hooks-loader.ts` treats that
 * shape as expected rather than as a corner. Both declarations are then the same
 * question, so whichever the resolver keeps asks exactly what the other would
 * have: nothing is ambiguous, and refusing the name would switch off the
 * clearing half on a machine whose two packs agree to the byte.
 *
 * Pure, and takes the packs rather than reading them, so the two callers that
 * already have them do not read `installed.json` again — and so both answer from
 * the same list. They MUST agree: a name in the reviewer set whose question is
 * another pack's is the bug this function exists to remove.
 */
export function contestedSemanticNames(
  packs: ReadonlyArray<Pick<ResolvedPack, "id" | "semantic"> & { source?: string }>,
): ReadonlyMap<string, string[]> {
  const claims = new Map<string, { form: string; ids: string[]; firstParty: boolean }>();
  const contested = new Map<string, string[]>();
  for (const pack of packs) {
    for (const entry of pack.semantic ?? []) {
      const form = canonical(entry);
      const claim = claims.get(entry.name);
      if (claim === undefined) {
        claims.set(entry.name, { form, ids: [pack.id], firstParty: isFirstPartyPack(pack) });
        continue;
      }
      claim.ids.push(pack.id);
      claim.firstParty ||= isFirstPartyPack(pack);
      // The array is the live one, so a third claimant is named too.
      if (claim.form !== form) contested.set(entry.name, claim.ids);
    }
  }
  // A builtin check name is FailproofAI's: core and user policies name it in
  // `reviewedBy`. Claimed by no first-party pack, it would make a third party's
  // question the reviewer that clears them — an `instruct`-mode
  // `destructive-deletion` beside the core pack turned `block-rm-rf` into a
  // warning. So it is asked for nobody; copies identical to a first-party
  // declaration are the same question and stay (the fork case above).
  for (const [name, claim] of claims) {
    if (SEMANTIC_REVIEWER_NAMES.has(name) && !claim.firstParty) contested.set(name, claim.ids);
  }
  return contested;
}

/**
 * Installed from a FailproofAI repository. Read from `source`, which this CLI
 * wrote from the repository it fetched, never from the pack's self-declared `id`.
 */
export function isFirstPartyPack(pack: { source?: string }): boolean {
  return /^github:FailproofAI\//i.test(pack.source ?? "");
}

/**
 * The installed packs' semantic policy names when any pack declares some, and
 * this build's compiled-in set otherwise.
 *
 * A name two packs claim differently is left out — see
 * {@link contestedSemanticNames}. When that leaves nothing, the compiled-in set
 * stands, which is not a softening but the same rule
 * `semanticPoliciesFromPacks` applies to the QUESTIONS: a declaring pack whose
 * every entry was unusable leaves the compiled-in semantic set live, so the
 * names honoured here are the names of the questions that will actually be
 * asked, and each of those is one of ours.
 *
 * Never throws: an unreadable manifest declares nothing, and the builtin set
 * stands. That is the same fail-open posture every other reader of the pack
 * manifest takes, and here it also fails in the safe direction — a pack's
 * `reviewedBy` will not match a builtin name, so its policies stay `hard`
 * rather than being cleared by a question nobody could read.
 */
export function effectiveReviewerNames(): ReadonlySet<string> {
  if (cached) return cached;
  let names: ReadonlySet<string> = SEMANTIC_REVIEWER_NAMES;
  try {
    const packs = jevPacks(readInstalledPacks().packs, reviewerCli);
    const contested = contestedSemanticNames(packs);
    const declared = packs
      .flatMap((p) => (p.semantic ?? []).map((s) => s.name))
      .filter((name) => !contested.has(name));
    // Only when a pack actually declared some. A machine whose packs carry only
    // the regex floor still runs the compiled-in semantic set, so its builtin
    // reviewer names are the live ones.
    if (declared.length > 0) names = new Set(declared);
  } catch {
    // See above: silence here is the builtin set, not an empty one.
  }
  cached = names;
  return names;
}

/**
 * Drop the cached answer, and set the agent the next one is for. Called by
 * `clearPolicies(cli)`, which every evaluation
 * runs before it registers anything — so a pack installed under a long-lived
 * warm worker is picked up on the next event rather than at the next restart.
 */
export function forgetEffectiveReviewerNames(cli?: string): void {
  cached = null;
  reviewerCli = cli;
}
