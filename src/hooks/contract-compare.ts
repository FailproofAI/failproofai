/**
 * Turn an observed hook contract into findings about THIS build's translation
 * maps.
 *
 * `contract-observer.ts` records what a vendor actually sent. This decides
 * whether what it sent is still something we can read. That gap is where the
 * product fails silently: every policy we enforce depends on a hand-written
 * translation of some vendor's payload, each verified live against one version
 * of one CLI, with nothing since re-checking it. When Copilot 1.0.71 renamed
 * Read's `file_path` to `path`, `block-env-files` went inert on a live `.env`
 * read and every surface went on reporting success.
 *
 * ## The one rule that keeps this honest
 *
 * It does not describe the translation — it RUNS it. `canonicalizeToolName`
 * and `canonicalizeToolInput` are the same functions `handler.ts` calls on the
 * live path, applied here to the key names the observer recorded. A separate
 * description of what those maps do would be a second copy of the maps, and the
 * copy nobody executes is the one that goes stale without telling anyone. This
 * is the same call `config-drift.ts` makes: regenerate through the real writer
 * rather than keeping a schema beside it.
 *
 * ## What it can and cannot prove
 *
 * From a table alone it can prove that a key we need is not derivable — that
 * is arithmetic on names, and it is the finding that matters. It cannot prove a
 * vendor stopped firing an event, because a table only holds what arrived and
 * an event may simply not have been exercised. Absence lives with whoever knows
 * what the session did (the lab, which drives a known tool call); this module
 * deliberately never infers it.
 *
 * Input is deliberately loosely typed. The same comparison runs over a table
 * from this machine and over one produced elsewhere by a newer build, and a
 * field we do not recognise must be ignored rather than throw.
 */
import { canonicalizeToolName, canonicalizeToolInput } from "./tool-name-canonicalize";
import { canonicalizeEventType } from "./handler";
import { HOOK_EVENT_TYPES, INTEGRATION_TYPES, type IntegrationType } from "./types";
import * as TYPES from "./types";

/**
 * A canonical input key our policies read, and what stops working without it.
 *
 * Each entry is an OR-set: `block-read-outside-cwd` reads
 * `toolInput.file_path || toolInput.path`, so either name satisfies it and
 * demanding one specific spelling would manufacture findings about CLIs that
 * are working perfectly.
 *
 * This table is small and hand-written, which is exactly the kind of thing that
 * rots — so `contract-compare.test.ts` asserts every key named here still
 * appears in `builtin-policies.ts`. Rename the key in a policy and this fails,
 * rather than quietly checking for something nothing reads.
 *
 * Deliberately NOT required: `old_string` / `new_string` (no builtin inspects
 * an edit body, so a vendor renaming them breaks nothing), `cwd`, and
 * `replace_all`. Several maps translate them as a convenience; a convenience
 * that goes missing is not an outage.
 */
interface KeyRequirement {
  /** Satisfied when ANY of these canonical keys is derivable. */
  anyOf: readonly string[];
  /** What stops working. Goes in the finding, so it must name real policies. */
  why: string;
  /** `high` when enforcement is lost; `info` when only an advisory degrades. */
  severity: "high" | "info";
}

export const REQUIRED_TOOL_INPUT_KEYS: Readonly<Record<string, readonly KeyRequirement[]>> = {
  Bash: [
    {
      anyOf: ["command"],
      why: "every Bash policy (block-sudo, block-rm-rf, block-force-push, ...) reads toolInput.command",
      severity: "high",
    },
  ],
  Read: [
    {
      anyOf: ["file_path", "path"],
      why: "block-env-files and block-read-outside-cwd read the path being read",
      severity: "high",
    },
  ],
  Write: [
    {
      anyOf: ["file_path", "path"],
      why: "block-env-files and block-secrets-write read the path being written",
      severity: "high",
    },
    {
      anyOf: ["content"],
      why: "warn-large-file-write inspects the bytes being written",
      severity: "info",
    },
  ],
  Edit: [
    {
      anyOf: ["file_path", "path"],
      why: "block-env-files and block-secrets-write read the path being edited",
      severity: "high",
    },
  ],
  Grep: [
    {
      anyOf: ["file_path", "path"],
      why: "block-read-outside-cwd reads the search path",
      severity: "high",
    },
  ],
};

export type ContractFindingKind =
  /** A canonical tool we recognise arrives without a key our policies need. */
  | "inert-tool-input"
  /** An event arrived whose name routes to nothing, so no policy can match it. */
  | "unroutable-event"
  /** A vendor tool name we neither map nor recognise. A rename would look like this. */
  | "unmapped-tool";

export interface ContractFinding {
  cli: string;
  kind: ContractFindingKind;
  severity: "high" | "info";
  /** The vendor's own event name, as recorded. */
  event?: string;
  /** The vendor's own tool name, as recorded. */
  tool?: string;
  canonicalTool?: string;
  /** Canonical keys we could not derive, for `inert-tool-input`. */
  missing?: string[];
  /** The vendor key names actually seen. */
  observed?: string[];
  /**
   * What stops working, named in terms of real policies. Separate from
   * `detail` so a caller can compose its own line without re-deriving this.
   */
  why?: string;
  /** One line, safe for a log. Never payload values — the observer records none. */
  detail: string;
}

/** The vendor version the table recorded, when it has one. */
export interface ContractComparison {
  cli: string;
  version?: string;
  findings: ContractFinding[];
}

const CANONICAL_EVENTS = new Set<string>(HOOK_EVENT_TYPES);
const KNOWN_CLIS = new Set<string>(INTEGRATION_TYPES);

/**
 * Tools whose name looks namespaced the way extensions and MCP servers name
 * theirs (`mcp__server__tool`, goose's `<ext>__<tool>`). Used only to hold the
 * rename heuristic below back from shouting about third-party tools.
 */
function looksThirdParty(toolName: string): boolean {
  return toolName.includes("__") || toolName.includes("/") || toolName.startsWith("mcp");
}

/**
 * Which gated tools an untranslated tool's KEYS look like.
 *
 * A tool name we cannot translate is ordinarily unremarkable — agents carry
 * third-party tools we have no business knowing. But a name we cannot translate
 * that arrives carrying exactly the keys one of our gated tools uses is a
 * different thing: that is what a vendor renaming its shell tool looks like
 * from here, and the consequence is every Bash policy silently matching
 * nothing. The keys are the evidence the name cannot give us.
 */
function resemblesGatedTools(observed: readonly string[]): string[] {
  const matches: string[] = [];
  for (const [tool, reqs] of Object.entries(REQUIRED_TOOL_INPUT_KEYS)) {
    const high = reqs.filter((r) => r.severity === "high");
    if (high.length > 0 && high.every((r) => r.anyOf.some((k) => observed.includes(k)))) {
      matches.push(tool);
    }
  }
  return matches;
}

/**
 * Every canonical tool name our maps can produce, derived from the maps rather
 * than listed beside them — a hand-kept copy would be one more thing to forget
 * when a CLI is added. Used to tell an untranslated name apart from a renamed
 * one.
 */
const CANONICAL_TOOL_NAMES = new Set<string>(
  Object.entries(TYPES)
    .filter(([name]) => name.endsWith("_TOOL_MAP"))
    .flatMap(([, map]) => Object.values(map as Record<string, string>)),
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Compare one CLI's recorded hooks against what this build can read.
 *
 * `cli` must be an integration we know; anything else yields no findings rather
 * than guesses, because canonicalization is per-CLI and running the wrong CLI's
 * maps would invent drift that is not there.
 */
export function compareCliContract(cli: string, record: unknown): ContractComparison {
  const rec = asRecord(record);
  const version = typeof rec?.version === "string" ? rec.version : undefined;
  const findings: ContractFinding[] = [];
  const hooks = asRecord(rec?.hooks);
  if (!hooks || !KNOWN_CLIS.has(cli)) return { cli, version, findings };
  const typed = cli as IntegrationType;

  for (const [rawEvent, shapeRaw] of Object.entries(hooks)) {
    const shape = asRecord(shapeRaw);
    if (!shape) continue;

    // An event whose name routes nowhere reaches the policy engine and matches
    // no policy's `match.events`, which reads exactly like a quiet session.
    let canonicalEvent: string;
    try {
      canonicalEvent = canonicalizeEventType(rawEvent, typed);
    } catch {
      canonicalEvent = rawEvent;
    }
    if (!CANONICAL_EVENTS.has(canonicalEvent)) {
      findings.push({
        cli,
        kind: "unroutable-event",
        severity: "high",
        event: rawEvent,
        detail:
          `${cli} sent the event "${rawEvent}", which canonicalizes to "${canonicalEvent}" — ` +
          "not an event any policy can match, so nothing runs for it",
      });
    }

    const tools = asRecord(shape.tools);
    if (!tools) continue;

    for (const [rawTool, keysRaw] of Object.entries(tools)) {
      const observed = asStringArray(keysRaw);
      const canonicalTool = canonicalizeToolName(rawTool, typed) ?? rawTool;

      const reqs = REQUIRED_TOOL_INPUT_KEYS[canonicalTool];
      if (!reqs) {
        // Not a tool our builtins gate. Only worth a note when the name also
        // failed to canonicalize, which is what a vendor rename looks like.
        if (canonicalTool === rawTool && !CANONICAL_TOOL_NAMES.has(rawTool)) {
          const resembles = looksThirdParty(rawTool) ? [] : resemblesGatedTools(observed);
          findings.push({
            cli,
            kind: "unmapped-tool",
            severity: resembles.length > 0 ? "high" : "info",
            event: rawEvent,
            tool: rawTool,
            observed,
            detail:
              resembles.length > 0
                ? `${cli} sent the untranslated tool "${rawTool}" carrying [${observed.join(", ")}] — ` +
                  `the keys ${resembles.join("/")} uses, so this looks like a rename, and every ` +
                  `policy gating ${resembles.join("/")} matches nothing until the map learns it`
                : `${cli} sent the tool "${rawTool}", which no map translates — ` +
                  "harmless if it is a third-party or MCP tool, a silent gap if it was renamed",
          });
        }
        continue;
      }

      // Run the REAL translation over the recorded key names. Values are
      // irrelevant to key mapping, so a placeholder per key is faithful.
      const fake: Record<string, unknown> = {};
      for (const k of observed) fake[k] = "";
      const produced = asRecord(canonicalizeToolInput(canonicalTool, fake, typed)) ?? {};
      const producedKeys = Object.keys(produced);

      for (const req of reqs) {
        if (req.anyOf.some((k) => producedKeys.includes(k))) continue;
        findings.push({
          cli,
          kind: "inert-tool-input",
          severity: req.severity,
          event: rawEvent,
          tool: rawTool,
          canonicalTool,
          missing: [...req.anyOf],
          observed,
          why: req.why,
          detail:
            `${cli} ${rawTool} (${canonicalTool}) arrives as [${observed.join(", ") || "no keys"}], ` +
            `which yields no ${req.anyOf.join(" or ")} — ${req.why}`,
        });
      }
    }
  }

  return { cli, version, findings };
}

/**
 * Compare a whole contract table. Never throws: this feeds `doctor` and a
 * daemon lane, and one malformed CLI record must not hide the other eleven.
 */
export function compareContractTable(table: unknown): ContractComparison[] {
  const clis = asRecord(asRecord(table)?.clis);
  if (!clis) return [];
  const out: ContractComparison[] = [];
  for (const [cli, record] of Object.entries(clis)) {
    try {
      out.push(compareCliContract(cli, record));
    } catch {
      // A record we cannot read is not a finding about the vendor.
      out.push({ cli, findings: [] });
    }
  }
  return out;
}
