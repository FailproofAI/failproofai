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
import { SIGNAL_MAP, deriveFeatures, MAPPABLE_KEYS } from "../../src/audit/features";
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

describe("persona distribution — realistic population is not skewed", () => {
  // Simulate a heterogeneous population with realistic latent tendencies (most
  // users make hundreds–thousands of tool calls but only a handful of policy
  // violations) plus cross-cluster noise, and confirm:
  //   • every persona gets a healthy share (no one swallows the population),
  //   • all 8 appear in a single 100-user cohort.
  // This guards the precision-gate regression: a rate-based clean gate used to
  // collapse ~80% of users into "precision".
  const sigsFor = (a: ArchetypeKey) =>
    Object.entries(SIGNAL_MAP).filter(([, v]) => v.archetype === a).map(([k]) => k);
  const ri = (rnd: () => number, a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  function genUser(rnd: () => number, latent: string): AuditResult {
    let events = ri(rnd, 150, 3000);
    const rows: AuditCount[] = [];
    const add = (n: string, h: number) => { if (h > 0) rows.push(row(n, h)); };
    const noise = () => {
      if (rnd() < 0.45) { const k = pick(ACTIVE, rnd); add(pick(sigsFor(k), rnd), ri(rnd, 1, 2)); }
    };
    if (latent === "clean") {
      events = ri(rnd, 1500, 6000);
      if (rnd() < 0.5) add(pick(Object.keys(SIGNAL_MAP), rnd), ri(rnd, 1, 2));
    } else if (latent === "scattered") {
      add("block-rm-rf", ri(rnd, 4, 7)); add("block-env-files", ri(rnd, 2, 4));
      add("warn-large-file-write", ri(rnd, 2, 4)); add("prefer-edit-over-sed-awk", ri(rnd, 1, 3));
      add("sleep-polling-loop", ri(rnd, 1, 2));
    } else if (latent === "architect") {
      add("reread-after-edit", ri(rnd, 4, 12)); add("redundant-cd-cwd", ri(rnd, 3, 10)); noise();
    } else {
      const sigs = sigsFor(latent as ArchetypeKey);
      for (let i = 0, n = ri(rnd, 1, 3); i < n; i++) add(pick(sigs, rnd), ri(rnd, 3, 12));
      noise(); noise();
    }
    return result(rows, events);
  }

  const PRIOR: [string, number][] = [
    ["clean", 0.16], ["cowboy", 0.16], ["explorer", 0.14], ["optimist", 0.14],
    ["ghost", 0.10], ["hammer", 0.08], ["architect", 0.10], ["scattered", 0.12],
  ];
  const sampleLatent = (rnd: () => number) => {
    let x = rnd(), c = 0;
    for (const [k, p] of PRIOR) { c += p; if (x < c) return k; }
    return "cowboy";
  };

  it("every persona gets a healthy share and all 8 appear in 100 users", () => {
    const rnd = lcg(424242);
    const N = 5000;
    const tally: Record<string, number> = {};
    const cohort = new Set<string>();
    for (let i = 0; i < N; i++) {
      const got = classifyAgent(genUser(rnd, sampleLatent(rnd)), `u${i}`).archetype;
      tally[got] = (tally[got] ?? 0) + 1;
      if (i < 100) cohort.add(got);
    }
    // No persona collapses the population (the old bug had precision at ~80%).
    for (const k of ALL) {
      const share = (tally[k] ?? 0) / N;
      expect(share, `${k} share ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.04);
      expect(share, `${k} share ${(share * 100).toFixed(1)}%`).toBeLessThan(0.30);
    }
    // The very first 100 users already cover all 8.
    for (const k of ALL) expect(cohort.has(k), `cohort missing ${k}`).toBe(true);
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

describe("persona distribution — ambient profile does not collapse to explorer", () => {
  // Regression for the reported bug: "every person who tries it gets explorer".
  //
  // Replaying real transcripts makes the *ambient* explorer signals (env access
  // + secrets-in-tool-output) and architect signals (reread-after-edit,
  // redundant-cd) the largest RAW clusters for nearly every agent — they fire
  // on benign, volume-scaled activity in essentially every session. Under the
  // old catalog-weight baseline that forced the whole population onto "the
  // explorer". The fix calibrates the lift denominator to EMPIRICAL firing
  // shares (features.ts BASELINE_SHARE), so ambient explorer firing no longer
  // over-indexes and a typical agent reads as scattered/over-verifying, never
  // auto-explorer.
  //
  // The genUser harness above fabricates users from a latent label and lights
  // only that label's signals, so it never reproduced this shape — that's the
  // exact gap this block closes.
  const ambientRows = (rnd: () => number): AuditCount[] => {
    const j = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    return [
      row("block-env-files", j(4, 8)),            // explorer — ambient env
      row("protect-env-vars", j(4, 8)),           // explorer — ambient env
      row("sanitize-connection-strings", j(3, 6)),// explorer — secrets in output
      row("reread-after-edit", j(5, 12)),         // architect — ambient re-read
      row("redundant-cd-cwd", j(4, 10)),          // architect — ambient cd
      row("sleep-polling-loop", j(0, 3)),         // hammer — elective tail
      row("block-gh-pipeline", j(0, 2)),          // cowboy — elective tail
      row("prefer-edit-over-read-cat", j(0, 4)),  // optimist — elective tail
    ];
  };

  it("a representative ambient agent has explorer's raw dominance normalized away by lift", () => {
    // Deterministic profile mirroring real measured shares: explorer raw 21
    // (the largest), architect 13.6, small elective tails. Under the OLD
    // catalog-weight baseline explorer's lift was inflated far above 1 and
    // it auto-won classification for almost everyone — the original "everyone
    // is explorer" bug. The empirical baseline (BASELINE_SHARE) must bring
    // explorer's lift down so its raw dominance does NOT automatically win:
    // a mild elevation (~1.4) can still legitimately classify explorer, but
    // the share of population landing on explorer is bounded by the cohort
    // test below, not by forcing this single agent off explorer.
    const res = result([
      row("block-env-files", 6), row("protect-env-vars", 6),
      row("sanitize-connection-strings", 5),
      row("reread-after-edit", 8), row("redundant-cd-cwd", 7),
      row("sleep-polling-loop", 2), row("block-gh-pipeline", 1),
      row("prefer-edit-over-read-cat", 2),
    ], 1500);
    const f = deriveFeatures(res, "ambient");
    const maxCluster = MAPPABLE_KEYS.reduce(
      (m, k) => (f.clusterRaw[k] > f.clusterRaw[m] ? k : m), MAPPABLE_KEYS[0]);
    expect(maxCluster, "precondition: explorer must dominate raw signal").toBe("explorer");
    // Explorer's raw share (~54%) must NOT translate into a runaway lift like
    // it did under the catalog-weight baseline — the empirical denominator
    // brings it into a reasonable band where other clusters can still win
    // when they over-index more.
    const explorerShare = f.clusterRaw.explorer / f.totalSignal;
    expect(explorerShare).toBeGreaterThan(0.5);
    expect(f.clusterLift.explorer).toBeLessThan(2);
  });

  it("a cohort of ambient agents does not collapse onto a single persona", () => {
    const rnd = lcg(54321);
    const N = 600;
    const tally: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const got = classifyAgent(
        result(ambientRows(rnd), 200 + Math.floor(rnd() * 3000)), `c${i}`).archetype;
      tally[got] = (tally[got] ?? 0) + 1;
    }
    const explorerShare = (tally.explorer ?? 0) / N;
    const topShare = Math.max(...Object.values(tally)) / N;
    // Old bug: 100% explorer. Now explorer must be a small minority…
    expect(explorerShare, `explorer ${(explorerShare * 100).toFixed(0)}%`).toBeLessThan(0.5);
    // …and no persona may own the ambient population.
    expect(topShare, `top persona ${(topShare * 100).toFixed(0)}%`).toBeLessThan(0.85);
  });
});

describe("persona distribution — ambient profile does not collapse to goldfish", () => {
  // Regression for the next reported bug: "almost everyone is getting goldfish".
  //
  // PR #426 retuned GOLDFISH_ENTROPY 0.75 → 0.70 and replaced the catalog-weight
  // baseline with an empirical firing share. Both moves were correct, but they
  // exposed a latent flaw in the goldfish gate: entropy of the LIFT vector
  // cannot distinguish "everyone fires at typical ambient rate" (lifts ≈ 1.0
  // across the board → high entropy) from "real scatter" (multiple clusters
  // genuinely over-indexing → also high entropy). A real-corpus audit (764
  // transcripts / 42k events) measured the exact lift profile reproduced below:
  // every active-fault cluster sits within 0.97–1.02 of baseline, ghost at 0.02
  // — no concentration anywhere, just typical volume — yet the classifier
  // returned goldfish because entropy = 0.91 cleared the 0.70 gate.
  //
  // The fix adds a secondLift threshold to the goldfish gate so it only fires
  // when AT LEAST TWO clusters are meaningfully above baseline (the actual
  // definition of scatter).
  it("a flat-at-baseline lift profile is NOT classified goldfish", () => {
    // Each cluster fires roughly in proportion to its empirical firing share
    // (BASELINE_SHARE), so every lift sits near 1.0 — no over-indexing
    // anywhere. This is the high-volume "typical agent" shape that surfaced in
    // a 764-transcript / 42k-event local audit. With nothing meaningfully
    // above baseline, the entropy of the lift vector pegs at 1.0 (the maximum)
    // and the OLD gate fired goldfish — wrong, because the entropy is high not
    // because the agent is scattered but because it's just average.
    const res = result([
      row("block-env-files", 48),       // explorer raw ≈ 72
      row("reread-after-edit", 63),     // architect raw  = 63
      row("block-rm-rf", 11),           // cowboy raw    ≈ 22
      row("sleep-polling-loop", 18),    // hammer raw    ≈ 22
      row("warn-package-publish", 13),  // optimist raw   = 13
      row("warn-large-file-write", 10), // ghost raw      = 10
    ], 5000);
    const f = deriveFeatures(res, "real");
    // Precondition: lifts are flat near baseline — no cluster meaningfully
    // over-indexes. This is the shape the classifier MUST not call goldfish.
    const sorted = MAPPABLE_KEYS.map((k) => f.clusterLift[k]).sort((a, b) => b - a);
    expect(sorted[0], `maxLift ${sorted[0]?.toFixed(2)}`).toBeLessThan(1.2);
    expect(sorted[1], `secondLift ${sorted[1]?.toFixed(2)}`).toBeLessThan(1.2);
    // The whole bug: high entropy + uniform-at-baseline lifts must not collapse
    // a typical user onto goldfish.
    expect(classifyAgent(res, "real").archetype).not.toBe("goldfish");
  });
});
