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
import { readInstalledPacks } from "./pack-manifest";
import { SEMANTIC_REVIEWER_NAMES } from "./policy-authority";

let cached: ReadonlySet<string> | null = null;

/**
 * The installed packs' semantic policy names when any pack declares some, and
 * this build's compiled-in set otherwise.
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
    const declared = readInstalledPacks().packs.flatMap((p) => (p.semantic ?? []).map((s) => s.name));
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
 * Drop the cached answer. Called by `clearPolicies()`, which every evaluation
 * runs before it registers anything — so a pack installed under a long-lived
 * warm worker is picked up on the next event rather than at the next restart.
 */
export function forgetEffectiveReviewerNames(): void {
  cached = null;
}
