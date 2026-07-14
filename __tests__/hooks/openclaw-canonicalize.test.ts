// @vitest-environment node
//
// Locks in OpenClaw event + tool NAME + INPUT canonicalization (verified live
// against openclaw v2026.7.1: before_tool_call payload tool `exec` with params
// `{command}`; file tools deliver the path as `path`, which Claude builtins read
// as `file_path`).
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";
import {
  OPENCLAW_EVENT_MAP,
  OPENCLAW_HOOK_EVENT_TYPES,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";

describe("OpenClaw event canonicalization", () => {
  it("maps every subscribed hook to a valid canonical event", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of OPENCLAW_HOOK_EVENT_TYPES) {
      const mapped = OPENCLAW_EVENT_MAP[ev];
      expect(mapped, `${ev} must map`).toBeTruthy();
      expect(canonical.has(mapped), `${mapped} must be a HookEventType`).toBe(true);
    }
  });

  it("maps the enforcement hooks to the right canonical events", () => {
    expect(OPENCLAW_EVENT_MAP.before_tool_call).toBe("PreToolUse");
    expect(OPENCLAW_EVENT_MAP.after_tool_call).toBe("PostToolUse");
    expect(OPENCLAW_EVENT_MAP.before_agent_run).toBe("UserPromptSubmit");
    // before_agent_finalize is the real turn-end gate (unlike Hermes, which has none).
    expect(OPENCLAW_EVENT_MAP.before_agent_finalize).toBe("Stop");
    expect(OPENCLAW_EVENT_MAP.session_start).toBe("SessionStart");
    expect(OPENCLAW_EVENT_MAP.session_end).toBe("SessionEnd");
    expect(OPENCLAW_EVENT_MAP.subagent_ended).toBe("SubagentStop");
    expect(OPENCLAW_EVENT_MAP.before_compaction).toBe("PreCompact");
  });

  it("does not subscribe to agent_end (would double-fire Stop) or message_sending (deferred)", () => {
    expect(OPENCLAW_HOOK_EVENT_TYPES).not.toContain("agent_end");
    expect(OPENCLAW_HOOK_EVENT_TYPES).not.toContain("message_sending");
  });
});

describe("OpenClaw tool canonicalization", () => {
  it("canonicalizes OpenClaw tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("exec", "openclaw")).toBe("Bash");
    expect(canonicalizeToolName("read", "openclaw")).toBe("Read");
    expect(canonicalizeToolName("write", "openclaw")).toBe("Write");
    expect(canonicalizeToolName("edit", "openclaw")).toBe("Edit");
    expect(canonicalizeToolName("grep", "openclaw")).toBe("Grep");
    expect(canonicalizeToolName("glob", "openclaw")).toBe("Glob");
    expect(canonicalizeToolName("web_search", "openclaw")).toBe("WebSearch");
    expect(canonicalizeToolName("web_fetch", "openclaw")).toBe("WebFetch");
  });

  it("passes unknown OpenClaw tools through unchanged (browser, process, memory_*)", () => {
    expect(canonicalizeToolName("browser", "openclaw")).toBe("browser");
    expect(canonicalizeToolName("process", "openclaw")).toBe("process");
    expect(canonicalizeToolName("memory_search", "openclaw")).toBe("memory_search");
  });

  it("maps the file tools' `path` arg to `file_path` so path builtins fire", () => {
    expect(canonicalizeToolInput("Read", { path: "/srv/.env" }, "openclaw")).toEqual({ file_path: "/srv/.env" });
    expect(canonicalizeToolInput("Write", { path: "/srv/x", content: "s" }, "openclaw")).toEqual({
      file_path: "/srv/x",
      content: "s",
    });
    expect(canonicalizeToolInput("Edit", { path: "/srv/x" }, "openclaw")).toEqual({ file_path: "/srv/x" });
  });

  it("leaves exec's already-canonical `command` unchanged (matches Bash builtins)", () => {
    expect(canonicalizeToolInput("Bash", { command: "sudo rm -rf /" }, "openclaw")).toEqual({
      command: "sudo rm -rf /",
    });
  });
});
