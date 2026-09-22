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
 */
export function resolvePolicyAuthority(decl: AuthorityDeclaration | undefined): ResolvedAuthority {
  const declaredReviewable = decl?.authority === "reviewable";
  if (!decl || effectiveAuthority(decl) === "hard") {
    if (!declaredReviewable) return { authority: "hard" };
    return { authority: "hard", downgraded: whyHard(decl!) };
  }
  const names = decl.reviewedBy as unknown[];
  if (!names.every(isName)) {
    return { authority: "hard", downgraded: "reviewedBy is not a list of semantic policy names" };
  }
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
export function authorityProblem(decl: AuthorityDeclaration): string | undefined {
  if (decl.authority !== undefined && decl.authority !== "hard" && decl.authority !== "reviewable") {
    const t = typeof decl.authority;
    return `authority must be "hard" or "reviewable", and is ${t === "string" ? JSON.stringify(decl.authority) : `${/^[aeiou]/.test(t) ? "an" : "a"} ${t}`}`;
  }
  if (decl.reviewedBy !== undefined && !(Array.isArray(decl.reviewedBy) && decl.reviewedBy.every(isName))) {
    return "reviewedBy must be a list of semantic policy names";
  }
  const { downgraded } = resolvePolicyAuthority(decl);
  return downgraded ? `authority "reviewable" was refused — ${downgraded}` : undefined;
}

/**
 * The authority fields a pack MANIFEST should carry for one entry: resolved, as
 * the registry will store them, so the manifest says exactly what takes effect.
 * Throws, naming the entry, on anything {@link authorityProblem} refuses.
 */
export function manifestAuthority(entry: AuthorityDeclaration & { name: string }): {
  authority: PolicyAuthority;
  reviewedBy?: string[];
} {
  const problem = authorityProblem(entry);
  if (problem) throw new Error(`${entry.name}: ${problem}`);
  const { authority, reviewedBy } = resolvePolicyAuthority(entry);
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
 * clear is stricter, never weaker). Otherwise it takes the first declaration
 * that is not reviewable, so a refused one is still reported at registration.
 *
 * Returns `record` itself when its own fields already say that, and a copy with
 * only the two authority fields replaced otherwise. `overruled` is true when
 * some declaration asked for reviewable, validly, and did not get it.
 */
export function withMergedAuthority<T extends AuthorityFields>(
  record: T,
  declarations: ReadonlyArray<AuthorityFields>,
): { merged: T; overruled: boolean } {
  const resolved = declarations.map((d) => resolvePolicyAuthority(d));
  const allReviewable = resolved.length > 0 && resolved.every((r) => r.authority === "reviewable");
  const fields: AuthorityFields = allReviewable
    ? { authority: "reviewable", reviewedBy: [...new Set(resolved.flatMap((r) => r.reviewedBy ?? []))] }
    : fieldsOf(declarations[resolved.findIndex((r) => r.authority !== "reviewable")] ?? {});
  const overruled = !allReviewable && resolved.some((r) => r.authority === "reviewable");
  const same =
    record.authority === fields.authority &&
    JSON.stringify(record.reviewedBy) === JSON.stringify(fields.reviewedBy);
  if (same) return { merged: record, overruled };
  const { authority: _a, reviewedBy: _r, ...rest } = record;
  return { merged: { ...rest, ...fields } as T, overruled };
}

/** The authority fields a record actually carries, and nothing else. */
function fieldsOf(d: AuthorityFields): AuthorityFields {
  return {
    ...(d.authority !== undefined ? { authority: d.authority } : {}),
    ...(d.reviewedBy !== undefined ? { reviewedBy: d.reviewedBy } : {}),
  };
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
