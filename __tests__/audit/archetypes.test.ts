// @vitest-environment node
import { describe, it, expect } from "vitest";
import { ARCHETYPES, classifyAgent, pickArchetypeVariant } from "../../src/audit/archetypes";
import type { AuditCount, AuditResult } from "../../src/audit/types";

function mkRow(name: string, hits: number, opts: Partial<AuditCount> = {}): AuditCount {
  return {
    name,
    source: "builtin",
    category: "test",
    severity: "warn",
    hits,
    projects: 1,
    examples: [],
    displayTitle: name,
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...opts,
  };
}

/** `events` controls eventsScanned (the fault-rate denominator). Defaults to a
 *  low value so a handful of hits clears the precision clean-rate threshold. */
function mkResult(rows: AuditCount[], events = 200): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-06-01T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 0 },
    results: rows,
    totals: { hits: rows.reduce((s, r) => s + r.hits, 0), projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: events,
    enabledBuiltinNames: [],
  };
}

const det = (name: string, hits: number) =>
  mkRow(name, hits, { source: "audit-detector", severity: "warn" });

describe("classifyAgent — relational personas", () => {
  it("precision when there is no signal at all", () => {
    const cls = classifyAgent(mkResult([]));
    expect(cls.archetype).toBe("precision");
    expect(cls.totalSignal).toBe(0);
  });

  it("precision when every row is zero hits", () => {
    expect(classifyAgent(mkResult([mkRow("failproofai/block-rm-rf", 0)])).archetype).toBe("precision");
  });

  it("precision when the total signal is below the absolute floor (no tendency)", () => {
    // A single cowboy hit (weight 2.0) is below PRECISION_FLOOR (2.5) → no
    // concentrated tendency → precision, regardless of volume.
    expect(classifyAgent(mkResult([mkRow("failproofai/block-rm-rf", 1)], 5000)).archetype).toBe("precision");
  });

  it("precision when a trace tendency is thinly spread over a high-volume session", () => {
    // 2 cowboy hits (weight 4.0, below the soft cap) across 5000 calls →
    // fault-rate < 0.003 → still reads clean.
    expect(classifyAgent(mkResult([mkRow("failproofai/block-rm-rf", 2)], 5000)).archetype).toBe("precision");
  });

  it("does NOT collapse a concentrated tendency into precision (the skew bug)", () => {
    // 8 rm-rf attempts across 2000 calls: fault-rate is tiny, but the tendency
    // is real → cowboy, not precision. (The score still rewards the clean
    // footprint separately.)
    expect(classifyAgent(mkResult([mkRow("failproofai/block-rm-rf", 8)], 2000)).archetype).toBe("cowboy");
  });

  it("architect when the over-verification detectors dominate", () => {
    const cls = classifyAgent(mkResult([
      det("reread-after-edit", 5),
      det("redundant-cd-cwd", 5),
    ]));
    expect(cls.archetype).toBe("architect");
  });

  it("goldfish when faults are spread proportionally across many clusters", () => {
    const cls = classifyAgent(mkResult([
      mkRow("failproofai/block-rm-rf", 5),           // cowboy
      mkRow("failproofai/block-env-files", 3),       // explorer
      mkRow("failproofai/warn-large-file-write", 3), // ghost
      det("prefer-edit-over-sed-awk", 2),            // optimist
      det("sleep-polling-loop", 1),                  // hammer
      det("reread-after-edit", 1),                   // architect (caution, <35%)
    ]));
    expect(cls.archetype).toBe("goldfish");
  });
});

describe("classifyAgent — active-fault personas (each reachable)", () => {
  const cases: [string, string][] = [
    ["failproofai/block-rm-rf", "cowboy"],
    ["failproofai/block-env-files", "explorer"],
    ["failproofai/warn-large-file-write", "ghost"],
    ["failproofai/prefer-package-manager", "optimist"],
    ["failproofai/warn-repeated-tool-calls", "hammer"],
  ];
  for (const [policy, expected] of cases) {
    it(`${expected} when ${policy} dominates`, () => {
      expect(classifyAgent(mkResult([mkRow(policy, 10)])).archetype).toBe(expected);
    });
  }
});

describe("classifyAgent — lift over baseline", () => {
  it("a low-baseline persona beats a higher raw-weight cowboy signal", () => {
    // cowboy raw = 10 (block-rm-rf ×5), hammer raw = 9 (warn-repeated ×6).
    // Raw argmax would pick cowboy; lift picks hammer (tiny baseline).
    const cls = classifyAgent(mkResult([
      mkRow("failproofai/block-rm-rf", 5),
      mkRow("failproofai/warn-repeated-tool-calls", 6),
    ]));
    expect(cls.archetype).toBe("hammer");
  });

  it("promotes secondary when its lift is ≥40% of the primary's", () => {
    const cls = classifyAgent(mkResult([
      mkRow("failproofai/block-rm-rf", 10),    // cowboy
      mkRow("failproofai/block-env-files", 3), // explorer, ≥40% of cowboy lift
    ]));
    expect(cls.archetype).toBe("cowboy");
    expect(cls.secondary).toBe("explorer");
  });

  it("falls back to authored secondary when runner-up is too weak", () => {
    const cls = classifyAgent(mkResult([
      mkRow("failproofai/block-rm-rf", 10),    // cowboy
      mkRow("failproofai/block-env-files", 1), // explorer, <40% of cowboy lift
    ]));
    expect(cls.archetype).toBe("cowboy");
    expect(cls.secondary).toBe(ARCHETYPES.cowboy.secondary);
  });

  it("ignores rows whose policy name doesn't map to a signal", () => {
    const cls = classifyAgent(mkResult([mkRow("failproofai/some-future-unmapped-policy", 50)]));
    expect(cls.archetype).toBe("precision");
  });
});

describe("classifyAgent — determinism", () => {
  it("same input → same output, every field", () => {
    const rows = [mkRow("failproofai/block-rm-rf", 4), mkRow("failproofai/block-env-files", 4)];
    const a = classifyAgent(mkResult(rows), "proj");
    const b = classifyAgent(mkResult(rows), "proj");
    expect(a).toEqual(b);
  });

  it("variantSeed folds the behaviour fingerprint into the seed", () => {
    const cls = classifyAgent(mkResult([mkRow("failproofai/block-rm-rf", 4)]), "proj");
    expect(cls.variantSeed.startsWith("proj|")).toBe(true);
  });
});

describe("pickArchetypeVariant", () => {
  it("returns the same variant for the same seed", () => {
    expect(pickArchetypeVariant("optimist", "my-project")).toEqual(
      pickArchetypeVariant("optimist", "my-project"),
    );
  });

  it("can return different variants for different seeds", () => {
    const variants = new Set(
      ["a", "b", "c", "d", "e", "f"].map((s) => pickArchetypeVariant("optimist", s).tagline),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});
