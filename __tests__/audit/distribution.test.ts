// @vitest-environment node
//
// No-skew / reachability harness. Deterministically generates many synthetic
// audits (seeded LCG — no Math.random, so CI is reproducible), classifies each
// and asserts:
//   1. All 8 personas are reachable.
//   2. Lift normalisation removes the cowboy surface-area skew: a profile that
//      focuses on one active-fault cluster classifies as THAT cluster the large
//      majority of the time, even though cowboy owns 20 of the 47 signals.
import { describe, it, expect } from "vitest";
import { classifyAgent, type ArchetypeKey } from "../../src/audit/archetypes";
import { SIGNAL_MAP } from "../../src/audit/features";
import type { AuditCount, AuditResult } from "../../src/audit/types";

const DETECTORS = new Set([
  "find-from-root", "git-commit-no-verify", "prefer-edit-over-read-cat",
  "prefer-edit-over-sed-awk", "prefer-write-over-heredoc", "redundant-cd-cwd",
  "reread-after-edit", "sleep-polling-loop",
]);

/** Signals grouped by the persona they feed. */
function signalsFor(archetype: ArchetypeKey): string[] {
  return Object.entries(SIGNAL_MAP)
    .filter(([, v]) => v.archetype === archetype)
    .map(([k]) => k);
}

/** Deterministic LCG → [0,1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function row(name: string, hits: number): AuditCount {
  return {
    name: DETECTORS.has(name) ? name : `failproofai/${name}`,
    source: DETECTORS.has(name) ? "audit-detector" : "builtin",
    category: "x", severity: "deny", hits, projects: 1, examples: [],
    displayTitle: name, impact: "", enabledInConfig: false, installHint: "",
  };
}

function result(rows: AuditCount[], events: number): AuditResult {
  return {
    version: 2, scannedAt: "2026-06-01T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 3, skipped: 0, errors: 0, durationMs: 0 },
    results: rows,
    totals: { hits: rows.reduce((s, r) => s + r.hits, 0), projectsWithHits: 0 },
    projectsScanned: [], eventsScanned: events, enabledBuiltinNames: [],
  };
}

const ACTIVE: ArchetypeKey[] = ["cowboy", "explorer", "ghost", "optimist", "hammer"];
const ALL: ArchetypeKey[] = [...ACTIVE, "architect", "precision", "goldfish"];

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

describe("persona distribution — reachability", () => {
  it("all 8 personas are reachable across varied profiles", () => {
    const rnd = lcg(20260609);
    const tally: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const style = pick(["clean", "caution", "spread", "focused", "mixed"], rnd);
      let rows: AuditCount[] = [];
      let events = 200 + Math.floor(rnd() * 3000);
      if (style === "clean") {
        events = 3000 + Math.floor(rnd() * 5000);
        if (rnd() < 0.5) rows = [row(pick(signalsFor("cowboy"), rnd), 1)];
      } else if (style === "caution") {
        rows = [row("reread-after-edit", 3 + Math.floor(rnd() * 8)),
                row("redundant-cd-cwd", 2 + Math.floor(rnd() * 8))];
      } else if (style === "spread") {
        // Lite signal proportional-ish to baseline → high lift entropy.
        rows = [
          row("block-rm-rf", 4 + Math.floor(rnd() * 3)),
          row("block-env-files", 2 + Math.floor(rnd() * 2)),
          row("warn-large-file-write", 2 + Math.floor(rnd() * 2)),
          row("prefer-edit-over-sed-awk", 1 + Math.floor(rnd() * 2)),
          row("sleep-polling-loop", 1),
        ];
      } else if (style === "focused") {
        const k = pick(ACTIVE, rnd);
        const sigs = signalsFor(k);
        rows = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
          row(pick(sigs, rnd), 2 + Math.floor(rnd() * 10)));
      } else {
        const n = 1 + Math.floor(rnd() * 5);
        const all = Object.keys(SIGNAL_MAP);
        rows = Array.from({ length: n }, () => row(pick(all, rnd), 1 + Math.floor(rnd() * 8)));
      }
      const a = classifyAgent(result(rows, events), `seed-${i}`).archetype;
      tally[a] = (tally[a] ?? 0) + 1;
    }
    for (const k of ALL) {
      expect(tally[k] ?? 0, `persona "${k}" should be reachable (got ${tally[k] ?? 0})`).toBeGreaterThan(0);
    }
  });
});

describe("persona distribution — no surface-area skew", () => {
  // For each active-fault cluster, light only its own signals and confirm the
  // classifier returns that cluster the large majority of the time. Cowboy's
  // 20-signal surface area must NOT let it hijack the other four.
  for (const target of ACTIVE) {
    it(`a ${target}-focused agent classifies as ${target}`, () => {
      const rnd = lcg(777 + target.length);
      const sigs = signalsFor(target);
      let correct = 0;
      let hijacked = 0; // misclassified as a DIFFERENT active-fault persona
      const N = 300;
      for (let i = 0; i < N; i++) {
        // Enough hits (over 150 calls) to clear the precision clean-rate gate,
        // so this isolates the skew property rather than the clean threshold.
        const rows = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
          row(pick(sigs, rnd), 6 + Math.floor(rnd() * 12)));
        const got = classifyAgent(result(rows, 150), `s${i}`).archetype;
        if (got === target) correct++;
        else if (ACTIVE.includes(got)) hijacked++;
      }
      expect(correct / N, `${target} accuracy`).toBeGreaterThan(0.95);
      // The whole point of lift normalisation: no other active persona
      // (cowboy especially) hijacks a single-cluster profile.
      expect(hijacked, `${target} hijacked by another persona`).toBe(0);
    });
  }
});
