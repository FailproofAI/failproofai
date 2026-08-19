/**
 * Curated policy bundles for the `failproofai config` wizard.
 *
 * Presets are resolved against BUILTIN_POLICIES by category (+ optional extras)
 * so that adding a new builtin to an existing category automatically flows into
 * the matching preset — the wizard stays in sync with the policy catalog with no
 * manual list maintenance. Order here is the order shown in the wizard (before
 * the "Everything" and "Custom…" entries).
 */
import { BUILTIN_POLICIES } from "./builtin-policies";

export interface PolicyPreset {
  id: string;
  label: string;
  description: string;
  /** Categories whose (non-beta) policies are included in this preset. */
  categories: string[];
  /** Extra policy names to include beyond the category members. */
  extra?: string[];
}

export const POLICY_PRESETS: PolicyPreset[] = [
  {
    id: "secrets",
    label: "Secrets & data",
    description:
      "Redact secrets in tool output, block .env & secret-file writes, keep reads inside the repo",
    categories: ["Sanitize", "Environment"],
    extra: ["block-secrets-write"],
  },
  {
    id: "git",
    label: "Git safety",
    description: "Block force-push & pushes to main, warn on history-rewriting git ops",
    categories: ["Git"],
  },
  {
    id: "ship",
    label: "Ship discipline",
    description:
      "Don't let the agent finish until changes are committed, pushed, PR'd and CI is green",
    categories: ["Workflow"],
  },
  {
    id: "infra",
    label: "Cloud & infra",
    description: "Block kubectl / terraform / aws / gcloud / az / helm / gh pipeline commands",
    categories: ["Infra Commands"],
  },
];

/** Resolve a preset id to the concrete list of non-beta builtin policy names it
 * enables. (Beta policies are wizard-excluded by design; reintroduce an
 * includeBeta flag here if a `--beta` wizard path ever lands.) */
export function resolvePreset(id: string): string[] {
  const preset = POLICY_PRESETS.find((p) => p.id === id);
  if (!preset) return [];
  const cats = new Set(preset.categories);
  const fromCategories = BUILTIN_POLICIES.filter(
    (p) => !p.beta && cats.has(p.category),
  ).map((p) => p.name);
  const extras = (preset.extra ?? []).filter((name) =>
    BUILTIN_POLICIES.some((p) => p.name === name && !p.beta),
  );
  return [...new Set([...fromCategories, ...extras])];
}

/** Every non-beta builtin policy (the "Everything" option). */
export function resolveEverything(): string[] {
  return BUILTIN_POLICIES.filter((p) => !p.beta).map((p) => p.name);
}

/**
 * What "Recommended" turns on — the set someone gets for pressing Enter once.
 *
 * WRITTEN OUT, not derived. `defaultEnabled` is the seed for the *policy list*
 * prompt and answers a narrower question ("tick this by default in a list of
 * 40"); this answers "what should guard a machine whose owner did not want to
 * choose". They overlap heavily and are not the same promise, and deriving one
 * from the other would silently change this set every time somebody flipped a
 * flag on an unrelated policy. `recommendedCoversEveryDefault()` keeps them
 * from drifting APART without anyone noticing.
 *
 * Nothing here needs configuring to be useful and nothing here has a common
 * false positive — that is the bar for being in this list, because the person
 * who chose Recommended is the person least equipped to debug a bad deny.
 *
 * Deliberately EXCLUDED, and why:
 *   • Workflow (`require-*-before-stop`) — refuses to let the agent finish
 *     until CI is green. A defensible choice, never a default one, and it does
 *     not fire at all on hermes or goose (see enforcement-capability.ts).
 *   • Infra Commands — blocking kubectl/terraform/aws breaks the day job of
 *     anyone doing infra. That is what the "Cloud & infra" bundle is for.
 *   • block-read-outside-cwd — agents legitimately read outside the repo.
 *   • block-work-on-main — plenty of people work on main on purpose.
 *   • the warn-* family — non-blocking and cheap, but ten warnings is noise,
 *     and a warning nobody reads is worse than one that was never shown.
 */
export const RECOMMENDED_POLICIES: readonly string[] = [
  // Secrets never reach the model, and never reach disk.
  "sanitize-jwt",
  "sanitize-api-keys",
  "sanitize-connection-strings",
  "sanitize-private-key-content",
  "sanitize-bearer-tokens",
  "protect-env-vars",
  "block-env-files",
  "block-secrets-write",
  // Prevention, not just scrubbing. PostToolUse is observation-only on 10 of
  // the 12 CLIs (see enforcement-capability.ts), so a sanitize-* deny does not
  // keep a secret out of the model's context on most machines. These two run at
  // PreToolUse, which blocks on all 12 — they are what makes the promise above
  // this list true rather than aspirational.
  "block-secret-in-write",
  "block-credential-files",
  // The agent cannot disable its own guardrails.
  "block-self-pause",
  "block-failproofai-commands",
  // Commands that are unrecoverable when they are wrong.
  "block-sudo",
  "block-curl-pipe-sh",
  "block-rm-rf",
  // Git history stays recoverable. `--force-with-lease` is still allowed.
  "block-push-master",
  "block-force-push",
];

/**
 * Every `defaultEnabled` policy that Recommended does NOT include.
 *
 * Empty today, and a test asserts it stays that way. The point is the day
 * someone adds a new default-on builtin: Recommended is a separate list and
 * would silently not include it, so a machine set up by pressing Enter would
 * be guarded LESS than one set up through the policy list — the kind of gap
 * that is invisible until somebody is standing in it.
 */
export function defaultsMissingFromRecommended(): string[] {
  const recommended = new Set(RECOMMENDED_POLICIES);
  return BUILTIN_POLICIES.filter((p) => p.defaultEnabled && !p.beta && !recommended.has(p.name)).map(
    (p) => p.name,
  );
}
