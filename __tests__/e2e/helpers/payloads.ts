/**
 * Claude-accurate payload factories for E2E hook tests.
 *
 * Shapes match what Claude Code actually sends to hook processes
 * (sourced from src/hooks/handler.ts parsing logic).
 */

const SESSION_ID = "test-session-e2e-001";

/**
 * A transcript path that always exists and is readable.
 * Using /dev/null so transcript-reading policies (warn-repeated-tool-calls) skip gracefully.
 */
const TRANSCRIPT_PATH = "/dev/null";

/** ISO-8601 timestamp used by integrations that include one in stdin (Gemini). */
const TIMESTAMP = "2026-05-03T18:00:00.000Z";

export const Payloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      };
    },

    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },

    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: filePath },
      };
    },
  },

  postToolUse: {
    bash(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_result: output,
      };
    },

    read(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: filePath },
        tool_result: content,
      };
    },
  },

  stop(cwd: string, transcriptPath?: string): Record<string, unknown> {
    return {
      session_id: SESSION_ID,
      transcript_path: transcriptPath ?? TRANSCRIPT_PATH,
      cwd,
      permission_mode: "default",
      hook_event_name: "Stop",
    };
  },

  notification(message: string, cwd: string): Record<string, unknown> {
    return {
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      permission_mode: "default",
      hook_event_name: "Notification",
      message,
    };
  },
};

/**
 * Codex-accurate payload factories. Codex sends snake_case `hook_event_name`
 * (pre_tool_use, post_tool_use, …); the failproofai handler canonicalizes to
 * PascalCase for internal lookup. Otherwise the shape mirrors Claude.
 */
const CODEX_SESSION_ID = "test-session-codex-001";

export const CodexPayloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CODEX_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "pre_tool_use",
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      // Codex aliases Edit/Write → apply_patch in matchers, so policies that
      // filter on toolNames: ["Write"] continue to fire for Codex.
      return {
        session_id: CODEX_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "pre_tool_use",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
  },
  postToolUse: {
    bash(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CODEX_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "post_tool_use",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: output,
      };
    },
  },
  permissionRequest: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CODEX_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "permission_request",
        tool_name: "Bash",
        tool_input: { command, description: "Run shell command outside sandbox" },
      };
    },
  },
  stop(cwd: string): Record<string, unknown> {
    return {
      session_id: CODEX_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "stop",
    };
  },
  userPromptSubmit(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: CODEX_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "user_prompt_submit",
      prompt,
    };
  },
};

/**
 * Cursor Agent CLI-accurate payload factories. Cursor delivers camelCase
 * `hook_event_name` (`preToolUse`, `beforeSubmitPrompt`, …) plus snake_case
 * fields. The failproofai handler canonicalizes camelCase → PascalCase via
 * CURSOR_EVENT_MAP for internal lookup. Ref: https://cursor.com/docs/hooks
 * (Stdin Payload Schema).
 *
 * Per-event cwd shape (verified against the docs as of 2026-05-07):
 *   • preToolUse / postToolUse: top-level `cwd` is sent. `workspace_roots`
 *     is also a common base field on every Cursor hook payload, so we
 *     include both for fidelity.
 *   • beforeSubmitPrompt / sessionStart / sessionEnd / stop: NO top-level
 *     `cwd`. `workspace_roots: string[]` is the only directory signal.
 *     The handler resolves cwd via resolveCwd() with a Cursor-specific
 *     workspace_roots[0] fallback (src/hooks/resolve-cwd.ts).
 */
const CURSOR_SESSION_ID = "test-session-cursor-001";
const CURSOR_CONVERSATION_ID = "test-conversation-cursor-001";

export const CursorPayloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        conversation_id: CURSOR_CONVERSATION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        workspace_roots: [cwd],
        hook_event_name: "preToolUse",
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        conversation_id: CURSOR_CONVERSATION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        workspace_roots: [cwd],
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        conversation_id: CURSOR_CONVERSATION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        workspace_roots: [cwd],
        hook_event_name: "preToolUse",
        tool_name: "Read",
        tool_input: { file_path: filePath },
      };
    },
  },
  postToolUse: {
    bash(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        conversation_id: CURSOR_CONVERSATION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        workspace_roots: [cwd],
        hook_event_name: "postToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_output: output,
      };
    },
  },
  beforeSubmitPrompt(prompt: string, cwd: string): Record<string, unknown> {
    return {
      conversation_id: CURSOR_CONVERSATION_ID,
      transcript_path: TRANSCRIPT_PATH,
      workspace_roots: [cwd],
      hook_event_name: "beforeSubmitPrompt",
      prompt,
    };
  },
  sessionStart(cwd: string): Record<string, unknown> {
    return {
      session_id: CURSOR_SESSION_ID,
      conversation_id: CURSOR_CONVERSATION_ID,
      transcript_path: TRANSCRIPT_PATH,
      workspace_roots: [cwd],
      hook_event_name: "sessionStart",
    };
  },
  sessionEnd(cwd: string): Record<string, unknown> {
    return {
      session_id: CURSOR_SESSION_ID,
      conversation_id: CURSOR_CONVERSATION_ID,
      transcript_path: TRANSCRIPT_PATH,
      workspace_roots: [cwd],
      hook_event_name: "sessionEnd",
      reason: "user_exit",
    };
  },
  stop(cwd: string): Record<string, unknown> {
    return {
      conversation_id: CURSOR_CONVERSATION_ID,
      transcript_path: TRANSCRIPT_PATH,
      workspace_roots: [cwd],
      hook_event_name: "stop",
    };
  },
  subagentStop(cwd: string): Record<string, unknown> {
    return {
      conversation_id: CURSOR_CONVERSATION_ID,
      transcript_path: TRANSCRIPT_PATH,
      workspace_roots: [cwd],
      hook_event_name: "subagentStop",
    };
  },
};

/**
 * Copilot CLI-accurate payload factories. Copilot hooks are installed in
 * "VS Code compatible" PascalCase mode, so EVENT names arrive PascalCase plus
 * snake_case wrapper fields (`tool_name`, `tool_input`, `cwd`). Copilot's
 * tool registry, however, uses LOWERCASE IDs (`bash`, `read`, `write`, …) —
 * confirmed by the session-log shape at `lib/copilot-sessions.ts:257` and the
 * test fixture at `__tests__/lib/copilot-sessions.test.ts:87`. The handler's
 * canonicalizeToolName(cli="copilot") maps these to Claude PascalCase before
 * policy evaluation (see src/hooks/types.ts:COPILOT_TOOL_MAP).
 */
const COPILOT_SESSION_ID = "test-session-copilot-001";

export const CopilotPayloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "write",
        tool_input: { file_path: filePath, content },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "read",
        tool_input: { file_path: filePath },
      };
    },
    // Copilot's `view` reads files OR lists directory contents depending on
    // whether `path` resolves to a file or a dir — verified empirically
    // against Copilot CLI 1.0.39 (`{"toolName":"view","arguments":{"path":"/some/dir"}}`).
    // Canonicalizes to `Read`; the block-read-outside-cwd policy reads
    // tool_input.path as a fallback to file_path so directory listings get
    // covered by the same path check.
    view(path: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "view",
        tool_input: { path },
      };
    },
  },
  postToolUse: {
    bash(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "bash",
        tool_input: { command },
        tool_response: output,
      };
    },
  },
  userPromptSubmit(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: COPILOT_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt,
    };
  },
  stop(cwd: string): Record<string, unknown> {
    return {
      session_id: COPILOT_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "Stop",
    };
  },
};

/**
 * OpenCode payload factories — for the e2e harness, which invokes the
 * failproofai binary directly with `--cli opencode`. The plugin shim
 * (`.opencode/plugins/failproofai.mjs`) is what translates plugin events
 * into Claude-shape JSON before invoking the binary, so the binary itself
 * sees Claude-shape PascalCase events. These factories therefore produce
 * Claude-shape payloads. The shim's plugin-side translation is exercised
 * separately in `__tests__/hooks/opencode-plugin-shim.test.ts`.
 */
const OPENCODE_SESSION_ID = "ses_test_opencode001";

export const OpenCodePayloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: OPENCODE_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: OPENCODE_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
    edit(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: OPENCODE_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: "x", new_string: "y" },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: OPENCODE_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: filePath },
      };
    },
  },
  postToolUse: {
    bash(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: OPENCODE_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: output,
      };
    },
  },
  userPromptSubmit(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: OPENCODE_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt,
    };
  },
  sessionStart(cwd: string): Record<string, unknown> {
    return {
      session_id: OPENCODE_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "SessionStart",
    };
  },
  stop(cwd: string): Record<string, unknown> {
    return {
      session_id: OPENCODE_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "Stop",
    };
  },
};

/**
 * Pi (pi-coding-agent) payload factories. The on-disk shape we forward to
 * `failproofai --hook ... --cli pi` is the same as Claude's stdin shape
 * (snake_case `tool_name`, `tool_input`, …) — the pi-extension shim does
 * the camelCase-to-snake_case translation before spawning failproofai.
 *
 * These payload factories reproduce what the shim writes, NOT what Pi
 * itself emits, because the e2e tests run against the bare failproofai
 * binary and don't go through the shim. The hook_event_name is the Pi-side
 * underscore_lower_snake_case form (`tool_call`, `user_bash`, `input`,
 * `session_start`); the handler canonicalizes to PascalCase via PI_EVENT_MAP.
 */
const PI_SESSION_ID = "test-session-pi-001";

export const PiPayloads = {
  toolCall: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: PI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: PI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: PI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: filePath },
      };
    },
  },
  userBash(command: string, cwd: string): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    };
  },
  input(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt,
    };
  },
  sessionStart(cwd: string): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "SessionStart",
    };
  },
  sessionShutdown(cwd: string, reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit"): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      reason,
      hook_event_name: "SessionEnd",
    };
  },
  toolResult(toolName: string, toolInput: Record<string, unknown>, content: unknown[], cwd: string, isError = false): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { content, isError },
    };
  },
  agentEnd(cwd: string): Record<string, unknown> {
    return {
      session_id: PI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "Stop",
    };
  },
};

const GEMINI_SESSION_ID = "g1234567-9abc-7def-0123-456789abcdef";

/**
 * Gemini CLI hook payload shapes.
 *
 * Gemini sends Claude-shape stdin: snake_case fields (`session_id`,
 * `tool_name`, `tool_input`, `hook_event_name`, `cwd`, `transcript_path`)
 * plus `timestamp`. Tool names are snake_case (`run_shell_command`,
 * `read_file`, `write_file`, `replace`, etc.) — the binary canonicalizes
 * these to PascalCase via GEMINI_TOOL_MAP before policy lookup.
 *
 * Per https://geminicli.com/docs/hooks/ as of 2026-04-13.
 */
export const GeminiPayloads = {
  beforeTool: {
    runShellCommand(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "BeforeTool",
        timestamp: TIMESTAMP,
        tool_name: "run_shell_command",
        tool_input: { command },
      };
    },
    readFile(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "BeforeTool",
        timestamp: TIMESTAMP,
        tool_name: "read_file",
        tool_input: { file_path: filePath },
      };
    },
    writeFile(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "BeforeTool",
        timestamp: TIMESTAMP,
        tool_name: "write_file",
        tool_input: { file_path: filePath, content },
      };
    },
    replace(filePath: string, oldStr: string, newStr: string, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "BeforeTool",
        timestamp: TIMESTAMP,
        tool_name: "replace",
        tool_input: { file_path: filePath, old_string: oldStr, new_string: newStr },
      };
    },
    mcpExtension(toolName: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "BeforeTool",
        timestamp: TIMESTAMP,
        tool_name: toolName,
        tool_input: input,
      };
    },
  },
  afterTool: {
    runShellCommand(command: string, output: string, cwd: string): Record<string, unknown> {
      return {
        session_id: GEMINI_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "AfterTool",
        timestamp: TIMESTAMP,
        tool_name: "run_shell_command",
        tool_input: { command },
        tool_response: { llmContent: output, returnDisplay: output },
      };
    },
  },
  beforeAgent(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "BeforeAgent",
      timestamp: TIMESTAMP,
      prompt,
    };
  },
  afterAgent(prompt: string, response: string, cwd: string): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "AfterAgent",
      timestamp: TIMESTAMP,
      prompt,
      prompt_response: response,
      stop_hook_active: false,
    };
  },
  sessionStart(cwd: string, source: "startup" | "resume" | "clear" = "startup"): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "SessionStart",
      timestamp: TIMESTAMP,
      source,
    };
  },
  sessionEnd(cwd: string, reason: "exit" | "clear" | "logout" | "prompt_input_exit" | "other" = "exit"): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "SessionEnd",
      timestamp: TIMESTAMP,
      reason,
    };
  },
  beforeModel(cwd: string): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "BeforeModel",
      timestamp: TIMESTAMP,
      llm_request: { model: "gemini-pro", messages: [] },
    };
  },
  preCompress(cwd: string): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "PreCompress",
      timestamp: TIMESTAMP,
      trigger: "auto",
    };
  },
  notification(cwd: string, message = "test"): Record<string, unknown> {
    return {
      session_id: GEMINI_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "Notification",
      timestamp: TIMESTAMP,
      notification_type: "ToolPermission",
      message,
      details: {},
    };
  },
};
