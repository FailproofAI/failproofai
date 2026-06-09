/**
 * Behavioural feature layer for the audit dashboard.
 *
 * Both the archetype classifier (`archetypes.ts`) and the score derivation
 * (`scoring.ts`) read from the *same* derived features so they can never
 * drift. Everything here is a pure function of `AuditResult` (+ an optional
 * seed string) — no I/O, no clock, no `Math.random()`. Given the same input,
 * every output is byte-identical on every run.
 *
 * Design goals (see the audit redesign):
 *   1. All 8 personas reachable. Five are mapped by *which* faults dominate
 *      (`SIGNAL_MAP`); three are relational — `precision` (low fault rate),
 *      `architect` (faults are over-verification), `goldfish` (scattered).
 *   2. No artificial skew. The catalog is cowboy-heavy (20 of 47 signals), so
 *      a raw argmax would almost always pick cowboy. We rank by *lift over a
 *      self-calibrated baseline* instead — cowboy's large baseline means it
 *      has to over-index to win, neutralising the surface-area advantage.
 *   3. Deterministic personalisation. A `fingerprint` hash of the rounded
 *      behaviour vector seeds tie-breaks and copy-variant selection, so two
 *      different agents that land on the same primary still look distinct,
 *      while the same agent is always identical.
 */
import type { AuditResult } from "./types";
import type { ArchetypeKey } from "./archetypes";

/** djb2-style hash. Stable across renders/processes, no crypto needed.
 *  Lives here (not archetypes.ts) so the feature layer has no import cycle. */
export function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Strip the `failproofai/` namespace so map keys match the bare policy name. */
export function shortName(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** All eight archetype keys, including the two relational ones. */
export const ALL_ARCHETYPE_KEYS: ArchetypeKey[] = [
  "optimist", "cowboy", "explorer", "goldfish",
  "architect", "precision", "hammer", "ghost",
];

/**
 * Personas that receive direct signal mapping. `precision` and `goldfish`
 * are NOT here — they are derived from the *shape* of the distribution, not
 * from any single policy. `architect` is mapped (it owns the two "caution"
 * detectors) but is primarily reached via its ratio rule.
 */
export const MAPPABLE_KEYS: ArchetypeKey[] = [
  "cowboy", "explorer", "ghost", "optimist", "hammer", "architect",
];

/** Active-fault personas ranked by lift in the classifier's argmax step. */
export const ACTIVE_FAULT_KEYS: ArchetypeKey[] = [
  "cowboy", "explorer", "ghost", "optimist", "hammer",
];

/** The two detectors that define "the paranoid architect" — pure
 *  over-verification. When these dominate an agent's signal it is classified
 *  architect regardless of raw weight. */
export const ARCHITECT_CAUTION_SIGNALS = new Set(["reread-after-edit", "redundant-cd-cwd"]);

/**
 * Mapping from policy/detector short-name → which archetype its hits feed,
 * and how heavily (intensity within the cluster). Every one of the 39 builtin
 * policies and 8 audit-only detectors maps exactly once — no overlaps, full
 * coverage. Weights express *severity within* a persona; cross-persona
 * fairness is handled later by lift normalisation, not by these numbers.
 */
export const SIGNAL_MAP: Record<string, { archetype: ArchetypeKey; weight: number }> = {
  // ── cowboy ── destructive / forceful / bypasses guardrails (20) ───────────
  "block-rm-rf":               { archetype: "cowboy", weight: 2.0 },
  "block-failproofai-commands":{ archetype: "cowboy", weight: 2.0 },
  "block-sudo":                { archetype: "cowboy", weight: 1.5 },
  "block-curl-pipe-sh":        { archetype: "cowboy", weight: 1.5 },
  "block-force-push":          { archetype: "cowboy", weight: 1.5 },
  "block-push-master":         { archetype: "cowboy", weight: 1.5 },
  "block-work-on-main":        { archetype: "cowboy", weight: 1.2 },
  "warn-destructive-sql":      { archetype: "cowboy", weight: 1.5 },
  "warn-schema-alteration":    { archetype: "cowboy", weight: 1.0 },
  "git-commit-no-verify":      { archetype: "cowboy", weight: 1.5 },
  "warn-git-amend":            { archetype: "cowboy", weight: 0.8 },
  "warn-git-stash-drop":       { archetype: "cowboy", weight: 1.0 },
  "warn-all-files-staged":     { archetype: "cowboy", weight: 0.6 },
  "block-kubectl":             { archetype: "cowboy", weight: 1.5 },
  "block-terraform":           { archetype: "cowboy", weight: 1.5 },
  "block-helm":                { archetype: "cowboy", weight: 1.2 },
  "block-aws-cli":             { archetype: "cowboy", weight: 1.2 },
  "block-gcloud":              { archetype: "cowboy", weight: 1.2 },
  "block-az-cli":              { archetype: "cowboy", weight: 1.2 },
  "block-gh-pipeline":         { archetype: "cowboy", weight: 1.2 },

  // ── explorer ── boundary crossing / secrets exposure (10) ─────────────────
  "sanitize-private-key-content":{ archetype: "explorer", weight: 1.5 },
  "block-env-files":           { archetype: "explorer", weight: 1.5 },
  "block-secrets-write":       { archetype: "explorer", weight: 1.5 },
  "sanitize-api-keys":         { archetype: "explorer", weight: 1.2 },
  "sanitize-jwt":              { archetype: "explorer", weight: 1.2 },
  "sanitize-connection-strings":{ archetype: "explorer", weight: 1.2 },
  "block-read-outside-cwd":    { archetype: "explorer", weight: 1.2 },
  "sanitize-bearer-tokens":    { archetype: "explorer", weight: 1.0 },
  "protect-env-vars":          { archetype: "explorer", weight: 1.0 },
  "find-from-root":            { archetype: "explorer", weight: 1.0 },

  // ── ghost ── unfinished / unsupervised work (7) ───────────────────────────
  // NOTE: the five require-*-before-stop policies only fire on `Stop` events,
  // which the audit replay never synthesises, so in practice ghost is reached
  // via warn-large-file-write + warn-background-process. They are mapped here
  // for completeness and in case a future Stop-replay path is added.
  "require-ci-green-before-stop":   { archetype: "ghost", weight: 1.2 },
  "require-commit-before-stop":     { archetype: "ghost", weight: 1.2 },
  "require-push-before-stop":       { archetype: "ghost", weight: 1.0 },
  "require-pr-before-stop":         { archetype: "ghost", weight: 1.0 },
  "require-no-conflicts-before-stop":{ archetype: "ghost", weight: 1.0 },
  "warn-large-file-write":     { archetype: "ghost", weight: 1.0 },
  "warn-background-process":   { archetype: "ghost", weight: 0.8 },

  // ── optimist ── low-friction shortcuts / sloppy tool choice (6) ───────────
  "warn-package-publish":      { archetype: "optimist", weight: 1.0 },
  "warn-global-package-install":{ archetype: "optimist", weight: 0.8 },
  "prefer-package-manager":    { archetype: "optimist", weight: 0.8 },
  "prefer-edit-over-sed-awk":  { archetype: "optimist", weight: 0.8 },
  "prefer-edit-over-read-cat": { archetype: "optimist", weight: 0.5 },
  "prefer-write-over-heredoc": { archetype: "optimist", weight: 0.5 },

  // ── hammer ── brute-force repetition (2) ──────────────────────────────────
  "warn-repeated-tool-calls":  { archetype: "hammer", weight: 1.5 },
  "sleep-polling-loop":        { archetype: "hammer", weight: 1.2 },

  // ── architect ── over-verification "caution" signals (2) ──────────────────
  "reread-after-edit":         { archetype: "architect", weight: 1.0 },
  "redundant-cd-cwd":          { archetype: "architect", weight: 0.8 },
};

/** Builtin severity derived from the policy name prefix. The builtin
 *  definitions carry no static severity field — the runtime decision lives in
 *  the policy fn — but the name prefix encodes intent deterministically:
 *    sanitize-* → sanitize (gentle)   warn-/protect-/prefer-/require-* → warn
 *    block-*    → deny (severe)        anything else → deny (safe default)
 *  Replaces the old hardcoded `"deny"` so the score's medium/gentle buckets
 *  actually populate. */
export function severityForBuiltin(name: string): string {
  const n = shortName(name);
  if (n.startsWith("sanitize-")) return "sanitize";
  if (n.startsWith("block-")) return "deny";
  if (
    n.startsWith("warn-") || n.startsWith("protect-") ||
    n.startsWith("prefer-") || n.startsWith("require-")
  ) return "warn";
  return "deny";
}

function emptyWeights(): Record<ArchetypeKey, number> {
  return {
    optimist: 0, cowboy: 0, explorer: 0, goldfish: 0,
    architect: 0, precision: 0, hammer: 0, ghost: 0,
  };
}

/**
 * Each mappable persona's *expected* share of total signal, derived directly
 * from `SIGNAL_MAP` (sum of its weights ÷ sum of all weights). Self-calibrates
 * whenever a weight changes. Used to compute lift = observed-share ÷ baseline,
 * which is what removes the cowboy surface-area skew.
 */
export const BASELINE_SHARE: Record<ArchetypeKey, number> = (() => {
  const raw = emptyWeights();
  let total = 0;
  for (const { archetype, weight } of Object.values(SIGNAL_MAP)) {
    raw[archetype] += weight;
    total += weight;
  }
  const out = emptyWeights();
  for (const k of MAPPABLE_KEYS) out[k] = total > 0 ? raw[k] / total : 0;
  return out;
})();

/** Normalised Shannon entropy of a lift vector, base = number of mappable
 *  clusters (6). 0 = all signal in one persona, 1 = perfectly even spread.
 *  Two equally-lit clusters score ~0.39 (not goldfish); ~4 even clusters
 *  cross 0.77 (goldfish territory). */
function normalizedEntropy(vals: number[]): number {
  const total = vals.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const v of vals) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(vals.length);
}

/** Volume floor — a 3-call session shouldn't divide-by-tiny and explode. */
export const MIN_EVENTS = 50;

export interface AuditFeatures {
  /** Tool calls scanned, floored at MIN_EVENTS. */
  events: number;
  sessions: number;
  totalHits: number;
  /** totalHits / events — the cleanliness denominator the old scorer ignored. */
  faultRate: number;
  /** Per-persona Σ(hits × weight). Same shape the old classifier returned. */
  clusterRaw: Record<ArchetypeKey, number>;
  totalSignal: number;
  /** Per-persona observed-share ÷ baseline-share. The ranking metric. */
  clusterLift: Record<ArchetypeKey, number>;
  /** Normalised entropy of the lift vector (goldfish detector). */
  entropy: number;
  /** Share of total signal coming from the two architect caution detectors. */
  cautionShare: number;
  cowboyLift: number;
  /** Deterministic hash of the rounded behaviour vector + seed. Seeds
   *  tie-breaks and copy-variant selection. */
  fingerprint: number;
}

function sumHits(result: AuditResult): number {
  let s = 0;
  for (const r of result.results) s += r.hits;
  return s;
}

/** Derive the behaviour feature vector. Pure over (result, seed). */
export function deriveFeatures(result: AuditResult, seed = ""): AuditFeatures {
  const events = Math.max(result.eventsScanned ?? 0, MIN_EVENTS);
  const sessions = result.transcripts.scanned;
  const totalHits = result.totals?.hits ?? sumHits(result);

  const clusterRaw = emptyWeights();
  let cautionRaw = 0;
  for (const row of result.results) {
    const short = shortName(row.name);
    const sig = SIGNAL_MAP[short];
    if (!sig) continue;
    const w = row.hits * sig.weight;
    clusterRaw[sig.archetype] += w;
    if (ARCHITECT_CAUTION_SIGNALS.has(short)) cautionRaw += w;
  }

  const totalSignal = MAPPABLE_KEYS.reduce((s, k) => s + clusterRaw[k], 0);

  const clusterLift = emptyWeights();
  for (const k of MAPPABLE_KEYS) {
    const share = totalSignal > 0 ? clusterRaw[k] / totalSignal : 0;
    clusterLift[k] = BASELINE_SHARE[k] > 0 ? share / BASELINE_SHARE[k] : 0;
  }

  const entropy = normalizedEntropy(MAPPABLE_KEYS.map((k) => clusterLift[k]));
  const cautionShare = totalSignal > 0 ? cautionRaw / totalSignal : 0;
  const faultRate = totalHits / events;

  // Fingerprint: stable over the rounded behaviour signature + seed. Rounding
  // keeps it stable against floating-point noise while still varying between
  // genuinely different agents.
  const sig = MAPPABLE_KEYS.map((k) => Math.round(clusterRaw[k] * 10)).join(",");
  const fingerprint = hashSeed(`${seed}|${sig}|${Math.round(faultRate * 1000)}`);

  return {
    events, sessions, totalHits, faultRate,
    clusterRaw, totalSignal, clusterLift, entropy,
    cautionShare, cowboyLift: clusterLift.cowboy, fingerprint,
  };
}
