/**
 * Which semantic policy set this machine runs: a pack's, or the compiled-in one.
 *
 * ## The replacement rule
 *
 * A pack that declares at least ONE `semantic` entry replaces
 * `SEMANTIC_POLICIES` wholesale. It mirrors the rule already in force for the
 * regex builtins — installing a pack stops the compiled builtins registering —
 * and it exists for the same reason: one source of truth, so a name collision
 * between a pack's `destructive-deletion` and the builtin of that name cannot
 * arise, and `reviewedBy: ["destructive-deletion"]` in a pack manifest cannot
 * silently mean the builtin's question set instead of the pack's.
 *
 * Two packs that both declare entries CONCATENATE; a name declared by two packs
 * keeps the first and drops the later one, because the answer map is keyed by
 * policy name and the second would overwrite the first's questions in the
 * compiled request.
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
import { INJECTION_PROBE, SCOPE_PROBE, SEMANTIC_POLICIES, TASK_PROBES } from "./policies";
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
 * The real sixteen use 19,787 characters at their worst, so this is not a
 * constraint on the set we ship. It is the ceiling on what a stranger's pack may
 * ask for.
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

export interface ResolvedSemanticPolicies {
  policies: ReadonlyArray<SemanticPolicy>;
  /** True when a pack supplied the set, so the compiled-in one is not in play. */
  fromPack: boolean;
  /** One line per dropped policy. Diagnostics; nothing here changes a verdict. */
  errors: string[];
}

/** Turn one validated manifest entry into a policy the compiler can use. */
function toSemanticPolicy(entry: SemanticManifestEntry): SemanticPolicy {
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
  };
}

/**
 * The semantic set these packs declare, or the compiled-in set when none of them
 * declares any.
 *
 * Pure: it takes the packs rather than reading them, so the caller that already
 * has them does not read `installed.json` a second time and a test does not need
 * a filesystem.
 */
export function semanticPoliciesFromPacks(
  packs: ReadonlyArray<Pick<ResolvedPack, "id" | "semantic">>,
): ResolvedSemanticPolicies {
  const declared = packs.filter((p) => packSemantic(p).length > 0);
  if (declared.length === 0) return { policies: SEMANTIC_POLICIES, fromPack: false, errors: [] };

  const policies: SemanticPolicy[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  for (const pack of declared) {
    for (const entry of packSemantic(pack)) {
      if (seen.has(entry.name)) {
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
        continue;
      }
      try {
        policies.push(toSemanticPolicy(entry));
      } catch (err) {
        errors.push(`pack ${pack.id} semantic policy ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      seen.add(entry.name);
      spent += cost;
    }
  }

  // Every entry a declaring pack shipped was unusable. The compiled-in set is
  // the honest answer — it is what the machine ran yesterday — and it is also
  // the safe one: what a pack's regex half names in `reviewedBy` will not match
  // it, so those policies stay hard rather than being cleared by questions
  // nobody validated.
  if (policies.length === 0) return { policies: SEMANTIC_POLICIES, fromPack: false, errors };
  return { policies, fromPack: true, errors };
}

const warned = new Set<string>();

/**
 * The live set, read from the installed packs.
 *
 * Called from `prepareSemantic`, so only on a machine that has a Jev config and
 * is preparing a request. It re-reads the manifest rather than caching: the
 * daemon's warm worker lives for hours, a pack can be installed or upgraded
 * under it, and `readInstalledPacks` re-verifies each artifact digest for
 * exactly that reason. The read costs one digest per pack against a call that is
 * about to spend up to three seconds on the network.
 *
 * Never throws. An unreadable manifest yields the compiled-in set, which is the
 * same fail-open posture every other reader of that file takes, and here it also
 * fails in the safe direction: the set a pack's `reviewedBy` names is not the
 * builtin set, so nothing gets cleared by a policy nobody could read.
 */
export function resolveSemanticPolicies(): ReadonlyArray<SemanticPolicy> {
  let packs: ReadonlyArray<ResolvedPack> = [];
  let manifestErrors: string[] = [];
  try {
    const read = readInstalledPacks();
    packs = read.packs;
    manifestErrors = read.warnings ?? [];
  } catch {
    return SEMANTIC_POLICIES;
  }
  const resolved = semanticPoliciesFromPacks(packs);
  // Once per process per message, like `warnAuthority`: this runs on every gate
  // event, and in the warm worker that is every tool call of every session.
  for (const message of [...manifestErrors, ...resolved.errors]) {
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
