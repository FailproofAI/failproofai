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
  COPILOT_TOOL_INPUT_MAP,
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
  GROK_TOOL_MAP,
  GROK_TOOL_INPUT_MAP,
  QWEN_TOOL_MAP,
  ORI_TOOL_MAP,
  ORI_TOOL_INPUT_MAP,
  CLINE_TOOL_MAP,
} from "./types";
import { canonicalizeClineToolInput, applyPatchFilePaths } from "./batch-expand";

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
  // grok: run_terminal_command→Bash, write/read_file/search_replace→file ops, …
  // (every entry observed on the wire against grok 1.0.3).
  if (cli === "grok") return GROK_TOOL_MAP[raw] ?? raw;
  // qwen: run_shell_command→Bash, write_file/read_file/edit→file ops, …
  // (verified live against qwen-code 0.21.12).
  if (cli === "qwen") return QWEN_TOOL_MAP[raw] ?? raw;
  // Ori: tool ids arrive lowercase (bash/read/write/edit/glob/grep) — all six
  // captured at the live approval gate on ori 0.12.0+68f9a36.
  if (cli === "ori") return ORI_TOOL_MAP[raw] ?? raw;
  // Cline: run_commands/read_files/search_codebase/apply_patch — all four
  // observed live on cline v3.0.60's PreToolUse payload.
  if (cli === "cline") return CLINE_TOOL_MAP[raw] ?? raw;
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
  // Copilot file tools deliver `path` (+ Write's `file_text`, Edit's
  // `old_str`/`new_str`); map to canonical keys so path/content builtins fire
  // (verified live against Copilot CLI 1.0.71).
  if (cli === "copilot") perToolMap = COPILOT_TOOL_INPUT_MAP[toolName];
  else if (cli === "opencode") perToolMap = OPENCODE_TOOL_INPUT_MAP[toolName];
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
  // grok's read_file delivers `target_file` and list_dir `target_directory`;
  // every other grok tool is already canonical. Without the Read entry a live
  // `.env` read walks past block-env-files (verified grok 1.0.3). qwen needs no
  // entry at all — all six of its tools deliver canonical keys.
  else if (cli === "grok") perToolMap = GROK_TOOL_INPUT_MAP[toolName];
  // Ori: read/write deliver the path as `path`; bash/glob/grep are already
  // canonical. `edit` is special — its path lives INSIDE the patch blob and is
  // derived below rather than renamed, because there is no key to rename.
  else if (cli === "ori") {
    if (toolName === "Edit") return canonicalizeOriEditInput(rawInput as Record<string, unknown>);
    perToolMap = ORI_TOOL_INPUT_MAP[toolName];
  }
  // Cline has NO key-rename map: every tool is batch- or blob-shaped, so this
  // is a value-SHAPE transform. It is the SAFETY NET for the paths that do not
  // fan out (PostToolUse, audit replay, fail-closed shaping); PreToolUse
  // enforces through expandBatchToolInput instead, because a collapse cannot
  // make an anchored regex match every element.
  else if (cli === "cline") {
    return canonicalizeClineToolInput(toolName, rawInput as Record<string, unknown>);
  }
  if (!perToolMap) return rawInput;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawInput as Record<string, unknown>)) {
    out[perToolMap[k] ?? k] = v;
  }
  return out;
}

/**
 * Recover the file path(s) from an OpenAI apply_patch blob.
 *
 * Kept as the ori-facing NAME so existing callers and
 * __tests__/hooks/ori-canonicalize.test.ts keep working, but the implementation
 * now lives in batch-expand.ts and is shared: ori's `edit` and cline's
 * `apply_patch` carry byte-identical blobs, and one implementation is what
 * stops a third CLI adding a third regex.
 *
 * NOTE for a follow-up: `splitApplyPatch` (same module) now returns per-file
 * old/new text as well, which closes ori's documented multi-file KNOWN GAP —
 * and a worse one the gap comment understates, that ori's Edit sets NO
 * old_string/new_string at all, so block-secrets-write can never fire on it.
 * Deliberately NOT changed here: ori's behaviour stays as shipped in this PR.
 */
export const oriPatchFilePaths = applyPatchFilePaths;

function canonicalizeOriEditInput(input: Record<string, unknown>): Record<string, unknown> {
  const patch = input.patch;
  if (typeof patch !== "string") return input;
  const paths = oriPatchFilePaths(patch);
  if (paths.length === 0) return input;
  return { ...input, file_path: paths[0], ori_patch_files: paths };
}
