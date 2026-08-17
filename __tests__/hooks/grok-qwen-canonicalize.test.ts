// @vitest-environment node
//
// Locks in the grok + qwen wire contracts, all captured from live recorder
// hooks (grok 1.0.3 / qwen-code 0.21.12) rather than read off either CLI's
// docs — which matters, because in grok's case the docs were wrong twice.
//
// The cases that are NOT cosmetic, and why each is here:
//   • grok's `read_file` delivers `target_file`, so without the input map a
//     live `.env` read walks past block-env-files (the Copilot bug, again).
//   • grok pipes camelCase, so without normalization `tool_name`/`tool_input`
//     reach every builtin as undefined.
//   • grok EXECUTES `.claude/settings.json` — the file our own claude install
//     writes — so a grok payload can arrive on a hook flagged `--cli claude`.
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";
import {
  normalizeCliPayload,
  isGrokEnvelope,
  resolveEffectiveCli,
} from "@/src/hooks/normalize-cli-payload";
import {
  GROK_HOOK_EVENT_TYPES,
  GROK_TOOL_INPUT_MAP,
  QWEN_HOOK_EVENT_TYPES,
  QWEN_EVENT_MAP,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";
import { canonicalizeEventType } from "@/src/hooks/handler";

/** A PreToolUse payload exactly as grok 1.0.3 pipes it (captured verbatim). */
function grokPreToolUsePayload(): Record<string, unknown> {
  return {
    hookEventName: "pre_tool_use",
    sessionId: "01a00bc4-57ad-7231-98ef-9f037a781572",
    cwd: "/tmp/fp-probe/ws",
    workspaceRoot: "/tmp/fp-probe/ws",
    transcriptPath: "/home/u/.grok/sessions/%2Ftmp/01a00bc4/chat_history.jsonl",
    permissionMode: "bypassPermissions",
    toolName: "run_terminal_command",
    toolInput: { command: "echo FPPROBE", description: "Echo FPPROBE to stdout" },
    toolUseId: "call-ed78750f",
    toolInputTruncated: false,
    timestamp: "2026-08-16T18:10:12Z",
  };
}

describe("grok + qwen event types", () => {
  it("are all already-canonical PascalCase HookEventTypes (no event map needed)", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of GROK_HOOK_EVENT_TYPES) {
      expect(canonical.has(ev), `${ev} must be a HookEventType`).toBe(true);
    }
    // qwen is canonical too, EXCEPT its two Todo names, which QWEN_EVENT_MAP
    // translates to TaskCreated/TaskCompleted.
    for (const ev of QWEN_HOOK_EVENT_TYPES) {
      const mapped = QWEN_EVENT_MAP[ev];
      expect(canonical.has(mapped), `${ev} must map to a HookEventType`).toBe(true);
    }
  });

  it("both subscribe to Stop — each has a verified force-retry gate", () => {
    // Unlike goose/hermes, both of these CAN keep the agent working, so the 5
    // require-*-before-stop builtins are applicable and Stop must be installed.
    expect(GROK_HOOK_EVENT_TYPES).toContain("Stop");
    expect(QWEN_HOOK_EVENT_TYPES).toContain("Stop");
  });

  it("grok subscribes to its ENTIRE event surface", () => {
    // A live grok 1.0.3 accepted all 14 (`hook_count=14`, no unknown-key
    // warning). grok silently skips names it doesn't recognize, so this list
    // drifting out of sync would cost coverage with no error anywhere.
    expect(GROK_HOOK_EVENT_TYPES).toHaveLength(14);
    for (const e of ["PermissionDenied", "StopFailure", "Notification", "SubagentStart", "PreCompact", "PostCompact"]) {
      expect(GROK_HOOK_EVENT_TYPES, `${e} must be installed`).toContain(e);
    }
  });

  it("qwen omits the two events that would cost more than they return", () => {
    // MessageDisplay fires per streaming chunk — a hook process per chunk.
    // PostToolBatch fired 6× where PostToolUse fired 5, carrying the same tool
    // calls in batch form, and no builtin reads it. Both are deliberate.
    expect(QWEN_HOOK_EVENT_TYPES).not.toContain("MessageDisplay");
    expect(QWEN_HOOK_EVENT_TYPES).not.toContain("PostToolBatch");
    expect(QWEN_HOOK_EVENT_TYPES).not.toContain("SessionDelete");
  });

  it("qwen's Todo events canonicalize onto the Task events", () => {
    // qwen calls its task list "todos"; mapping them means a policy written
    // against TaskCreated fires on qwen and Claude alike.
    expect(canonicalizeEventType("TodoCreated", "qwen")).toBe("TaskCreated");
    expect(canonicalizeEventType("TodoCompleted", "qwen")).toBe("TaskCompleted");
  });

  it("qwen's other 17 events canonicalize to themselves", () => {
    for (const e of QWEN_HOOK_EVENT_TYPES) {
      if (e === "TodoCreated" || e === "TodoCompleted") continue;
      expect(canonicalizeEventType(e, "qwen"), e).toBe(e);
    }
  });

  it("the qwen event map covers every installed event", () => {
    // Exhaustive at the type level; assert it at runtime too, since a missing
    // entry would write an `undefined` event key into a user's settings.json.
    for (const e of QWEN_HOOK_EVENT_TYPES) {
      expect(QWEN_EVENT_MAP[e], `${e} needs a canonical mapping`).toBeTruthy();
    }
  });

  it("grok needs no event map — its names are canonical already", () => {
    for (const e of GROK_HOOK_EVENT_TYPES) {
      expect(canonicalizeEventType(e, "grok"), e).toBe(e);
    }
  });
});

describe("grok tool canonicalization", () => {
  it("maps grok's tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("run_terminal_command", "grok")).toBe("Bash");
    expect(canonicalizeToolName("write", "grok")).toBe("Write");
    expect(canonicalizeToolName("read_file", "grok")).toBe("Read");
    expect(canonicalizeToolName("search_replace", "grok")).toBe("Edit");
    expect(canonicalizeToolName("grep", "grok")).toBe("Grep");
    expect(canonicalizeToolName("list_dir", "grok")).toBe("LS");
  });

  it("also accepts the shell-tool name grok's headless doc uses", () => {
    // The hooks doc says `run_terminal_command` (which is what the wire sends);
    // the headless doc says `run_terminal_cmd`. Both canonicalize.
    expect(canonicalizeToolName("run_terminal_cmd", "grok")).toBe("Bash");
  });

  it("passes unknown tools through unchanged", () => {
    expect(canonicalizeToolName("some_mcp__tool", "grok")).toBe("some_mcp__tool");
  });

  it("maps read_file's target_file to file_path so path builtins fire", () => {
    // THE load-bearing case: block-env-files / block-read-outside-cwd read
    // `file_path`. Without this a live `.env` read is invisible to them.
    expect(canonicalizeToolInput("Read", { target_file: ".env" }, "grok")).toEqual({
      file_path: ".env",
    });
  });

  it("maps list_dir's target_directory to path", () => {
    expect(canonicalizeToolInput("LS", { target_directory: "/etc" }, "grok")).toEqual({
      path: "/etc",
    });
  });

  it("leaves already-canonical inputs untouched", () => {
    // Bash/Write/Edit/Grep deliver canonical keys, so they have no map entry.
    expect(GROK_TOOL_INPUT_MAP.Bash).toBeUndefined();
    const bash = { command: "rm -rf /" };
    expect(canonicalizeToolInput("Bash", bash, "grok")).toEqual(bash);
    const edit = { file_path: "a.ts", old_string: "a", new_string: "b" };
    expect(canonicalizeToolInput("Edit", edit, "grok")).toEqual(edit);
  });
});

describe("qwen tool canonicalization", () => {
  it("maps qwen's runtime tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("run_shell_command", "qwen")).toBe("Bash");
    expect(canonicalizeToolName("read_file", "qwen")).toBe("Read");
    expect(canonicalizeToolName("write_file", "qwen")).toBe("Write");
    expect(canonicalizeToolName("edit", "qwen")).toBe("Edit");
    expect(canonicalizeToolName("grep_search", "qwen")).toBe("Grep");
    expect(canonicalizeToolName("list_directory", "qwen")).toBe("LS");
  });

  it("also accepts qwen's legacy display-name matcher aliases", () => {
    expect(canonicalizeToolName("ReadFile", "qwen")).toBe("Read");
    expect(canonicalizeToolName("WriteFile", "qwen")).toBe("Write");
  });

  it("needs NO input mapping — every qwen tool key is already canonical", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["Bash", { command: "echo hi" }],
      ["Read", { file_path: "/tmp/a.txt" }],
      ["Write", { file_path: "/tmp/a.txt", content: "x" }],
      ["Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }],
      ["Grep", { pattern: "x", path: "." }],
      ["LS", { path: "." }],
    ];
    for (const [tool, input] of cases) {
      expect(canonicalizeToolInput(tool, input, "qwen"), tool).toEqual(input);
    }
  });
});

describe("grok payload normalization", () => {
  it("maps the camelCase envelope onto the snake_case fields builtins read", () => {
    const p = grokPreToolUsePayload();
    normalizeCliPayload("grok", p);
    expect(p.tool_name).toBe("run_terminal_command");
    expect(p.tool_input).toEqual({ command: "echo FPPROBE", description: "Echo FPPROBE to stdout" });
    expect(p.session_id).toBe("01a00bc4-57ad-7231-98ef-9f037a781572");
    expect(p.permission_mode).toBe("bypassPermissions");
    expect(p.transcript_path).toBe(
      "/home/u/.grok/sessions/%2Ftmp/01a00bc4/chat_history.jsonl",
    );
  });

  it("maps PostToolUse's toolResult onto tool_response (grok does not send Claude's key)", () => {
    const p: Record<string, unknown> = {
      hookEventName: "post_tool_use",
      workspaceRoot: "/w",
      toolName: "run_terminal_command",
      toolResult: { exit_code: 0, output_for_prompt: "hi\n" },
    };
    normalizeCliPayload("grok", p);
    expect(p.tool_response).toEqual({ exit_code: 0, output_for_prompt: "hi\n" });
  });

  it("falls back to workspaceRoot for cwd, without clobbering a real cwd", () => {
    const withCwd = grokPreToolUsePayload();
    withCwd.cwd = "/real/cwd";
    normalizeCliPayload("grok", withCwd);
    expect(withCwd.cwd).toBe("/real/cwd");

    const noCwd = grokPreToolUsePayload();
    delete noCwd.cwd;
    normalizeCliPayload("grok", noCwd);
    expect(noCwd.cwd).toBe("/tmp/fp-probe/ws");
  });

  it("does NOT map hookEventName — its value is snake_case, the --hook arg is canonical", () => {
    const p = grokPreToolUsePayload();
    normalizeCliPayload("grok", p);
    expect(p.hook_event_name).toBeUndefined();
  });
});

describe("grok executing another CLI's hook config", () => {
  it("recognizes grok's envelope", () => {
    expect(isGrokEnvelope(grokPreToolUsePayload())).toBe(true);
  });

  it("does NOT mistake a real Claude payload for grok's", () => {
    // The guard that keeps Claude's own enforcement intact.
    expect(
      isGrokEnvelope({
        hook_event_name: "PreToolUse",
        session_id: "s",
        cwd: "/w",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    ).toBe(false);
    // A payload with neither marker (e.g. a bare Stop) is not grok's either.
    expect(isGrokEnvelope({ stop_hook_active: false })).toBe(false);
    // camelCase alone is not enough — Copilot's permissionRequest sends
    // `toolName`/`sessionId` too, and must keep its own contract.
    expect(isGrokEnvelope({ toolName: "bash", sessionId: "s", cwd: "/w" })).toBe(false);
  });

  it("re-routes a grok payload flagged --cli claude onto grok's contract", () => {
    // grok scans ~/.claude/settings.json and <cwd>/.claude/settings.json by
    // default, so it runs OUR claude hooks and passes `--cli claude` while
    // piping its own payload. Verified live: without this the hook fires,
    // every builtin sees undefined, and nothing is enforced.
    expect(resolveEffectiveCli("claude", grokPreToolUsePayload())).toBe("grok");
  });

  it("leaves every other (cli, payload) pair alone", () => {
    const claudePayload = { hook_event_name: "PreToolUse", tool_name: "Bash" };
    expect(resolveEffectiveCli("claude", claudePayload)).toBe("claude");
    expect(resolveEffectiveCli("goose", { event: "PreToolUse" })).toBe("goose");
    expect(resolveEffectiveCli("qwen", { hook_event_name: "PreToolUse" })).toBe("qwen");
    // Already-declared grok stays grok.
    expect(resolveEffectiveCli("grok", grokPreToolUsePayload())).toBe("grok");
  });

  it("end-to-end: a grok-shaped .claude hook still resolves a canonical Bash command", () => {
    const parsed = grokPreToolUsePayload();
    const cli = resolveEffectiveCli("claude", parsed);
    normalizeCliPayload(cli, parsed);
    const tool = canonicalizeToolName(parsed.tool_name as string, cli);
    const input = canonicalizeToolInput(tool, parsed.tool_input, cli);
    expect(tool).toBe("Bash");
    expect((input as Record<string, unknown>).command).toBe("echo FPPROBE");
  });

  it("end-to-end: a grok-shaped .claude hook exposes a read of .env as file_path", () => {
    const parsed: Record<string, unknown> = {
      hookEventName: "pre_tool_use",
      workspaceRoot: "/repo",
      toolName: "read_file",
      toolInput: { target_file: ".env" },
    };
    const cli = resolveEffectiveCli("claude", parsed);
    normalizeCliPayload(cli, parsed);
    const tool = canonicalizeToolName(parsed.tool_name as string, cli);
    const input = canonicalizeToolInput(tool, parsed.tool_input, cli);
    expect(tool).toBe("Read");
    // Both halves of the leak fix: without either, block-env-files sees nothing.
    expect((input as Record<string, unknown>).file_path).toBe(".env");
  });
});
