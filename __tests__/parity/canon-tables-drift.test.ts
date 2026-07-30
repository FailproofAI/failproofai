// @vitest-environment node
/**
 * Drift gate for the generated canonicalization tables.
 *
 * `crates/generated/*.json` is consumed by the Rust `fpai-canon` crate. If it
 * drifts from `src/hooks/types.ts`, the Rust daemon canonicalizes an event or a
 * tool name differently from the TypeScript reference and returns a *different
 * verdict* — silently, and only for the CLI whose table went stale.
 *
 * Two independent assertions, because either alone is insufficient:
 *
 *   1. BYTE-EQUALITY. Re-run the generator into a temp dir and diff against the
 *      committed files. Catches "someone changed types.ts and forgot to
 *      regenerate", and "someone hand-edited the JSON".
 *   2. TOTALITY. Assert the structural properties directly against the live
 *      constants, so a regenerated-but-WRONG table still fails. Byte-equality
 *      alone would happily bless a generator that emits a partial table.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CANONICALIZATION_TABLES_FILENAME,
  ENFORCEMENT_CAPABILITY_FILENAME,
  PAYLOAD_NORMALIZATIONS,
  PAYLOAD_REQUIRE_TYPES,
  PAYLOAD_WHEN,
  REGENERATE_COMMAND,
  SCHEMA_VERSION,
  writeTables,
} from "../../scripts/gen-canon-tables";
import * as types from "@/src/hooks/types";
import { HOOK_EVENT_TYPES, HOOK_SCOPES, INTEGRATION_TYPES } from "@/src/hooks/types";
import { ENFORCEMENT_CAPABILITY } from "@/src/hooks/enforcement-capability";

const ROOT = process.cwd();
const GENERATED_DIR = resolve(ROOT, "crates", "generated");

/**
 * The only labels `EnforcementCapability` admits. Hardcoded ON PURPOSE: the
 * generator derives `labels` from the values actually present, so if a third
 * label is ever introduced this assertion is what makes it a conscious decision
 * instead of a silent widening.
 */
const KNOWN_ENFORCEMENT_LABELS = ["block", "observe"];

const STALE_MESSAGE =
  `crates/generated/*.json is out of date with src/hooks/types.ts.\n` +
  `Regenerate with:\n\n    ${REGENERATE_COMMAND}\n\n` +
  `and commit the result. Do NOT hand-edit the JSON — src/hooks/types.ts is the source of truth.`;

function readCommitted(filename: string): string {
  return readFileSync(join(GENERATED_DIR, filename), "utf8");
}

function regenerateIntoTempDir(): { dir: string; read: (filename: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "fpai-canon-tables-"));
  writeTables(dir);
  return { dir, read: (filename: string) => readFileSync(join(dir, filename), "utf8") };
}

interface CanonicalizationTablesJson {
  schema_version: number;
  generated_from: string;
  regenerate_with: string;
  pipeline: string[];
  canonical_event_types: string[];
  canonical_tool_names: string[];
  payload_normalization_vocabulary: { require_type: string[]; when: string[] };
  clis: Record<
    string,
    {
      event_names_are_canonical: boolean;
      event_types_source: string;
      event_types: string[];
      event_map: Record<string, string>;
      unmapped_event_types: string[];
      reachable_canonical_events: string[];
      scopes_source: string;
      scopes: string[];
      tool_map_source: string | null;
      tool_map: Record<string, string>;
      tool_input_map_source: string | null;
      tool_input_map: Record<string, Record<string, string>>;
      payload_normalizations: Array<{
        from: Array<string | number>;
        to: string;
        require_type: string;
        when: string;
        source: string;
      }>;
    }
  >;
}

interface EnforcementCapabilityJson {
  schema_version: number;
  generated_from: string;
  labels: string[];
  clis: Record<
    string,
    {
      capabilities: Record<string, string>;
      unverified_events: string[];
      capabilities_outside_reachable_events: string[];
    }
  >;
}

const canon = JSON.parse(readCommitted(CANONICALIZATION_TABLES_FILENAME)) as CanonicalizationTablesJson;
const enforcement = JSON.parse(readCommitted(ENFORCEMENT_CAPABILITY_FILENAME)) as EnforcementCapabilityJson;

describe("canon tables — drift gate", () => {
  it("committed JSON is byte-identical to a fresh generator run", () => {
    const temp = regenerateIntoTempDir();
    try {
      for (const filename of [CANONICALIZATION_TABLES_FILENAME, ENFORCEMENT_CAPABILITY_FILENAME]) {
        const fresh = temp.read(filename);
        const committed = readCommitted(filename);
        if (fresh !== committed) {
          throw new Error(`${STALE_MESSAGE}\n\nFirst stale file: crates/generated/${filename}`);
        }
        // Byte-for-byte, not just string-equal after any normalization.
        expect(Buffer.from(committed, "utf8").equals(Buffer.from(fresh, "utf8"))).toBe(true);
      }
    } finally {
      rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it("the generator is deterministic — two runs produce identical bytes", () => {
    const a = regenerateIntoTempDir();
    const b = regenerateIntoTempDir();
    try {
      for (const filename of [CANONICALIZATION_TABLES_FILENAME, ENFORCEMENT_CAPABILITY_FILENAME]) {
        expect(a.read(filename)).toBe(b.read(filename));
      }
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it("both documents are stable 2-space JSON with a trailing newline", () => {
    for (const filename of [CANONICALIZATION_TABLES_FILENAME, ENFORCEMENT_CAPABILITY_FILENAME]) {
      const raw = readCommitted(filename);
      expect(raw.endsWith("}\n"), `${filename} must end with a trailing newline`).toBe(true);
      expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      expect(raw.includes("\t"), `${filename} must not contain tabs`).toBe(false);
    }
  });

  it("every object's keys are sorted, at every depth", () => {
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
    walk(canon, "canonicalization-tables");
    walk(enforcement, "enforcement-capability");
  });
});

describe("canon tables — self-describing header", () => {
  it("both documents carry the current schema version and their provenance", () => {
    expect(canon.schema_version).toBe(SCHEMA_VERSION);
    expect(enforcement.schema_version).toBe(SCHEMA_VERSION);
    expect(Number.isInteger(canon.schema_version)).toBe(true);
    expect(canon.generated_from).toBe("src/hooks/types.ts");
    expect(enforcement.generated_from).toBe("src/hooks/enforcement-capability.ts");
    expect(canon.regenerate_with).toBe(REGENERATE_COMMAND);
    expect(REGENERATE_COMMAND).toBe("bun scripts/gen-canon-tables.ts");
  });

  it("records the order the tables must be applied in", () => {
    expect(canon.pipeline).toEqual([
      "payload_normalizations",
      "event_map",
      "tool_map",
      "tool_input_map",
    ]);
  });
});

describe("canon tables — totality", () => {
  it("has an entry for every INTEGRATION_TYPES member and nothing else", () => {
    expect(Object.keys(canon.clis).sort()).toEqual([...INTEGRATION_TYPES].sort());
    expect(Object.keys(enforcement.clis).sort()).toEqual([...INTEGRATION_TYPES].sort());
  });

  it("canonical_event_types is exactly HOOK_EVENT_TYPES", () => {
    expect(canon.canonical_event_types).toEqual([...(HOOK_EVENT_TYPES as readonly string[])].sort());
  });

  it.each([...INTEGRATION_TYPES])(
    "%s: event_map ∪ unmapped_event_types partitions event_types exactly",
    (cli) => {
      const entry = canon.clis[cli];
      const covered = [...Object.keys(entry.event_map), ...entry.unmapped_event_types].sort();
      expect(covered).toEqual([...entry.event_types].sort());
      // A partition, not merely a cover — no event may be in both halves.
      expect(new Set(covered).size).toBe(covered.length);
    },
  );

  it.each([...INTEGRATION_TYPES])("%s: every event_map value is a HOOK_EVENT_TYPES member", (cli) => {
    const canonicalEvents = new Set<string>(HOOK_EVENT_TYPES as readonly string[]);
    for (const [vendorEvent, canonicalEvent] of Object.entries(canon.clis[cli].event_map)) {
      expect(
        canonicalEvents.has(canonicalEvent),
        `${cli}: ${vendorEvent} → ${canonicalEvent} is not in HOOK_EVENT_TYPES`,
      ).toBe(true);
    }
  });

  it.each([...INTEGRATION_TYPES])("%s: reachable_canonical_events is the image of event_map", (cli) => {
    const entry = canon.clis[cli];
    expect(entry.reachable_canonical_events).toEqual(
      [...new Set(Object.values(entry.event_map))].sort(),
    );
  });

  it.each([...INTEGRATION_TYPES])("%s: event_types matches the exported constant", (cli) => {
    const ns = types as unknown as Record<string, unknown>;
    const declared = ns[`${cli.toUpperCase()}_HOOK_EVENT_TYPES`] as readonly string[] | undefined;
    const entry = canon.clis[cli];
    if (declared) {
      expect(entry.event_types_source).toBe(`${cli.toUpperCase()}_HOOK_EVENT_TYPES`);
      expect(entry.event_types).toEqual([...declared].sort());
    } else {
      // The fallback is only legitimate when the CLI also declares no event map
      // — i.e. its vendor event names ARE the canonical names.
      expect(ns[`${cli.toUpperCase()}_EVENT_MAP`]).toBeUndefined();
      expect(entry.event_types_source).toBe("HOOK_EVENT_TYPES");
      expect(entry.event_types).toEqual([...(HOOK_EVENT_TYPES as readonly string[])].sort());
    }
  });

  it.each([...INTEGRATION_TYPES])("%s: event_map matches the exported constant", (cli) => {
    const ns = types as unknown as Record<string, unknown>;
    const declared = ns[`${cli.toUpperCase()}_EVENT_MAP`] as Record<string, string> | undefined;
    const entry = canon.clis[cli];
    expect(entry.event_names_are_canonical).toBe(!declared);
    if (declared) {
      // The generator drops entries whose target is not a HookEventType; those
      // land in unmapped_event_types instead.
      const canonicalEvents = new Set<string>(HOOK_EVENT_TYPES as readonly string[]);
      const expected = Object.fromEntries(
        Object.entries(declared).filter(([, v]) => canonicalEvents.has(v)),
      );
      expect(entry.event_map).toEqual(expected);
    } else {
      for (const [key, value] of Object.entries(entry.event_map)) expect(value).toBe(key);
    }
  });

  it.each([...INTEGRATION_TYPES])("%s: tool tables match the exported constants", (cli) => {
    const ns = types as unknown as Record<string, unknown>;
    const prefix = cli.toUpperCase();
    const toolMap = ns[`${prefix}_TOOL_MAP`] as Record<string, string> | undefined;
    const toolInputMap = ns[`${prefix}_TOOL_INPUT_MAP`] as
      | Record<string, Record<string, string>>
      | undefined;
    const entry = canon.clis[cli];
    expect(entry.tool_map_source).toBe(toolMap ? `${prefix}_TOOL_MAP` : null);
    expect(entry.tool_map).toEqual(toolMap ?? {});
    expect(entry.tool_input_map_source).toBe(toolInputMap ? `${prefix}_TOOL_INPUT_MAP` : null);
    expect(entry.tool_input_map).toEqual(toolInputMap ?? {});
  });

  it.each([...INTEGRATION_TYPES])("%s: scopes match the exported constant", (cli) => {
    const ns = types as unknown as Record<string, unknown>;
    const declared = ns[`${cli.toUpperCase()}_HOOK_SCOPES`] as readonly string[] | undefined;
    const entry = canon.clis[cli];
    expect(entry.scopes).toEqual([...(declared ?? (HOOK_SCOPES as readonly string[]))].sort());
    expect(entry.scopes_source).toBe(declared ? `${cli.toUpperCase()}_HOOK_SCOPES` : "HOOK_SCOPES");
  });

  it("canonical_tool_names is the union of every tool_map value", () => {
    const union = new Set<string>();
    for (const cli of INTEGRATION_TYPES) {
      for (const value of Object.values(canon.clis[cli].tool_map)) union.add(value);
    }
    expect(canon.canonical_tool_names).toEqual([...union].sort());
  });

  it("every tool_input_map is keyed by a CANONICAL tool name, never a vendor name", () => {
    // tool_input_map is applied AFTER tool_map, so a vendor-named key would
    // never match and the mapping would silently no-op.
    for (const cli of INTEGRATION_TYPES) {
      const entry = canon.clis[cli];
      const producible = new Set(Object.values(entry.tool_map));
      for (const toolName of Object.keys(entry.tool_input_map)) {
        expect(
          producible.has(toolName),
          `${cli}: tool_input_map key ${toolName} is not produced by ${cli}'s tool_map — it can never match`,
        ).toBe(true);
      }
    }
  });
});

describe("canon tables — payload normalizations", () => {
  it("uses only the declared vocabulary", () => {
    expect(canon.payload_normalization_vocabulary.require_type).toEqual(
      [...PAYLOAD_REQUIRE_TYPES].sort(),
    );
    expect(canon.payload_normalization_vocabulary.when).toEqual([...PAYLOAD_WHEN].sort());
    for (const cli of INTEGRATION_TYPES) {
      for (const rule of canon.clis[cli].payload_normalizations) {
        expect(PAYLOAD_REQUIRE_TYPES as readonly string[]).toContain(rule.require_type);
        expect(PAYLOAD_WHEN as readonly string[]).toContain(rule.when);
        expect(rule.from.length).toBeGreaterThan(0);
        expect(rule.to.length).toBeGreaterThan(0);
      }
    }
  });

  it("is keyed only by INTEGRATION_TYPES members", () => {
    for (const cli of Object.keys(PAYLOAD_NORMALIZATIONS)) {
      expect(INTEGRATION_TYPES as readonly string[]).toContain(cli);
    }
  });

  it("every rule sourced from handler.ts is present in handler.ts, and vice versa", () => {
    // The rules are transcribed rather than imported (handler.ts holds them as
    // inline code, not exported constants), so this is the tripwire that keeps
    // the transcription honest. It brace-matches every `if (cli === "…") { … }`
    // block that WRITES to `parsed` — the payload-normalization blocks, as
    // opposed to the read-only `canonicalizeEventType` dispatch — and compares
    // the set of canonical keys assigned against the transcribed rules.
    const handler = readFileSync(resolve(ROOT, "src", "hooks", "handler.ts"), "utf8");

    const normalizationBlocksFor = (cli: string): string[] => {
      const marker = `if (cli === "${cli}") {`;
      const blocks: string[] = [];
      let from = 0;
      for (;;) {
        const start = handler.indexOf(marker, from);
        if (start === -1) break;
        let depth = 0;
        let end = handler.length - 1;
        for (let i = start + marker.length - 1; i < handler.length; i += 1) {
          if (handler[i] === "{") depth += 1;
          else if (handler[i] === "}") {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const block = handler.slice(start, end + 1);
        if (/parsed\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/.test(block)) blocks.push(block);
        from = end + 1;
      }
      return blocks;
    };

    for (const cli of INTEGRATION_TYPES) {
      const rules = (PAYLOAD_NORMALIZATIONS[cli] ?? []).filter(
        (r) => r.source === "src/hooks/handler.ts",
      );
      const blocks = normalizationBlocksFor(cli);

      if (rules.length === 0) {
        expect(
          blocks,
          `handler.ts has a "${cli}" payload-normalization block with no transcribed rules — ` +
            `add it to PAYLOAD_NORMALIZATIONS in scripts/gen-canon-tables.ts and regenerate`,
        ).toEqual([]);
        continue;
      }
      expect(
        blocks.length,
        `handler.ts is missing the "${cli}" payload-normalization block`,
      ).toBeGreaterThan(0);

      const assigned = new Set<string>();
      for (const block of blocks) {
        for (const m of block.matchAll(/parsed\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/g)) {
          assigned.add(m[1]);
        }
      }
      expect(
        [...assigned].sort(),
        `handler.ts's "${cli}" block assigns a different set of canonical keys than PAYLOAD_NORMALIZATIONS`,
      ).toEqual([...new Set(rules.map((r) => r.to))].sort());

      const joined = blocks.join("\n");
      for (const rule of rules) {
        const leaf = String(rule.from[rule.from.length - 1]);
        const sourceKey = typeof rule.from[0] === "string" ? rule.from[0] : leaf;
        expect(
          joined.includes(sourceKey),
          `handler.ts's "${cli}" block does not read ${sourceKey} (rule → ${rule.to})`,
        ).toBe(true);
      }
    }
  });

  it("the cursor cwd fallback still lives in resolve-cwd.ts", () => {
    const rules = (PAYLOAD_NORMALIZATIONS.cursor ?? []).filter(
      (r) => r.source === "src/hooks/resolve-cwd.ts",
    );
    expect(rules).toHaveLength(1);
    const source = readFileSync(resolve(ROOT, "src", "hooks", "resolve-cwd.ts"), "utf8");
    expect(source).toContain(`integration === "cursor"`);
    expect(source).toContain("workspace_roots");
    expect(rules[0].to).toBe("cwd");
  });
});

describe("enforcement capability", () => {
  it("declares only the known label vocabulary", () => {
    expect(enforcement.labels).toEqual(
      KNOWN_ENFORCEMENT_LABELS.filter((l) => enforcement.labels.includes(l)),
    );
    for (const label of enforcement.labels) expect(KNOWN_ENFORCEMENT_LABELS).toContain(label);
  });

  it.each([...INTEGRATION_TYPES])("%s: every label is from the known vocabulary", (cli) => {
    for (const [event, label] of Object.entries(enforcement.clis[cli].capabilities)) {
      expect(KNOWN_ENFORCEMENT_LABELS, `${cli}/${event} has label ${label}`).toContain(label);
      expect(enforcement.labels).toContain(label);
    }
  });

  it.each([...INTEGRATION_TYPES])("%s: capabilities match ENFORCEMENT_CAPABILITY exactly", (cli) => {
    expect(enforcement.clis[cli].capabilities).toEqual(ENFORCEMENT_CAPABILITY[cli]);
  });

  it.each([...INTEGRATION_TYPES])("%s: every labelled event is a HOOK_EVENT_TYPES member", (cli) => {
    const canonicalEvents = new Set<string>(HOOK_EVENT_TYPES as readonly string[]);
    for (const event of Object.keys(enforcement.clis[cli].capabilities)) {
      expect(canonicalEvents.has(event), `${cli}: ${event} is not a HookEventType`).toBe(true);
    }
  });

  it.each([...INTEGRATION_TYPES])(
    "%s: capabilities ∪ unverified_events covers the reachable events",
    (cli) => {
      const entry = enforcement.clis[cli];
      const reachable = new Set(canon.clis[cli].reachable_canonical_events);
      const labelled = Object.keys(entry.capabilities).filter((e) => reachable.has(e));
      expect([...labelled, ...entry.unverified_events].sort()).toEqual([...reachable].sort());
    },
  );

  it.each([...INTEGRATION_TYPES])(
    "%s: no capability is keyed on an event the CLI cannot produce",
    (cli) => {
      // Non-empty means enforcement-capability.ts and types.ts disagree about
      // which events a CLI has — a real bug in one of them, not a table nit.
      expect(enforcement.clis[cli].capabilities_outside_reachable_events).toEqual([]);
    },
  );
});
