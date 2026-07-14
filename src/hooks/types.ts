/**
 * Constants and interfaces for agent CLI hooks integrations (Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent, OpenCode, Pi, …).
 */

export const HOOK_SCOPES = ["user", "project", "local"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

export const INTEGRATION_TYPES = ["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"] as const;
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

// ── Hermes (hermes-agent) ───────────────────────────────────────────────────
//
// Hermes supports BOTH audit (Pillar 2) and live hooks (Pillar 1). This tool
// map is consumed by the audit adapter (via `logEntriesToEvents`) AND the
// live-hook handler, both through `canonicalizeToolName`. Tool names are the
// granular toolset tools verified
// against a live ~/.hermes/state.db (frequency in a real gateway session:
// terminal 574, read_file 124, patch 94, write_file 54, web_search 42, …).
// Names with a Claude canonical are mapped so builtin policies fire; Hermes-
// specific tools (skill_view, cronjob, browser_*, memory, session_search,
// clarify, process) pass through unchanged so they still appear in the audit,
// just unmatched by builtin policies.
export const HERMES_TOOL_MAP: Record<string, string> = {
  terminal: "Bash",
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  patch: "Edit",
  web_search: "WebSearch",
  web_extract: "WebFetch",
  search_files: "Grep",
  todo: "TodoWrite",
};

// Hermes tool-INPUT key canonicalization, keyed by the *canonical* tool name
// (the handler canonicalizes the name before calling canonicalizeToolInput).
// Verified against a live ~/.hermes/state.db: read_file / write_file / patch
// deliver the file path as `path`, but Claude builtins read `file_path`
// (block-env-files, block-secrets-write, block-read-outside-cwd) — so map it.
// write_file's `content`, patch's `old_string`/`new_string`, and search_files'
// `pattern`/`path` are already canonical, so Grep needs no entry. Mirrors
// PI_TOOL_INPUT_MAP (Pi has the same `path` → `file_path` shape).
export const HERMES_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
};

// Hermes live-hook (Pillar 1) events + scopes. Hermes fires these snake_case
// events with a JSON payload on stdin; the command we install runs
// `failproofai --hook <event> --cli hermes`. Config is USER-scope only
// (`~/.hermes/config.yaml`; Hermes has no project scope). `pre_tool_call` is the
// core deny point — it fires for tool calls from every source
// (slack/telegram/cli/cron) and internal subagents, so a single install
// intercepts all platforms. Hermes has NO turn-end `Stop` event, so the
// `require-*-before-stop` builtins never fire for it (see the audit plan).
export const HERMES_HOOK_SCOPES = ["user"] as const;
export type HermesHookScope = (typeof HERMES_HOOK_SCOPES)[number];

export const HERMES_HOOK_EVENT_TYPES = [
  "pre_tool_call",
  "post_tool_call",
  "on_session_start",
  "on_session_end",
  "subagent_stop",
] as const;
export type HermesHookEventType = (typeof HERMES_HOOK_EVENT_TYPES)[number];

export const HERMES_EVENT_MAP: Record<HermesHookEventType, HookEventType> = {
  pre_tool_call: "PreToolUse",
  post_tool_call: "PostToolUse",
  on_session_start: "SessionStart",
  on_session_end: "SessionEnd",
  subagent_stop: "SubagentStop",
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

// ── OpenClaw (openclaw gateway) ─────────────────────────────────────────────
//
// OpenClaw is a self-hosted assistant gateway (23+ chat channels). Like Hermes
// it is a dual-pillar integration (live hooks + audit) and USER-scope only
// (`~/.openclaw/openclaw.json`; workspace plugins are disabled by default).
//
// Enforcement is via OpenClaw's IN-PROCESS PLUGIN hooks (its file-based
// "internal hooks" are observation-only and cannot block) — so failproofai
// ships a plugin (`openclaw-plugin/`) that async-spawns the binary and maps a
// flat `{permission, reason}` verdict back to each hook's native return shape.
// The shim forwards a Claude-shaped stdin (params→tool_input, toolName→
// tool_name, transcriptPath→transcript_path, stopHookActive→stop_hook_active),
// so the handler + builtins work unchanged; canonicalization stays binary-side
// via the maps below (no inline maps in the shim, unlike OpenCode/Pi).
//
// Per-hook capability (verified live against openclaw v2026.7.1):
//   before_tool_call    → PreToolUse       ✅ deny  ({block:true, blockReason})
//   after_tool_call     → PostToolUse      observation
//   before_agent_run    → UserPromptSubmit ✅ deny  ({outcome:"block", reason})
//   before_agent_finalize → Stop           ✅ revise ({action:"revise", reason});
//                           carries transcriptPath + stopHookActive (≈ Claude Stop)
//   session_start/end   → SessionStart/End observation
//   subagent_ended      → SubagentStop     observation only (cannot veto)
//   before_compaction   → PreCompact       observation
// Omitted: agent_end (would double-fire Stop); message_sending (outbound-msg
// cancel gate — OpenClaw-only capability, deferred).
export const OPENCLAW_HOOK_SCOPES = ["user"] as const;
export type OpenClawHookScope = (typeof OPENCLAW_HOOK_SCOPES)[number];

export const OPENCLAW_HOOK_EVENT_TYPES = [
  "before_tool_call",
  "after_tool_call",
  "before_agent_run",
  "before_agent_finalize",
  "session_start",
  "session_end",
  "subagent_ended",
  "before_compaction",
] as const;
export type OpenClawHookEventType = (typeof OPENCLAW_HOOK_EVENT_TYPES)[number];

export const OPENCLAW_EVENT_MAP: Record<OpenClawHookEventType, HookEventType> = {
  before_tool_call: "PreToolUse",
  after_tool_call: "PostToolUse",
  before_agent_run: "UserPromptSubmit",
  before_agent_finalize: "Stop",
  session_start: "SessionStart",
  session_end: "SessionEnd",
  subagent_ended: "SubagentStop",
  before_compaction: "PreCompact",
};

// OpenClaw native tool ids (verified against source src/agents/tool-catalog.ts
// and a live before_tool_call payload: tool `exec`, params `{command}`). Names
// with a Claude canonical are mapped so builtin policies fire; OpenClaw-specific
// tools (process, apply_patch, memory_*, sessions_*, browser, canvas, …) pass
// through unchanged so they still appear in the audit, just unmatched.
export const OPENCLAW_TOOL_MAP: Record<string, string> = {
  exec: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

// OpenClaw tool-INPUT key canonicalization, keyed by the *canonical* tool name
// (the handler canonicalizes the name before calling canonicalizeToolInput).
// `exec` already delivers `command` (matches Bash builtins), so no entry; the
// file tools deliver the path as `path`, which Claude builtins read as
// `file_path`. Mirrors HERMES_TOOL_INPUT_MAP / PI_TOOL_INPUT_MAP.
export const OPENCLAW_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
};

// ── Factory Droid (droid) ───────────────────────────────────────────────────
//
// Factory's droid CLI ships a Claude-compatible external-command hook system,
// but with two schema quirks verified LIVE against droid v0.171.0:
//
//   1. **Event names live at the TOP LEVEL of hooks.json — there is NO `"hooks"`
//      wrapper.** The published docs are wrong; droid rejects a `{"hooks":{…}}`
//      wrapper with `WARN Ignoring unknown hook event keys keys:["hooks"]`. The
//      correct shape is:
//        { "PreToolUse": [ { "matcher": "*", "hooks": [ { … } ] } ],
//          "Stop":       [ { "hooks": [ { … } ] } ] }
//      Tool events (PreToolUse / PostToolUse) MUST carry `"matcher": "*"`
//      (matches all tools); non-tool events omit the matcher.
//
//   2. **Deny is driven by EXIT CODE 2 + stderr, NOT a JSON decision.** droid
//      ignores a `{decision:…}` object on tool events and blocks purely on
//      exit code 2 (verified live: `Hook returned exit code 2, throwing
//      ToolExecutionControlError`). The one exception is the `Stop` event,
//      where droid does NOT support exit-2 force-retry — there we emit
//      `{decision:"block", reason}` JSON on stdout at exit 0 (docs: "if
//      decision is block, Droid does not stop"). Both branches live in
//      policy-evaluator.ts's `cli === "factory"` handling.
//
// Event names are already PascalCase (matching Claude's canonical set), so
// there is NO FACTORY_EVENT_MAP and NO handler.ts canonicalization branch — the
// binary sees the events verbatim. The stdin payload is Claude snake_case
// (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`,
// `tool_name`, `tool_input:{command,…}`), so no payload normalization is needed
// either.
//
// Settings paths (verified against droid v0.171.0):
//   user    → ~/.factory/hooks.json
//   project → <cwd>/.factory/hooks.json
//
// Audit pillar: sessions at ~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl
// (Claude-style encoded-cwd folders), one JSONL per session alongside a
// `<sessionId>.settings.json` sibling we ignore. See lib/factory-sessions.ts.

export const FACTORY_HOOK_SCOPES = ["user", "project"] as const;
export type FactoryHookScope = (typeof FACTORY_HOOK_SCOPES)[number];

export const FACTORY_HOOK_EVENT_TYPES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;
export type FactoryHookEventType = (typeof FACTORY_HOOK_EVENT_TYPES)[number];

/**
 * Factory droid's tool names → Claude PascalCase canonical names so existing
 * builtin policies (which match `toolName === "Bash"`, etc.) fire unchanged.
 * Verified against droid v0.171.0: shell runs as `Execute`, file writes as
 * `Create`, URL fetches as `FetchUrl`. `tool_input.command` is already the
 * canonical Bash key, so there is NO FACTORY_TOOL_INPUT_MAP. Unknown tools
 * (MCP, extensions) pass through unchanged via the `?? raw` fallback.
 */
export const FACTORY_TOOL_MAP: Record<string, string> = {
  Execute: "Bash",
  Read: "Read",
  Edit: "Edit",
  Create: "Write",
  Grep: "Grep",
  Glob: "Glob",
  LS: "LS",
  FetchUrl: "WebFetch",
  WebSearch: "WebSearch",
  TodoWrite: "TodoWrite",
  Task: "Task",
};

// ── Devin CLI (devin) ───────────────────────────────────────────────────────
//
// Devin's CLI (Cognition) is a **pure Claude-clone** external-command hook
// system — verified LIVE against devin v3000.1.27. Unlike Factory, it uses the
// standard Claude `"hooks"`-wrapper schema (its config.json also holds
// `org_id`, `theme_mode`, etc., so writes are merge-preserving via
// readJsonFile/writeJsonFile). No quirks:
//
//   • Config lives under a `"hooks"` key exactly like Claude's settings.json:
//       user    → ~/.config/devin/config.json  (the `"hooks"` key)
//       project → <cwd>/.devin/config.json      (the `"hooks"` key)
//   • Event names are already PascalCase (matching Claude's canonical set), so
//     there is NO DEVIN_EVENT_MAP and NO handler.ts canonicalization branch.
//   • The stdin payload is pure Claude snake_case (no normalization needed):
//       PreToolUse  → {hook_event_name, tool_name:"exec", tool_input:{command}, tool_use_id}
//       PostToolUse → adds tool_response:{success, output, error}
//       Stop        → {stop_hook_active}
//   • Deny contract = `{"decision":"block","reason"}` JSON on stdout at exit 0
//     (VERIFIED live — it blocked and overrode `--permission-mode dangerous`).
//     Both non-Stop and Stop use the same `{decision:"block"}` shape (Stop's
//     reason carries the MANDATORY-ACTION force-retry wording). Devin is
//     Claude-compatible, so instruct on context-injection events emits
//     `{hookSpecificOutput:{hookEventName, additionalContext}}`. See
//     policy-evaluator.ts's `cli === "devin"` branch.
//
// Audit pillar: sessions live in SQLite at
// ~/.local/share/devin/cli/sessions.db (tables `sessions` — one row per
// session WITH a `working_directory` — and `message_nodes`, whose
// `chat_message` column is OpenAI-style JSON `{role, content, tool_calls?,
// tool_call_id?}`). See lib/devin-sessions.ts. `DEVIN_HOME` overrides the home
// dir for tests.

export const DEVIN_HOOK_SCOPES = ["user", "project"] as const;
export type DevinHookScope = (typeof DEVIN_HOOK_SCOPES)[number];

export const DEVIN_HOOK_EVENT_TYPES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;
export type DevinHookEventType = (typeof DEVIN_HOOK_EVENT_TYPES)[number];

/**
 * Devin's tool names → Claude PascalCase canonical names so existing builtin
 * policies (which match `toolName === "Bash"`, etc.) fire unchanged. Verified
 * live against devin v3000.1.27: the shell tool runs as `exec` and its
 * `tool_input.command` is already the canonical Bash key, so there is NO
 * DEVIN_TOOL_INPUT_MAP. All other Devin tool names pass through unchanged via
 * the `?? raw` fallback.
 */
export const DEVIN_TOOL_MAP: Record<string, string> = {
  exec: "Bash",
};

// ── Antigravity CLI (antigravity) ────────────────────────────────────────────
//
// Antigravity's `agy` CLI has its OWN hook contract — it is NOT a Claude-clone.
// Verified LIVE against agy v1.1.2 (shipped docs at
// ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md):
//
//   1. **hooks.json is a NAMED-hook schema.** Each top-level key is a hook
//      *name* ("failproofai"), whose value is an event→handlers map. Tool events
//      (PreToolUse / PostToolUse) use a `{matcher, hooks:[…]}` wrapper;
//      non-tool events (PreInvocation / Stop) are FLAT arrays of handler
//      objects:
//        { "failproofai": {
//            "PreToolUse":  [ { "matcher":"*", "hooks":[ {type,command,timeout} ] } ],
//            "PreInvocation": [ { type, command, timeout } ],
//            "Stop":          [ { type, command, timeout } ] } }
//      Multiple named hooks merge; `"enabled": false` disables a named hook.
//
//   2. **camelCase (protojson) stdin payload.** Antigravity pipes camelCase
//      fields (`toolCall:{name,args}`, `conversationId`, `workspacePaths`,
//      `transcriptPath`, `stepIdx`, `modelName`) — handler.ts normalizes these
//      to canonical snake_case (`tool_name`, `tool_input`, `session_id`, `cwd`,
//      `transcript_path`) right after JSON.parse. Tool `args` are PascalCase
//      (`CommandLine`, `Cwd`) — canonicalized via ANTIGRAVITY_TOOL_INPUT_MAP.
//
//   3. **Antigravity's OWN response shapes** (policy-evaluator.ts
//      `cli === "antigravity"` branch):
//        • Deny (tool events) → exit 0, `{decision:"deny", reason}` on stdout.
//        • Deny on Stop        → exit 0, `{decision:"continue", reason}` —
//          "continue" re-enters the loop (how require-*-before-stop enforces).
//        • Instruct on UserPromptSubmit (canonical for PreInvocation) → exit 0,
//          `{injectSteps:[{ephemeralMessage:"Instruction from failproofai: …"}]}`.
//        • Instruct on Stop → `{decision:"continue", reason}`.
//        • Other instruct events → stderr note only (degrade like Hermes).
//
//   4. **ANTIGRAVITY_EVENT_MAP** maps the `--hook` arg to a canonical event:
//      PreToolUse→PreToolUse, PostToolUse→PostToolUse,
//      PreInvocation→UserPromptSubmit, Stop→Stop.
//
// Settings paths (verified against agy v1.1.2):
//   user    → ~/.gemini/config/hooks.json
//   project → <cwd>/.agents/hooks.json
//
// Audit pillar: plain JSONL transcripts at
// ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
// transcript_full.jsonl (one step per line); the conversation index lives in
// SQLite at ~/.gemini/antigravity-cli/conversation_summaries.db. See
// lib/antigravity-sessions.ts + lib/antigravity-projects.ts. `ANTIGRAVITY_HOME`
// overrides the home dir for tests.

export const ANTIGRAVITY_HOOK_SCOPES = ["user", "project"] as const;
export type AntigravityHookScope = (typeof ANTIGRAVITY_HOOK_SCOPES)[number];

/** The events failproofai installs into Antigravity's hooks.json. Tool events
 *  use the `{matcher, hooks}` wrapper; PreInvocation / Stop are flat arrays. */
export const ANTIGRAVITY_HOOK_EVENT_TYPES = [
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "Stop",
] as const;
export type AntigravityHookEventType = (typeof ANTIGRAVITY_HOOK_EVENT_TYPES)[number];

/** Antigravity `--hook` arg → canonical HookEventType. PreInvocation is
 *  Antigravity's before-model event → maps to UserPromptSubmit (where instruct
 *  injects `injectSteps`). Verified against agy v1.1.2. */
export const ANTIGRAVITY_EVENT_MAP: Record<AntigravityHookEventType, HookEventType> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PreInvocation: "UserPromptSubmit",
  Stop: "Stop",
};

/**
 * Antigravity's tool names → Claude PascalCase canonical names so existing
 * builtin policies (which match `toolName === "Bash"`, etc.) fire unchanged.
 * Tool names VERIFIED against the agy binary's tool registry + live transcripts:
 * the file tool is `write_to_file` (NOT `write_file`), listing is `list_dir`
 * (NOT `list_directory`), and glob is `find_by_name` (NOT `find_filepath`) — the
 * earlier best-effort names were wrong, so `block-env-files`/`block-secrets-write`
 * silently no-op'd on Antigravity file writes. Unknown tools pass through via the
 * `?? raw` fallback.
 */
export const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  run_command: "Bash",
  write_to_file: "Write",
  read_file: "Read",
  view_file: "Read",
  edit_file: "Edit",
  replace_file_content: "Edit",
  list_dir: "LS",
  find_by_name: "Glob",
  grep_search: "Grep",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
};

/**
 * Antigravity tool args are PascalCase. Keyed by the CANONICAL tool name
 * (canonicalizeToolInput runs after canonicalizeToolName). VERIFIED live:
 * `run_command` delivers `CommandLine`/`Cwd`; `write_to_file` delivers the path
 * as `TargetFile` and body as `CodeContent`. Without the Write/Edit/Read entries
 * the path/content builtins (`block-env-files`, `block-secrets-write`,
 * `block-read-outside-cwd`) never saw a `file_path` and silently no-op'd on
 * Antigravity file operations. Read/Edit path keys are best-effort within the
 * same tool family (all file tools operate on `TargetFile`); extra keys are
 * harmless (only remapped when present).
 */
export const ANTIGRAVITY_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Bash: { CommandLine: "command", Cwd: "cwd" },
  Write: { TargetFile: "file_path", CodeContent: "content" },
  Edit: { TargetFile: "file_path" },
  Read: { TargetFile: "file_path", AbsolutePath: "file_path", File: "file_path" },
};

// ── Goose (codename goose, Block) ────────────────────────────────────────────
//
// Goose is Block's open-source Rust MCP agent — a LOCAL dev-agent CLI (like
// Claude/Factory/Devin, NOT a gateway). Dual-pillar: external shell-hook
// enforcement + SQLite audit. The entire contract below was verified LIVE
// against goose v1.43.0.
//
// Enforcement is via Goose's "hooks" system (the cross-agent Open Plugins spec):
// a plugin directory whose `hooks/hooks.json` `command` runs
// `failproofai --hook <event> --cli goose`. Goose AUTO-DISCOVERS the dir at
// startup (no config edit needed) and self-registers it into config.yaml.
//
//   1. **Deny contract = `PreToolUse` ONLY** (shipped in goose ≥ v1.37.0,
//      PR block/goose#9304). A hook blocks a tool via `{"decision":"block",
//      "reason"}` on stdout at exit 0 (exit 2 + stderr also works); ANY other
//      error/timeout → fail-open (allow). Verified live: the reason reaches the
//      model and "do not retry" is appended. Goose has NO `Stop` event, so the 5
//      `require-*-before-stop` builtins never fire (inapplicable, like Hermes).
//      `UserPromptSubmit` deny is NOT honored (observation only). `PreToolUse`
//      fires for the shell tool AND inside delegated subagents, so it is the
//      single sufficient deny point.
//
//   2. **Event names are already PascalCase** (matching Claude's canonical set),
//      so there is NO `GOOSE_EVENT_MAP` and NO handler.ts event-canonicalization
//      branch. The stdin payload, however, uses `event` (not `hook_event_name`)
//      and `working_dir` (not `cwd`) — handler.ts normalizes `working_dir`→`cwd`
//      for goose so `block-read-outside-cwd` keeps its cwd. `tool_name` /
//      `tool_input` are already the canonical field names.
//
//   3. Tool names arrive BOTH bare (`shell`, `write`, `edit`, `view`,
//      `read_image`, `tree`, `delegate`) AND `<ext>__<tool>` namespaced
//      (`todo__todo_write`); GOOSE_TOOL_MAP covers both forms, unknown tools
//      pass through via the `?? raw` fallback. Path-bearing tools deliver the
//      path as `path` (or `source` for read_image), so GOOSE_TOOL_INPUT_MAP maps
//      it to `file_path`. Shell's `command` is already canonical.
//
//   4. **Instruct has no channel** — a non-block PreToolUse decision injects
//      nothing (verified live), so instruct() degrades to allow + stderr note
//      (like Factory/Hermes on non-Stop events). policy-evaluator.ts's
//      `cli === "goose"` branch: PreToolUse deny → `{"decision":"block",reason}`
//      JSON at exit 0; no Stop branch.
//
// Settings paths (verified against goose v1.43.0):
//   user    → ~/.agents/plugins/failproofai/hooks/hooks.json
//   project → <cwd>/.agents/plugins/failproofai/hooks/hooks.json
//
// Audit pillar: sessions in SQLite at
// ~/.local/share/goose/sessions/sessions.db (schema v15). `sessions` rows carry
// a real `working_dir`, so `audit --project <cwd>` filters like Devin (NOT
// grouped-by-source like Hermes); `messages` rows hold Claude-style typed-block
// `content_json`. See lib/goose-sessions.ts. `GOOSE_HOME` overrides the data
// dir for tests.

export const GOOSE_HOOK_SCOPES = ["user", "project"] as const;
export type GooseHookScope = (typeof GOOSE_HOOK_SCOPES)[number];

export const GOOSE_HOOK_EVENT_TYPES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SessionEnd",
] as const;
export type GooseHookEventType = (typeof GOOSE_HOOK_EVENT_TYPES)[number];

/**
 * Goose's tool names → Claude PascalCase canonical names so existing builtin
 * policies (which match `toolName === "Bash"`, etc.) fire unchanged. Verified
 * live against goose v1.43.0: the developer extension exposes `shell` (Bash),
 * `write`/`edit`/`view` (file ops), `read_image`, `glob`/`grep`, plus
 * `tree`/`delegate`; other extensions namespace their tools (`todo__todo_write`).
 * Unknown tools (MCP, other extensions) pass through unchanged via the `?? raw`
 * fallback in handler.ts:canonicalizeToolName.
 */
export const GOOSE_TOOL_MAP: Record<string, string> = {
  shell: "Bash",
  write: "Write",
  edit: "Edit",
  view: "Read",
  read_image: "Read",
  glob: "Glob",
  grep: "Grep",
  tree: "LS",
  delegate: "Task",
  todo__todo_write: "TodoWrite",
};

/**
 * Per-tool input-key translation, keyed by the *canonical* tool name (the
 * handler canonicalizes the name before calling canonicalizeToolInput).
 * Verified live: goose's file tools deliver the path as `path` (`read_image`
 * uses `source`), but Claude builtins read `file_path` (block-env-files,
 * block-secrets-write, block-read-outside-cwd) — so map it. `shell` already
 * delivers `command` (canonical), so Bash needs no entry. `edit` delivers
 * `before`/`after` (not `old_string`/`new_string`); only the top-level `path`
 * is mapped (no builtin inspects the edit body), mirroring PI_TOOL_INPUT_MAP.
 */
export const GOOSE_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path", source: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
  LS: { path: "file_path" },
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
   *  agent-emitted event name (e.g. Cursor's `preToolUse`, Pi's `tool_call`).
   *  May be undefined when stdin omits it. */
  hookEventName?: string;
  /** The raw event name passed on the CLI's `--hook` flag, BEFORE any
   *  per-CLI canonicalization to PascalCase (e.g. `preToolUse` for Cursor).
   *  Use this for round-tripping the agent-side event name in response shapes
   *  when stdin doesn't include `hook_event_name`. */
  rawHookEventName?: string;
  /** Which agent CLI fired this hook (claude | codex | copilot | cursor | opencode | pi | hermes | openclaw | factory | devin | antigravity | goose). Set by handler.ts from --cli. */
  cli?: IntegrationType;
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}
