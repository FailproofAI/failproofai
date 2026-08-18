/**
 * What a CLI's hook config looks like, as data.
 *
 * Eight integrations wrote the same file eight times, differing only in details
 * a table can hold: which key the events live under, whether each event's array
 * holds entries directly or wraps them in a group, whether a matcher is written,
 * what the timeout field is called. `config-render.ts` reads one of these and
 * produces the file; `integrations.ts` supplies the template and nothing else.
 *
 * ## The one thing a template may never carry
 *
 * The **command**. That field is what runs on the machine, on every tool call,
 * before the tool runs. If a template could set it, then anything that can
 * supply a template — today the bundled constants, tomorrow possibly a fetched
 * pack — could run arbitrary code on every machine, at high frequency, with no
 * prompt.
 *
 * So a template describes SHAPE and the renderer builds CONTENT. It says the
 * command goes in a field called `bash`; the renderer decides what the command
 * is, from the binary path and scope it was handed. `validateTemplate()` rejects
 * anything command-shaped, so this is a checked boundary rather than a
 * convention — and it is checked from the first commit, because a security
 * boundary added later is one that was absent for every release before it.
 *
 * The worst a bad template can then do is wire hooks to the wrong events or drop
 * them, which weakens enforcement rather than executing anything, and which the
 * repair path's verify-and-roll-back and the contracts lab's next run can both
 * catch.
 */
import {
  ANTIGRAVITY_HOOK_EVENT_TYPES,
  CLAUDE_INSTALL_EVENT_TYPES,
  CODEX_EVENT_MAP,
  CODEX_HOOK_EVENT_TYPES,
  COPILOT_HOOK_EVENT_TYPES,
  CURSOR_HOOK_EVENT_TYPES,
  DEVIN_HOOK_EVENT_TYPES,
  FACTORY_HOOK_EVENT_TYPES,
  GOOSE_HOOK_EVENT_TYPES,
} from "./types";

/** How one event's array is shaped. */
export type GroupShape =
  /** `[{ hooks: [entry] }]` — a matcher group wrapping the entries. */
  | "wrapped"
  /** `[entry]` — the entries sit in the array directly. */
  | "flat";

export interface HookTemplate {
  /**
   * Path to the object holding the per-event arrays. `[]` means the settings
   * root, which is Factory: its docs describe a `hooks` wrapper and droid
   * rejects one.
   */
  readonly container: readonly string[];

  /**
   * The vendor's own event names, which are also the `--hook` argument. Taken
   * from the existing per-CLI constants rather than copied, so adding an event
   * stays a one-line change in one place.
   */
  readonly events: readonly string[];

  /**
   * Event to the key it is stored under, where those differ. Codex alone does:
   * it stores under `SessionStart` and invokes with `session_start`.
   */
  readonly keyMap?: Readonly<Record<string, string>>;

  /** Events the vendor treats as tool events, for the matcher and group rules. */
  readonly toolEvents?: readonly string[];

  /**
   * Group shape, which is not always uniform: Antigravity wraps its tool events
   * and writes the rest flat.
   */
  readonly group: { readonly tool: GroupShape; readonly other: GroupShape };

  /**
   * When a `matcher` key is written. Omitted entirely for most CLIs — and that
   * is load-bearing for goose, where a bare `"*"` is an invalid regex that
   * matches NOTHING, so writing one silently disables every hook.
   */
  readonly matcher?: { readonly on: "tool" | "all"; readonly value: string };

  /** The timeout field, in the vendor's own units and spelling. */
  readonly timeout?: { readonly key: string; readonly seconds: number };

  /**
   * Field names that carry the command. Copilot wants two — `bash` and
   * `powershell` — holding the same string.
   */
  readonly commandFields: readonly string[];

  /** A fixed `type` on each entry, where the vendor expects one. */
  readonly entryType?: string;

  /**
   * Whether to stamp `__failproofai_hook__`. Goose does not get one: failproofai
   * owns that whole plugin directory and goose parses the file, so our entries
   * are identified by the `--cli goose` substring instead.
   */
  readonly marker: boolean;

  /** Whether the command carries `--cli <id>`. Claude is the only one without. */
  readonly cliFlag: boolean;

  /** Keys set on the file when absent (Copilot and Cursor want `version: 1`). */
  readonly fileDefaults?: Readonly<Record<string, unknown>>;

  /** Keys removed from the file if present (Codex carries a legacy `version`). */
  readonly dropKeys?: readonly string[];
}

/**
 * Anything that could be EXECUTED rather than named.
 *
 * The test is deliberately about executability, not vocabulary. An earlier
 * version matched the word "failproofai" and rejected Antigravity's own
 * container key, which is literally `failproofai` — a legitimate key name that
 * happens to be our product. What actually distinguishes a command from a key
 * is structure: a command carries arguments (whitespace), or names a path (a
 * separator), or is a flag (a leading dash). Key and field names never do.
 */
const EXECUTABLE_SHAPED = /\s|[/\\]|^-/;

/**
 * Reject a template that tries to carry content rather than shape.
 *
 * It walks every string in the template and refuses anything that could be
 * executed — carrying arguments, naming a path, or reading as a flag. A key or
 * field name never does, so the rule separates the two cleanly and fails loud.
 */
export function validateTemplate(template: HookTemplate): string[] {
  const problems: string[] = [];
  const check = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (EXECUTABLE_SHAPED.test(value)) {
        problems.push(`${path}: "${value}" could be executed — a template describes shape, not content`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => check(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`);
    }
  };

  for (const [key, value] of Object.entries(template)) {
    // The event list and key map are vendor event names; they cannot contain a
    // command, and checking them would only invite a false positive on a vendor
    // that names an event with a dash.
    if (key === "events" || key === "keyMap" || key === "toolEvents") continue;
    check(value, key);
  }
  if (template.commandFields.length === 0) problems.push("commandFields: at least one is required");
  if (template.events.length === 0) problems.push("events: at least one is required");
  return problems;
}

const TOOL_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/**
 * The bundled templates — the floor every install writes from.
 *
 * Derived from what each writer actually produced, not transcribed from reading
 * them: `config-render.test.ts` asserts every one renders byte-for-byte to a
 * fixture captured off the previous implementation.
 */
export const HOOK_TEMPLATES: Readonly<Record<string, HookTemplate>> = {
  claude: {
    container: ["hooks"],
    events: CLAUDE_INSTALL_EVENT_TYPES,
    group: { tool: "wrapped", other: "wrapped" },
    timeout: { key: "timeout", seconds: 60 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    // No `--cli` flag: the handler defaults to claude when it is omitted, which
    // keeps hooks installed before multi-CLI support working.
    cliFlag: false,
  },

  codex: {
    container: ["hooks"],
    events: CODEX_HOOK_EVENT_TYPES,
    // Stores under PascalCase, invokes with snake_case. The only CLI where the
    // two differ, and the map already exists.
    keyMap: CODEX_EVENT_MAP,
    group: { tool: "wrapped", other: "wrapped" },
    timeout: { key: "timeout", seconds: 60 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    cliFlag: true,
    dropKeys: ["version"],
  },

  copilot: {
    container: ["hooks"],
    events: COPILOT_HOOK_EVENT_TYPES,
    group: { tool: "wrapped", other: "wrapped" },
    // Copilot counts in SECONDS but spells the field differently.
    timeout: { key: "timeoutSec", seconds: 60 },
    commandFields: ["bash", "powershell"],
    entryType: "command",
    marker: true,
    cliFlag: true,
    fileDefaults: { version: 1 },
  },

  cursor: {
    container: ["hooks"],
    events: CURSOR_HOOK_EVENT_TYPES,
    // Cursor's own flat form: no matcher wrapper at all.
    group: { tool: "flat", other: "flat" },
    timeout: { key: "timeout", seconds: 60 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    cliFlag: true,
    fileDefaults: { version: 1 },
  },

  factory: {
    // Event names at the TOP LEVEL: the published docs show a `hooks` wrapper
    // and droid rejects it outright.
    container: [],
    events: FACTORY_HOOK_EVENT_TYPES,
    toolEvents: TOOL_EVENTS,
    group: { tool: "wrapped", other: "wrapped" },
    matcher: { on: "tool", value: "*" },
    timeout: { key: "timeout", seconds: 30 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    cliFlag: true,
  },

  devin: {
    container: ["hooks"],
    events: DEVIN_HOOK_EVENT_TYPES,
    group: { tool: "wrapped", other: "wrapped" },
    timeout: { key: "timeout", seconds: 60 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    cliFlag: true,
  },

  antigravity: {
    // A NAMED hook: everything lives under our own key, beside anyone else's.
    container: ["failproofai"],
    events: ANTIGRAVITY_HOOK_EVENT_TYPES,
    toolEvents: TOOL_EVENTS,
    // The only mixed one: tool events wrap, the rest are flat.
    group: { tool: "wrapped", other: "flat" },
    matcher: { on: "tool", value: "*" },
    timeout: { key: "timeout", seconds: 30 },
    commandFields: ["command"],
    entryType: "command",
    marker: true,
    cliFlag: true,
  },

  goose: {
    container: ["hooks"],
    events: GOOSE_HOOK_EVENT_TYPES,
    group: { tool: "wrapped", other: "wrapped" },
    // NO matcher, and no timeout. A bare `"*"` is an invalid regex here that
    // matches nothing, so writing one would silently disable every hook.
    commandFields: ["command"],
    entryType: "command",
    // No marker: failproofai owns this whole plugin directory and goose parses
    // the file, so our entries are found by the `--cli goose` substring.
    marker: false,
    cliFlag: true,
  },
};
