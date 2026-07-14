/**
 * Per-CLI canonicalization of tool names and tool-input keys.
 *
 * Extracted from handler.ts so the audit replay engine and the live hook
 * handler share one implementation. Re-importing this module from
 * `src/audit/cli-adapters/*.ts` keeps the per-CLI maps in one place.
 */
import type { IntegrationType } from "./types";
import {
  CODEX_TOOL_MAP,
  COPILOT_TOOL_MAP,
  CURSOR_TOOL_MAP,
  OPENCODE_TOOL_MAP,
  OPENCODE_TOOL_INPUT_MAP,
  PI_TOOL_MAP,
  PI_TOOL_INPUT_MAP,
  HERMES_TOOL_MAP,
  HERMES_TOOL_INPUT_MAP,
  OPENCLAW_TOOL_MAP,
  OPENCLAW_TOOL_INPUT_MAP,
  FACTORY_TOOL_MAP,
  DEVIN_TOOL_MAP,
  ANTIGRAVITY_TOOL_MAP,
  ANTIGRAVITY_TOOL_INPUT_MAP,
  GOOSE_TOOL_MAP,
  GOOSE_TOOL_INPUT_MAP,
} from "./types";

/**
 * Canonicalize a per-CLI tool name to the Claude PascalCase form that builtin
 * policies match on (e.g. `Bash`, `Read`, `Write`, `Edit`). Unknown tool names
 * (MCP `mcp_*`, third-party extensions, Skills) pass through unchanged.
 */
export function canonicalizeToolName(
  raw: string | undefined,
  cli: IntegrationType,
): string | undefined {
  if (!raw) return raw;
  if (cli === "copilot") return COPILOT_TOOL_MAP[raw] ?? raw;
  if (cli === "cursor") return CURSOR_TOOL_MAP[raw] ?? raw;
  if (cli === "codex") return CODEX_TOOL_MAP[raw] ?? raw;
  if (cli === "opencode") return OPENCODE_TOOL_MAP[raw] ?? raw;
  if (cli === "pi") return PI_TOOL_MAP[raw] ?? raw;
  if (cli === "hermes") return HERMES_TOOL_MAP[raw] ?? raw;
  if (cli === "openclaw") return OPENCLAW_TOOL_MAP[raw] ?? raw;
  // Factory droid: Execute→Bash, Create→Write, FetchUrl→WebFetch, … (verified
  // live against droid v0.171.0). tool_input keys are already canonical.
  if (cli === "factory") return FACTORY_TOOL_MAP[raw] ?? raw;
  // Devin CLI: exec→Bash (verified live against devin v3000.1.27).
  // tool_input.command is already canonical.
  if (cli === "devin") return DEVIN_TOOL_MAP[raw] ?? raw;
  // Antigravity CLI: run_command→Bash (verified agy v1.1.2), view_file→Read, …
  // (best-effort). tool_input keys are PascalCase → ANTIGRAVITY_TOOL_INPUT_MAP.
  if (cli === "antigravity") return ANTIGRAVITY_TOOL_MAP[raw] ?? raw;
  // Goose: shell→Bash, write/edit/view→file ops, todo__todo_write→TodoWrite, …
  // (verified live against goose v1.43.0). Handles bare + `<ext>__<tool>` names.
  if (cli === "goose") return GOOSE_TOOL_MAP[raw] ?? raw;
  return raw;
}

/**
 * Canonicalize per-CLI tool-input keys to the snake_case shape that builtin
 * policies read (e.g. `file_path`, `old_string`). OpenCode delivers args as
 * camelCase; Pi delivers `path` for Read/Write/Edit. Idempotent — when already
 * canonical the loop is a no-op.
 */
export function canonicalizeToolInput(
  toolName: string | undefined,
  rawInput: unknown,
  cli: IntegrationType,
): unknown {
  // Arrays are objects too — pass them through verbatim instead of letting
  // Object.entries flatten them into a numeric-keyed plain object (which would
  // silently corrupt array-shaped tool inputs).
  if (!toolName || !rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return rawInput;
  }
  let perToolMap: Record<string, string> | undefined;
  if (cli === "opencode") perToolMap = OPENCODE_TOOL_INPUT_MAP[toolName];
  else if (cli === "pi") perToolMap = PI_TOOL_INPUT_MAP[toolName];
  // Hermes read_file/write_file/patch deliver the file path as `path`; map it to
  // `file_path` so path/content builtins fire (verified against a live state.db).
  else if (cli === "hermes") perToolMap = HERMES_TOOL_INPUT_MAP[toolName];
  // OpenClaw file tools (read/write/edit) deliver the path as `path`; exec
  // already delivers `command`. Map path → file_path so path builtins fire.
  else if (cli === "openclaw") perToolMap = OPENCLAW_TOOL_INPUT_MAP[toolName];
  // Antigravity's run_command args are PascalCase (`CommandLine`, `Cwd`); map
  // to `command`/`cwd` so Bash builtins fire (verified agy v1.1.2).
  else if (cli === "antigravity") perToolMap = ANTIGRAVITY_TOOL_INPUT_MAP[toolName];
  // Goose file tools (write/edit/view) deliver the path as `path`, read_image as
  // `source`; map to `file_path` so path builtins fire (verified goose v1.43.0).
  else if (cli === "goose") perToolMap = GOOSE_TOOL_INPUT_MAP[toolName];
  if (!perToolMap) return rawInput;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawInput as Record<string, unknown>)) {
    out[perToolMap[k] ?? k] = v;
  }
  return out;
}
