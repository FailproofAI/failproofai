/**
 * Constants and interfaces for agent harness hook integrations.
 *
 * A harness is whatever an agent runs inside. The twelve below are two classes:
 * ten coding CLIs (Claude Code, Codex, Copilot, Cursor, OpenCode, Pi, Factory,
 * Devin, Antigravity, Goose) and two chat/assistant gateways (Hermes, OpenClaw).
 *
 * An agent instrumented directly via the Python SDK is NOT one of these twelve
 * and is not a third class here: the SDK reports events, it does not sit in the
 * tool-call path, so it delivers observability without enforcement. Copy that
 * lists it alongside the twelve overstates what it does.
 *
 * INTEGRATION_TYPES below is the authoritative list:
 * __tests__/scripts/copy-counts.test.ts pins its length, and the policy, event
 * and enforcement counts, against the harness and policy counts stated in
 * README.md, package.json and docs/index.mdx.
 */

export const HOOK_SCOPES = ["user", "project", "local"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

export const INTEGRATION_TYPES = ["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose", "grok", "qwen", "ori"] as const;
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
// intercepts all platforms.
//
// `pre_verify` IS a turn-end gate — the earlier claim here that Hermes has none
// was wrong. We deliberately do NOT install it (product decision, 2026-07-29);
// this note records what it would buy so the choice can be revisited without
// re-deriving it.
//
// Upstream fires it once per turn when the agent has edited code and is about to
// finish (`agent/conversation_loop.py:6754`), and its parser accepts our Claude
// Stop shape verbatim — `{decision:"block", reason}` means "block the stop",
// i.e. keep going (`agent/shell_hooks.py:606-615`). The reason is injected as a
// synthetic user message and the loop re-enters
// (`conversation_loop.py:6774-6800`). Installing it is one entry in
// config.yaml — it is a shell hook like the other five, no Python involved.
//
// It would make the 5 `require-*-before-stop` builtins fire on Hermes, subject
// to three upstream conditions:
//   1. It fires ONLY on turns that landed a file mutation, and that means
//      exactly `write_file` or `patch` (`agent/tool_result_classification.py:9`)
//      — a turn that did its work through `terminal` (sed -i, rm, >) does not
//      qualify, so a chat-only gateway may never see it.
//   2. Capped at 3 nudges per turn (`DEFAULT_MAX_VERIFY_NUDGES`,
//      `agent/verify_hooks.py:21`), operator-overridable; resets each turn.
//   3. It landed upstream ~2026-06-30. Older Hermes fails the key against
//      VALID_HOOKS and warn-and-skips it SILENTLY (`agent/shell_hooks.py:325`).
//
// Until it is installed, `HERMES_EVENT_MAP` emits no `Stop` and those 5
// builtins remain inapplicable on Hermes.
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

/**
 * Copilot CLI tool-input key canonicalization, keyed by CANONICAL tool name.
 *
 * Verified live against Copilot CLI 1.0.71: the snake_case hook events
 * (PreToolUse/PostToolUse) deliver `tool_name` already canonical (`Bash`,
 * `Read`, `Write`, `Edit`, `Grep`) but the file tools' input keys are
 * Copilot's own — `path` instead of `file_path`, Write's content as
 * `file_text`, Edit's strings as `old_str`/`new_str`. Without this map,
 * path/content builtins (block-env-files, block-secrets-write) silently
 * allowed Copilot file access (a live `.env` read was observed passing).
 * Bash's `command` and Grep's `pattern` are already canonical.
 */
export const COPILOT_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path", file_text: "content" },
  Edit: { path: "file_path", old_str: "old_string", new_str: "new_string" },
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

// ---------------------------------------------------------------------------
// grok (xAI's `grok` CLI) — 13th integration. Dual-pillar (live hooks + audit),
// user + project scope, Claude/Codex-style external shell hooks. The entire
// contract below was VERIFIED LIVE against grok 1.0.3 (1a29d5bc12) with a
// recorder hook on all 14 events plus deny / stop-gate probes.
//
//   1. **The envelope is camelCase**, so — like Antigravity — normalizeCliPayload
//      has a `grok` branch. `toolName`/`toolInput`/`sessionId`/`transcriptPath`
//      → snake_case, `workspaceRoot` → `cwd`, `toolResult` → `tool_response`
//      (grok does NOT use Claude's `tool_response`), `stopHookActive` →
//      `stop_hook_active`. NOTE `hookEventName`'s *value* is snake_case
//      ("pre_tool_use") while the `--hook` arg is PascalCase, so the arg is the
//      canonical source and there is NO GROK_EVENT_MAP.
//
//   2. **Deny = `{"decision":"deny","reason"}` on stdout at exit 0.** VERIFIED
//      live, and it beat `--yolo` (permissionMode `bypassPermissions`). grok
//      does NOT read Claude's `hookSpecificOutput.permissionDecision` shape —
//      also verified live, by A/B: the identical hook emitting Claude's shape
//      let `echo` run, emitting grok's shape blocked it. This is why
//      isGrokEnvelope() exists (see normalize-cli-payload.ts).
//
//   3. **Stop fires TWICE per session** — once per real turn end
//      (`reason: "end_turn"`) and once at shutdown (`reason: "shutdown"`),
//      whose decision grok parses and then IGNORES (no turn is left to
//      continue). So the Stop branch in policy-evaluator.ts gates on
//      `reason === "end_turn"`; blocking on the shutdown fire would emit a deny
//      that is counted as enforcement and can never be acted on. Captured
//      sequence, one turn: end_turn/stopHookActive=false (we blocked) → the
//      agent ran the required command → end_turn/stopHookActive=true (allowed)
//      → shutdown. Cap: 8 continuations per turn, then grok forces the stop.
//
//   4. **Project hooks require a GIT REPO** — undocumented, verified live: in a
//      *trusted* non-git directory holding a valid `.grok/hooks/*.json`, grok
//      logs `project_sources=0` and the hook never fires; after `git init` in
//      the same directory it logs `project_sources=4` and fires. A project-scope
//      install into a non-git dir is a silent no-op, so the installer warns.
//      Project scope additionally requires folder trust (`--trust` /
//      `/hooks-trust`); user scope (`~/.grok/hooks/`) is always trusted.
//
// Settings paths (VERIFIED):
//   user    → ~/.grok/hooks/failproofai.json      (always trusted)
//   project → <repo>/.grok/hooks/failproofai.json (needs git + folder trust)
//
// `timeout` is in SECONDS (grok's default is 5; 600 for Stop/SubagentStop).
// Env injected on every hook: GROK_HOOK_EVENT, GROK_HOOK_NAME, GROK_SESSION_ID,
// GROK_WORKSPACE_ROOT, and CLAUDE_PROJECT_DIR (a Claude-compatible alias) — so
// the dogfood config can use $CLAUDE_PROJECT_DIR like .claude/settings.json.
//
// Audit pillar: `~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/` —
// PERCENT encoding (`%2Fhome%2Fyou%2Frepo`), not Claude's dash style. Each
// session dir holds chat_history.jsonl + events.jsonl + summary.json (the last
// carries `info.cwd`, `session_summary`, `num_messages`, `current_model_id`).
// See lib/grok-sessions.ts. `GROK_HOME` overrides the home dir for tests.
export const GROK_HOOK_SCOPES = ["user", "project"] as const;
export type GrokHookScope = (typeof GROK_HOOK_SCOPES)[number];

// All 14 of grok's events, which is its entire surface. Every name here was
// accepted by a live grok 1.0.3 (`hooks: loaded from global source … count=14`,
// `loaded hooks hook_count=14`, no unknown-key warning) — grok silently SKIPS
// unrecognized event keys, so acceptance is the thing to verify, and it was.
// `Notification` and `StopFailure` were additionally observed firing.
//
// The six beyond the original eight are all OBSERVATION — grok's own ACP
// handshake advertises `blockingEvents: ["pre_tool_use","stop","subagent_stop"]`
// and that is the complete list, so nothing added here can ever deny. They are
// installed for custom-policy surface and audit signal, and because the cost of
// an event that never fires is zero.
export const GROK_HOOK_EVENT_TYPES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;
export type GrokHookEventType = (typeof GROK_HOOK_EVENT_TYPES)[number];

/**
 * grok's tool ids → Claude PascalCase canonical names so existing builtins
 * (which match `toolName === "Bash"`) fire unchanged. Every entry below was
 * observed on the wire, not read from a doc — which matters here, because
 * grok's own docs disagree with themselves: the hooks doc calls the shell tool
 * `run_terminal_command` and the headless doc calls it `run_terminal_cmd`. The
 * wire says `run_terminal_command`; the alias is kept so a matcher written
 * against either name still canonicalizes. Unknown tools pass through via the
 * `?? raw` fallback in handler.ts:canonicalizeToolName.
 */
export const GROK_TOOL_MAP: Record<string, string> = {
  run_terminal_command: "Bash",
  run_terminal_cmd: "Bash",
  write: "Write",
  read_file: "Read",
  search_replace: "Edit",
  grep: "Grep",
  list_dir: "LS",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  spawn_subagent: "Task",
};

/**
 * Per-tool input-key translation, keyed by the *canonical* tool name. Only two
 * of grok's tools deviate, and both were found by capture rather than by
 * reading: `read_file` delivers the path as `target_file` and `list_dir` as
 * `target_directory`. The `read_file` entry is the load-bearing one — without
 * it a live `.env` read sails past block-env-files / block-read-outside-cwd,
 * the exact bug COPILOT_TOOL_INPUT_MAP was added to fix. Everything else is
 * already canonical: Bash `command`, Write `file_path`/`content`, Edit
 * `file_path`/`old_string`/`new_string`, Grep `pattern`/`path`.
 */
export const GROK_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { target_file: "file_path" },
  LS: { target_directory: "path" },
};

// ---------------------------------------------------------------------------
// qwen (Alibaba's Qwen Code, `qwen`) — 14th integration. Dual-pillar, user +
// project scope. The CHEAPEST integration in the codebase: qwen is a near-pure
// Claude clone on the wire, so it needs NO event map, NO payload normalization,
// and NO tool-input map. Verified live against @qwen-code/qwen-code 0.21.12.
//
//   1. **Payload is pure Claude snake_case** — `hook_event_name` (PascalCase
//      *value*, unlike grok), `session_id`, `transcript_path`, `cwd`,
//      `permission_mode`, `tool_name`, `tool_input`, `tool_response`,
//      `stop_hook_active`. Nothing to normalize.
//
//   2. **Deny = `hookSpecificOutput.permissionDecision`** ("allow" | "deny" |
//      "ask"), which is Claude's own PreToolUse shape — so the generic Claude
//      branch in policy-evaluator.ts already emits the right thing and qwen
//      needs no PreToolUse special-case. VERIFIED live: it beat `-y` (yolo) and
//      the reason reached the model verbatim. ("ask" degrades to deny in
//      headless and in background subagents.) Stop takes the top-level
//      `{decision:"block",reason}` shape instead, which is why the qwen branch
//      below exists at all.
//
//   3. **`stop_hook_active` is TRUE on the FIRST Stop fire**, before anything
//      has blocked — verified live. It is therefore NOT a usable "already
//      retrying" signal on qwen, and no failproofai loop guard may depend on
//      it. (Unlike grok, qwen fires no session-end Stop: both fires are real.)
//
//   4. **`UserPromptSubmit` fires per MODEL INVOCATION, not per user prompt** —
//      one user turn produced FOUR of them (initial query + one per tool-result
//      continuation). qwen's own docs confirm it covers UserQuery/ToolResult/
//      Hook sends and warn that `prompt` is not necessarily user input. Any
//      UserPromptSubmit policy fires N× per turn here; `submitted_prompt` is
//      present only for interactive-TUI submissions (absent in headless, ACP,
//      serve, SDK).
//
// Settings paths (VERIFIED): the `hooks` key inside qwen's normal settings.
//   user    → ~/.qwen/settings.json
//   project → <cwd>/.qwen/settings.json
//
// `timeout` is in MILLISECONDS (default 60000) — qwen is the ONLY integration
// that is not seconds-based, so buildHookEntry must not be "simplified" to
// share the others' value. `disableAllHooks: true` (top level) and `--safe-mode`
// both disable every hook.
//
// Audit pillar: `~/.qwen/projects/<dash-encoded-cwd>/chats/<sessionId>.jsonl` —
// Claude-style encoded-cwd folders, one JSONL per session, lines carrying
// `{sessionId, timestamp, type: user|assistant|system|tool_result, cwd}`. A real
// cwd per line means audit groups by project like Claude/Devin/Goose. See
// lib/qwen-sessions.ts. `QWEN_HOME` overrides the home dir for tests.
export const QWEN_HOOK_SCOPES = ["user", "project"] as const;
export type QwenHookScope = (typeof QWEN_HOOK_SCOPES)[number];

// Every event below has a real `executeHooks("<Event>")` dispatch site in the
// shipped qwen bundle (verified by reading it, not the docs — which is also how
// `InstructionsLoaded`, `UserPromptExpansion` and `PostToolBatch` turned up:
// all three are dispatched but absent from qwen's documented event table).
// TodoCreated/TodoCompleted/PostToolBatch/InstructionsLoaded/Notification were
// additionally observed firing in a live 0.21.12 session.
//
// Deliberately NOT subscribed:
//   • `MessageDisplay` — fires per streaming chunk, i.e. a hook process per
//     chunk. The one entry here that could make hooks feel slow.
//   • `PostToolBatch` — fired 6× in the same task PostToolUse fired 5×, and
//     carries the same tool calls in batch form. Measured at +76% hook
//     invocations for a task, against no builtin that reads it. One line to add
//     later if a custom policy ever wants batch granularity.
//   • `SessionDelete` — no canonical equivalent, and little to enforce on.
export const QWEN_HOOK_EVENT_TYPES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  "InstructionsLoaded",
  "UserPromptExpansion",
  "TodoCreated",
  "TodoCompleted",
  "SessionEnd",
] as const;
export type QwenHookEventType = (typeof QWEN_HOOK_EVENT_TYPES)[number];

/**
 * qwen event name → canonical HookEventType.
 *
 * Seventeen of nineteen are already canonical and map to themselves; this map
 * exists for the two that are not. qwen calls its task list "todos", so
 * `TodoCreated`/`TodoCompleted` are the same concept failproofai and Claude
 * call `TaskCreated`/`TaskCompleted`, and mapping them lets a policy written
 * once fire on both.
 *
 * These two are also the only ADDED events on either CLI that can actually
 * block. qwen runs todo hooks in two phases and the payload says which:
 * during `phase: "validation"` a `{decision:"block"|"deny", reason}` prevents
 * the write and the reason goes back to the model; during `phase: "postWrite"`
 * the todo is already persisted and a block is ignored. Both phases were
 * observed live (`phase: "validation"` on every capture).
 *
 * Exhaustive `Record<QwenHookEventType, HookEventType>` so tsc fails the build
 * if an event is added here without deciding what it canonicalizes to.
 */
export const QWEN_EVENT_MAP: Record<QwenHookEventType, HookEventType> = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  PermissionRequest: "PermissionRequest",
  PermissionDenied: "PermissionDenied",
  Stop: "Stop",
  StopFailure: "StopFailure",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  Notification: "Notification",
  InstructionsLoaded: "InstructionsLoaded",
  UserPromptExpansion: "UserPromptExpansion",
  TodoCreated: "TaskCreated",
  TodoCompleted: "TaskCompleted",
  SessionEnd: "SessionEnd",
};

/**
 * qwen's runtime tool ids → Claude PascalCase canonical names. All six were
 * observed live. qwen also accepts its own display names (`WriteFile`,
 * `ReadFile`) as matcher aliases, so those are mapped too for configs written
 * against the older names. Unknown tools pass through via the `?? raw`
 * fallback.
 *
 * There is deliberately NO QWEN_TOOL_INPUT_MAP: every tool already delivers
 * canonical keys — `run_shell_command` `{command}`, `read_file` `{file_path}`,
 * `write_file` `{file_path, content}`, `edit` `{file_path, old_string,
 * new_string}`, `grep_search` `{pattern, path}`, `list_directory` `{path}`.
 */
export const QWEN_TOOL_MAP: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  ReadFile: "Read",
  read_many_files: "Read",
  write_file: "Write",
  WriteFile: "Write",
  edit: "Edit",
  replace: "Edit",
  grep_search: "Grep",
  search_file_content: "Grep",
  glob: "Glob",
  list_directory: "LS",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
  task: "Task",
  todo_write: "TodoWrite",
};


// ── Ori (OpenRouter's ori) ──────────────────────────────────────────────────
//
// `ori` is two products behind one binary, and only the second is this
// integration:
//
//   1. A LAUNCHER for other agent CLIs (`ori claude`, `ori codex`, `ori grok`,
//      `ori opencode`, `ori hermes`, `ori omp`, `ori prime-agent`, `ori kilo`,
//      `ori dsh`) that runs the real third-party binary under OpenRouter
//      credentials. It injects credentials and NOTHING else — verified live
//      against ori 0.12.0+68f9a36: `ori claude` passes `--settings '<json>'`
//      carrying only `apiKeyHelper` + `env`; `ori codex` passes `-c
//      model_provider=…` key overrides (which override `config.toml` keys, a
//      different file from `hooks.json`); `ori grok` and `ori opencode` set env
//      vars only; and NONE of them redirect HOME or a config dir. Claude's
//      `--settings` MERGES (proven: a project SessionStart hook fired
//      identically with and without ori's exact blob) and opencode's
//      `OPENCODE_CONFIG_CONTENT` merges too (proven against `opencode debug
//      config`: the `plugin` array survived intact and `openrouter` was added
//      beside the pre-existing provider). So failproofai's EXISTING per-CLI
//      hooks keep enforcing under `ori <agent>`, and this integration
//      deliberately does nothing for that path.
//
//   2. ori's OWN agent — bare `ori` / `ori code`, the built-in
//      `@ori-runloop/agent-loop` harness. THAT is what this integration gates.
//
// Enforcement is via ori's PUBLISHED EXTENSION POINTS, supplied by a feature: a
// workspace package under the global workspace's `features/`, AUTO-DISCOVERED
// with no config file to register it in (like Goose's dropped plugin dir, and
// unlike OpenCode, which must be named in `opencode.json`). failproofai
// generates that feature at `~/.ori/global/features/failproofai/`. USER scope
// only — bare `ori` boots the GLOBAL workspace rather than the project's, so
// one install covers every project and there is no project-scope equivalent.
//
// Three points, each `policy: "unique"` (exactly one provider apiece, so a
// competing feature claiming one displaces us):
//
//   approval-policy       static {defaultAction, rules[]} — consulted in BOTH modes
//   approval-asker        dynamic per-call callback       — MANUAL mode only
//   unattended-approvals  dynamic per-call callback       — unattended runs
//
// **The mode caveat is the whole story for coverage** (verified live). ori's
// approval mode defaults to `self-drive`, which "approves every command without
// prompting", and in that mode the DYNAMIC points are NEVER CALLED. Proven
// three ways: no callback fired under self-drive; still none after adding
// `approval-policy` with `defaultAction:"ask"` (so `ask` degrades to
// auto-approve); but `defaultAction:"reject"` DID block every tool call — which
// proves the static point is wired and that it is specifically the dynamic
// asker self-drive skips. So failproofai's per-argument policies enforce on ori
// only under `--approvals manual` (or `/approvals` → manual in the TUI). There
// is no config key or env var to change that default: searched `config.json`,
// `ori.md` frontmatter, the `ORI_*` env surface and the shipped selfdev docs.
// `ORI_STATIC_APPROVAL_POLICY` below is what we can still enforce in the
// default mode, and it is deliberately `ask` (a no-op there) rather than
// `reject`, because claiming the point with a blanket reject would brick every
// self-drive session the moment failproofai is installed.
//
// The one thing ori does BETTER than every other integration: both dynamic
// points declare `failureBehavior: "deny"` — "a throwing, rejecting, or
// malformed provider denies the request". **ori fails closed natively**, so a
// failproofai fault blocks the call instead of waving it through. Goose and
// OpenClaw fail open today; everywhere else we built fail-closed ourselves.
//
// The verdict shape is `{outcome: "allow" | "deny"}` — binary, and NO reason
// string reaches the model, so a denial arrives as a bare tool failure.
// `instruct()` therefore degrades to allow + a stderr note. There is no Stop
// event at all, so the 5 `require-*-before-stop` builtins are INAPPLICABLE on
// ori, exactly as on Hermes and Goose.
//
// Gate payload, captured live off real tool calls (ori 0.12.0+68f9a36 driving
// nvidia/nemotron-3.5-lightning:free):
//   {tool:"bash",  arguments:[{name:"command"}],                capabilities:["execute","read","write"]}
//   {tool:"read",  arguments:[{name:"path"}],                   capabilities:["read"]}
//   {tool:"write", arguments:[{name:"path"},{name:"content"}],  capabilities:["write"]}
//   {tool:"glob",  arguments:[{name:"pattern"}],                capabilities:["read"]}
//   {tool:"grep",  arguments:[{name:"pattern"},{name:"path"}],  capabilities:["read"]}
//   {tool:"edit",  arguments:[{name:"patch"}],                  capabilities:["read","write"]}
//
// Two properties that bite:
//   • `arguments` is a flat name/value STRING array — every value arrives
//     stringified, so a policy expecting a structured tool input sees text.
//   • The gate fires TWICE per tool call: once with `escalated:false`, then
//     again with `escalated:true` plus a synthetic `{name:"escalated",
//     value:"true"}` argument. A policy must be idempotent across that ladder.
//
// `edit` is the awkward one: it carries the entire change as a single `patch`
// string in OpenAI apply_patch format (`*** Begin Patch` / `*** Update File:
// <path>` / `*** End Patch`) with NO separate path argument — so `file_path`,
// which `block-env-files`, `block-secrets-write` and every other path builtin
// reads, is simply absent and those builtins would never fire on an edit.
// `oriPatchFilePaths()` in tool-name-canonicalize.ts recovers it from the patch
// header. KNOWN GAP: a multi-file patch yields several paths and `file_path`
// holds only one, so builtins see the FIRST and a policy that would have denied
// on a later file does not fire; the full list is exposed as `ori_patch_files`
// for custom policies to read.
export const ORI_HOOK_SCOPES = ["user"] as const;
export type OriHookScope = (typeof ORI_HOOK_SCOPES)[number];

// Only PreToolUse: all three approval points gate a tool call and nothing else.
// ori has no prompt-submit, post-tool, session or stop hook we can subscribe to
// (its feature-to-feature `hooks` export is documented upstream as "consumer
// wiring and dispatch land in #1068" — i.e. not wired yet).
export const ORI_HOOK_EVENT_TYPES = ["PreToolUse"] as const;
export type OriHookEventType = (typeof ORI_HOOK_EVENT_TYPES)[number];

// ori tool ids arrive lowercase. All six below were observed at the live
// approval gate; unknown tools pass through unchanged so they still reach the
// audit, just unmatched by name-keyed builtins.
export const ORI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
};

// Keyed by the CANONICAL tool name (the handler canonicalizes the name first).
// `bash`'s `command`, `glob`/`grep`'s `pattern` and `grep`'s `path` are already
// the keys Claude builtins read, so they need no entry; `read`/`write` deliver
// the path as `path`. `Edit` is absent on purpose — its path is inside the
// patch blob, not a key, and is derived instead.
export const ORI_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
};

// Claimed so `approval-policy` is ours (it is `unique`, so leaving it unclaimed
// invites another feature to take it), but deliberately inert: `ask` is what
// self-drive already does. See the mode caveat above for why this is not
// `reject`.
export const ORI_STATIC_APPROVAL_POLICY = {
  defaultAction: "ask",
  rules: [] as const,
} as const;

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

/**
 * Events failproofai actually INSTALLS a hook for on Claude Code.
 *
 * Everything in `HOOK_EVENT_TYPES` except `WorktreeCreate`, which is not a
 * permission gate at all: Claude uses it as a worktree-PATH PROVIDER, taking
 * the stdout of the first hook that succeeds as the directory to create and
 * failing with "WorktreeCreate hook failed" when no hook supplies one. Our
 * allow path writes nothing to stdout — correctly, by the contract every other
 * event uses — so merely being registered there broke `claude --worktree` and
 * `/worktree` for every user, whatever any policy decided.
 *
 * It stays in `HOOK_EVENT_TYPES` because that list is the canonical set a
 * policy may subscribe to; this one governs what we write into settings.json.
 * No builtin matches it (all 39 match only PreToolUse / PostToolUse /
 * PermissionRequest / Stop), so nothing is lost by not registering.
 */
export const CLAUDE_INSTALL_EVENT_TYPES = HOOK_EVENT_TYPES.filter(
  (e) => e !== "WorktreeCreate",
) as readonly HookEventType[];

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
  /** Which agent CLI fired this hook (claude | codex | copilot | cursor | opencode | pi | hermes | openclaw | factory | devin | antigravity | goose | ori). Set by handler.ts from --cli. */
  cli?: IntegrationType;
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}
