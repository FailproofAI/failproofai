/**
 * Per-CLI payload field normalization, applied in place BEFORE any
 * canonicalization or session-metadata resolution runs.
 *
 * Extracted out of handler.ts so the fail-closed evaluator (fail-closed.ts)
 * can produce a correctly-shaped decision without duplicating a second copy
 * of these CLI-specific field mappings — the exact quirks below took real
 * verification effort against each CLI's live payload shape (see CLAUDE.md),
 * so they must stay described in exactly one place.
 */
import type { IntegrationType } from "./types";

export function normalizeCliPayload(cli: IntegrationType, parsed: Record<string, unknown>): void {
  // Antigravity (agy) pipes a camelCase protojson payload; normalize the fields
  // the handler downstream reads to canonical snake_case BEFORE any
  // canonicalization runs. `toolCall.{name,args}` → `tool_name`/`tool_input`,
  // `conversationId` → `session_id`, `workspacePaths[0]` → `cwd`,
  // `transcriptPath` → `transcript_path`. Verified against agy v1.1.2.
  if (cli === "antigravity") {
    const tc = parsed.toolCall as { name?: string; args?: unknown } | undefined;
    if (tc && typeof tc === "object") {
      if (tc.name !== undefined) parsed.tool_name = tc.name;
      if (tc.args !== undefined) parsed.tool_input = tc.args;
    }
    if (typeof parsed.conversationId === "string") parsed.session_id = parsed.conversationId;
    if (Array.isArray(parsed.workspacePaths) && typeof parsed.workspacePaths[0] === "string") {
      parsed.cwd = parsed.workspacePaths[0];
    }
    if (typeof parsed.transcriptPath === "string") parsed.transcript_path = parsed.transcriptPath;
  }

  // Copilot's snake_case events (PreToolUse/PostToolUse/Stop/…) are already
  // Claude-shaped, but `permissionRequest` alone pipes a camelCase payload
  // (`hookName`, `sessionId`, `toolName` in lowercase, `toolInput`) — verified
  // live against Copilot CLI 1.0.71. Normalize the fields the handler reads so
  // PermissionRequest-matched policies (e.g. block-sudo's Codex-escalation
  // guard) fire instead of seeing a null tool name.
  if (cli === "copilot") {
    if (typeof parsed.toolName === "string" && parsed.tool_name === undefined) {
      parsed.tool_name = parsed.toolName;
    }
    if (parsed.toolInput !== undefined && parsed.tool_input === undefined) {
      parsed.tool_input = parsed.toolInput;
    }
    if (typeof parsed.sessionId === "string" && parsed.session_id === undefined) {
      parsed.session_id = parsed.sessionId;
    }
  }

  // Goose pipes `event` / `working_dir` instead of Claude's `hook_event_name` /
  // `cwd` (its `tool_name` / `tool_input` are already canonical field names).
  // Normalize both so resolveCwd keeps its cwd (block-read-outside-cwd) and the
  // round-tripped event name is available. The --hook arg is already PascalCase,
  // so canonicalizeEventType needs no goose branch. Verified goose v1.43.0.
  if (cli === "goose") {
    if (typeof parsed.working_dir === "string") parsed.cwd = parsed.working_dir;
    if (typeof parsed.event === "string" && parsed.hook_event_name === undefined) {
      parsed.hook_event_name = parsed.event;
    }
  }
}
