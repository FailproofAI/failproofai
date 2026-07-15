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
