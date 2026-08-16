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

/**
 * True when `parsed` carries grok's camelCase envelope.
 *
 * This exists because grok EXECUTES OTHER CLIS' HOOK CONFIGS. Its discovery
 * scans `~/.claude/settings.json`, `~/.claude/settings.local.json`,
 * `<cwd>/.claude/settings.json` and the `.cursor` equivalents by default
 * (`[compat.claude] hooks = true`) — and `<cwd>/.claude/settings.json` is
 * exactly the file `policies --install --cli claude --scope project` writes. So
 * on any machine with both tools, grok runs OUR hooks and hands them `--cli
 * claude` on the command line while piping ITS OWN camelCase payload.
 *
 * Verified live against grok 1.0.3: the hook fired, `tool_name` and
 * `tool_input` were both undefined, and every builtin that reads either —
 * block-sudo, block-env-files, block-secrets-write, block-force-push — allowed.
 * Installed, running, costing latency, enforcing nothing; strictly worse than
 * no coverage, because the install reports success. Detecting the envelope lets
 * handler.ts re-route the event onto grok's path (tool maps AND response
 * shapes — grok ignores Claude's `hookSpecificOutput.permissionDecision`, also
 * verified by A/B).
 *
 * The test is on the PAYLOAD, never on an env var: `GROK_HOOK_EVENT` is set by
 * grok's runner but is still just an env var, and mistaking a real Claude event
 * for a grok one would break Claude's own enforcement. `workspaceRoot` +
 * `hookEventName` with no `hook_event_name` is a shape Claude never sends.
 */
export function isGrokEnvelope(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.hookEventName === "string" &&
    typeof parsed.workspaceRoot === "string" &&
    parsed.hook_event_name === undefined
  );
}

/**
 * The CLI whose contract actually governs this event.
 *
 * Identical to the declared `--cli` for every integration except the grok
 * cross-execution case above, where the flag says `claude` and the wire says
 * grok. Returning "grok" there routes the rest of the pipeline — tool-name and
 * tool-input canonicalization, and the response shape policy-evaluator emits —
 * onto the contract that will actually be honored.
 */
export function resolveEffectiveCli(
  cli: IntegrationType,
  parsed: Record<string, unknown>,
): IntegrationType {
  if (cli === "claude" && isGrokEnvelope(parsed)) return "grok";
  return cli;
}

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

  // grok pipes a camelCase envelope (verified live against grok 1.0.3 with a
  // recorder hook on all 14 events). Normalize the fields the handler reads to
  // snake_case BEFORE any canonicalization runs. Note `workspaceRoot` → `cwd`:
  // grok sends BOTH, they were identical in every capture, and `cwd` is what
  // resolveCwd + block-read-outside-cwd need. `toolResult` is grok's PostToolUse
  // output key — it is NOT Claude's `tool_response`, so a sanitize policy
  // reading the documented Claude key would see nothing without this line.
  // `hookEventName` is deliberately NOT mapped: its value is snake_case
  // ("pre_tool_use") whereas the canonical set is PascalCase, and the `--hook`
  // arg already carries the PascalCase name.
  if (cli === "grok") {
    if (typeof parsed.toolName === "string") parsed.tool_name = parsed.toolName;
    if (parsed.toolInput !== undefined) parsed.tool_input = parsed.toolInput;
    if (parsed.toolResult !== undefined && parsed.tool_response === undefined) {
      parsed.tool_response = parsed.toolResult;
    }
    if (typeof parsed.sessionId === "string") parsed.session_id = parsed.sessionId;
    if (typeof parsed.transcriptPath === "string") parsed.transcript_path = parsed.transcriptPath;
    if (typeof parsed.workspaceRoot === "string" && parsed.cwd === undefined) {
      parsed.cwd = parsed.workspaceRoot;
    }
    if (typeof parsed.permissionMode === "string") parsed.permission_mode = parsed.permissionMode;
    if (typeof parsed.stopHookActive === "boolean") {
      parsed.stop_hook_active = parsed.stopHookActive;
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
