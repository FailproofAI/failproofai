// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleHookEvent } from "../../src/hooks/handler";

vi.mock("../../src/hooks/hooks-config", () => ({
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: ["block-sudo"] })),
}));

vi.mock("../../src/hooks/builtin-policies", () => ({
  registerBuiltinPolicies: vi.fn(),
}));

vi.mock("../../src/hooks/policy-evaluator", () => ({
  evaluatePolicies: vi.fn(() => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    policyName: null,
    reason: null,
    decision: "allow",
  })),
}));

vi.mock("../../src/hooks/policy-registry", () => ({
  clearPolicies: vi.fn(),
  registerPolicy: vi.fn(),
}));

vi.mock("../../src/hooks/custom-hooks-loader", () => ({
  loadAllCustomHooks: vi.fn(() => Promise.resolve({ hooks: [], conventionSources: [] })),
}));

vi.mock("../../src/hooks/hook-activity-store", () => ({
  persistHookActivity: vi.fn(),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/telemetry-id", () => ({
  getInstanceId: vi.fn(() => "test-instance-id"),
}));

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogInfo: vi.fn(),
  hookLogWarn: vi.fn(),
  hookLogError: vi.fn(),
}));

describe("hooks/handler", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const originalStdin = process.stdin;

  function mockStdin(payload?: string): void {
    Object.defineProperty(process, "stdin", {
      value: {
        setEncoding: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn((event: string, cb: (data?: string) => void) => {
          if (event === "data" && payload) cb(payload);
          if (event === "end") cb();
        }),
        readableEnded: !payload,
      },
      writable: true,
      configurable: true,
    });
  }

  function restoreStdin(): void {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStdin();
  });

  it("returns exit code from policy evaluation", async () => {
    mockStdin();
    const exitCode = await handleHookEvent("PreToolUse");
    expect(exitCode).toBe(0);
  });

  it("returns number (not void)", async () => {
    mockStdin();
    const result = await handleHookEvent("SessionStart");
    expect(typeof result).toBe("number");
  });

  it("does not write raw stderr (logging is via hook-logger)", async () => {
    mockStdin(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/foo" } }));
    await handleHookEvent("PreToolUse");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("calls readMergedHooksConfig and registerBuiltinPolicies", async () => {
    mockStdin();
    const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
    const { registerBuiltinPolicies } = await import("../../src/hooks/builtin-policies");

    await handleHookEvent("PreToolUse");

    expect(readMergedHooksConfig).toHaveBeenCalled();
    expect(registerBuiltinPolicies).toHaveBeenCalledWith(["block-sudo"]);
  });

  it("passes session cwd to loadAllCustomHooks for relative customPoliciesPath resolution", async () => {
    const sessionPayload = JSON.stringify({
      cwd: "/home/user/project",
    });
    mockStdin(sessionPayload);
    const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");

    await handleHookEvent("PreToolUse");

    expect(loadAllCustomHooks).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ sessionCwd: "/home/user/project" }),
    );
  });

  it("persists hook activity for every evaluation", async () => {
    mockStdin();
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

    await handleHookEvent("PreToolUse");

    expect(persistHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "PreToolUse",
        decision: "allow",
        policyName: null,
      }),
    );
  });

  it("persists deny decision when evaluator returns deny", async () => {
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    vi.mocked(evaluatePolicies).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
      stderr: "",
      policyName: "block-sudo",
      reason: "sudo blocked",
      decision: "deny",
    });
    mockStdin(JSON.stringify({ tool_name: "Bash" }));
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

    await handleHookEvent("PreToolUse");

    expect(persistHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        policyName: "block-sudo",
        reason: "sudo blocked",
      }),
    );
  });

  describe("PostHog telemetry", () => {
    it("fires telemetry with full payload for deny decisions", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        {
          event_type: "PreToolUse",
          cli: "claude",
          tool_name: "Bash",
          policy_name: "block-sudo",
          decision: "deny",
          is_custom_hook: false,
          is_convention_policy: false,
          convention_scope: null,
          has_custom_params: false,
          param_keys_overridden: [],
        },
      );
    });

    it("tags telemetry with cli=copilot when invoked with --cli copilot", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse", "copilot");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({ cli: "copilot" }),
      );
    });

    it("tags activity store entry with integration=copilot for copilot hook fires", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("PreToolUse", "copilot");

      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "copilot" }),
      );
    });

    it("canonicalizes Copilot lowercase tool name bash → Bash before evaluating (regression for #293)", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "bash", hook_event_name: "PreToolUse" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("PreToolUse", "copilot");

      // Without the canonicalizer the case-sensitive policy filter at
      // policy-registry.ts:93-95 silently no-ops every Bash builtin.
      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.objectContaining({ tool_name: "Bash" }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "copilot", toolName: "Bash" }),
      );
    });

    it("canonicalizes every Copilot tool name in COPILOT_TOOL_MAP", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      const cases: Array<[string, string]> = [
        ["bash", "Bash"],
        ["read", "Read"],
        ["write", "Write"],
        ["edit", "Edit"],
        ["str_replace_editor", "Edit"],
        ["glob", "Glob"],
        ["grep", "Grep"],
        ["ls", "LS"],
      ];
      for (const [raw, canonical] of cases) {
        vi.mocked(evaluatePolicies).mockResolvedValueOnce({
          exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
        });
        mockStdin(JSON.stringify({ tool_name: raw, hook_event_name: "PreToolUse" }));
        await handleHookEvent("PreToolUse", "copilot");
        expect(evaluatePolicies).toHaveBeenLastCalledWith(
          "PreToolUse",
          expect.objectContaining({ tool_name: canonical }),
          expect.any(Object),
          expect.any(Object),
        );
      }
    });

    it("passes through unknown Copilot tool names (MCP, extensions) unchanged", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "mcp_github_create_issue", hook_event_name: "PreToolUse" }));

      await handleHookEvent("PreToolUse", "copilot");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.objectContaining({ tool_name: "mcp_github_create_issue" }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("canonicalizes Cursor camelCase event names to PascalCase before evaluating", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash", hook_event_name: "preToolUse" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      // Cursor sends the camelCase event name on the --hook arg.
      await handleHookEvent("preToolUse", "cursor");

      // Internal evaluator + activity store key on PascalCase.
      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "cursor", eventType: "PreToolUse" }),
      );
    });

    it("tags telemetry with cli=cursor when invoked with --cli cursor", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"permission":"deny","user_message":"Blocked","agent_message":"Blocked"}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("preToolUse", "cursor");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({ cli: "cursor", event_type: "PreToolUse" }),
      );
    });

    it("canonicalizes Pi tool_call → PreToolUse before evaluating", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "bash", hook_event_name: "PreToolUse" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("tool_call", "pi");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "pi", eventType: "PreToolUse" }),
      );
    });

    it("canonicalizes Pi user_bash → PreToolUse (synthetic Bash)", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("user_bash", "pi");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "pi", eventType: "PreToolUse" }),
      );
    });

    it("canonicalizes Pi input → UserPromptSubmit", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ prompt: "hello" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("input", "pi");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "UserPromptSubmit",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "pi", eventType: "UserPromptSubmit" }),
      );
    });

    it("canonicalizes Pi session_start → SessionStart", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ cwd: "/home/u/repo" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("session_start", "pi");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "SessionStart",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "pi", eventType: "SessionStart" }),
      );
    });

    it("passes through unknown Pi event names unchanged", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({}));

      await handleHookEvent("model_select", "pi");

      // Unknown pi event passes through verbatim — handler doesn't map it
      // and policy evaluation simply finds no matching policies.
      expect(evaluatePolicies).toHaveBeenCalledWith(
        "model_select",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("tags telemetry with cli=pi when invoked with --cli pi", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"permission":"deny","reason":"sudo blocked"}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("tool_call", "pi");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({ cli: "pi", event_type: "PreToolUse" }),
      );
    });

    it("canonicalizes Gemini BeforeTool → PreToolUse before evaluating", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "run_shell_command", hook_event_name: "BeforeTool" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("BeforeTool", "gemini");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      );
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "gemini", eventType: "PreToolUse" }),
      );
    });

    it("canonicalizes Gemini snake_case tool name run_shell_command → Bash before evaluating", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        policyName: null,
        reason: null,
        decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "run_shell_command", hook_event_name: "BeforeTool" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("BeforeTool", "gemini");

      // The mutated payload passed to evaluatePolicies should carry the canonicalized tool_name
      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.objectContaining({ tool_name: "Bash" }),
        expect.any(Object),
        expect.any(Object),
      );
      // Activity store should also see canonicalized toolName=Bash, NOT raw run_shell_command
      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "gemini", toolName: "Bash" }),
      );
    });

    it("canonicalizes every Gemini tool name in GEMINI_TOOL_MAP", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      const cases: Array<[string, string]> = [
        ["run_shell_command", "Bash"],
        ["read_file", "Read"],
        ["read_many_files", "Read"],
        ["write_file", "Write"],
        ["replace", "Edit"],
        ["glob", "Glob"],
        ["grep_search", "Grep"],
        ["list_directory", "LS"],
        ["web_fetch", "WebFetch"],
        ["google_web_search", "WebSearch"],
        ["write_todos", "TodoWrite"],
        ["save_memory", "Memory"],
        ["ask_user", "AskUser"],
      ];
      for (const [raw, canonical] of cases) {
        vi.mocked(evaluatePolicies).mockResolvedValueOnce({
          exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
        });
        mockStdin(JSON.stringify({ tool_name: raw, hook_event_name: "BeforeTool" }));
        await handleHookEvent("BeforeTool", "gemini");
        expect(evaluatePolicies).toHaveBeenLastCalledWith(
          "PreToolUse",
          expect.objectContaining({ tool_name: canonical }),
          expect.any(Object),
          expect.any(Object),
        );
      }
    });

    it("passes through unknown Gemini tool names (MCP, extensions) unchanged", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "mcp_github_create_issue", hook_event_name: "BeforeTool" }));

      await handleHookEvent("BeforeTool", "gemini");

      // Unknown tool names are NOT in GEMINI_TOOL_MAP — must pass through unchanged so MCP tools aren't lost
      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.objectContaining({ tool_name: "mcp_github_create_issue" }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("does NOT canonicalize tool names when cli=claude (other CLIs unaffected)", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
      });
      // A Claude session that somehow has a Gemini-shaped tool name should NOT be remapped.
      mockStdin(JSON.stringify({ tool_name: "run_shell_command", hook_event_name: "PreToolUse" }));

      await handleHookEvent("PreToolUse", "claude");

      expect(evaluatePolicies).toHaveBeenCalledWith(
        "PreToolUse",
        expect.objectContaining({ tool_name: "run_shell_command" }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("canonicalizes all 11 Gemini events to canonical names (BeforeAgent → UserPromptSubmit, etc.)", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      const cases: Array<[string, string]> = [
        ["SessionStart", "SessionStart"],
        ["SessionEnd", "SessionEnd"],
        ["BeforeAgent", "UserPromptSubmit"],
        ["AfterAgent", "Stop"],
        ["BeforeTool", "PreToolUse"],
        ["AfterTool", "PostToolUse"],
        ["PreCompress", "PreCompact"],
        ["Notification", "Notification"],
        // Gemini-only events with no Claude canonical — passthrough.
        ["BeforeModel", "BeforeModel"],
        ["AfterModel", "AfterModel"],
        ["BeforeToolSelection", "BeforeToolSelection"],
      ];
      for (const [raw, canonical] of cases) {
        vi.mocked(evaluatePolicies).mockResolvedValueOnce({
          exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
        });
        mockStdin(JSON.stringify({ hook_event_name: raw }));
        await handleHookEvent(raw, "gemini");
        expect(evaluatePolicies).toHaveBeenLastCalledWith(
          canonical,
          expect.any(Object),
          expect.any(Object),
          expect.any(Object),
        );
      }
    });

    it("tags telemetry with cli=gemini and canonicalized tool_name=Bash when invoked with --cli gemini", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"decision":"deny","reason":"sudo blocked"}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "run_shell_command", hook_event_name: "BeforeTool" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("BeforeTool", "gemini");

      // Telemetry should see the canonicalized tool name (Bash, not run_shell_command)
      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({ cli: "gemini", event_type: "PreToolUse", tool_name: "Bash" }),
      );
    });

    it("tags activity store entry with integration=gemini and canonicalized eventType for Gemini hook fires", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow",
      });
      mockStdin(JSON.stringify({ tool_name: "read_file", hook_event_name: "BeforeTool" }));
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

      await handleHookEvent("BeforeTool", "gemini");

      expect(persistHookActivity).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "gemini", eventType: "PreToolUse", toolName: "Read" }),
      );
    });

    it("fires telemetry with full payload for instruct decisions", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"additionalContext":"Instruction from failproofai: repeated calls"}}',
        stderr: "",
        policyName: "warn-repeated-tool-calls",
        reason: "repeated calls",
        decision: "instruct",
      });
      mockStdin(JSON.stringify({ tool_name: "Read" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        {
          event_type: "PreToolUse",
          cli: "claude",
          tool_name: "Read",
          policy_name: "warn-repeated-tool-calls",
          decision: "instruct",
          is_custom_hook: false,
          is_convention_policy: false,
          convention_scope: null,
          has_custom_params: false,
          param_keys_overridden: [],
        },
      );
    });

    it("sets is_custom_hook true when triggered policy is a custom hook", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "custom/my-hook",
        reason: "custom blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({
          policy_name: "custom/my-hook",
          is_custom_hook: true,
          has_custom_params: false,
          param_keys_overridden: [],
        }),
      );
    });

    it("sets has_custom_params and param_keys_overridden when policyParams are configured", async () => {
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      vi.mocked(readMergedHooksConfig).mockReturnValueOnce({
        enabledPolicies: ["block-sudo"],
        policyParams: { "block-sudo": { allowPatterns: ["sudo systemctl status"] } },
      });
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({
          policy_name: "block-sudo",
          is_custom_hook: false,
          has_custom_params: true,
          param_keys_overridden: ["allowPatterns"],
        }),
      );
    });

    it("does not fire telemetry for allow decisions", async () => {
      mockStdin();
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).not.toHaveBeenCalled();
    });

    it("passes null tool_name when payload has no tool_name", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({}));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "hook_policy_triggered",
        expect.objectContaining({
          tool_name: null,
        }),
      );
    });

    it("telemetry failure does not throw or affect exit code", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");
      vi.mocked(trackHookEvent).mockRejectedValueOnce(new Error("PostHog unavailable"));

      const exitCode = await handleHookEvent("PreToolUse");

      expect(exitCode).toBe(0);
    });

    it("fires custom_hooks_loaded with count, names, and event types when custom hooks are present", async () => {
      const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadAllCustomHooks).mockResolvedValueOnce({
        hooks: [
          { name: "hook-a", fn: async () => ({ decision: "allow" as const }), match: { events: ["PreToolUse" as never] } },
          { name: "hook-b", fn: async () => ({ decision: "allow" as const }), match: { events: ["Stop" as never] } },
        ],
        conventionSources: [],
      });
      mockStdin();
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "custom_hooks_loaded",
        {
          cli: "claude",
          custom_hooks_count: 2,
          custom_hook_names: ["hook-a", "hook-b"],
          event_types_covered: expect.arrayContaining(["PreToolUse", "Stop"]),
        },
      );
    });

    it("does not fire custom_hooks_loaded when no custom hooks are loaded", async () => {
      mockStdin();
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      const calls = vi.mocked(trackHookEvent).mock.calls;
      expect(calls.every(([, event]) => event !== "custom_hooks_loaded")).toBe(true);
    });

    it("fires custom_hook_error with error_type exception when hook throws", async () => {
      const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadAllCustomHooks).mockResolvedValueOnce({
        hooks: [
          { name: "bad-hook", fn: async () => { throw new Error("oops"); } },
        ],
        conventionSources: [],
      });
      const { registerPolicy } = await import("../../src/hooks/policy-registry");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      let wrappedFn: ((ctx: never) => Promise<unknown>) | null = null;
      vi.mocked(registerPolicy).mockImplementationOnce((_n, _d, fn) => {
        wrappedFn = fn as (ctx: never) => Promise<unknown>;
      });

      mockStdin();
      await handleHookEvent("PreToolUse");

      expect(wrappedFn).not.toBeNull();
      await wrappedFn!({} as never);

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "custom_hook_error",
        { hook_name: "bad-hook", error_type: "exception", event_type: "PreToolUse", cli: "claude", is_convention_policy: false, convention_scope: null },
      );
    });

    it("fires custom_hook_error with error_type timeout when hook times out", async () => {
      const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
      vi.mocked(loadAllCustomHooks).mockResolvedValueOnce({
        hooks: [
          { name: "slow-hook", fn: async () => { throw new Error("timeout"); } },
        ],
        conventionSources: [],
      });
      const { registerPolicy } = await import("../../src/hooks/policy-registry");
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      let wrappedFn: ((ctx: never) => Promise<unknown>) | null = null;
      vi.mocked(registerPolicy).mockImplementationOnce((_n, _d, fn) => {
        wrappedFn = fn as (ctx: never) => Promise<unknown>;
      });

      mockStdin();
      await handleHookEvent("PreToolUse");

      expect(wrappedFn).not.toBeNull();
      await wrappedFn!({} as never);

      expect(trackHookEvent).toHaveBeenCalledWith(
        "test-instance-id",
        "custom_hook_error",
        { hook_name: "slow-hook", error_type: "timeout", event_type: "PreToolUse", cli: "claude", is_convention_policy: false, convention_scope: null },
      );
    });

    it("fires exactly one telemetry event per hook invocation", async () => {
      const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
      vi.mocked(evaluatePolicies).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        stderr: "",
        policyName: "block-sudo",
        reason: "sudo blocked",
        decision: "deny",
      });
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

      await handleHookEvent("PreToolUse");

      expect(trackHookEvent).toHaveBeenCalledTimes(1);
    });
  });

  it("passes session metadata to persistHookActivity", async () => {
    const sessionPayload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/foo/bar.ts" },
      session_id: "sess-abc-123",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/home/user/project",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
    });
    mockStdin(sessionPayload);
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

    await handleHookEvent("PreToolUse");

    expect(persistHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-abc-123",
        transcriptPath: "/tmp/transcript.jsonl",
        cwd: "/home/user/project",
        permissionMode: "default",
        hookEventName: "PreToolUse",
      }),
    );
  });

  it("passes undefined session fields when payload is empty", async () => {
    mockStdin();
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

    await handleHookEvent("PreToolUse");

    expect(persistHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        transcriptPath: undefined,
        cwd: undefined,
        // resolvePermissionMode returns "default" for claude with no permission_mode in stdin
        permissionMode: "default",
        hookEventName: undefined,
        integration: "claude",
      }),
    );
  });

  it("passes session metadata to evaluatePolicies", async () => {
    const sessionPayload = JSON.stringify({
      session_id: "sess-xyz",
      cwd: "/home/user/project",
      permission_mode: "plan",
    });
    mockStdin(sessionPayload);
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");

    await handleHookEvent("PreToolUse");

    expect(evaluatePolicies).toHaveBeenCalledWith(
      "PreToolUse",
      expect.any(Object),
      expect.objectContaining({
        sessionId: "sess-xyz",
        cwd: "/home/user/project",
        permissionMode: "plan",
      }),
      expect.any(Object),
    );
  });

  it("writes stdout from evaluator result", async () => {
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    vi.mocked(evaluatePolicies).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
      stderr: "",
      policyName: "block-sudo",
      reason: "blocked",
      decision: "deny",
    });
    mockStdin(JSON.stringify({ tool_name: "Bash" }));

    await handleHookEvent("PreToolUse");

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("permissionDecision"),
    );
  });

  it("persists instruct decision as 'instruct' in activity store", async () => {
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    vi.mocked(evaluatePolicies).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"additionalContext":"Instruction from failproofai: repeated calls"}}',
      stderr: "",
      policyName: "warn-repeated-tool-calls",
      reason: "repeated calls",
      decision: "instruct",
    });
    mockStdin(JSON.stringify({ tool_name: "Read" }));
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");

    await handleHookEvent("PreToolUse");

    expect(persistHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "instruct",
        policyName: "warn-repeated-tool-calls",
        reason: "repeated calls",
      }),
    );
  });

  describe("hook logging", () => {
    it("logs event type and policy count at info level", async () => {
      mockStdin(JSON.stringify({ tool_name: "Bash" }));
      const { hookLogInfo } = await import("../../src/hooks/hook-logger");

      await handleHookEvent("PreToolUse");

      expect(hookLogInfo).toHaveBeenCalledWith(expect.stringContaining("event=PreToolUse"));
      expect(hookLogInfo).toHaveBeenCalledWith(expect.stringContaining("policies="));
    });

    it("logs evaluation result at info level", async () => {
      mockStdin();
      const { hookLogInfo } = await import("../../src/hooks/hook-logger");

      await handleHookEvent("PreToolUse");

      expect(hookLogInfo).toHaveBeenCalledWith(expect.stringContaining("result=allow"));
      expect(hookLogInfo).toHaveBeenCalledWith(expect.stringContaining("duration="));
    });

    it("logs warning when JSON parse fails", async () => {
      mockStdin("not valid json {{{");
      const { hookLogWarn } = await import("../../src/hooks/hook-logger");

      await handleHookEvent("PreToolUse");

      expect(hookLogWarn).toHaveBeenCalledWith(expect.stringContaining("payload parse failed"));
    });

    it("logs warning and returns exit 0 when stdin exceeds 1 MB", async () => {
      const oversized = "A".repeat(1_100_000); // 1.1 MB
      mockStdin(oversized);
      const { hookLogWarn } = await import("../../src/hooks/hook-logger");

      const exitCode = await handleHookEvent("PreToolUse");

      expect(hookLogWarn).toHaveBeenCalledWith(expect.stringContaining("exceeds 1 MB"));
      expect(exitCode).toBe(0);
    });

    it("logs warning when activity persistence fails", async () => {
      mockStdin();
      const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");
      vi.mocked(persistHookActivity).mockImplementation(() => { throw new Error("disk full"); });
      const { hookLogWarn } = await import("../../src/hooks/hook-logger");

      await handleHookEvent("PreToolUse");

      expect(hookLogWarn).toHaveBeenCalledWith(expect.stringContaining("activity persistence failed"));
    });
  });

});
