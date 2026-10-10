/**
 * The semantic checks a `reviewedBy` may name ON THIS MACHINE.
 *
 * ## Only what an installed pack declares
 *
 * The npm package ships no Jev checks, so no name is a reviewer by default. A
 * `reviewedBy` is honoured only for checks some installed pack declares — in
 * practice `FailproofAI/jev-policies`, which the core pack's fifteen
 * `reviewable` policies name. With no such pack the set is EMPTY, every policy
 * registers `hard`, and nothing Jev says can clear a regex verdict. That is the
 * fail-safe direction, and it is also what keeps Jev inert on a machine that
 * never installed its checks: `jevChecksInstalled` below is the hook path's
 * gate for starting a review at all.
 *
 * ## …and a FailproofAI Cloud `both` policy's own Cloud checks
 *
 * A `both` policy's JS half names its own Jev checks, which run on FailproofAI
 * Cloud and never reach this machine (CONTRACT C10). While Cloud's Jev mode
 * asks (`observe`/`enforce`), those names are reviewers too — but only as
 * `cloud:<policyId>/<name>` (`cloudReviewerName`), which the Cloud review files
 * that policy's own Cloud outcomes under. An installed pack's check of the same
 * name is a different reviewer and can never clear it.
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
import { NO_REVIEWERS, SEMANTIC_REVIEWER_NAMES } from "./policy-authority";
import { cloudReviewerNames, readCloudAuthorityInputs, readCloudJevMode } from "./cloud-managed-policies";
import type { AgentIdentity } from "./agent-targets";

let cached: ReadonlySet<string> | null = null;
let cachedContested: ReadonlyMap<string, string[]> = new Map();
/** The agent the current registration pass is for; see {@link forgetEffectiveReviewerNames}. */
let reviewerCli: string | undefined;
let reviewerAgent: AgentIdentity | null = null;

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
  const claims = new Map<string, { form: string; ids: string[] }>();
  const contested = new Map<string, string[]>();
  for (const pack of packs) {
    for (const entry of pack.semantic ?? []) {
      // Void, so not a claim either: see `isReservedClaim`.
      if (isReservedClaim(pack, entry.name)) continue;
      const form = canonical(entry);
      const claim = claims.get(entry.name);
      if (claim === undefined) {
        claims.set(entry.name, { form, ids: [pack.id] });
        continue;
      }
      claim.ids.push(pack.id);
      // The array is the live one, so a third claimant is named too.
      if (claim.form !== form) contested.set(entry.name, claim.ids);
    }
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
 * One of FailproofAI's sixteen check names (`SEMANTIC_REVIEWER_NAMES`) declared
 * by a pack that is not FailproofAI's. Core and user policies name those checks
 * in `reviewedBy`, so the third party's
 * question would become the reviewer that clears them — an `instruct`-mode
 * `destructive-deletion` beside the core pack turned `block-rm-rf` into a
 * warning. The claim is void: never asked, never a reviewer, and never a
 * second declaration that contests FailproofAI's own, which would switch off a
 * deny the regex tier does not have. The reviewer set, the question set and
 * the contest all apply it.
 */
export function isReservedClaim(pack: { source?: string }, name: string): boolean {
  return SEMANTIC_REVIEWER_NAMES.has(name) && !isFirstPartyPack(pack);
}

/**
 * The semantic check names the installed packs declare — the only names a
 * `reviewedBy` is honoured for on this machine. Empty when no pack declares any.
 *
 * A name two packs claim differently is left out — see
 * {@link contestedSemanticNames} — and so is one of FailproofAI's names claimed
 * by anyone else ({@link isReservedClaim}).
 *
 * Never throws: an unreadable manifest declares nothing, so the set is empty and
 * every policy stays `hard`. There is no compiled-in set to fall back to.
 */
export function effectiveReviewerNames(): ReadonlySet<string> {
  if (cached) return cached;
  let names: ReadonlySet<string> = NO_REVIEWERS;
  cachedContested = new Map();
  try {
    const packs = jevPacks(readInstalledPacks().packs, reviewerCli);
    names = reviewerNamesFor(packs);
    cachedContested = contestedSemanticNames(packs);
  } catch {
    // See above: an unreadable manifest declares no checks.
  }
  try {
    // Both reads answer "nothing" for a file they cannot use; guarded anyway,
    // because a throw here would cost the registration pass — every policy.
    const cloud = cloudReviewerNames(readCloudAuthorityInputs(reviewerAgent), readCloudJevMode());
    if (cloud.length > 0) names = new Set([...names, ...cloud]);
  } catch {
    // No Cloud reviewers: every `both` policy stays hard.
  }
  cached = names;
  return names;
}

/** The contest behind {@link effectiveReviewerNames}' answer, so a refusal can name it. */
export function contestedReviewerNames(): ReadonlyMap<string, string[]> {
  effectiveReviewerNames();
  return cachedContested;
}

/**
 * Whether any installed pack gives Jev something to ask. False on a machine
 * with no pack declaring a `semantic` entry — the vanilla install — and then
 * the hook path does not start a Jev review at all: no request, no intent
 * capture, exactly as if Jev were unconfigured. `failproofai policies add
 * FailproofAI/jev-policies` is what turns it true.
 *
 * Read off the same cached set registration just used, so it costs nothing on
 * the hook path and cannot disagree with which policies registered reviewable.
 */
export function jevChecksInstalled(): boolean {
  return effectiveReviewerNames().size > 0;
}

/**
 * The same question for a CLI command, read fresh rather than from the
 * registration cache (which only the hook path fills): any agent, packs as
 * `jevPacks` narrows them. Never throws; an unreadable manifest has none.
 */
export function jevChecksDeclared(): boolean {
  try {
    return reviewerNamesFor(jevPacks(readInstalledPacks().packs)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The reviewer set for the packs taking part: every usable name they declare. Pure.
 *
 * Manifest-only: it cannot see a check `semanticPoliciesFromPacks` drops for the
 * question budget, because measuring questions means loading the semantic
 * modules this hook-path file must not reach. That overcount is fail-safe — a
 * dropped check is never answered, so it never clears — and the diagnostic
 * (`surveyReviewableCoverage`) asks the resolver instead.
 */
export function reviewerNamesFor(
  packs: ReadonlyArray<Pick<ResolvedPack, "id" | "semantic"> & { source?: string }>,
): ReadonlySet<string> {
  const contested = contestedSemanticNames(packs);
  const declared = packs
    .flatMap((p) => (p.semantic ?? []).filter((s) => !isReservedClaim(p, s.name)).map((s) => s.name))
    .filter((name) => !contested.has(name));
  // Nothing usable declared: nothing is asked, so nothing may clear.
  if (declared.length === 0) return NO_REVIEWERS;
  return new Set(declared);
}

/**
 * Drop the cached answer, and set the agent the next one is for. Called by
 * `clearPolicies(cli)`, which every evaluation
 * runs before it registers anything — so a pack installed under a long-lived
 * warm worker is picked up on the next event rather than at the next restart.
 */
export function forgetEffectiveReviewerNames(cli?: string, agent: AgentIdentity | null = null): void {
  cached = null;
  reviewerCli = cli;
  reviewerAgent = agent;
}
