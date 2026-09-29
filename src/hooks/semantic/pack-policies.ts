/**
 * Which Jev checks this machine asks: the ones its installed packs declare, and
 * nothing else.
 *
 * ## No pack, no questions
 *
 * The npm package ships NO Jev checks. The sixteen FailproofAI writes are
 * published as the `FailproofAI/jev-policies` pack, and a machine asks them only
 * after `failproofai policies add FailproofAI/jev-policies`. With no installed
 * pack declaring a `semantic` entry the set is EMPTY: nothing is asked, no
 * request is sent (the hook path does not even start a review —
 * `jevChecksInstalled` in `effective-reviewers.ts`), and no regex verdict can be
 * cleared, because the reviewer names come from the same packs and there are
 * none. That holds whether or not the machine is Jev-configured or connected to
 * FailproofAI Cloud: configuring a provider says where to ask, a pack says what.
 *
 * Several declaring packs CONCATENATE, FailproofAI's first. A name declared by
 * two packs keeps the first and drops the later one, because the answer map is
 * keyed by policy name and the second would overwrite the first's questions in
 * the compiled request. The sixteen FailproofAI names are reserved: a pack not
 * installed from a FailproofAI repository that declares one is ignored for that
 * name (`isReservedClaim`), so it cannot become the question that clears the
 * core pack's policies.
 *
 * ## Where the manifest ends and this begins
 *
 * `pack-manifest.ts` validates the shape — names, modes, probe ids, caps it can
 * check by counting — because it runs on every hook event and may not touch a
 * semantic module. Everything that needs the semantic side is here: binding a
 * precondition NAME to its predicate, and the request budget, which is a
 * character count and not a probe count.
 *
 * ## Dropping, not failing
 *
 * Every failure here drops ONE policy and records why. A semantic policy is what
 * CLEARS a reviewable regex verdict, so losing one leaves the regex deny
 * standing: noisier, never weaker. Dropping the whole set would be the same
 * direction but much louder, and failing the pack would deny every event its
 * regex policies cover — a machine locked out over a typo in the half of the
 * system whose job is to let more real work through.
 */
import { readCloudJevPolicies, type CloudPolicyError, type CloudSemanticPolicySet } from "../cloud-managed-policies";
import { contestedSemanticNames, isFirstPartyPack, isReservedClaim, jevPacks, withCloudSemantic } from "../effective-reviewers";
import { hookLogWarn } from "../hook-logger";
import {
  packSemantic,
  readInstalledPacks,
  semanticQuestions,
  type ResolvedPack,
  type SemanticManifestEntry,
} from "../pack-manifest";
import { MAX_REQUEST_CHARS, userAskedQuestion } from "./compile";
import { MAX_STATE_CHARS } from "./envelope";
import { INJECTION_PROBE, SCOPE_PROBE, TASK_PROBES } from "./policies";
import { preconditionFor } from "./preconditions";
import { isPackPreconditionName } from "./precondition-names";
import type { NoulQuestion, SemanticPolicy } from "./types";

/** The question object `compile.ts` builds for one probe. Shared so the measurement matches. */
function noulOf(probe: { instructions: string; criteria?: { true: string; false: string } }): NoulQuestion {
  return { type: "noul", instructions: probe.instructions, ...(probe.criteria ? { criteria: { ...probe.criteria } } : {}) };
}

/**
 * What the questions a call does NOT get to choose already cost: the injection
 * probe, the v0 scope probe and the v1 task probes, whichever set is larger.
 *
 * Reserved out of the budget below because they are in every request that asks
 * anything, so a pack budget that ignored them would be over by their size on
 * every call.
 */
const GLOBAL_QUESTION_CHARS = Math.max(
  JSON.stringify({ [INJECTION_PROBE.id]: noulOf(INJECTION_PROBE), [SCOPE_PROBE.id]: noulOf(SCOPE_PROBE) }).length,
  JSON.stringify(
    Object.fromEntries([INJECTION_PROBE, ...TASK_PROBES].map((p) => [p.id, noulOf(p)])),
  ).length,
);

/**
 * How many characters of questions every installed pack may contribute,
 * together.
 *
 * DERIVED, not chosen. `prepareSemantic` checks one number — the serialized
 * request against `MAX_REQUEST_CHARS` — and the state side of that is already
 * spent to the last character by `buildEnvelope` (`MAX_STATE_CHARS`), so what is
 * left for questions is the difference, minus the globals above. A pack set that
 * fits this fits at FULL state size, which is the only size worth budgeting for:
 * the state is a function of the caps and not of what the agent sent, so a
 * request that only fits on small inputs is a request that intermittently
 * doesn't.
 *
 * Deriving it is the point. The count caps it replaced (24 policies, 80 probes)
 * were set without reference to the envelope and permitted a question set 23,032
 * characters past what a request can carry — at which point `PreparedCall
 * .oversized` stops meaning "our own question set overran" and starts meaning
 * "somebody installed a big pack", and the flag that was supposed to be
 * unreachable from ordinary work becomes routine.
 *
 * `FailproofAI/jev-policies` uses `JEV_POLICIES_QUESTION_CHARS` of it, so this
 * is not a constraint on the set we ship. FailproofAI Cloud's checks spend the
 * budget first, then FailproofAI's packs, so a stranger's pack installed beside
 * those gets what they leave (see `semanticPoliciesFromPacks`).
 *
 * FailproofAI Cloud measures a version's questions with a mirror of
 * `questionChars` and refuses one that cannot fit (CONTRACT C9.2); the machine's
 * count is the authoritative one.
 */
export const MAX_PACK_QUESTION_CHARS = MAX_REQUEST_CHARS - MAX_STATE_CHARS - GLOBAL_QUESTION_CHARS;

/**
 * The compiled cost of one entry's questions, measured the way
 * `prepareSemantic` measures the request: the serialized question map.
 *
 * `user_asked` is counted for an overridable policy even though the shipped
 * path is intent v1, which does not ask it. A budget is worst-case over the
 * modes a machine can run, and the alternative — a set that fits under v1 and
 * overruns the moment anything asks in v0 — is a size cliff that depends on a
 * flag rather than on the pack.
 */
export function questionChars(entry: SemanticManifestEntry): number {
  const questions: Record<string, NoulQuestion> = {};
  for (const probe of semanticQuestions(entry)) questions[`${entry.name}.${probe.id}`] = noulOf(probe);
  if (entry.userCanOverride) {
    // It reads `title` and nothing else (`actionPhrase` in `compile.ts`), so a
    // stub is the honest argument here — building a whole `SemanticPolicy` to
    // measure one string would invite it to drift from the real conversion.
    questions[`${entry.name}.user_asked`] = userAskedQuestion({ title: entry.title } as SemanticPolicy);
  }
  return JSON.stringify(questions).length;
}

/**
 * What `FailproofAI/jev-policies`' sixteen checks spend of that budget, which a
 * pack from anyone else shares with them on a machine that has both installed.
 * Measured, not chosen: `pack-semantic-registry.test.ts` pins it to the
 * reference copy in `__tests__/fixtures/jev-policies.ts`. Only `publish` reads
 * it, to warn an author before release; the machine measures what is actually
 * installed.
 */
export const JEV_POLICIES_QUESTION_CHARS = 18490;

export interface ResolvedSemanticPolicies {
  policies: ReadonlyArray<SemanticPolicy>;
  /** True when a pack supplied any of the set. */
  fromPack: boolean;
  /** One line per dropped policy. Diagnostics; nothing here changes a verdict. */
  errors: string[];
  /**
   * The checks the question budget dropped, structured, for FailproofAI Cloud's
   * report (`jevBudgetErrors`). `over` is how many characters past the budget
   * asking it as well would have been.
   */
  budgetDropped: Array<{ source: { id: string; policyId?: string; policyVersion?: number }; name: string; over: number }>;
}

/** A FailproofAI Cloud Jev policy in the resolver's input. Pack ids cannot contain `:`. */
function isCloudSet(p: { id: string }): boolean {
  return p.id.startsWith("cloud:");
}

/** Turn one validated manifest entry into a policy the compiler can use. */
function toSemanticPolicy(entry: SemanticManifestEntry, pack: { id: string; version?: string }): SemanticPolicy {
  // An unknown precondition name DROPS the policy (the caller catches this),
  // rather than compiling it with no gate at all. Ungating would be the wider
  // direction, not the weaker one, but it is not what the author asked for: a
  // question written for the one case its gate selects would then be put to Jev
  // on every call, and nothing would say so. Unreachable through
  // `parsePackSemanticPolicy`, which refuses the name; reachable if the two
  // precondition files ever drift, which is what this is here for.
  const name = entry.precondition;
  if (name !== undefined && !isPackPreconditionName(name)) {
    throw new Error(`precondition ${JSON.stringify(name)} is not a name this build has`);
  }
  const precondition = name === undefined ? null : preconditionFor(name);
  return {
    name: entry.name,
    title: entry.title,
    appliesTo: entry.appliesTo,
    mode: entry.mode,
    userCanOverride: entry.userCanOverride,
    probes: entry.probes,
    ...(entry.exempt ? { exempt: entry.exempt } : {}),
    // Absent, never `() => true`: `selectPolicies` treats an absent precondition
    // as "ask", so `precondition: "always"` and an omitted field have to compile
    // to the identical policy.
    ...(precondition ? { precondition } : {}),
    guidance: entry.guidance,
    origin: { packId: pack.id, ...(pack.version ? { packVersion: pack.version } : {}) },
  };
}

/**
 * The semantic set these packs declare — empty when none of them declares any.
 *
 * Pure: it takes the packs rather than reading them, so the caller that already
 * has them does not read `installed.json` a second time and a test does not need
 * a filesystem.
 */
export function semanticPoliciesFromPacks(
  packs: ReadonlyArray<Pick<ResolvedPack, "id" | "semantic"> & { source?: string; version?: string }>,
): ResolvedSemanticPolicies {
  const declared = packs.filter((p) => packSemantic(p).length > 0);
  if (declared.length === 0) return { policies: [], fromPack: false, errors: [], budgetDropped: [] };

  // Who spends the budget first (CONTRACT C9.2): FailproofAI Cloud's checks —
  // an org's central assignment, and the only ones a deployment's `both`
  // policies can be reviewed by — then first-party packs, so install order
  // cannot starve them, then everyone else. Installed-pack checks are therefore
  // what an over-budget machine drops first.
  const ordered = [
    ...declared.filter((p) => isCloudSet(p)),
    ...declared.filter((p) => !isCloudSet(p) && isFirstPartyPack(p)),
    ...declared.filter((p) => !isCloudSet(p) && !isFirstPartyPack(p)),
  ];
  const policies: SemanticPolicy[] = [];
  const errors: string[] = [];
  const budgetDropped: ResolvedSemanticPolicies["budgetDropped"] = [];
  const seen = new Set<string>();
  // A name two packs declare DIFFERENTLY is asked for nobody. Keeping the first
  // was the escalation: the question that decides another pack's policies came
  // from whichever pack was listed first, so installing a permissive
  // `production-infra-change` beside a real one cleared every policy reviewable
  // by that name. Computed by `effectiveReviewerNames`'s own function, because
  // the name it refuses in the reviewer set and the question refused here have to
  // be the same name — a check in the set with nobody's question, or a question
  // nobody may name, are both worse than neither.
  const contested = contestedSemanticNames(declared);
  let spent = 0;
  for (const pack of ordered) {
    for (const entry of packSemantic(pack)) {
      if (isReservedClaim(pack, entry.name)) {
        errors.push(
          `pack ${pack.id} declares semantic policy ${entry.name}, a name reserved for FailproofAI's own Jev checks, ` +
            `so that pack's version of it is never asked`,
        );
        continue;
      }
      const claimants = contested.get(entry.name);
      if (claimants) {
        // Once per name: every claimant reaches here with the same message.
        const message =
          `packs ${claimants.join(" and ")} declare different semantic policies named ${entry.name}, so it is asked ` +
          `for neither of them and no policy can be cleared by that name`;
        if (!errors.includes(message)) errors.push(message);
        continue;
      }
      if (seen.has(entry.name)) {
        // Same name, same declaration — a fork or a re-publish of one pack, where
        // the question is identical either way. Kept once, said once.
        errors.push(`pack ${pack.id} declares semantic policy ${entry.name}, which another pack already declared`);
        continue;
      }
      const cost = questionChars(entry);
      if (spent + cost > MAX_PACK_QUESTION_CHARS) {
        errors.push(
          `pack ${pack.id} semantic policy ${entry.name} was dropped: its questions need ${cost} characters and ` +
            `only ${Math.max(0, MAX_PACK_QUESTION_CHARS - spent)} of the ${MAX_PACK_QUESTION_CHARS}-character ` +
            `question budget one Jev request has are left`,
        );
        const cloud = pack as { policyId?: unknown; policyVersion?: unknown };
        budgetDropped.push({
          source: {
            id: pack.id,
            ...(typeof cloud.policyId === "string" ? { policyId: cloud.policyId } : {}),
            ...(typeof cloud.policyVersion === "number" ? { policyVersion: cloud.policyVersion } : {}),
          },
          name: entry.name,
          over: spent + cost - MAX_PACK_QUESTION_CHARS,
        });
        continue;
      }
      try {
        policies.push(toSemanticPolicy(entry, pack));
      } catch (err) {
        errors.push(`pack ${pack.id} semantic policy ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      seen.add(entry.name);
      spent += cost;
    }
  }

  // Every entry a declaring pack shipped was unusable: nothing is asked, and
  // `fromPack` says no pack supplied anything. There is no compiled-in set to
  // fall back to, and that is the safe direction — nothing is asked, so nothing
  // a `reviewedBy` names is ever answered, and those policies stay hard.
  return { policies, fromPack: policies.length > 0, errors, budgetDropped };
}

/**
 * Every check the one Jev question budget drops on this machine, as
 * `errors.json` entries (CONTRACT C9.2): a Cloud check as `kind: "jev"` under
 * its policy's id and version, an installed pack's as `kind: "daemon"` under
 * `pack:<packId>`, each with `jev_budget: dropped <name> (<n> chars over)`.
 *
 * Measured over every agent's view — `jevPacks(packs)` with no agent, as the
 * rest of the report is — so it does not flip with each event's agent.
 *
 * Once per change of what it is measured over: the Cloud sets (by digest) and
 * the packs (by id, version, digest, effect and agents). The answer is a pure
 * function of those, and the question set is otherwise re-measured on every
 * event of every session in the warm worker.
 */
export function jevBudgetErrors(
  packs: ReadonlyArray<ResolvedPack>,
  cloud: ReadonlyArray<CloudSemanticPolicySet>,
): CloudPolicyError[] {
  const key = JSON.stringify([
    cloud.map((c) => [c.id, c.version, c.sha256]),
    packs.map((p) => [p.id, p.version, p.sha256, p.effect, p.clis]),
  ]);
  if (budgetMemo?.key === key) return budgetMemo.value;
  const resolved = semanticPoliciesFromPacks(withCloudSemantic(jevPacks(packs), cloud).sources);
  const value = resolved.budgetDropped.map(({ source, name, over }): CloudPolicyError => {
    const message = `jev_budget: dropped ${name} (${over} chars over)`;
    return source.policyId !== undefined
      ? { id: source.policyId, version: source.policyVersion ?? null, kind: "jev", message }
      : { id: `pack:${source.id}`, version: null, kind: "daemon", message };
  });
  budgetMemo = { key, value };
  return value;
}

let budgetMemo: { key: string; value: CloudPolicyError[] } | null = null;

const warned = new Set<string>();

/**
 * The live set, read from the installed packs and the FailproofAI Cloud Jev
 * policies deployed to this machine (`active.json` `semanticPolicies`).
 *
 * Called from `prepareSemantic`, so only on a machine that has a Jev config and
 * is preparing a request. It re-reads the manifest rather than caching: the
 * daemon's warm worker lives for hours, a pack can be installed or upgraded
 * under it, and `readInstalledPacks` re-verifies each artifact digest for
 * exactly that reason. The read costs one digest per pack against a call that is
 * about to spend up to three seconds on the network.
 *
 * Never throws. An unreadable manifest yields NO checks: nothing is asked and
 * nothing is cleared, so every regex verdict stands. There is deliberately no
 * compiled-in set to fall back to — the package ships none.
 */
export function resolveSemanticPolicies(cli?: string): ReadonlyArray<SemanticPolicy> {
  let packs: ReadonlyArray<ResolvedPack> = [];
  let manifestErrors: string[] = [];
  try {
    const read = readInstalledPacks();
    packs = read.packs;
    manifestErrors = read.warnings ?? [];
  } catch {
    return [];
  }
  // Installed packs ∪ FailproofAI Cloud Jev policies, Cloud winning a name
  // clash (`withCloudSemantic`), through the one budget below. The Cloud read
  // never throws; what it dropped it has already logged once and reported.
  const merged = withCloudSemantic(jevPacks(packs, cli), readCloudJevPolicies().sets);
  const resolved = semanticPoliciesFromPacks(merged.sources);
  // Once per process per message, like `warnAuthority`: this runs on every gate
  // event, and in the warm worker that is every tool call of every session.
  for (const message of [...manifestErrors, ...merged.shadowed, ...resolved.errors]) {
    if (warned.has(message)) continue;
    warned.add(message);
    hookLogWarn(message);
  }
  return resolved.policies;
}

/** Forget which warnings were already said. Tests only. */
export function _resetSemanticWarningsForTest(): void {
  warned.clear();
}
