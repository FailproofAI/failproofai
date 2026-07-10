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
  GEMINI_TOOL_MAP,
  HERMES_TOOL_MAP,
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
  if (cli === "gemini") return GEMINI_TOOL_MAP[raw] ?? raw;
  if (cli === "opencode") return OPENCODE_TOOL_MAP[raw] ?? raw;
  if (cli === "pi") return PI_TOOL_MAP[raw] ?? raw;
  if (cli === "hermes") return HERMES_TOOL_MAP[raw] ?? raw;
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
  // NOTE (Hermes): tool NAMES are canonicalized (HERMES_TOOL_MAP) and
  // `terminal`'s `command` arg is already canonical (live-verified — sudo/rm -rf
  // block), but there is no HERMES_TOOL_INPUT_MAP yet. So read_file/write_file/
  // patch/search_files arg keys pass through unmapped: file-path/content builtins
  // (block-env-files, block-secrets-write, block-read-outside-cwd) fire on Hermes
  // only if those keys already match canonical (`file_path`/`content`/`path`).
  // Add a Hermes branch here once the real arg shapes are verified against a live
  // ~/.hermes/state.db — do NOT guess the keys (a wrong map silently mis-maps).
  if (!perToolMap) return rawInput;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawInput as Record<string, unknown>)) {
    out[perToolMap[k] ?? k] = v;
  }
  return out;
}
