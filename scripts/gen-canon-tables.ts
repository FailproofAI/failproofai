/**
 * gen-canon-tables.ts — emit the canonicalization + enforcement-capability
 * tables that the Rust `fpai-canon` crate consumes.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  REGENERATE WITH:   bun scripts/gen-canon-tables.ts                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Outputs (both JSON, never `.rs`):
 *
 *   crates/generated/canonicalization-tables.json
 *   crates/generated/enforcement-capability.json
 *
 * WHY JSON AND NOT GENERATED RUST. `src/hooks/types.ts` stays the single source
 * of truth. Its "verified live against <cli> vX.Y.Z" annotations stay where
 * reviewers already look, and there is no generated Rust in the diff for anyone
 * to review or hand-patch. A CI drift gate
 * (`__tests__/parity/canon-tables-drift.test.ts`) re-runs this generator and
 * fails on any byte difference.
 *
 * DERIVATION RULES — nothing here hardcodes "twelve CLIs" or a list of events:
 *
 *   • The CLI list is `INTEGRATION_TYPES`.
 *   • The canonical event list is `HOOK_EVENT_TYPES`.
 *   • Per-CLI tables are resolved from `src/hooks/types.ts` BY NAMING
 *     CONVENTION — `<CLI>_HOOK_EVENT_TYPES`, `<CLI>_EVENT_MAP`,
 *     `<CLI>_TOOL_MAP`, `<CLI>_TOOL_INPUT_MAP`, `<CLI>_HOOK_SCOPES` — so a
 *     thirteenth CLI changes the output the moment its constants land.
 *   • Every emitted tool table is PROBED against the live
 *     `canonicalizeToolName` / `canonicalizeToolInput` implementations, so the
 *     table can never claim a mapping the runtime does not perform (or omit a
 *     branch the runtime does have).
 *   • Structural violations are HARD FAILURES (nonzero exit, nothing written).
 *     Gaps that are properties of the source of truth rather than of this
 *     generator — a vendor event with no canonical `HookEventType`, a CLI with
 *     no declared event list — are recorded as data in the output AND warned
 *     about on stderr, never silently dropped.
 *
 * THE ONE THING NOT DERIVED, AND WHY. The per-CLI payload field normalizations
 * live as inline code in `src/hooks/handler.ts` (and `resolve-cwd.ts`), not as
 * exported constants, so they are transcribed as data below in
 * `PAYLOAD_NORMALIZATIONS`. They are part of canonicalization: a Rust daemon
 * that skips them reads a null tool name off an Antigravity payload and returns
 * a different verdict. Every key is validated against `INTEGRATION_TYPES`, and
 * `canon-tables-drift.test.ts` cross-checks each rule against the actual source
 * text of the normalization block it mirrors.
 *
 * Usage:
 *   bun scripts/gen-canon-tables.ts                # write crates/generated/
 *   bun scripts/gen-canon-tables.ts --out <dir>    # write elsewhere (tests)
 *   bun scripts/gen-canon-tables.ts --check        # verify only, write nothing
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as types from "../src/hooks/types";
import { HOOK_EVENT_TYPES, HOOK_SCOPES, INTEGRATION_TYPES } from "../src/hooks/types";
import type { HookEventType, IntegrationType } from "../src/hooks/types";
import { ENFORCEMENT_CAPABILITY } from "../src/hooks/enforcement-capability";
import { canonicalizeToolInput, canonicalizeToolName } from "../src/hooks/tool-name-canonicalize";

// ── Schema version ───────────────────────────────────────────────────────────
//
// Bump when the SHAPE of either emitted document changes (a renamed key, a
// changed value vocabulary). Do NOT bump for content changes — a new CLI, a new
// tool mapping — those are data. The Rust reader refuses an unexpected version.
export const SCHEMA_VERSION = 1;

export const CANONICALIZATION_TABLES_FILENAME = "canonicalization-tables.json";
export const ENFORCEMENT_CAPABILITY_FILENAME = "enforcement-capability.json";

export const REGENERATE_COMMAND = "bun scripts/gen-canon-tables.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT_DIR = join(REPO_ROOT, "crates", "generated");

// ── Payload field normalization ──────────────────────────────────────────────

/** Where a normalization rule reads its value from. A string element is an
 *  object key; a number element is an array index. */
export type PayloadPathSegment = string | number;

/** Guard on the SOURCE value. Mirrors the `typeof` checks in handler.ts. */
export const PAYLOAD_REQUIRE_TYPES = ["defined", "string", "non_empty_string"] as const;
export type PayloadRequireType = (typeof PAYLOAD_REQUIRE_TYPES)[number];

/** Guard on the TARGET key — whether an existing canonical value is overwritten. */
export const PAYLOAD_WHEN = ["always", "target_undefined", "target_missing_or_empty"] as const;
export type PayloadWhen = (typeof PAYLOAD_WHEN)[number];

export interface PayloadNormalization {
  /** Path into the raw stdin payload. */
  from: PayloadPathSegment[];
  /** Top-level canonical key the value is written to. */
  to: string;
  require_type: PayloadRequireType;
  when: PayloadWhen;
  /** The TypeScript module this rule mirrors. The drift test reads it. */
  source: string;
}

const HANDLER_SOURCE = "src/hooks/handler.ts";
const RESOLVE_CWD_SOURCE = "src/hooks/resolve-cwd.ts";

/**
 * Per-CLI payload field normalizations, in the order the TypeScript applies
 * them. CLIs absent from this map need none — their stdin is already
 * Claude-shaped snake_case.
 *
 * MIRRORS `src/hooks/handler.ts` (the `cli === "…"` blocks that run
 * immediately after `JSON.parse`, BEFORE event/tool canonicalization) and the
 * Cursor branch of `src/hooks/resolve-cwd.ts`. Change one, change the other —
 * `__tests__/parity/canon-tables-drift.test.ts` asserts they agree.
 */
export const PAYLOAD_NORMALIZATIONS: Partial<Record<IntegrationType, PayloadNormalization[]>> = {
  // Antigravity (agy) pipes a camelCase protojson payload. Verified agy v1.1.2.
  antigravity: [
    { from: ["toolCall", "name"], to: "tool_name", require_type: "defined", when: "always", source: HANDLER_SOURCE },
    { from: ["toolCall", "args"], to: "tool_input", require_type: "defined", when: "always", source: HANDLER_SOURCE },
    { from: ["conversationId"], to: "session_id", require_type: "string", when: "always", source: HANDLER_SOURCE },
    { from: ["workspacePaths", 0], to: "cwd", require_type: "string", when: "always", source: HANDLER_SOURCE },
    { from: ["transcriptPath"], to: "transcript_path", require_type: "string", when: "always", source: HANDLER_SOURCE },
  ],
  // Copilot's snake_case events are already Claude-shaped; `permissionRequest`
  // ALONE pipes camelCase. Verified live against Copilot CLI 1.0.71. The
  // `target_undefined` guard is what keeps this inert on the other events.
  copilot: [
    { from: ["toolName"], to: "tool_name", require_type: "string", when: "target_undefined", source: HANDLER_SOURCE },
    { from: ["toolInput"], to: "tool_input", require_type: "defined", when: "target_undefined", source: HANDLER_SOURCE },
    { from: ["sessionId"], to: "session_id", require_type: "string", when: "target_undefined", source: HANDLER_SOURCE },
  ],
  // Goose pipes `event` / `working_dir` instead of `hook_event_name` / `cwd`.
  // Verified goose v1.43.0.
  goose: [
    { from: ["working_dir"], to: "cwd", require_type: "string", when: "always", source: HANDLER_SOURCE },
    { from: ["event"], to: "hook_event_name", require_type: "string", when: "target_undefined", source: HANDLER_SOURCE },
  ],
  // Cursor omits top-level `cwd` on every non-tool event and sends
  // `workspace_roots: string[]` instead. Unlike the three above this is applied
  // by the cwd RESOLVER rather than by an in-place payload rewrite, hence the
  // different `source` — but a daemon that skips it loses the cwd that
  // `block-read-outside-cwd` and project-scope config discovery both depend on.
  cursor: [
    {
      from: ["workspace_roots", 0],
      to: "cwd",
      require_type: "non_empty_string",
      when: "target_missing_or_empty",
      source: RESOLVE_CWD_SOURCE,
    },
  ],
};

// ── Emitted document types ───────────────────────────────────────────────────

export interface CliCanonicalizationEntry {
  /** True when the vendor's own event names ARE the canonical names, i.e.
   *  there is no `<CLI>_EVENT_MAP`. `event_map` is then the identity. */
  event_names_are_canonical: boolean;
  /** The exported constant `event_types` came from. `HOOK_EVENT_TYPES` means
   *  the CLI declares no list of its own (today: claude). */
  event_types_source: string;
  /** The vendor's own event names. Partitioned exhaustively by
   *  `event_map` ∪ `unmapped_event_types`. */
  event_types: string[];
  /** Vendor event name → canonical `HookEventType`. Every value is a member of
   *  `canonical_event_types`. */
  event_map: Record<string, string>;
  /** Vendor events with NO canonical `HookEventType`. A policy cannot subscribe
   *  to these and `enforcement-capability.json` cannot key them. */
  unmapped_event_types: string[];
  /** Sorted, de-duplicated image of `event_map`. */
  reachable_canonical_events: string[];
  scopes_source: string;
  scopes: string[];
  /** Exported constant name, or null when the CLI needs no tool-name mapping. */
  tool_map_source: string | null;
  /** Vendor tool name → canonical tool name. Unlisted names pass through. */
  tool_map: Record<string, string>;
  tool_input_map_source: string | null;
  /** Canonical tool name → { vendor input key → canonical input key }. Applied
   *  AFTER `tool_map`, so it is keyed by the canonical name. */
  tool_input_map: Record<string, Record<string, string>>;
  /** Applied FIRST, before every other table. See `pipeline`. */
  payload_normalizations: PayloadNormalization[];
}

export interface CanonicalizationTables {
  schema_version: number;
  generated_from: string;
  generated_by: string;
  regenerate_with: string;
  description: string;
  /** The order the tables must be applied in. */
  pipeline: string[];
  canonical_event_types: string[];
  /** Union of every `tool_map` value. `types.ts` declares no canonical
   *  tool-name list, so this is the closest thing to one. */
  canonical_tool_names: string[];
  payload_normalization_vocabulary: {
    require_type: string[];
    when: string[];
  };
  clis: Record<string, CliCanonicalizationEntry>;
}

export interface CliEnforcementEntry {
  /** Canonical event → label. ABSENT MEANS NOT VERIFIED, never "block". */
  capabilities: Record<string, string>;
  /** Canonical events this CLI can produce that carry no label. */
  unverified_events: string[];
  /** Labelled events this CLI's `event_map` cannot actually produce. Non-empty
   *  is a bug in one of the two source files. */
  capabilities_outside_reachable_events: string[];
}

export interface EnforcementCapabilityTable {
  schema_version: number;
  generated_from: string;
  generated_by: string;
  regenerate_with: string;
  description: string;
  absent_means: string;
  /** The complete label vocabulary, derived from the values actually present. */
  labels: string[];
  clis: Record<string, CliEnforcementEntry>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

class CanonGenerationError extends Error {}

function fail(message: string): never {
  throw new CanonGenerationError(message);
}

const warnings: string[] = [];
function warn(message: string): void {
  warnings.push(message);
}

const moduleNamespace = types as unknown as Record<string, unknown>;

function lookupExport<T>(name: string): T | undefined {
  return moduleNamespace[name] as T | undefined;
}

function constantPrefix(cli: IntegrationType): string {
  return cli.toUpperCase();
}

/** Recursively sort object keys. Arrays keep the order they were built with. */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = deepSortKeys(src[key]);
    return out;
  }
  return value;
}

/** Stable 2-space JSON with a trailing newline. Byte-identical across runs. */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(deepSortKeys(value), null, 2)}\n`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ── Runtime probes ───────────────────────────────────────────────────────────

const PROBE_SENTINEL = "__fpai_canon_probe__";

/**
 * Prove the emitted tool tables describe what the runtime actually does. A
 * table that names a mapping `canonicalizeToolName` never performs would send
 * the Rust daemon down a different code path than the TypeScript reference,
 * which is exactly the class of bug byte-exact parity exists to catch.
 */
function probeToolTables(
  cli: IntegrationType,
  toolMap: Record<string, string> | undefined,
  toolInputMap: Record<string, Record<string, string>> | undefined,
  allToolMapKeys: readonly string[],
  allToolInputPairs: ReadonlyArray<readonly [string, string]>,
): void {
  if (toolMap) {
    for (const [raw, canonical] of Object.entries(toolMap)) {
      const actual = canonicalizeToolName(raw, cli);
      if (actual !== canonical) {
        fail(
          `${constantPrefix(cli)}_TOOL_MAP says ${JSON.stringify(raw)} → ${JSON.stringify(canonical)}, ` +
            `but canonicalizeToolName() returned ${JSON.stringify(actual)}. ` +
            `Add or fix the "${cli}" branch in src/hooks/tool-name-canonicalize.ts.`,
        );
      }
    }
  } else {
    // No declared map: assert the runtime really has no hidden branch for this
    // CLI, by throwing every OTHER CLI's vendor tool name at it.
    for (const raw of allToolMapKeys) {
      const actual = canonicalizeToolName(raw, cli);
      if (actual !== raw) {
        fail(
          `No ${constantPrefix(cli)}_TOOL_MAP is exported from src/hooks/types.ts, but ` +
            `canonicalizeToolName(${JSON.stringify(raw)}, "${cli}") returned ${JSON.stringify(actual)}. ` +
            `The runtime canonicalizes "${cli}" tool names from a table this generator cannot see.`,
        );
      }
    }
  }

  if (toolInputMap) {
    for (const [toolName, keyMap] of Object.entries(toolInputMap)) {
      for (const [vendorKey, canonicalKey] of Object.entries(keyMap)) {
        const out = canonicalizeToolInput(toolName, { [vendorKey]: PROBE_SENTINEL }, cli) as Record<
          string,
          unknown
        >;
        if (out?.[canonicalKey] !== PROBE_SENTINEL) {
          fail(
            `${constantPrefix(cli)}_TOOL_INPUT_MAP says ${toolName}.${vendorKey} → ${canonicalKey}, ` +
              `but canonicalizeToolInput() produced ${JSON.stringify(out)}. ` +
              `Add or fix the "${cli}" branch in src/hooks/tool-name-canonicalize.ts.`,
          );
        }
      }
    }
  } else {
    for (const [toolName, vendorKey] of allToolInputPairs) {
      const out = canonicalizeToolInput(toolName, { [vendorKey]: PROBE_SENTINEL }, cli) as Record<
        string,
        unknown
      >;
      if (out?.[vendorKey] !== PROBE_SENTINEL) {
        fail(
          `No ${constantPrefix(cli)}_TOOL_INPUT_MAP is exported from src/hooks/types.ts, but ` +
            `canonicalizeToolInput(${JSON.stringify(toolName)}, {${vendorKey}}, "${cli}") rewrote the key ` +
            `(${JSON.stringify(out)}). The runtime canonicalizes "${cli}" tool inputs from a table this ` +
            `generator cannot see.`,
        );
      }
    }
  }
}

// ── Builders ─────────────────────────────────────────────────────────────────

export function buildCanonicalizationTables(): CanonicalizationTables {
  warnings.length = 0;

  const canonicalEvents = new Set<string>(HOOK_EVENT_TYPES as readonly string[]);

  for (const cli of Object.keys(PAYLOAD_NORMALIZATIONS)) {
    if (!(INTEGRATION_TYPES as readonly string[]).includes(cli)) {
      fail(
        `PAYLOAD_NORMALIZATIONS has an entry for "${cli}", which is not in INTEGRATION_TYPES. ` +
          `Remove the stale key or add the CLI to src/hooks/types.ts.`,
      );
    }
  }

  // Collect every declared vendor tool name / tool-input pair up front, so the
  // "this CLI declares no map" probe has something meaningful to throw at it.
  const allToolMapKeys = new Set<string>();
  const allToolInputPairs: Array<readonly [string, string]> = [];
  for (const cli of INTEGRATION_TYPES) {
    const prefix = constantPrefix(cli);
    const tm = lookupExport<Record<string, string>>(`${prefix}_TOOL_MAP`);
    if (tm) for (const key of Object.keys(tm)) allToolMapKeys.add(key);
    const tim = lookupExport<Record<string, Record<string, string>>>(`${prefix}_TOOL_INPUT_MAP`);
    if (tim) {
      for (const [toolName, keyMap] of Object.entries(tim)) {
        for (const vendorKey of Object.keys(keyMap)) allToolInputPairs.push([toolName, vendorKey] as const);
      }
    }
  }
  const probeToolNames = [...allToolMapKeys].sort();

  const clis: Record<string, CliCanonicalizationEntry> = {};
  const canonicalToolNames = new Set<string>();

  for (const cli of INTEGRATION_TYPES) {
    const prefix = constantPrefix(cli);
    const eventTypesName = `${prefix}_HOOK_EVENT_TYPES`;
    const eventMapName = `${prefix}_EVENT_MAP`;
    const toolMapName = `${prefix}_TOOL_MAP`;
    const toolInputMapName = `${prefix}_TOOL_INPUT_MAP`;
    const scopesName = `${prefix}_HOOK_SCOPES`;

    const declaredEventTypes = lookupExport<readonly string[]>(eventTypesName);
    const eventMap = lookupExport<Record<string, string>>(eventMapName);
    const toolMap = lookupExport<Record<string, string>>(toolMapName);
    const toolInputMap = lookupExport<Record<string, Record<string, string>>>(toolInputMapName);
    const declaredScopes = lookupExport<readonly string[]>(scopesName);

    // A CLI that renames events MUST declare which events it renames.
    if (eventMap && !declaredEventTypes) {
      fail(
        `${eventMapName} is exported from src/hooks/types.ts but ${eventTypesName} is not. ` +
          `The event map cannot be shown total without the vendor's own event list.`,
      );
    }

    let eventTypesSource = eventTypesName;
    let eventTypes: readonly string[];
    if (declaredEventTypes) {
      eventTypes = declaredEventTypes;
    } else {
      // No vendor list and (by the check above) no event map: the CLI's names
      // are the canonical names. True for claude today.
      eventTypes = HOOK_EVENT_TYPES as readonly string[];
      eventTypesSource = "HOOK_EVENT_TYPES";
      warn(
        `${cli}: no ${eventTypesName} export — falling back to HOOK_EVENT_TYPES ` +
          `(recorded as event_types_source in the output).`,
      );
    }

    if (eventMap) {
      const missing = eventTypes.filter((event) => !(event in eventMap));
      if (missing.length > 0) {
        fail(
          `${eventMapName} is not total over ${eventTypesName}: no mapping for ` +
            `${missing.map((m) => JSON.stringify(m)).join(", ")}.`,
        );
      }
      const extra = Object.keys(eventMap).filter((k) => !eventTypes.includes(k));
      if (extra.length > 0) {
        fail(
          `${eventMapName} maps ${extra.map((m) => JSON.stringify(m)).join(", ")}, which ` +
            `${extra.length === 1 ? "is" : "are"} not in ${eventTypesName}.`,
        );
      }
    }

    const emittedEventMap: Record<string, string> = {};
    const unmappedEventTypes: string[] = [];
    for (const vendorEvent of eventTypes) {
      const canonical = eventMap ? eventMap[vendorEvent] : vendorEvent;
      if (canonicalEvents.has(canonical)) {
        emittedEventMap[vendorEvent] = canonical;
      } else {
        unmappedEventTypes.push(vendorEvent);
        warn(
          `${cli}: vendor event ${JSON.stringify(vendorEvent)} has no canonical HookEventType ` +
            `(${eventMap ? `${eventMapName} → ${JSON.stringify(canonical)}` : "identity"}). ` +
            `Recorded in unmapped_event_types; no policy can subscribe to it.`,
        );
      }
    }

    probeToolTables(cli, toolMap, toolInputMap, probeToolNames, allToolInputPairs);

    if (toolMap) for (const value of Object.values(toolMap)) canonicalToolNames.add(value);

    let scopesSource = scopesName;
    let scopes: readonly string[];
    if (declaredScopes) {
      scopes = declaredScopes;
    } else {
      scopes = HOOK_SCOPES as readonly string[];
      scopesSource = "HOOK_SCOPES";
      warn(
        `${cli}: no ${scopesName} export — falling back to HOOK_SCOPES ` +
          `(recorded as scopes_source in the output).`,
      );
    }

    clis[cli] = {
      event_names_are_canonical: !eventMap,
      event_types_source: eventTypesSource,
      event_types: [...eventTypes].sort(),
      event_map: emittedEventMap,
      unmapped_event_types: unmappedEventTypes.sort(),
      reachable_canonical_events: sortedUnique(Object.values(emittedEventMap)),
      scopes_source: scopesSource,
      scopes: [...scopes].sort(),
      tool_map_source: toolMap ? toolMapName : null,
      tool_map: toolMap ? { ...toolMap } : {},
      tool_input_map_source: toolInputMap ? toolInputMapName : null,
      tool_input_map: toolInputMap ? { ...toolInputMap } : {},
      payload_normalizations: PAYLOAD_NORMALIZATIONS[cli] ?? [],
    };
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_from: "src/hooks/types.ts",
    generated_by: "scripts/gen-canon-tables.ts",
    regenerate_with: REGENERATE_COMMAND,
    description:
      "Per-CLI canonicalization tables for the failproofai hook pipeline. Consumed by the Rust " +
      "fpai-canon crate. src/hooks/types.ts is the single source of truth; do not hand-edit.",
    pipeline: ["payload_normalizations", "event_map", "tool_map", "tool_input_map"],
    canonical_event_types: [...(HOOK_EVENT_TYPES as readonly string[])].sort(),
    canonical_tool_names: sortedUnique(canonicalToolNames),
    payload_normalization_vocabulary: {
      require_type: [...PAYLOAD_REQUIRE_TYPES].sort(),
      when: [...PAYLOAD_WHEN].sort(),
    },
    clis,
  };
}

export function buildEnforcementCapability(
  canonicalization: CanonicalizationTables,
): EnforcementCapabilityTable {
  const labels = new Set<string>();
  const clis: Record<string, CliEnforcementEntry> = {};

  for (const cli of INTEGRATION_TYPES) {
    const perCli = ENFORCEMENT_CAPABILITY[cli];
    if (!perCli) {
      fail(
        `ENFORCEMENT_CAPABILITY has no entry for "${cli}". Every INTEGRATION_TYPES member needs ` +
          `one (an empty object is fine — absent means "not verified", and the table must still be total).`,
      );
    }

    const entry = canonicalization.clis[cli];
    const reachable = new Set(entry.reachable_canonical_events);

    const capabilities: Record<string, string> = {};
    for (const [event, label] of Object.entries(perCli)) {
      if (typeof label !== "string") continue;
      capabilities[event] = label;
      labels.add(label);
    }

    const outside = Object.keys(capabilities).filter((event) => !reachable.has(event));
    for (const event of outside) {
      warn(
        `${cli}: ENFORCEMENT_CAPABILITY labels ${JSON.stringify(event)}, but the CLI's event map ` +
          `cannot produce it. One of the two source files is wrong.`,
      );
    }

    clis[cli] = {
      capabilities,
      unverified_events: [...reachable].filter((event) => !(event in capabilities)).sort(),
      capabilities_outside_reachable_events: outside.sort(),
    };
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_from: "src/hooks/enforcement-capability.ts",
    generated_by: "scripts/gen-canon-tables.ts",
    regenerate_with: REGENERATE_COMMAND,
    description:
      "Does a policy DENY on this (cli, canonical event) pair actually change the agent's behaviour, " +
      "given the wire shape failproofai emits today? Consumed by the Rust adapter descriptor, which is " +
      "asserted against this table. src/hooks/enforcement-capability.ts is the single source of truth; " +
      "do not hand-edit.",
    absent_means:
      "NOT VERIFIED. Never assume \"block\" — a hedge rendered in a UI is still a claim, and an " +
      "unverified claim is what the source file exists to prevent.",
    labels: sortedUnique(labels),
    clis,
  };
}

// ── Emit ─────────────────────────────────────────────────────────────────────

export interface GeneratedFile {
  filename: string;
  contents: string;
}

/** Build both documents. Throws on any structural violation; nothing is written. */
export function generate(): GeneratedFile[] {
  const canonicalization = buildCanonicalizationTables();
  const enforcement = buildEnforcementCapability(canonicalization);
  return [
    { filename: CANONICALIZATION_TABLES_FILENAME, contents: renderJson(canonicalization) },
    { filename: ENFORCEMENT_CAPABILITY_FILENAME, contents: renderJson(enforcement) },
  ];
}

/** Build and write. Returns the absolute paths written. */
export function writeTables(outDir: string = DEFAULT_OUT_DIR): string[] {
  const files = generate();
  mkdirSync(outDir, { recursive: true });
  return files.map(({ filename, contents }) => {
    const target = join(outDir, filename);
    writeFileSync(target, contents, "utf8");
    return target;
  });
}

/** Warnings accumulated by the most recent `generate()` call. */
export function lastWarnings(): string[] {
  return [...warnings];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { outDir: string; check: boolean } {
  let outDir = DEFAULT_OUT_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      const next = argv[i + 1];
      if (!next) fail(`--out requires a directory argument.`);
      outDir = resolve(next);
      i += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        `Usage: ${REGENERATE_COMMAND} [--out <dir>] [--check]\n\n` +
          `  --out <dir>   write the JSON tables to <dir> (default: crates/generated)\n` +
          `  --check       build and verify only; write nothing\n`,
      );
      process.exit(0);
    } else {
      fail(`Unknown argument ${JSON.stringify(arg)}. Try --help.`);
    }
  }
  return { outDir, check };
}

function main(argv: string[]): number {
  let outDir: string;
  let check: boolean;
  try {
    ({ outDir, check } = parseArgs(argv));
  } catch (err) {
    process.stderr.write(`[gen-canon-tables] ${(err as Error).message}\n`);
    return 2;
  }

  let files: GeneratedFile[];
  try {
    files = generate();
  } catch (err) {
    if (err instanceof CanonGenerationError) {
      process.stderr.write(`[gen-canon-tables] FAILED: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  for (const message of lastWarnings()) {
    process.stderr.write(`[gen-canon-tables] warning: ${message}\n`);
  }

  if (check) {
    let stale = 0;
    for (const { filename, contents } of files) {
      const target = join(outDir, filename);
      let existing = "";
      try {
        existing = readFileSync(target, "utf8");
      } catch {
        process.stderr.write(`[gen-canon-tables] missing: ${target}\n`);
        stale += 1;
        continue;
      }
      if (existing !== contents) {
        process.stderr.write(`[gen-canon-tables] stale: ${target}\n`);
        stale += 1;
      }
    }
    if (stale > 0) {
      process.stderr.write(`[gen-canon-tables] ${stale} file(s) out of date. Run: ${REGENERATE_COMMAND}\n`);
      return 1;
    }
    process.stdout.write(`[gen-canon-tables] up to date (${files.length} files).\n`);
    return 0;
  }

  mkdirSync(outDir, { recursive: true });
  for (const { filename, contents } of files) {
    const target = join(outDir, filename);
    writeFileSync(target, contents, "utf8");
    process.stdout.write(`[gen-canon-tables] wrote ${target}\n`);
  }
  return 0;
}

// Run only when executed directly, never on import (the drift test imports the
// builders). `import.meta.main` is bun-only, so compare argv instead.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
