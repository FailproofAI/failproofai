/**
 * Population-level signals shown on the audit poster: how rare your
 * archetype is and where your score sits in the cohort. Seeded with
 * snapshot values; swap for live aggregates once that pipeline lands.
 */

import type { ArchetypeKey } from "./archetypes";

/** Percentage of audited agents that map to a given archetype. */
const ARCHETYPE_RARITY: Record<ArchetypeKey, number> = {
  optimist: 18,
  cowboy: 9,
  explorer: 14,
  goldfish: 11,
  architect: 7,
  precision: 16,
  hammer: 13,
  ghost: 12,
};

/** Map a 0-100 score to a "top N%" rank band. Bands roughly mirror the
 *  S/A/B/C/D/F tiers in scoring.ts. */
export function getScoreRank(score: number): string {
  if (score >= 90) return "top 5%";
  if (score >= 80) return "top 15%";
  if (score >= 71) return "top 35%";
  if (score >= 55) return "top 60%";
  if (score >= 40) return "top 85%";
  return "bottom tier";
}

export function getArchetypeRarityPct(key: ArchetypeKey): number {
  return ARCHETYPE_RARITY[key];
}
