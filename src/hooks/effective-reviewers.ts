/**
 * The semantic checks a `reviewedBy` may name ON THIS MACHINE.
 *
 * ## Only what an installed pack — or FailproofAI Cloud — declares
 *
 * The npm package ships no Jev checks, so no name is a reviewer by default. A
 * `reviewedBy` is honoured only for checks some installed pack declares — in
 * practice `FailproofAI/jev-policies`, which the core pack's fifteen
 * `reviewable` policies name — or a FailproofAI Cloud Jev policy deployed to
 * this machine declares (a `both` policy's JS half names its own checks; see
 * `withCloudSemantic`). With no such pack the set is EMPTY, every policy
 * registers `hard`, and nothing Jev says can clear a regex verdict. That is the
 * fail-safe direction, and it is also what keeps Jev inert on a machine that
 * never installed its checks: `jevChecksInstalled` below is the hook path's
 * gate for starting a review at all.
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
import { readCloudJevPolicies, type CloudJevRead, type CloudSemanticPolicySet } from "./cloud-managed-policies";

let cached: ReadonlySet<string> | null = null;
let cachedContested: ReadonlyMap<string, string[]> = new Map();
/** The Cloud Jev read behind `cached`, for the same registration pass. */
let cachedCloud: CloudJevRead | null = null;
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
    const sources = withCloudSemantic(jevPacks(readInstalledPacks().packs, reviewerCli), cloudJevForPass().sets).sources;
    names = reviewerNamesFor(sources);
    cachedContested = contestedSemanticNames(sources);
  } catch {
    // See above: an unreadable manifest declares no checks.
  }
  cached = names;
  return names;
}

/**
 * The FailproofAI Cloud Jev policies `active.json` names, read once per
 * registration pass — the same lifetime as the reviewer set built from them, so
 * the two cannot describe different deployments. Never throws.
 */
export function cloudJevForPass(): CloudJevRead {
  if (!cachedCloud) {
    try {
      cachedCloud = readCloudJevPolicies();
    } catch {
      // It never throws by contract; this is for the hook path's callers
      // outside any `try`, where a throw would cost the event its answer.
      cachedCloud = { sets: [], semanticIds: [], jevMode: null, errors: [] };
    }
  }
  return cachedCloud;
}

/**
 * Installed packs ∪ FailproofAI Cloud Jev policies, as ONE list of semantic
 * sources for the reviewer set, the question set and the contest.
 *
 * ## Cloud wins a name clash
 *
 * A check name both a Cloud policy and an installed pack declare is the Cloud
 * one's: the pack's same-named entry is dropped here (and `shadowed` says so,
 * once per pack and name). Left in, the two declarations would CONTEST the name
 * and it would be asked for nobody — so a pack could switch off an org's
 * centrally deployed check by declaring its name, which is the same "local
 * config cannot disable a central assignment" rule Cloud JS policies follow.
 *
 * A reserved name is the exception, in both directions: Cloud is never
 * first-party, so its claim to one of FailproofAI's sixteen names is void
 * (`isReservedClaim`) and shadows nothing — FailproofAI's own pack keeps it.
 *
 * Cloud sets come first in the list; `semanticPoliciesFromPacks` still spends
 * the one question budget on first-party packs before anyone else. Pure.
 */
export function withCloudSemantic<T extends Pick<ResolvedPack, "id" | "semantic"> & { source?: string }>(
  packs: ReadonlyArray<T>,
  cloud: ReadonlyArray<CloudSemanticPolicySet>,
): { sources: Array<T | CloudSemanticPolicySet>; shadowed: string[] } {
  if (cloud.length === 0) return { sources: [...packs], shadowed: [] };
  const cloudNames = new Map<string, string>();
  for (const set of cloud) {
    for (const entry of set.semantic) {
      if (!isReservedClaim(set, entry.name) && !cloudNames.has(entry.name)) cloudNames.set(entry.name, set.source);
    }
  }
  const shadowed: string[] = [];
  const kept = packs.map((pack) => {
    const semantic = pack.semantic ?? [];
    const clashing = semantic.filter((entry) => cloudNames.has(entry.name));
    if (clashing.length === 0) return pack;
    for (const entry of clashing) {
      shadowed.push(
        `pack ${pack.id} declares Jev check ${entry.name}, which FailproofAI Cloud policy ` +
          `${cloudNames.get(entry.name)} also declares — the Cloud one is asked, the pack's is not`,
      );
    }
    return { ...pack, semantic: semantic.filter((entry) => !cloudNames.has(entry.name)) };
  });
  return { sources: [...cloud, ...kept], shadowed };
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
    return reviewerNamesFor(withCloudSemantic(jevPacks(readInstalledPacks().packs), readCloudJevPolicies().sets).sources).size > 0;
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
export function forgetEffectiveReviewerNames(cli?: string): void {
  cached = null;
  cachedCloud = null;
  reviewerCli = cli;
}
