// @vitest-environment node
/**
 * Drift gate for the Stage-0 parity corpus and its (cli, event) coverage map.
 *
 * `__tests__/parity/fixtures/**` is the byte-exact oracle a future Rust
 * evaluator is diffed against, and `__tests__/parity/coverage.json` records
 * which of the 348 (cli, event) cells failproofai actually installs a hook for
 * and whether the vendor honours a decision there. Both are generated:
 *
 *     bun scripts/gen-parity-corpus.mjs
 *
 * FOUR INDEPENDENT ASSERTIONS, because no one of them is sufficient:
 *
 *   1. BYTE-EQUALITY. Re-run the generator and diff against the committed
 *      files. Catches "someone changed policy-evaluator.ts and forgot to
 *      regenerate" and "someone hand-edited a fixture". Byte-exactness is the
 *      only assertion that catches a response encoder that is "semantically
 *      equivalent" and silently allows.
 *   2. THE COVERAGE REGRESSION GATE. Recompute every cell's label directly from
 *      the live constants — deliberately duplicating the generator's derivation
 *      rather than importing it — and fail when a cell that was `reachable`
 *      becomes `not-registered`. That is the specific regression this file
 *      exists to catch: an event silently dropped from an install list turns a
 *      working gate into nothing, and byte-equality would happily bless the
 *      regenerated-and-smaller corpus.
 *   3. TOTALITY. The map covers INTEGRATION_TYPES × HOOK_EVENT_TYPES exactly. A
 *      thirteenth CLI or a new event with no classification fails here rather
 *      than going silently untested.
 *   4. STRUCTURE. Stable 2-space JSON, sorted keys, and — the corpus-determinism
 *      requirement from the Phase 1 plan — not one byte of this machine's home
 *      directory, cwd or username anywhere in the corpus.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import {
  COVERAGE_FILENAME,
  COVERAGE_LABELS,
  DECISION_KINDS,
  EXPECTED_FIXTURE_COUNT,
  FIXTURES_DIRNAME,
  MANIFEST_FILENAME,
  POLICY_COUNTS,
  REGENERATE_COMMAND,
  SCHEMA_VERSION,
  SYNTHETIC,
  TOOL_PRESENCE,
  caseId,
  corpusDigest,
  fixtureRelPath,
  generateAll,
} from "../../scripts/gen-parity-corpus.mjs";
import * as types from "@/src/hooks/types";
import { HOOK_EVENT_TYPES, INTEGRATION_TYPES } from "@/src/hooks/types";
import type { HookEventType, IntegrationType } from "@/src/hooks/types";
import { ENFORCEMENT_CAPABILITY } from "@/src/hooks/enforcement-capability";
import { getIntegration } from "@/src/hooks/integrations";

const ROOT = process.cwd();
const PARITY_DIR = resolve(ROOT, "__tests__", "parity");
const FIXTURES_DIR = join(PARITY_DIR, FIXTURES_DIRNAME);

interface GeneratedFile {
  relPath: string;
  contents: string;
}

const STALE_MESSAGE =
  `__tests__/parity/ is out of date with the TypeScript reference implementation.\n` +
  `Regenerate with:\n\n    ${REGENERATE_COMMAND}\n\n` +
  `and commit the result. Do NOT hand-edit a fixture — src/hooks/policy-evaluator.ts is the ` +
  `oracle, and a hand-patched fixture silently weakens it.`;

// ── Committed tree ───────────────────────────────────────────────────────────

/** Every file this generator owns, keyed by its path relative to `__tests__/parity`. */
function readCommittedTree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(PARITY_DIR, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(FIXTURES_DIR);
  out.set(COVERAGE_FILENAME, readFileSync(join(PARITY_DIR, COVERAGE_FILENAME), "utf8"));
  return out;
}

let fresh: GeneratedFile[];
let freshByPath: Map<string, string>;
let committed: Map<string, string>;

beforeAll(async () => {
  fresh = (await generateAll()) as GeneratedFile[];
  freshByPath = new Map(fresh.map((f) => [f.relPath, f.contents]));
  committed = readCommittedTree();
}, 300_000);

const coverage = JSON.parse(
  readFileSync(join(PARITY_DIR, COVERAGE_FILENAME), "utf8"),
) as CoverageJson;

interface CoverageJson {
  schema_version: number;
  generated_by: string;
  regenerate_with: string;
  description: string;
  labels: string[];
  derivation: Record<string, string>;
  notes: string[];
  sources: string[];
  totals: Record<string, number>;
  cells: Record<string, Record<string, string>>;
  per_cli: Record<
    string,
    {
      capabilities_outside_install_set: string[];
      install_list_source: string;
      installed_canonical_events: string[];
      installed_vendor_events: string[];
      totals: Record<string, number>;
      unmapped_vendor_events: string[];
    }
  >;
}

interface ManifestJson {
  corpus_sha256: string;
  fixture_count: number;
  schema_version: number;
  regenerate_with: string;
  dimensions: {
    clis: string[];
    decision_kinds: string[];
    events: string[];
    policy_counts: number[];
    tool_presence: string[];
  };
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURES_DIR, MANIFEST_FILENAME), "utf8"),
) as ManifestJson;

// ── The independent derivation (assertion 2) ─────────────────────────────────
//
// Deliberately NOT imported from the generator. Byte-equality would bless a
// generator that derives the wrong thing consistently; this recomputes the same
// answer from the live constants by a separate route, so the two have to agree.

const CANONICAL_EVENTS = new Set<string>(HOOK_EVENT_TYPES as readonly string[]);
const typeExports = types as unknown as Record<string, unknown>;

/** The canonical events failproofai writes a hook entry for on `cli`. */
function installedCanonicalEvents(cli: IntegrationType): Set<string> {
  const eventMap = typeExports[`${cli.toUpperCase()}_EVENT_MAP`] as
    | Record<string, string>
    | undefined;
  const out = new Set<string>();
  for (const vendorEvent of getIntegration(cli).eventTypes) {
    const canonical = eventMap ? eventMap[vendorEvent] : vendorEvent;
    if (canonical && CANONICAL_EVENTS.has(canonical)) out.add(canonical);
  }
  return out;
}

function expectedLabel(cli: IntegrationType, event: HookEventType): string {
  if (!installedCanonicalEvents(cli).has(event)) return "not-registered";
  const capability = ENFORCEMENT_CAPABILITY[cli]?.[event];
  if (capability === "block") return "reachable";
  if (capability === "observe") return "observe-only";
  return "registered-unverified";
}

/** Labels whose cells DO fire a hook, so the encoder runs and the corpus applies. */
const REGISTERED_LABELS = new Set(["reachable", "observe-only", "registered-unverified"]);

/**
 * Events `ENFORCEMENT_CAPABILITY` labels for `cli` that `installed` does not
 * contain — i.e. we claim to know how the vendor treats a verdict on an event
 * we never ask it about.
 *
 * Taken as a parameter rather than reading the install list itself so the test
 * below can prove the predicate discriminates. A predicate that always returns
 * `[]` would make the assertion that uses it vacuous.
 */
function labelledButNotInstalled(cli: IntegrationType, installed: Set<string>): string[] {
  return Object.keys(ENFORCEMENT_CAPABILITY[cli] ?? {})
    .filter((event) => !installed.has(event))
    .sort();
}

// ── 1. Byte-equality ─────────────────────────────────────────────────────────

describe("parity corpus — drift gate", () => {
  it("the committed corpus is byte-identical to a fresh generator run", () => {
    // Hash first: the happy path then costs one comparison rather than 5,570.
    const freshDigest = corpusDigest(fresh);
    const committedDigest = corpusDigest(
      [...committed.entries()]
        .map(([relPath, contents]) => ({ relPath, contents }))
        .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)),
    );
    if (freshDigest === committedDigest) {
      expect(committed.size).toBe(fresh.length);
      return;
    }

    // Digests differ — now find and name the FIRST offending path, in sorted
    // order, so the failure points at one file instead of at a hash.
    const missing = fresh.filter((f) => !committed.has(f.relPath)).map((f) => f.relPath);
    const extra = [...committed.keys()].filter((p) => !freshByPath.has(p));
    const changed = fresh.filter(
      (f) => committed.has(f.relPath) && committed.get(f.relPath) !== f.contents,
    );

    const detail: string[] = [];
    if (missing.length > 0) detail.push(`${missing.length} missing, first: ${missing[0]}`);
    if (extra.length > 0) detail.push(`${extra.length} unexpected, first: ${extra.sort()[0]}`);
    if (changed.length > 0) {
      const first = changed[0];
      const onDisk = committed.get(first.relPath) ?? "";
      // Show a window around the FIRST differing byte. A fixture is ~1.5 KB and
      // its opening lines are identical across the whole corpus, so a leading
      // excerpt would show two indistinguishable blobs.
      let at = 0;
      while (at < first.contents.length && first.contents[at] === onDisk[at]) at += 1;
      const from = Math.max(0, at - 60);
      detail.push(
        `${changed.length} changed, first: ${first.relPath} (diverges at byte ${at})\n\n` +
          `  expected: …${JSON.stringify(first.contents.slice(from, at + 120))}\n` +
          `  on disk:  …${JSON.stringify(onDisk.slice(from, at + 120))}`,
      );
    }
    throw new Error(`${STALE_MESSAGE}\n\n${detail.join("\n")}`);
  });

  it("the generator is deterministic — two runs produce identical bytes", async () => {
    const second = (await generateAll()) as GeneratedFile[];
    expect(second.map((f) => f.relPath)).toEqual(fresh.map((f) => f.relPath));
    expect(corpusDigest(second)).toBe(corpusDigest(fresh));
  }, 300_000);

  it("writes to an arbitrary directory without embedding it", async () => {
    // The drift gate is only meaningful if the output does not depend on WHERE
    // it is written — otherwise every contributor's tree would differ.
    const dir = mkdtempSync(join(tmpdir(), "fpai-parity-"));
    try {
      const { writeAll } = await import("../../scripts/gen-parity-corpus.mjs");
      await writeAll(dir);
      const sample = fixtureRelPath("claude", "PreToolUse", "deny", "tool-present", 1);
      expect(readFileSync(join(dir, sample), "utf8")).toBe(freshByPath.get(sample));
      expect(readFileSync(join(dir, COVERAGE_FILENAME), "utf8")).toBe(
        committed.get(COVERAGE_FILENAME),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

// ── The manifest ─────────────────────────────────────────────────────────────

describe("parity corpus — manifest", () => {
  it("records the count the cross product actually implies", () => {
    // Derived from the constants, never written down: a thirteenth CLI or a new
    // HookEventType changes this number, and a stale corpus fails above.
    expect(EXPECTED_FIXTURE_COUNT).toBe(
      INTEGRATION_TYPES.length *
        HOOK_EVENT_TYPES.length *
        DECISION_KINDS.length *
        TOOL_PRESENCE.length *
        POLICY_COUNTS.length,
    );
    expect(manifest.fixture_count).toBe(EXPECTED_FIXTURE_COUNT);
    expect(manifest.schema_version).toBe(SCHEMA_VERSION);
    expect(manifest.regenerate_with).toBe(REGENERATE_COMMAND);
    expect(REGENERATE_COMMAND).toBe("bun scripts/gen-parity-corpus.mjs");
  });

  it("declares the same dimensions the constants declare", () => {
    expect(manifest.dimensions.clis).toEqual([...INTEGRATION_TYPES]);
    expect(manifest.dimensions.events).toEqual([...(HOOK_EVENT_TYPES as readonly string[])]);
    expect(manifest.dimensions.decision_kinds).toEqual([...DECISION_KINDS]);
    expect(manifest.dimensions.tool_presence).toEqual([...TOOL_PRESENCE]);
    expect(manifest.dimensions.policy_counts).toEqual([...POLICY_COUNTS]);
  });

  it("its digest matches the fixtures actually on disk", () => {
    // Recomputed from the committed tree, not from the fresh run — so a
    // hand-edited fixture plus a hand-edited manifest still fails.
    const onDisk = [...committed.entries()]
      .filter(([p]) => p.startsWith(`${FIXTURES_DIRNAME}/`) && !p.endsWith(`/${MANIFEST_FILENAME}`))
      .map(([relPath, contents]) => ({ relPath, contents }))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    expect(onDisk).toHaveLength(EXPECTED_FIXTURE_COUNT);
    expect(corpusDigest(onDisk)).toBe(manifest.corpus_sha256);
  });
});

// ── 3. Totality + vocabulary ─────────────────────────────────────────────────

describe("coverage map — totality", () => {
  it("carries its own provenance", () => {
    expect(coverage.schema_version).toBe(SCHEMA_VERSION);
    expect(coverage.generated_by).toBe("scripts/gen-parity-corpus.mjs");
    expect(coverage.regenerate_with).toBe(REGENERATE_COMMAND);
    expect(coverage.sources.length).toBeGreaterThan(0);
    // Every label the file uses must be explained in the file itself.
    expect(Object.keys(coverage.derivation).sort()).toEqual([...coverage.labels].sort());
  });

  it("is total over INTEGRATION_TYPES × HOOK_EVENT_TYPES", () => {
    expect(Object.keys(coverage.cells).sort()).toEqual([...INTEGRATION_TYPES].sort());
    for (const cli of INTEGRATION_TYPES) {
      expect(Object.keys(coverage.cells[cli]).sort(), `${cli} is missing an event`).toEqual(
        [...(HOOK_EVENT_TYPES as readonly string[])].sort(),
      );
    }
    const cellCount = Object.values(coverage.cells).reduce((n, c) => n + Object.keys(c).length, 0);
    expect(cellCount).toBe(INTEGRATION_TYPES.length * HOOK_EVENT_TYPES.length);
  });

  it("uses only the declared label vocabulary", () => {
    expect(coverage.labels).toEqual([...COVERAGE_LABELS]);
    for (const cli of INTEGRATION_TYPES) {
      for (const [event, label] of Object.entries(coverage.cells[cli])) {
        expect(coverage.labels, `${cli}/${event} has label ${label}`).toContain(label);
      }
    }
  });

  it("its totals add up to the cell count", () => {
    const counted: Record<string, number> = Object.fromEntries(coverage.labels.map((l) => [l, 0]));
    for (const cli of INTEGRATION_TYPES) {
      for (const label of Object.values(coverage.cells[cli])) counted[label] += 1;
    }
    expect(coverage.totals).toEqual(counted);
    expect(Object.values(coverage.totals).reduce((a, b) => a + b, 0)).toBe(
      INTEGRATION_TYPES.length * HOOK_EVENT_TYPES.length,
    );
  });

  it("no CLI labels an enforcement capability for an event it installs no hook for", () => {
    // Non-empty means enforcement-capability.ts and the install lists disagree —
    // a real bug in one of the two, not a table nit.
    for (const cli of INTEGRATION_TYPES) {
      expect(coverage.per_cli[cli].capabilities_outside_install_set).toEqual([]);
    }
  });
});

// ── 2. The regression gate ───────────────────────────────────────────────────

describe("coverage map — regression gate", () => {
  it.each([...INTEGRATION_TYPES])(
    "%s: every committed label still matches the live constants",
    (cli) => {
      for (const event of HOOK_EVENT_TYPES) {
        expect(
          coverage.cells[cli][event],
          `${cli}/${event}: coverage.json says "${coverage.cells[cli][event]}" but the live ` +
            `constants say "${expectedLabel(cli, event)}".\n${STALE_MESSAGE}`,
        ).toBe(expectedLabel(cli, event));
      }
    },
  );

  it("NO cell recorded as enforcing has stopped being registered", () => {
    // THE regression this file exists to catch. An event quietly dropped from an
    // install list turns a working gate into nothing at all: the policy still
    // evaluates in our tests, the UI still lists it, and no hook ever fires.
    const lost: string[] = [];
    for (const cli of INTEGRATION_TYPES) {
      const installed = installedCanonicalEvents(cli);
      for (const event of HOOK_EVENT_TYPES) {
        if (REGISTERED_LABELS.has(coverage.cells[cli][event]) && !installed.has(event)) {
          lost.push(`${cli}/${event} (was "${coverage.cells[cli][event]}")`);
        }
      }
    }
    expect(
      lost,
      `failproofai no longer installs a hook for ${lost.length} (cli, event) pair(s) that ` +
        `__tests__/parity/coverage.json records as covered:\n  ${lost.join("\n  ")}\n\n` +
        `If the hook was removed ON PURPOSE, say so in the PR and regenerate:\n\n` +
        `    ${REGENERATE_COMMAND}\n`,
    ).toEqual([]);
  });

  it("a regeneration CANNOT hide an event that stopped being installed", () => {
    // The previous assertion compares the committed labels against the live
    // constants, so it catches a hand-edited coverage.json. It does NOT catch
    // the other direction: drop `PreToolUse` from GOOSE_HOOK_EVENT_TYPES, rerun
    // the generator, and both sides agree on "not-registered" again.
    //
    // This one is un-regenerable. ENFORCEMENT_CAPABILITY.goose.PreToolUse ===
    // "block" is a traced claim that a deny there stops the tool. If the hook is
    // no longer installed, that claim is false, and the ONLY way to make this
    // pass is to delete the capability row as well — a conscious, reviewable
    // edit to a file full of byte offsets and live-probe citations, not a
    // regenerated diff nobody reads.
    const violations: string[] = [];
    for (const cli of INTEGRATION_TYPES) {
      for (const event of labelledButNotInstalled(cli, installedCanonicalEvents(cli))) {
        violations.push(`${cli}/${event} is labelled "${ENFORCEMENT_CAPABILITY[cli]?.[event as HookEventType]}"`);
      }
    }
    expect(
      violations,
      `src/hooks/enforcement-capability.ts states how the vendor treats a verdict on ` +
        `${violations.length} (cli, event) pair(s) failproofai installs no hook for:\n  ` +
        `${violations.join("\n  ")}\n\n` +
        `Either the event was dropped from an install list by mistake, or the capability row ` +
        `is stale. Fix one of the two — do not regenerate around it.`,
    ).toEqual([]);
  });

  it("that gate is not vacuous — the predicate really discriminates", () => {
    // Feed the predicate an empty install set: it must report every labelled
    // event. If it returned [] here, the assertion above would pass forever.
    const goose = labelledButNotInstalled("goose", new Set<string>());
    expect(goose).toContain("PreToolUse");
    expect(goose).toEqual(Object.keys(ENFORCEMENT_CAPABILITY.goose).sort());
    expect(goose.length).toBeGreaterThan(0);
  });

  it("per-CLI install lists match what the integration actually writes", () => {
    for (const cli of INTEGRATION_TYPES) {
      expect(coverage.per_cli[cli].installed_vendor_events).toEqual(
        [...getIntegration(cli).eventTypes].sort(),
      );
      expect(coverage.per_cli[cli].installed_canonical_events).toEqual(
        [...installedCanonicalEvents(cli)].sort(),
      );
    }
  });

  it("agrees with crates/generated/enforcement-capability.json", () => {
    // The coverage labels are derived from ENFORCEMENT_CAPABILITY; the Rust
    // adapter descriptor reads the generated JSON. If those two ever diverge,
    // the daemon would enforce against a table this map never saw.
    const generated = JSON.parse(
      readFileSync(resolve(ROOT, "crates", "generated", "enforcement-capability.json"), "utf8"),
    ) as { clis: Record<string, { capabilities: Record<string, string> }> };
    for (const cli of INTEGRATION_TYPES) {
      expect(generated.clis[cli].capabilities).toEqual(ENFORCEMENT_CAPABILITY[cli]);
      for (const [event, capability] of Object.entries(generated.clis[cli].capabilities)) {
        if (!installedCanonicalEvents(cli).has(event)) continue;
        expect(coverage.cells[cli][event]).toBe(
          capability === "block" ? "reachable" : "observe-only",
        );
      }
    }
  });
});

// ── Corpus coverage of the map ───────────────────────────────────────────────

describe("coverage map — the corpus covers it", () => {
  const ALL_CASES = DECISION_KINDS.flatMap((decision: string) =>
    TOOL_PRESENCE.flatMap((tool: string) =>
      POLICY_COUNTS.map((count: number) => ({ decision, tool, count })),
    ),
  );

  it("has a fixture for every cell that fires a hook", () => {
    const gaps: string[] = [];
    for (const cli of INTEGRATION_TYPES) {
      for (const event of HOOK_EVENT_TYPES) {
        if (!REGISTERED_LABELS.has(coverage.cells[cli][event])) continue;
        for (const { decision, tool, count } of ALL_CASES) {
          const relPath = fixtureRelPath(cli, event, decision, tool, count);
          if (!committed.has(relPath)) gaps.push(relPath);
        }
      }
    }
    expect(
      gaps,
      `${gaps.length} covered (cli, event) case(s) have no fixture. Regenerate:\n\n` +
        `    ${REGENERATE_COMMAND}\n\nFirst: ${gaps[0]}`,
    ).toEqual([]);
  });

  it("has a fixture for EVERY cell, covered or not", () => {
    // The encoder is total over HookEventType, so a reimplementation must match
    // on the not-registered cells too — cheap insurance against a CLI gaining an
    // event later and inheriting an untested branch.
    let expected = 0;
    for (const cli of INTEGRATION_TYPES) {
      for (const event of HOOK_EVENT_TYPES) {
        for (const { decision, tool, count } of ALL_CASES) {
          expect(committed.has(fixtureRelPath(cli, event, decision, tool, count))).toBe(true);
          expected += 1;
        }
      }
    }
    expect(expected).toBe(EXPECTED_FIXTURE_COUNT);
    expect(ALL_CASES).toHaveLength(
      DECISION_KINDS.length * TOOL_PRESENCE.length * POLICY_COUNTS.length,
    );
  });

  it("names every case file after the dimensions it varies", () => {
    for (const { decision, tool, count } of ALL_CASES) {
      const id = caseId(decision, tool, count);
      expect(id).toContain(decision);
      expect(id).toContain(tool);
      expect(fixtureRelPath("claude", "Stop", decision, tool, count)).toBe(
        `${FIXTURES_DIRNAME}/claude/Stop/${id}.json`,
      );
    }
  });
});

// ── 4. Structure and determinism of the committed bytes ──────────────────────

describe("parity corpus — committed bytes", () => {
  /** This machine's fingerprints. Short values are dropped: a two-character
   *  username would match by coincidence and teach people to ignore the gate. */
  const NEEDLES: Array<[string, string]> = (
    [
      ["os.homedir()", homedir()],
      ["process.cwd()", process.cwd()],
      ["os.userInfo().username", userInfo().username],
    ] as Array<[string, string]>
  ).filter(([, v]) => typeof v === "string" && v.length >= 4);

  it("contains nothing machine-specific", () => {
    // The Phase 1 plan's "Corpus determinism" risk in one assertion: a corpus
    // carrying a developer's home directory is worthless the moment anyone else
    // regenerates it, and the failure would look like an unrelated diff.
    for (const [relPath, contents] of committed) {
      for (const [label, needle] of NEEDLES) {
        expect(
          contents.includes(needle),
          `${relPath} contains this machine's ${label} (${JSON.stringify(needle)})`,
        ).toBe(false);
      }
      expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(contents), `${relPath} contains a timestamp`).toBe(
        false,
      );
    }
  });

  it("uses the synthetic constants and only those", () => {
    const sample = JSON.parse(
      committed.get(fixtureRelPath("codex", "PreToolUse", "deny", "tool-present", 2)) ?? "{}",
    ) as { input: { session: Record<string, string>; payload: Record<string, unknown> } };
    expect(sample.input.session.home).toBe(SYNTHETIC.home);
    expect(sample.input.session.cwd).toBe(SYNTHETIC.cwd);
    expect(sample.input.session.sessionId).toBe(SYNTHETIC.sessionId);
    expect(sample.input.payload.tool_name).toBe(SYNTHETIC.toolName);
  });

  it("is stable 2-space JSON with sorted keys and a trailing newline", () => {
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        expect(keys, `${path} keys are not sorted`).toEqual([...keys].sort());
        for (const key of keys) walk((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    for (const [relPath, raw] of committed) {
      expect(raw.endsWith("}\n"), `${relPath} must end with a trailing newline`).toBe(true);
      expect(raw.includes("\t"), `${relPath} must not contain a literal tab`).toBe(false);
      const parsed: unknown = JSON.parse(raw);
      expect(raw, `${relPath} is not stable 2-space JSON`).toBe(
        `${JSON.stringify(parsed, null, 2)}\n`,
      );
      walk(parsed, relPath);
    }
  });

  it("every fixture records both the input and the captured wire bytes", () => {
    const OUTPUT_KEYS = [
      "decision",
      "exitCode",
      "policyName",
      "policyNames",
      "reason",
      "stderr",
      "stdout",
    ];
    for (const [relPath, raw] of committed) {
      if (!relPath.startsWith(`${FIXTURES_DIRNAME}/`)) continue;
      if (relPath.endsWith(`/${MANIFEST_FILENAME}`)) continue;
      const fixture = JSON.parse(raw) as {
        case: string;
        cli: string;
        decision_kind: string;
        event: string;
        policy_count: number;
        tool: string;
        input: { event_type: string; payload: Record<string, unknown>; policies: unknown[] };
        output: Record<string, unknown>;
      };
      const [, cli, event, file] = relPath.split("/");
      expect(fixture.cli).toBe(cli);
      expect(fixture.event).toBe(event);
      expect(fixture.input.event_type).toBe(event);
      expect(`${fixture.case}.json`).toBe(file);
      expect(fixture.input.policies).toHaveLength(fixture.policy_count);
      expect(Object.keys(fixture.output).sort()).toEqual(OUTPUT_KEYS);
      // A `tool-absent` payload must genuinely have no tool, or the deny-noun
      // branch under test is not the one being exercised.
      expect("tool_name" in fixture.input.payload).toBe(fixture.tool === "tool-present");
      expect([0, 2]).toContain(fixture.output.exitCode);
    }
  });

  it("actually exercises the JSON-escaping cases byte-exactness exists for", () => {
    // If the synthetic reasons ever lose their escape stress, this corpus stops
    // catching the single most likely Rust/JS divergence and nobody notices.
    const stdout = JSON.parse(
      committed.get(fixtureRelPath("claude", "PreToolUse", "deny", "tool-present", 1)) ?? "{}",
    ) as { output: { stdout: string } };
    expect(stdout.output.stdout).toContain('\\"');
    expect(stdout.output.stdout).toContain("\\\\");
    expect(stdout.output.stdout).toContain("\\n");
    expect(stdout.output.stdout).toContain("\\t");
    expect(stdout.output.stdout).toContain("/s/");
    expect(stdout.output.stdout).toContain("<t>&a");
    expect(stdout.output.stdout).toContain("é");
    expect(stdout.output.stdout).toContain("𝄞");
  });
});

// ── A last sanity check on the gate itself ───────────────────────────────────

describe("parity corpus — the gate is not vacuous", () => {
  it("a single flipped byte in a fixture changes the corpus digest", () => {
    const relPath = fixtureRelPath("cursor", "PreToolUse", "deny", "tool-present", 1);
    const original = committed.get(relPath);
    expect(original).toBeDefined();
    const mutated = [...committed.entries()]
      .map(([p, c]) => ({ relPath: p, contents: p === relPath ? c.replace("deny", "denyX") : c }))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    expect(corpusDigest(mutated)).not.toBe(manifest.corpus_sha256);
  });

  it("a flipped coverage label disagrees with the live derivation", () => {
    // The mirror image of the regression gate: prove the recomputation can tell
    // the labels apart, so `expectedLabel` is not accidentally constant.
    const distinct = new Set<string>();
    for (const cli of INTEGRATION_TYPES) {
      for (const event of HOOK_EVENT_TYPES) distinct.add(expectedLabel(cli, event));
    }
    expect(distinct.size).toBeGreaterThan(1);
    expect(distinct.has("reachable")).toBe(true);
    expect(distinct.has("not-registered")).toBe(true);

    const claudePreToolUse = expectedLabel("claude", "PreToolUse");
    expect(claudePreToolUse).toBe("reachable");
    expect(claudePreToolUse).not.toBe("not-registered");
    // claude installs every event EXCEPT WorktreeCreate (Claude uses it as a
    // worktree-PATH PROVIDER, not a gate), so this pair is the one cell where
    // "registered" and "the CLI has the event" genuinely differ.
    expect(expectedLabel("claude", "WorktreeCreate")).toBe("not-registered");
  });

  it("the corpus digest is a real hash of real content", () => {
    const one = corpusDigest([{ relPath: "a", contents: "b" }]);
    const two = corpusDigest([{ relPath: "a", contents: "c" }]);
    expect(one).not.toBe(two);
    expect(one).toHaveLength(64);
    expect(one).toBe(createHash("sha256").update("a").update("\n").update("b").digest("hex"));
  });
});
