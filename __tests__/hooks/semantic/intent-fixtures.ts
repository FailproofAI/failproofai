/**
 * Fixtures for intent capture (T4).
 *
 * Each payload is what the harness writes on the hook's stdin (or what our
 * shim for it forwards), before `normalizeCliPayload`. Each transcript mirrors
 * the line shapes observed in real files from the named harness version:
 * the keys, nesting and discriminators are real, every value is invented.
 */

export const SID = {
  claude: "0f8e7c1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  codex: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
  copilot: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
  cursor: "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a",
  opencode: "ses_4f3e2d1c0b9a8f7e6d5c4b3a2",
  pi: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  openclaw: "7e6d5c4b-3a2f-4e1d-8c9b-0a1f2e3d4c5b",
  factory: "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d",
  devin: "orchid-pillow-4711",
  antigravity: "6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c",
  goose: "20260922_7",
} as const;

// ── Stdin payloads, one per harness ─────────────────────────────────────────

/** Claude Code 2.1.x `UserPromptSubmit`. */
export const claudePrompt = (prompt: string, transcriptPath: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID.claude,
  transcript_path: transcriptPath,
  cwd: "/work/app",
  prompt_id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  permission_mode: "default",
  agent_type: "general-purpose",
  hook_event_name: "UserPromptSubmit",
  prompt,
  session_title: "fix login flow",
  ...extra,
});

/** Codex 0.154 `UserPromptSubmit` (installed as `--hook user_prompt_submit`). */
export const codexPrompt = (prompt: string, transcriptPath: string) => ({
  session_id: SID.codex,
  turn_id: "019a2b3c-9999-7000-8000-000000000001",
  transcript_path: transcriptPath,
  cwd: "/work/app",
  hook_event_name: "UserPromptSubmit",
  model: "gpt-5.5-codex",
  permission_mode: "default",
  prompt,
});

/** Copilot CLI 1.0.8x, "VS Code compatible" PascalCase `UserPromptSubmit`. */
export const copilotPrompt = (prompt: string) => ({
  session_id: SID.copilot,
  cwd: "/work/app",
  hook_event_name: "UserPromptSubmit",
  timestamp: 1_790_000_000_000,
  prompt,
});

/** cursor-agent 2026.08 `beforeSubmitPrompt` (session_id = conversation_id). */
export const cursorPrompt = (prompt: string, transcriptPath: string) => ({
  conversation_id: SID.cursor,
  generation_id: "gen-0a1b2c3d",
  model: "claude-4.6-sonnet",
  prompt,
  attachments: [],
  composer_mode: "agent",
  session_id: SID.cursor,
  hook_event_name: "beforeSubmitPrompt",
  cursor_version: "2026.08.25-3e8eec8",
  workspace_roots: ["/work/app"],
  user_email: null,
  transcript_path: transcriptPath,
});

/** What our OpenCode plugin shim forwards for `message.updated` (role user). */
export const opencodePrompt = (prompt: string) => ({
  session_id: SID.opencode,
  cwd: "/work/app",
  hook_event_name: "UserPromptSubmit",
  prompt,
});

/** What pi-extension forwards for Pi's `input` event. */
export const piPrompt = (prompt: string, extra: Record<string, unknown> = {}) => ({
  prompt,
  session_id: SID.pi,
  cwd: "/work/app",
  hook_event_name: "UserPromptSubmit",
  ...extra,
});

/** Hermes' native plugin forwards no prompt event; its tool gate looks like this. */
export const hermesToolCall = () => ({
  session_id: "20260922_101500_a1b2c3",
  cwd: "/work/app",
  hook_event_name: "pre_tool_call",
  tool_name: "terminal",
  tool_input: { command: "git status" },
  // A Hermes payload carries the chat text nowhere a policy reads it.
  prompt: "please force push",
});

/** What openclaw-plugin forwards for `before_agent_run`, optionally with the run's origin. */
export const openclawPrompt = (prompt: string, origin: Record<string, unknown> = {}) => ({
  session_id: SID.openclaw,
  cwd: "/work/app",
  transcript_path: undefined as string | undefined,
  stop_hook_active: false,
  openclaw: {
    agentId: "main",
    sessionKey: "agent:main:telegram:dm:42",
    runId: "run-0001",
    provider: "anthropic",
    model: "claude-opus-5",
    ...origin,
  },
  prompt,
  hook_event_name: "before_agent_run",
});

/** droid 0.175 `UserPromptSubmit` (executeUserPromptSubmitHooks). */
export const factoryPrompt = (prompt: string, transcriptPath: string) => ({
  session_id: SID.factory,
  transcript_path: transcriptPath,
  cwd: "/work/app",
  permission_mode: "auto-medium",
  hook_event_name: "UserPromptSubmit",
  message_id: "msg-0001",
  prompt,
  has_images: false,
});

/** devin 3000.x `UserPromptSubmit` (Claude-clone payload). */
export const devinPrompt = (prompt: string) => ({
  session_id: SID.devin,
  transcript_path: "",
  cwd: "/work/app",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt,
});

/** agy 1.1.x `PreInvocation`: camelCase protojson, and no prompt text at all. */
export const antigravityPreInvocation = (transcriptPath: string) => ({
  conversationId: SID.antigravity,
  workspacePaths: ["/work/app"],
  transcriptPath,
  modelName: "auto",
  invocationNum: 3,
  initialNumSteps: 10,
});

/** goose 1.43 `UserPromptSubmit`: the text is in `message` (and `matcher_context`). */
export const goosePrompt = (prompt: string) => ({
  event: "UserPromptSubmit",
  session_id: SID.goose,
  matcher_context: prompt,
  message: prompt,
  working_dir: "/work/app",
});

// ── Transcripts ─────────────────────────────────────────────────────────────

const claudeCommon = (uuid: string, parentUuid: string | null) => ({
  parentUuid,
  isSidechain: false,
  uuid,
  timestamp: "2026-09-22T09:14:03.120Z",
  userType: "external",
  entrypoint: "cli",
  cwd: "/work/app",
  sessionId: SID.claude,
  version: "2.1.278",
  gitBranch: "feature/login",
});

const claudeAssistant = (
  uuid: string,
  parent: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  model = "claude-opus-5",
) => ({
  ...claudeCommon(uuid, parent),
  message: {
    model,
    id: `msg_${uuid}`,
    type: "message",
    role: "assistant",
    content,
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 4096, output_tokens: 88 },
  },
  requestId: `req_${uuid}`,
  type: "assistant",
  ...extra,
});

export const CLAUDE_AGENT_QUESTION =
  "I found two stale branches, feature/old-auth and feature/tmp. Delete both and force-push feature/login so the rebase lands?";

/** Claude Code 2.1.278 session JSONL, ending mid-way through the next turn. */
export const claudeTranscript = (): unknown[] => [
  { type: "permission-mode", permissionMode: "default", sessionId: SID.claude },
  {
    ...claudeCommon("u1", null),
    promptId: "p1",
    type: "user",
    message: { role: "user", content: "rebase feature/login onto main" },
    permissionMode: "default",
    origin: { kind: "human" },
    promptSource: "typed",
  },
  {
    ...claudeCommon("a0", "u1"),
    attachment: { type: "date", date: "2026-09-22" },
    type: "attachment",
    rendered: [{ content: "Today is 2026-09-22." }],
  },
  claudeAssistant("a1", "u1", [{ type: "thinking", thinking: "Check branches first.", signature: "sig" }]),
  claudeAssistant("a2", "a1", [
    { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "git branch -a", description: "List branches" }, caller: { type: "direct" } },
  ]),
  {
    ...claudeCommon("u2", "a2"),
    promptId: "p1",
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "* feature/login\n  main", is_error: false }] },
    toolUseResult: { stdout: "* feature/login\n  main", stderr: "", interrupted: false, isImage: false },
    sourceToolAssistantUUID: "a2",
  },
  claudeAssistant("a3", "u2", [{ type: "text", text: CLAUDE_AGENT_QUESTION }]),
  { ...claudeCommon("s1", "a3"), type: "system", subtype: "turn_duration", durationMs: 8120, messageCount: 6, isMeta: false },
  // Written by Claude Code, not by the model: must never be taken as the agent's message.
  claudeAssistant("a4", "a3", [{ type: "text", text: "No response requested." }], {}, "<synthetic>"),
  { ...claudeAssistant("a5", "a4", [{ type: "text", text: "API Error: 529 overloaded" }]), isApiErrorMessage: true },
  { ...claudeAssistant("a6", "a5", [{ type: "text", text: "Subagent finished scanning." }]), isSidechain: true },
  { type: "last-prompt", lastPrompt: "rebase feature/login onto main", leafUuid: "a6", sessionId: SID.claude },
  { type: "ai-title", aiTitle: "Rebase login branch", sessionId: SID.claude },
];

// ── Claude Code: prompts the model scheduled (2.1.278) ──────────────────────

/**
 * The model scheduling a prompt for itself: the tool call, its result, and
 * the model's closing words. `CronCreate` takes `{cron, prompt, recurring}`
 * and `ScheduleWakeup` `{delaySeconds, reason, prompt}`.
 */
export const claudeScheduleCall = (
  uuid: string,
  parent: string,
  tool: "CronCreate" | "ScheduleWakeup",
  prompt: string,
): unknown[] => [
  claudeAssistant(`${uuid}-call`, parent, [
    {
      type: "tool_use",
      id: `toolu_${uuid}`,
      name: tool,
      input: tool === "CronCreate" ? { cron: "*/5 * * * *", prompt, recurring: true } : { delaySeconds: 600, reason: "wait for CI", prompt },
      caller: { type: "direct" },
    },
  ]),
  {
    ...claudeCommon(`${uuid}-result`, `${uuid}-call`),
    promptId: "p1",
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${uuid}`, type: "tool_result", content: `Scheduled ${tool === "CronCreate" ? "job a1b2c3d4" : "a wakeup in 600s"}.` }] },
    sourceToolAssistantUUID: `${uuid}-call`,
  },
  claudeAssistant(`${uuid}-done`, `${uuid}-result`, [{ type: "text", text: "Scheduled. I'll check back." }]),
  { ...claudeCommon(`${uuid}-turn`, `${uuid}-done`), type: "system", subtype: "turn_duration", durationMs: 4200, messageCount: 4, isMeta: false },
];

/**
 * What Claude Code's `useScheduledTasks` appends when a task fires, just
 * before it submits the task's prompt (`g2t` in 2.1.278): the prompt with
 * control characters removed and whitespace collapsed, cut to 200 characters.
 */
export const claudeScheduledFire = (uuid: string, parent: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  ...claudeCommon(uuid, parent),
  type: "system",
  subtype: "scheduled_task_fire",
  content: "Running scheduled task (Sep 22, 9:20 AM)",
  isMeta: false,
  taskId: "a1b2c3d4",
  cron: "*/5 * * * *",
  prompt: prompt.replace(/\s+/g, " ").trim().slice(0, 200),
  ...extra,
});

/** The user entry Claude Code writes for a scheduled prompt once it has been submitted. */
export const claudeScheduledTurn = (uuid: string, parent: string, prompt: string) => ({
  ...claudeCommon(uuid, parent),
  promptId: `p-${uuid}`,
  type: "user",
  message: { role: "user", content: prompt },
  isMeta: true,
  scheduledTaskId: "a1b2c3d4",
  scheduledFireId: uuid,
});

/** A plain assistant text entry, for building transcripts around the above. */
export const claudeSays = (uuid: string, parent: string, text: string) => claudeAssistant(uuid, parent, [{ type: "text", text }]);

/** A human's typed prompt, as Claude Code writes it once submitted. */
export const claudeTyped = (uuid: string, parent: string, text: string) => ({
  ...claudeCommon(uuid, parent),
  promptId: `p-${uuid}`,
  type: "user",
  message: { role: "user", content: text },
  permissionMode: "default",
  origin: { kind: "human" },
  promptSource: "typed",
});

export const CODEX_AGENT_QUESTION = "The dev database has 3 stale migrations. Shall I drop it and re-run them from scratch?";

/** Codex 0.153 rollout: agent text as `event_msg` `agent_message`. */
export const codexRollout0153 = (source: unknown = "cli"): unknown[] => [
  {
    timestamp: "2026-09-20T11:02:00.000Z",
    type: "session_meta",
    payload: {
      id: SID.codex,
      timestamp: "2026-09-20T11:02:00.000Z",
      cwd: "/work/app",
      originator: "codex_cli_rs",
      cli_version: "0.153.4",
      source,
      model_provider: "openai",
    },
  },
  { timestamp: "2026-09-20T11:02:01.000Z", type: "event_msg", payload: { type: "task_started", model_context_window: 272000 } },
  {
    timestamp: "2026-09-20T11:02:01.100Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky migration test" }] },
  },
  {
    timestamp: "2026-09-20T11:02:01.100Z",
    type: "event_msg",
    payload: { type: "user_message", message: "fix the flaky migration test", images: [], local_images: [], text_elements: [] },
  },
  {
    timestamp: "2026-09-20T11:02:09.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: CODEX_AGENT_QUESTION }], phase: "final_answer" },
  },
  {
    timestamp: "2026-09-20T11:02:09.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: CODEX_AGENT_QUESTION, phase: "final_answer", memory_citation: null },
  },
  { timestamp: "2026-09-20T11:02:09.100Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {} } },
  {
    timestamp: "2026-09-20T11:02:09.200Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t1", last_agent_message: CODEX_AGENT_QUESTION },
  },
];

/** Codex 0.154 rollout: agent text as `item_completed` `AgentMessage` items. */
export const codexRollout0154 = (): unknown[] => [
  {
    timestamp: "2026-09-22T08:00:00.000Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: SID.codex,
      id: SID.codex,
      timestamp: "2026-09-22T08:00:00.000Z",
      cwd: "/work/app",
      originator: "codex-tui",
      cli_version: "0.154.0",
      source: "cli",
      thread_source: "user",
      model_provider: "openai",
    },
  },
  { timestamp: "2026-09-22T08:00:00.100Z", ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "t1", started_at: 1 } },
  { timestamp: "2026-09-22T08:00:00.200Z", ordinal: 2, type: "turn_context", payload: { turn_id: "t1", cwd: "/work/app", model: "gpt-5.5-codex" } },
  {
    timestamp: "2026-09-22T08:00:00.300Z",
    ordinal: 3,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: SID.codex,
      turn_id: "t1",
      item: { type: "UserMessage", id: "i1", client_id: "c1", content: [{ type: "text", text: "clean up the dev db", text_elements: [] }] },
    },
  },
  {
    timestamp: "2026-09-22T08:00:04.000Z",
    ordinal: 4,
    type: "response_item",
    payload: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Looking at the schema first." }], phase: "commentary" },
  },
  {
    timestamp: "2026-09-22T08:00:04.000Z",
    ordinal: 5,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: SID.codex,
      turn_id: "t1",
      item: { type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "Looking at the schema first." }], phase: "commentary" },
    },
  },
  {
    timestamp: "2026-09-22T08:00:09.000Z",
    ordinal: 6,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: SID.codex,
      turn_id: "t1",
      item: { type: "AgentMessage", id: "m2", content: [{ type: "Text", text: CODEX_AGENT_QUESTION }], phase: "final_answer" },
    },
  },
  { timestamp: "2026-09-22T08:00:09.100Z", ordinal: 7, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {} } },
  { timestamp: "2026-09-22T08:00:09.200Z", ordinal: 8, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: null } },
];

/** A Codex sub-agent thread: `SessionSource::SubAgent` serializes as an object. */
export const codexSubagentRollout = (): unknown[] =>
  codexRollout0153({ subagent: { thread_spawn: { parent_thread_id: "019a0000-0000-7000-8000-000000000000", depth: 1 } } });

export const CURSOR_AGENT_QUESTION = "Both .env files differ only in DATABASE_URL. Want me to delete .env.local?";

/** cursor-agent `agent-transcripts/<id>/<id>.jsonl`. */
export const cursorTranscript = (): unknown[] => [
  { role: "user", message: { content: [{ type: "text", text: "<timestamp>2026-09-22 10:00</timestamp>\n<user_query>tidy the env files</user_query>" }] } },
  { role: "assistant", message: { content: [{ type: "text", text: CURSOR_AGENT_QUESTION }] } },
  { type: "turn_end", status: "completed" },
];

export const COPILOT_AGENT_QUESTION = "The release branch is behind by 4 commits. Should I reset it hard to origin?";

/** Copilot CLI `~/.copilot/session-state/<id>/events.jsonl`. */
export const copilotEvents = (): unknown[] => [
  { type: "session.start", data: { sessionId: SID.copilot, version: 1, producer: "copilot-agent", copilotVersion: "1.0.83", startTime: "2026-09-22T10:00:00Z", context: { cwd: "/work/app" } }, id: "e1", timestamp: "2026-09-22T10:00:00Z", parentId: null },
  { type: "user.message", data: { content: "sync the release branch", transformedContent: "sync the release branch", attachments: [], interactionId: "x1" }, id: "e2", timestamp: "2026-09-22T10:00:01Z", parentId: "e1" },
  { type: "assistant.turn_start", data: { turnId: "t1", interactionId: "x1" }, id: "e3", timestamp: "2026-09-22T10:00:02Z", parentId: "e2" },
  { type: "assistant.message", data: { messageId: "m1", model: "gpt-5.5", content: COPILOT_AGENT_QUESTION, toolRequests: [], interactionId: "x1", turnId: "t1", phase: "final" }, id: "e4", timestamp: "2026-09-22T10:00:05Z", parentId: "e3" },
  { type: "assistant.turn_end", data: { turnId: "t1" }, id: "e5", timestamp: "2026-09-22T10:00:05Z", parentId: "e4" },
];

export const PI_AGENT_QUESTION = "Tests pass locally. Publish 2.4.0 to npm now?";

/** Pi 0.85 session JSONL (OpenClaw's legacy JSONL has the same message shape). */
export const piSession = (): unknown[] => [
  { type: "session", version: 3, id: SID.pi, timestamp: "2026-09-22T10:00:00Z", cwd: "/work/app" },
  { type: "model_change", id: "c1", parentId: null, timestamp: "2026-09-22T10:00:00Z", provider: "anthropic", modelId: "claude-opus-5" },
  { type: "message", id: "m1", parentId: "c1", timestamp: "2026-09-22T10:00:01Z", message: { role: "user", content: [{ type: "text", text: "prepare the 2.4.0 release" }], timestamp: 1 } },
  { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-22T10:00:03Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5" } },
  { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-22T10:00:09Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "42 passing" }], details: {}, isError: false, timestamp: 2 } },
  { type: "message", id: "m4", parentId: "m3", timestamp: "2026-09-22T10:00:10Z", message: { role: "assistant", content: [{ type: "text", text: PI_AGENT_QUESTION, textSignature: "s" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5" } },
];

export const FACTORY_AGENT_QUESTION = "I can drop the orphaned `sessions_old` table. Go ahead?";

/** droid session JSONL (`~/.factory/sessions/<encoded-cwd>/<id>.jsonl`). */
export const factorySession = (): unknown[] => [
  { type: "session_start", id: SID.factory, title: "db cleanup", owner: "dev", version: 2, cwd: "/work/app" },
  { type: "message", id: "m1", timestamp: "2026-09-22T10:00:01Z", message: { role: "user", content: [{ type: "text", text: "clean up old tables" }], visibility: "both" } },
  { type: "message", id: "m2", timestamp: "2026-09-22T10:00:07Z", message: { role: "assistant", content: [{ type: "text", text: FACTORY_AGENT_QUESTION }], visibility: "both" } },
];

/**
 * A droid session whose agent made a tool call carrying a `prompt` input. The
 * `tool_use` block is droid's own shape; the `Task` input keys are illustrative.
 */
export const factorySessionWithToolPrompt = (prompt: string): unknown[] => [
  ...factorySession(),
  {
    type: "message",
    id: "m3",
    timestamp: "2026-09-22T10:00:09Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_0a1b2c3d4e5f", name: "Task", input: { subagent_type: "worker", description: "follow-up", prompt } }],
      visibility: "both",
    },
  },
];

export const toJsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
