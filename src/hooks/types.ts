/**
 * Constants and interfaces for agent CLI hooks integrations (Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent, OpenCode, Pi, Gemini CLI, …).
 */

export const HOOK_SCOPES = ["user", "project", "local"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

export const INTEGRATION_TYPES = ["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"] as const;
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
  // Newly documented upstream (https://developers.openai.com/codex/hooks) —
  // snake_case forms of the documented SubagentStart / PreCompact / PostCompact /
  // SubagentStop events. Each has an exact 1:1 canonical HookEventType (already
  // present in HOOK_EVENT_TYPES), so their CODEX_EVENT_MAP entries below are
  // filled in directly. The map is an exhaustive `Record<CodexHookEventType,
  // HookEventType>`, so tsc guarantees every event here keeps a mapping — a
  // partial sync (event added, mapping missing) fails the build instead of
  // silently writing an `undefined` event key into users' .codex/hooks.json.
  "subagent_start",
  "pre_compact",
  "post_compact",
  "subagent_stop",
] as const;
export type CodexHookEventType = (typeof CODEX_HOOK_EVENT_TYPES)[number];

export const CODEX_EVENT_MAP: Record<CodexHookEventType, HookEventType> = {
  session_start: "SessionStart",
  pre_tool_use: "PreToolUse",
  permission_request: "PermissionRequest",
  post_tool_use: "PostToolUse",
  user_prompt_submit: "UserPromptSubmit",
  stop: "Stop",
  subagent_start: "SubagentStart",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  subagent_stop: "SubagentStop",
};

/**
 * Codex's per-tool canonicalization. Per
 * https://developers.openai.com/codex/hooks the hook payload reports
 * `tool_name: "Bash"` already PascalCase (passthrough) and `tool_name:
 * "apply_patch"` for file edits even when matchers say `Edit`/`Write`.
 * Local Codex sessions also expose `write_stdin` (sends input to a running
 * shell — same risk class as Bash). Map the two non-canonical names so
 * builtin policies fire; everything else (MCP `mcp__*`, future tools)
 * passes through.
 */
export const CODEX_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
  write_stdin: "Bash",
};

// ── GitHub Copilot CLI ─────────────────────────────────────────────────────
//
// Copilot CLI accepts two payload formats. We install with PascalCase event
// keys ("VS Code compatible" mode), which makes Copilot deliver PascalCase
// `hook_event_name` plus snake_case fields — same shape Claude already uses
// at the WRAPPER level (no event-name canonicalization needed).
//
// Empirically verified (Copilot CLI 1.0.41 against
// `~/.copilot/session-state/<id>/events.jsonl`): the user-scope PascalCase
// `Stop` entry IS dispatched on Copilot's native camelCase `agentStop` event
// — Copilot performs the alias mapping and case-fold internally so failproofai's
// `--hook Stop --cli copilot` invocation is what actually receives `agentStop`
// firings. Same alias rule applies to `SubagentStop` ↔ `subagentStop`.
//
// Tool names are a separate matter: Copilot's tool registry uses lowercase
// IDs (`bash`, `read`, `write`, `edit`, …) — confirmed by the session-log
// shape at `lib/copilot-sessions.ts:257` and the unit-test fixture at
// `__tests__/lib/copilot-sessions.test.ts:87`. Builtin policies match
// PascalCase (`Bash`, `Read`, …) via case-sensitive `Array.includes`, so
// without canonicalization every Bash/Read/Write/Edit builtin silently
// no-ops under Copilot. COPILOT_TOOL_MAP below is the source of truth.
//
// **Stop block semantics** (verified against Copilot CLI 1.0.41 + docs at
// https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference):
// `agentStop` accepts `{decision: "block", reason}` JSON on stdout — the reason
// becomes the next-turn prompt and the agent retries. **Exit-2 + stderr is NOT
// honored** — the session log shows it surfaced as `[WARNING] Hook warning: ...`
// to the user but the agent stops cleanly without retrying. policy-evaluator.ts
// has a `cli === "copilot"` Stop branch that emits the JSON-block shape so the
// 5 require-*-before-stop builtins actually enforce on Copilot sessions.
//
// Settings paths:
//   user    → ~/.copilot/hooks/failproofai.json
//   project → <cwd>/.github/hooks/failproofai.json   (also where the cloud agent reads)
// Settings file carries `version: 1`.

export const COPILOT_HOOK_SCOPES = ["user", "project"] as const;
export type CopilotHookScope = (typeof COPILOT_HOOK_SCOPES)[number];

export const COPILOT_HOOK_EVENT_TYPES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  // Newly documented upstream (cli-hooks-reference), each with an explicit
  // PascalCase "VS Code compatible" variant shown in the docs. No COPILOT_EVENT_MAP
  // exists (Copilot names are already Pascal), so appending keeps the build green.
  // NOTE: `subagentStart` is also newly documented but appears camelCase-ONLY (no
  // PascalCase variant listed), so it is deferred to the reviewer checklist rather
  // than guessing a casing. `notification`, by contrast, DOES have a documented
  // `Notification` PascalCase variant, so it is appended below.
  "PostToolUseFailure",
  "ErrorOccurred",
  "PreCompact",
  "PermissionRequest",
  "Notification",
] as const;
export type CopilotHookEventType = (typeof COPILOT_HOOK_EVENT_TYPES)[number];

/**
 * Copilot's lowercase tool IDs → Claude PascalCase canonical names so existing
 * builtin policies (which match `toolName === "Bash"`, etc.) fire unchanged on
 * Copilot sessions. Unknown tools (MCP `mcp_*`, extensions) pass through
 * unchanged via the `?? raw` fallback in handler.ts:canonicalizeToolName.
 *
 * Keys derived from in-repo evidence (lib/copilot-sessions.ts and the Copilot
 * CLI's published tool set). If a future Copilot release ships new tool IDs
 * we don't recognize, they pass through and any non-builtin custom policy
 * matching by raw name still works.
 */
export const COPILOT_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  // Windows shell + the *_bash / *_powershell session-management tools all
  // execute or interact with shell commands, so they map to the same risk
  // class as bash. Without this `block-sudo`, `block-rm-rf`,
  // `block-read-outside-cwd` (Bash branch), etc. silently no-op for any
  // command Copilot routes through powershell or a long-lived shell session.
  powershell: "Bash",
  list_bash: "Bash",
  read_bash: "Bash",
  stop_bash: "Bash",
  write_bash: "Bash",
  list_powershell: "Bash",
  read_powershell: "Bash",
  stop_powershell: "Bash",
  write_powershell: "Bash",
  read: "Read",
  // `view` reads files OR lists directories
  // (`{"toolName":"view","arguments":{"path":"/some/dir"}}` — verified
  // empirically against Copilot CLI 1.0.39). Mapping to Read makes
  // block-read-outside-cwd fire on `view` calls; the policy reads
  // toolInput.path as a fallback to file_path so directory listings get
  // covered by the same path check.
  view: "Read",
  show_file: "Read",
  write: "Write",
  create: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  str_replace_editor: "Edit",
  glob: "Glob",
  grep: "Grep",
  rg: "Grep",
  ls: "LS",
  web_fetch: "WebFetch",
};

// ── Cursor Agent CLI ───────────────────────────────────────────────────────
//
// Cursor delivers events under camelCase keys (`preToolUse`, `postToolUse`,
// `beforeSubmitPrompt`, …) per https://cursor.com/docs/hooks. The handler
// maps each one to the PascalCase canonical form via CURSOR_EVENT_MAP before
// looking up policies. We subscribe to the 7-event parity set: 6 events that
// align with Claude's canonical types plus `subagentStop` (sibling of `stop`,
// same payload shape and `{followup_message}` response contract) so custom
// policies subscribing to SubagentStop are reachable on Cursor subagent
// boundaries — matches the Copilot SubagentStop widening from #299.
// Cursor-specific events (`beforeShellExecution`, `afterFileEdit`,
// `subagentStart`, …) can be added later without touching the handler.
//
// Settings paths:
//   user    → ~/.cursor/hooks.json
//   project → <cwd>/.cursor/hooks.json
// Settings file carries `version: 1` like Copilot.

export const CURSOR_HOOK_SCOPES = ["user", "project"] as const;
export type CursorHookScope = (typeof CURSOR_HOOK_SCOPES)[number];

export const CURSOR_HOOK_EVENT_TYPES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "stop",
  "subagentStop",
] as const;
export type CursorHookEventType = (typeof CURSOR_HOOK_EVENT_TYPES)[number];

export const CURSOR_EVENT_MAP: Record<CursorHookEventType, HookEventType> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  stop: "Stop",
  subagentStop: "SubagentStop",
};

/**
 * Cursor delivers PascalCase tool names per https://cursor.com/docs/hooks
 * (`Shell | Read | Write | Grep | Delete | Task | MCP:*`). All but `Shell`
 * are already canonical (`Read`, `Write`, `Grep` match Claude verbatim) or
 * have no Claude equivalent (`Delete`, `Task`, `MCP:*`) so passthrough is
 * fine. `Shell` is Cursor's name for what Claude calls `Bash`; without this
 * map every Bash builtin (`block-sudo`, `block-rm-rf`,
 * `block-read-outside-cwd`, …) silently no-ops on Cursor sessions.
 */
export const CURSOR_TOOL_MAP: Record<string, string> = {
  Shell: "Bash",
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

/**
 * OpenCode's lowercase tool IDs → Claude PascalCase canonical names. OpenCode's
 * plugin SDK exposes `input.tool` as the raw tool ID (lowercase, snake_case
 * for multi-word — see opencode v1.14.33 tool registry). The shim template at
 * src/hooks/integrations.ts:writeFile re-implements an identical map inline
 * (the shim must be self-contained — opencode loads it as a JS module), so any
 * change here MUST be mirrored in the shim template.
 */
export const OPENCODE_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
};

/**
 * Per-tool input-key translation: OpenCode camelCase → Claude snake_case,
 * keyed by canonical (PascalCase) tool name so it pairs naturally with the
 * output of OPENCODE_TOOL_MAP. Without this, builtin policies that read
 * `ctx.toolInput.file_path` (`block-read-outside-cwd`, `block-env-files`,
 * `block-secrets-write`) silently no-op on every OpenCode Read/Write/Edit
 * call because OpenCode's native tools deliver args as `filePath` / `oldString`
 * / `newString` / `replaceAll`.
 *
 * Tools outside this set (MCP `mcp_*`, third-party plugins) pass through
 * unchanged so their schemas aren't corrupted. Mirrored inline in the shim
 * template at src/hooks/integrations.ts:buildOpenCodePluginShim — the shim
 * must be self-contained because opencode loads it as a JS module — so any
 * change here MUST be mirrored there.
 */
export const OPENCODE_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { filePath: "file_path" },
  Write: { filePath: "file_path" },
  Edit: {
    filePath: "file_path",
    oldString: "old_string",
    newString: "new_string",
    replaceAll: "replace_all",
  },
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

/**
 * Pi's lowercase tool IDs → Claude PascalCase canonical names. Pi exposes its
 * tool registry through `event.toolName` on `tool_call` / `tool_result` (see
 * pi-extension/index.ts). Confirmed lowercase by the docstring there at
 * line 105 ("Pi emits tool names in lowercase (`bash`, `read`, `edit`, `write`)")
 * and verified empirically against pi-coding-agent v0.72.1.
 *
 * The pi-extension shim re-implements an identical map inline (the shim must
 * be self-contained — Pi loads it as an in-process JS module), so any change
 * here MUST be mirrored in pi-extension/index.ts:canonicalizeToolName.
 */
export const PI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
};

/**
 * Per-tool input-key translation: Pi's tool args use `path` for Read / Write /
 * Edit (see https://github.com/earendil-works/pi packages/coding-agent/src/core/tools)
 * but failproofai builtins read `ctx.toolInput.file_path`. `block-read-outside-cwd`
 * already has a `ctx.toolInput.path` fallback (`src/hooks/builtin-policies.ts:796`)
 * so it works on Pi via that path; without this map, however,
 * `block-env-files` and `block-secrets-write` — which only check
 * `ctx.toolInput.file_path` via `getFilePath()` — silently no-op on Pi.
 *
 * Pi's Edit tool delivers a nested `edits: [{oldText, newText}, …]` array
 * shape that doesn't translate flatly to Claude's `{old_string, new_string,
 * replace_all}`, so only the top-level `path` is mapped. Edit-content
 * checks (sanitize-* on the edit body) remain Pi-shape — none of today's
 * builtins look at the edit body. Tools outside this set pass through
 * unchanged.
 *
 * Mirrored inline in pi-extension/index.ts (the extension must be self-
 * contained — Pi loads it as an in-process JS module), so any change here
 * MUST be mirrored there.
 */
export const PI_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
};

// ── Gemini CLI ─────────────────────────────────────────────────────────────
//
// Gemini CLI's hook contract is the closest thing to a Claude Code clone we've
// seen: same `{matcher, hooks: [{type, command, timeout}]}` settings shape,
// PascalCase event names, snake_case stdin payload field names (session_id,
// tool_name, tool_input, hook_event_name, cwd, transcript_path), subprocess
// execution model, and a `$CLAUDE_PROJECT_DIR` env-var alias on top of its own
// `$GEMINI_PROJECT_DIR` for back-compat. The integration is modeled on
// claudeCode in integrations.ts; only three translation layers differ:
//
//   1. Event names — Gemini uses BeforeTool/AfterTool/BeforeAgent/AfterAgent/
//      PreCompress/Notification/SessionStart/SessionEnd/BeforeModel/AfterModel/
//      BeforeToolSelection. We install all 11 events but only 8 have a Claude
//      canonical equivalent; the other 3 (BeforeModel/AfterModel/
//      BeforeToolSelection) pass through unchanged (no policy matches today,
//      but the binary still records activity).
//
//   2. Tool names — Gemini's tools are snake_case (run_shell_command, read_file,
//      write_file, replace, glob, grep_search, list_directory, web_fetch,
//      google_web_search, write_todos, save_memory, read_many_files, ask_user).
//      The handler canonicalizes via GEMINI_TOOL_MAP (run_shell_command → Bash,
//      read_file → Read, etc.) so existing builtin policies fire unchanged.
//      Unknown tools (extensions, MCP `mcp_*` names) pass through.
//
//   3. Response shape — Gemini emits flat `{decision: "deny", reason}` for
//      blocks (NOT Claude's `{hookSpecificOutput: {permissionDecision: "deny",
//      permissionDecisionReason}}`), and `{hookSpecificOutput: {hookEventName,
//      additionalContext}}` for context injection on BeforeAgent / AfterTool /
//      SessionStart only. policy-evaluator.ts handles this via a `cli ===
//      "gemini"` branch.
//
// Settings paths:
//   user    → ~/.gemini/settings.json
//   project → <cwd>/.gemini/settings.json
// Gemini also documents a system scope (/etc/gemini-cli/settings.json) but we
// don't expose it (matches Codex/Copilot/Cursor/OpenCode/Pi: user|project only).
//
// **Per-event capability** (from Gemini docs as of 2026-04-13):
//   • BeforeTool          → PreToolUse        · CAN block via `{decision: "deny"}`
//                                              · CAN rewrite via `hookSpecificOutput.tool_input`
//   • AfterTool           → PostToolUse       · CAN observe; `additionalContext` injection
//   • BeforeAgent         → UserPromptSubmit  · CAN block; `additionalContext` injection
//   • AfterAgent          → Stop              · CAN force-retry via `{decision: "block"}`
//                                                (closest to Claude's exit-2-from-Stop)
//   • SessionStart        → SessionStart      · `additionalContext` injection
//   • SessionEnd          → SessionEnd        · observation only
//   • PreCompress         → PreCompact        · observation only
//   • Notification        → Notification      · observation only
//   • BeforeModel         → BeforeModel       · Gemini-only; no canonical, observation
//   • AfterModel          → AfterModel        · Gemini-only; no canonical, observation
//   • BeforeToolSelection → BeforeToolSelection · Gemini-only; no canonical, observation
//
// Ref: https://geminicli.com/docs/hooks/

export const GEMINI_HOOK_SCOPES = ["user", "project"] as const;
export type GeminiHookScope = (typeof GEMINI_HOOK_SCOPES)[number];

export const GEMINI_HOOK_EVENT_TYPES = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeModel",
  "AfterModel",
  "BeforeToolSelection",
  "BeforeTool",
  "AfterTool",
  "PreCompress",
  "Notification",
] as const;
export type GeminiHookEventType = (typeof GEMINI_HOOK_EVENT_TYPES)[number];

/** Gemini event → canonical PascalCase HookEventType. Three Gemini-only events
 *  (BeforeModel, AfterModel, BeforeToolSelection) have no Claude equivalent and
 *  pass through unchanged. */
export const GEMINI_EVENT_MAP: Record<GeminiHookEventType, HookEventType> = {
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  BeforeAgent: "UserPromptSubmit",
  AfterAgent: "Stop",
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  PreCompress: "PreCompact",
  Notification: "Notification",
  // No canonical Claude equivalent — passthrough so the binary still records
  // activity but `getPoliciesForEvent` returns [] (no-op fast path).
  BeforeModel: "BeforeModel" as HookEventType,
  AfterModel: "AfterModel" as HookEventType,
  BeforeToolSelection: "BeforeToolSelection" as HookEventType,
};

/** Gemini's snake_case tool names → Claude PascalCase canonical names so existing
 *  builtin policies (which match `toolName === "Bash"`, etc.) fire unchanged on
 *  Gemini sessions. Unknown tools (MCP `mcp_*`, extensions, Skills) pass through
 *  unchanged. Per https://geminicli.com/docs/reference/tools/ as of 2026-04-13. */
export const GEMINI_TOOL_MAP: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  glob: "Glob",
  grep_search: "Grep",
  list_directory: "LS",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
  write_todos: "TodoWrite",
  save_memory: "Memory",
  ask_user: "AskUser",
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
  // Newly documented upstream (https://code.claude.com/docs/en/hooks lifecycle
  // table). `Setup` fires only on `--init`/`--maintenance` (low-frequency), so it
  // is appended and installed like any other event.
  //
  // `MessageDisplay` is intentionally NOT appended. The docs mark it observe-only
  // (it cannot block or modify anything) and note it fires on *every* assistant
  // message display with no matcher support. Since `writeHookEntries` installs a
  // hook for every entry in this array, appending it would spawn a failproofai
  // subprocess on every message render for zero enforcement value. Deferred to the
  // PR reviewer checklist; add it here only if a future observe-only use case
  // (e.g. redaction/telemetry) justifies the per-message cost.
  "Setup",
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
  /** Read from the stdin payload's `hook_event_name` field. Carries the raw
   *  agent-emitted event name (e.g. Gemini's `BeforeTool`, Cursor's
   *  `preToolUse`, Pi's `tool_call`). May be undefined when stdin omits it. */
  hookEventName?: string;
  /** The raw event name passed on the CLI's `--hook` flag, BEFORE any
   *  per-CLI canonicalization to PascalCase (e.g. `BeforeTool` for Gemini,
   *  `preToolUse` for Cursor). Use this for round-tripping the agent-side
   *  event name in response shapes when stdin doesn't include `hook_event_name`. */
  rawHookEventName?: string;
  /** Which agent CLI fired this hook (claude | codex | copilot | cursor | opencode | pi | gemini). Set by handler.ts from --cli. */
  cli?: IntegrationType;
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}
