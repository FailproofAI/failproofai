/**
 * Constants and interfaces for agent CLI hooks integrations (Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent, OpenCode, Pi, …).
 */

export const HOOK_SCOPES = ["user", "project", "local"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

export const INTEGRATION_TYPES = ["claude", "codex", "copilot", "cursor", "opencode", "pi"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const CODEX_HOOK_SCOPES = ["user", "project"] as const;
export type CodexHookScope = (typeof CODEX_HOOK_SCOPES)[number];

export const CODEX_HOOK_EVENT_TYPES = [
  "session_start",
  "pre_tool_use",
  "permission_request",
  "post_tool_use",
  "user_prompt_submit",
  "stop",
] as const;
export type CodexHookEventType = (typeof CODEX_HOOK_EVENT_TYPES)[number];

export const CODEX_EVENT_MAP: Record<CodexHookEventType, HookEventType> = {
  session_start: "SessionStart",
  pre_tool_use: "PreToolUse",
  permission_request: "PermissionRequest",
  post_tool_use: "PostToolUse",
  user_prompt_submit: "UserPromptSubmit",
  stop: "Stop",
};

// ── GitHub Copilot CLI ─────────────────────────────────────────────────────
//
// Copilot CLI accepts two payload formats. We install with PascalCase event
// keys ("VS Code compatible" mode), which makes Copilot deliver PascalCase
// `hook_event_name` plus snake_case fields — same shape Claude already uses.
// As a result no Codex-style canonicalization map is required.
//
// Settings paths:
//   user    → ~/.copilot/hooks/failproofai.json
//   project → <cwd>/.github/hooks/failproofai.json   (also where the cloud agent reads)
// Settings file carries `version: 1` like Codex's hooks.json.

export const COPILOT_HOOK_SCOPES = ["user", "project"] as const;
export type CopilotHookScope = (typeof COPILOT_HOOK_SCOPES)[number];

export const COPILOT_HOOK_EVENT_TYPES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;
export type CopilotHookEventType = (typeof COPILOT_HOOK_EVENT_TYPES)[number];

// ── Cursor Agent CLI ───────────────────────────────────────────────────────
//
// Cursor delivers events under camelCase keys (`preToolUse`, `postToolUse`,
// `beforeSubmitPrompt`, …) per https://cursor.com/docs/hooks. The handler
// maps each one to the PascalCase canonical form via CURSOR_EVENT_MAP before
// looking up policies. We install the same 6-event parity set as Copilot so
// every existing builtin policy fires; Cursor-specific events
// (`beforeShellExecution`, `afterFileEdit`, `subagentStart`, …) can be added
// later without touching the handler.
//
// Settings paths:
//   user    → ~/.cursor/hooks.json
//   project → <cwd>/.cursor/hooks.json
// Settings file carries `version: 1` like Codex/Copilot.

export const CURSOR_HOOK_SCOPES = ["user", "project"] as const;
export type CursorHookScope = (typeof CURSOR_HOOK_SCOPES)[number];

export const CURSOR_HOOK_EVENT_TYPES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "stop",
] as const;
export type CursorHookEventType = (typeof CURSOR_HOOK_EVENT_TYPES)[number];

export const CURSOR_EVENT_MAP: Record<CursorHookEventType, HookEventType> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  stop: "Stop",
};

// ── OpenCode (sst/opencode) ─────────────────────────────────────────────────
//
// OpenCode's plugin model is fundamentally different from the other four CLIs:
// there is NO external-command hook. Plugins are in-process JS/TS modules
// loaded from the `plugin: []` array in `opencode.json` (auto-discovery from
// `.opencode/plugins/` does NOT work — verified live on opencode v1.14.33).
// Plugins block tool calls by throwing an Error from `tool.execute.before`
// or by mutating `output.status = "deny"` from `permission.ask`.
//
// The failproofai integration ships a small generated plugin shim that
// spawns the failproofai binary as a subprocess and translates the binary's
// existing Claude-shape JSON response back into plugin semantics. As a
// result the binary itself sees Claude-shape PascalCase events — no
// canonicalization branch is needed in handler.ts. The OPENCODE_EVENT_MAP
// below documents the shim's plugin-side → binary-side translation; it is
// re-implemented inline in the shim template (so the shim file stays
// self-contained), but is exported here as the single source of truth and
// for tests.
//
// The integration uses six events for parity with Cursor / Copilot:
//   • tool.execute.before (first-class hook) → PreToolUse
//   • tool.execute.after  (first-class hook) → PostToolUse
//   • session.created     (bus event)        → SessionStart
//   • session.deleted     (bus event)        → SessionEnd
//   • session.idle        (bus event)        → Stop
//   • message.updated     (bus event, role:user-only) → UserPromptSubmit
// Plus optional `permission.ask` (first-class hook) → PermissionRequest for
// a cleaner deny UX when permission prompts trigger.
//
// Settings paths:
//   user    → ~/.config/opencode/opencode.json (plus plugins/failproofai.mjs)
//   project → <cwd>/.opencode/opencode.json     (plus plugins/failproofai.mjs)
// OpenCode has no `local` scope.

export const OPENCODE_HOOK_SCOPES = ["user", "project"] as const;
export type OpenCodeHookScope = (typeof OPENCODE_HOOK_SCOPES)[number];

export const OPENCODE_HOOK_EVENT_TYPES = [
  "tool.execute.before",
  "tool.execute.after",
  "session.created",
  "session.deleted",
  "session.idle",
  "message.updated",
  "permission.ask",
] as const;
export type OpenCodeHookEventType = (typeof OPENCODE_HOOK_EVENT_TYPES)[number];

export const OPENCODE_EVENT_MAP: Record<OpenCodeHookEventType, HookEventType> = {
  "tool.execute.before": "PreToolUse",
  "tool.execute.after": "PostToolUse",
  "session.created": "SessionStart",
  "session.deleted": "SessionEnd",
  "session.idle": "Stop",
  "message.updated": "UserPromptSubmit",
  "permission.ask": "PermissionRequest",
};

// ── Pi (pi-coding-agent) ───────────────────────────────────────────────────
//
// Pi loads TypeScript extensions from packages registered in `.pi/settings.json`
// (project, `<cwd>/.pi/settings.json`) or `~/.pi/agent/settings.json` (user-
// scope — confirmed empirically; the bare `~/.pi/settings.json` does NOT
// exist on a fresh install). Extensions are default-exported functions that
// receive an ExtensionAPI and call `pi.on("<event>", handler)`. A handler can
// `return { block: true, reason }` from `tool_call` / `user_bash` to veto the
// tool call.
//
// Settings file schema is a FLAT string array — `{"packages": ["..."]}` —
// where each entry is a path resolved relative to `.pi/` (so `../pi-extension`
// for `<cwd>/pi-extension`). NOT an array of objects, so the
// FAILPROOFAI_HOOK_MARKER convention used by Claude/Codex/Copilot/Cursor is
// not applicable; failproofai's entry is identified by a path-substring match
// (`source.includes("pi-extension") && source.includes("failproofai")`).
//
// Pi events arrive in camelCase (like Cursor): `event.toolName`,
// `event.toolCallId`, `event.input`, `event.text`, `event.cwd`. The handler
// canonicalizes Pi's underscore_lower_snake_case event names to PascalCase
// via PI_EVENT_MAP before policy lookup.
//
// **Veto capability per event** (verified against pi-coding-agent v0.72.1
// d.ts; relevant ResultEvent shape in parens):
//   • `tool_call`        → PreToolUse  · CAN veto via {block, reason}
//                          (ToolCallEventResult)
//   • `user_bash`        → PreToolUse  · CAN veto (UserBashEventResult)
//   • `input`            → UserPromptSubmit · CAN veto (InputEventResult)
//   • `session_start`    → SessionStart · observation only
//   • `tool_result`      → PostToolUse · OBSERVATION only — Pi's
//                          ToolResultEventResult exposes {content, details,
//                          isError} for mutation but not block. PostToolUse
//                          policies are observation/sanitize anyway, so this
//                          matches Claude semantics.
//   • `agent_end`        → Stop · OBSERVATION only — Pi's agent loop has
//                          already exited by the time this fires; we cannot
//                          keep Pi running the way Claude's exit-2-from-Stop
//                          can. Stop-policy violations land in the activity
//                          log + stderr but do not veto the stop.
//   • `session_shutdown` → SessionEnd · observation only.

export const PI_HOOK_SCOPES = ["user", "project"] as const;
export type PiHookScope = (typeof PI_HOOK_SCOPES)[number];

export const PI_HOOK_EVENT_TYPES = [
  "session_start",
  "session_shutdown",
  "input",
  "tool_call",
  "user_bash",
  "tool_result",
  "agent_end",
] as const;
export type PiHookEventType = (typeof PI_HOOK_EVENT_TYPES)[number];

export const PI_EVENT_MAP: Record<PiHookEventType, HookEventType> = {
  session_start: "SessionStart",
  session_shutdown: "SessionEnd",
  input: "UserPromptSubmit",
  tool_call: "PreToolUse",
  user_bash: "PreToolUse",
  tool_result: "PostToolUse",
  agent_end: "Stop",
};

export const HOOK_EVENT_TYPES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
  "UserPromptExpansion",
  "PostToolBatch",
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export const FAILPROOFAI_HOOK_MARKER = "__failproofai_hook__" as const;

export interface ClaudeHookEntry {
  type: "command";
  command: string;
  timeout: number;
  [FAILPROOFAI_HOOK_MARKER]: true;
}

export interface ClaudeHookMatcher {
  hooks: Array<ClaudeHookEntry | Record<string, unknown>>;
}

export interface SessionMetadata {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
  hookEventName?: string;
  /** Which agent CLI fired this hook (claude | codex | copilot | cursor | opencode | pi). Set by handler.ts from --cli. */
  cli?: IntegrationType;
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}
