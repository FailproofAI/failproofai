/**
 * How much of what this machine enforces Jev is allowed to CLEAR — the
 * diagnostic half of `policy-authority.ts`, and nothing else.
 *
 * ## The silence this exists to break
 *
 * Authority decides one thing: whether Jev may clear a regex policy's deny or
 * instruct (`combine.ts`, which returns early unless the authority is
 * `reviewable`). Absent means `hard`, and that default is right — it is what
 * keeps an unknown pack, cloud or custom policy from being weakened by a
 * classifier nobody asked about it.
 *
 * It is also completely silent. `authority` and `reviewedBy` reach a pack
 * through its manifest, and the only thing that writes them there is
 * `scripts/build-policy-pack.mjs`, which ships WITH this release. So a pack
 * published before it declares none, every policy in it resolves to `hard`
 * with nothing downgraded, and `warnAuthority` — which only speaks when a
 * `reviewable` declaration was not honored — has nothing to say. The result a
 * customer gets is the deny half of the two-tier evaluator working exactly as
 * documented, the clear half unable to fire once, and no diagnostic anywhere:
 * `jev status` says `on`, the fallback rate says the calls are being answered,
 * and `cleared` says `nothing` forever.
 *
 * This module counts. It changes no policy's authority and no verdict, it is
 * never imported from the hook path, and a machine with no `jev.json` never
 * reaches a caller of it.
 *
 * ## What "enabled" means here
 *
 * The same thing it means in `handler.ts`, read from the same files, without
 * loading or executing a policy:
 *
 * - **Installed packs** — each pack's manifest entries, narrowed by its
 *   `enabled` selection (absent means the whole pack). A pack's `clis`
 *   narrowing is NOT applied: there is no agent CLI in a status command, and
 *   the honest answer to "what could Jev clear on this machine" spans all of
 *   them.
 * - **Builtins** — this build's catalog, under the same migration shim the
 *   handler applies: they enforce only while no pack is installed. The
 *   `alwaysOn` guard is counted always, because it registers always (and is
 *   hard always, so it can only ever lower the ratio).
 * - **Cloud assignments** — the active deployment's records, whose authority is
 *   declared by whoever deployed them. One record per assignment; an artifact
 *   that registers several hooks is still one central decision.
 *
 * Two things are deliberately NOT counted, and `customFiles` is what says so
 * out loud when it matters:
 *
 * - **Policies from the user's own files.** A custom hook declares its
 *   authority inside the module, so counting one means importing and running
 *   somebody's JavaScript — from a settings page, on every read. The count of
 *   configured custom policy PATHS is reported instead, and the summary says
 *   in words that those policies were not counted.
 * - **A session pause.** It suspends local policy for minutes, and a warning
 *   about a policy set that is coming back shortly would be noise.
 */
import { readActiveCloudManagedPolicies } from "./cloud-managed-policies";
import { jevPacks, reviewerNamesFor } from "./effective-reviewers";
import { configuredCustomPolicyPaths, readMergedHooksConfig } from "./hooks-config";
import { hasInstalledPacks, readInstalledPacks } from "./pack-manifest";
import { resolvePolicyAuthority } from "./policy-authority";
import { POLICY_CATALOG } from "./policy-catalog";
import { normalizePolicyName } from "./policy-registry";
import type { HooksConfig } from "./policy-types";

/** Anything that carries an authority declaration: a catalog entry, a pack entry, a cloud record. */
export interface AuthorityRecord {
  authority?: unknown;
  reviewedBy?: unknown;
  alwaysOn?: boolean;
}

export interface ReviewableCoverage {
  /** Enabled policies whose authority could be read without running code. */
  enabled: number;
  /** Of those, the ones Jev may clear a deny or an instruct from. */
  reviewable: number;
  /** Configured custom policy paths, whose policies are not in the counts above. */
  customFiles: number;
}

/** The command that replaces a pack with one built by this release. */
export const RETAKE_PACK_COMMAND = "failproofai policies add FailproofAI/policies";

/**
 * Count a policy set by the authority it would REGISTER with —
 * `resolvePolicyAuthority`, the rule `registerPolicy` applies — so this cannot
 * report a clear that would not happen or hide one that would.
 *
 * Deliberately not `effectiveAuthority`, the looser §7 contract `jev-review.ts`
 * asks at evaluation time. That one needs a single non-empty name and is right
 * where it is asked, because by then the registry holds a `reviewedBy` that
 * registration already cleaned, and on cleaned records the two rules agree.
 * Nothing counted HERE has been through registration: these records are read
 * straight off a pack manifest, this build's catalog and the cloud deployment.
 * So a declaration naming a check this build does not have — `reviewedBy:
 * ["future-check"]`, which is what a pack built against a NEWER semantic set
 * looks like here — is reviewable to the loose rule and hard in the registry,
 * and counting it would report a clear that can never happen while
 * `reviewableProblem` stayed silent about the machine it exists to warn.
 */
export function countReviewable(
  policies: Iterable<AuthorityRecord>,
  /**
   * The semantic checks that can be asked on this machine. Defaults to the
   * compiled-in set; `surveyReviewableCoverage` passes the pack's when one
   * declares its own, because otherwise this diagnostic reports "0 of 11
   * reviewable" on exactly the machines the feature was built for — the ones
   * running a pack that carries both tiers.
   */
  knownReviewers?: ReadonlySet<string>,
): {
  enabled: number;
  reviewable: number;
} {
  let enabled = 0;
  let reviewable = 0;
  for (const p of policies) {
    enabled += 1;
    if (resolvePolicyAuthority(p, knownReviewers).authority === "reviewable") reviewable += 1;
  }
  return { enabled, reviewable };
}

/**
 * What this machine's enabled policy set looks like to Jev. Reads three files
 * and no policy: see the header for what is in the counts and what is not.
 *
 * Every source is wrapped, and an unreadable one contributes nothing rather
 * than throwing — the same fail-open posture `handler.ts` takes for packs and
 * cloud policies, for the same reason: this is a diagnostic, and one corrupt
 * byte must not replace a settings page with an error boundary.
 */
export function surveyReviewableCoverage(cwd?: string): ReviewableCoverage {
  const records: AuthorityRecord[] = [];

  let packsInstalled = false;
  /**
   * The reviewers a pack brought with it. Collected from the SAME read as the
   * policies rather than through `effectiveReviewerNames()`, which would re-read
   * and re-verify every artifact for an answer already in hand — and would, for
   * one read of a manifest being rewritten underneath, be able to disagree with
   * the records counted here.
   *
   * A pack's `enabled` selection is deliberately not applied: it narrows which
   * of its REGEX policies register, and its semantic set is not selectable.
   */
  let reviewers: ReadonlySet<string> | undefined;
  try {
    packsInstalled = hasInstalledPacks();
    const packs = readInstalledPacks().packs;
    for (const pack of packs) {
      const selected = pack.enabled;
      records.push(...(selected ? pack.policies.filter((p) => selected.includes(p.name)) : pack.policies));
    }
    // Only the packs whose checks registration honours (an observe pack's are
    // not), and minus a name two packs claim differently — the panel and `jev
    // status` would otherwise promise a clear that cannot happen. Same
    // functions, same read, so the two cannot disagree.
    reviewers = reviewerNamesFor(jevPacks(packs));
  } catch {
    // An unreadable manifest enforces nothing; `readInstalledPacks` already
    // reports that to the hook log on the path that cares.
  }

  let config: HooksConfig;
  try {
    config = readMergedHooksConfig(cwd);
  } catch {
    config = { enabledPolicies: [] };
  }
  // The migration shim, exactly as `handler.ts` applies it: this build's
  // builtins enforce only until a pack is installed.
  const legacyEnabled = new Set(packsInstalled ? [] : config.enabledPolicies.map(normalizePolicyName));
  for (const policy of POLICY_CATALOG) {
    if (policy.alwaysOn || legacyEnabled.has(normalizePolicyName(policy.name))) records.push(policy);
  }

  try {
    for (const assignment of readActiveCloudManagedPolicies()) {
      records.push({ authority: assignment.authority, reviewedBy: assignment.reviewedBy });
    }
  } catch {
    // Same fail-open as the handler's own read of this file.
  }

  let customFiles = 0;
  try {
    customFiles = configuredCustomPolicyPaths(config).length;
  } catch {
    customFiles = 0;
  }

  return { ...countReviewable(records, reviewers), customFiles };
}

/**
 * The one line both surfaces show: the count, in the words `jev status` and the
 * dashboard panel must agree on. A non-zero count is worth saying too — it is
 * how someone learns how much of their policy set Jev can act on at all.
 */
export function reviewableSummary(coverage: ReviewableCoverage): string {
  const { enabled, reviewable } = coverage;
  // Said out loud rather than folded into the number, because a custom policy
  // CAN be reviewable and this count would not know: reading that declaration
  // means importing and running the file it lives in.
  const tail = coverage.customFiles > 0 ? " (policies from your own files are not counted)" : "";
  if (enabled === 0) return `No policies are enabled here, so there is nothing for Jev to clear${tail}.`;
  const noun = enabled === 1 ? "1 enabled policy is" : `${enabled} enabled policies are`;
  if (reviewable === 0) return `0 of ${noun} reviewable${tail}.`;
  return `${reviewable} of ${noun} reviewable: Jev may clear a deny or an instruction from those, and from no others${tail}.`;
}

/**
 * Why Jev can never clear anything here, and what fixes it — or null when it
 * can clear something, which needs no explanation.
 *
 * It states the observation before naming the usual cause, because the cause is
 * the usual one and not the only one: a machine can also reach zero by enabling
 * only hard policies, or by having nothing but the self-protection guard. The
 * remedy is the same in each case, and it is one command.
 *
 * Nothing is diagnosed for an empty policy set: there is no clear to lose, and
 * an authority warning to someone who enforces nothing answers a question they
 * did not ask.
 */
export function reviewableProblem(coverage: ReviewableCoverage): string | null {
  if (coverage.enabled === 0 || coverage.reviewable > 0) return null;
  return (
    "Jev can add a deny or an instruction on this machine, but it can never clear one. " +
    "No enabled policy is marked reviewable — a policy pack published before this release carries no such marks — " +
    `so re-take the pack (\`${RETAKE_PACK_COMMAND}\`) to get a marked copy, ` +
    "or enforce this build's builtin policies, which carry them."
  );
}
