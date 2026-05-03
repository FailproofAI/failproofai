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
 * fields (`tool_name`, `tool_input`, `cwd`). The failproofai handler
 * canonicalizes camelCase → PascalCase via CURSOR_EVENT_MAP for internal
 * lookup. Ref: https://cursor.com/docs/hooks (Stdin Payload Schema).
 */
const CURSOR_SESSION_ID = "test-session-cursor-001";

export const CursorPayloads = {
  preToolUse: {
    bash(command: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "preToolUse",
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: CURSOR_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
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
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "postToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_output: output,
      };
    },
  },
  beforeSubmitPrompt(prompt: string, cwd: string): Record<string, unknown> {
    return {
      session_id: CURSOR_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "beforeSubmitPrompt",
      prompt,
    };
  },
  stop(cwd: string): Record<string, unknown> {
    return {
      session_id: CURSOR_SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd,
      hook_event_name: "stop",
    };
  },
};

/**
 * Copilot CLI-accurate payload factories. We install Copilot hooks in
 * "VS Code compatible" PascalCase mode, so Copilot delivers PascalCase
 * `hook_event_name` plus snake_case fields (the same shape Claude uses).
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
        tool_name: "Bash",
        tool_input: { command },
      };
    },
    write(filePath: string, content: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      };
    },
    read(filePath: string, cwd: string): Record<string, unknown> {
      return {
        session_id: COPILOT_SESSION_ID,
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
        session_id: COPILOT_SESSION_ID,
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
