// @vitest-environment node
//
// Locks in Antigravity (agy) event mapping + tool NAME/INPUT canonicalization.
// Verified live against agy v1.1.2: shell runs as `run_command` with PascalCase
// args (`CommandLine`, `Cwd`); PreInvocation maps to the canonical
// UserPromptSubmit event.
import { describe, it, expect } from "vitest";
import {
  canonicalizeToolName,
  canonicalizeToolInput,
} from "@/src/hooks/tool-name-canonicalize";
import {
  ANTIGRAVITY_HOOK_EVENT_TYPES,
  ANTIGRAVITY_EVENT_MAP,
  ANTIGRAVITY_TOOL_MAP,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";

describe("Antigravity event mapping", () => {
  it("subscribes to the 4 verified agy hook events", () => {
    expect(ANTIGRAVITY_HOOK_EVENT_TYPES).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PreInvocation",
      "Stop",
    ]);
  });

  it("maps every agy --hook arg to a canonical HookEventType", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of ANTIGRAVITY_HOOK_EVENT_TYPES) {
      expect(canonical.has(ANTIGRAVITY_EVENT_MAP[ev]), `${ev} → ${ANTIGRAVITY_EVENT_MAP[ev]}`).toBe(true);
    }
  });

  it("PreInvocation maps to UserPromptSubmit; tool/stop pass through", () => {
    expect(ANTIGRAVITY_EVENT_MAP.PreInvocation).toBe("UserPromptSubmit");
    expect(ANTIGRAVITY_EVENT_MAP.PreToolUse).toBe("PreToolUse");
    expect(ANTIGRAVITY_EVENT_MAP.PostToolUse).toBe("PostToolUse");
    expect(ANTIGRAVITY_EVENT_MAP.Stop).toBe("Stop");
  });
});

describe("Antigravity tool-name canonicalization", () => {
  it("canonicalizes agy tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("run_command", "antigravity")).toBe("Bash");
    expect(canonicalizeToolName("write_to_file", "antigravity")).toBe("Write");
    expect(canonicalizeToolName("read_file", "antigravity")).toBe("Read");
    expect(canonicalizeToolName("view_file", "antigravity")).toBe("Read");
    expect(canonicalizeToolName("edit_file", "antigravity")).toBe("Edit");
    expect(canonicalizeToolName("replace_file_content", "antigravity")).toBe("Edit");
    expect(canonicalizeToolName("list_dir", "antigravity")).toBe("LS");
    expect(canonicalizeToolName("find_by_name", "antigravity")).toBe("Glob");
    expect(canonicalizeToolName("grep_search", "antigravity")).toBe("Grep");
    expect(canonicalizeToolName("read_url_content", "antigravity")).toBe("WebFetch");
    expect(canonicalizeToolName("search_web", "antigravity")).toBe("WebSearch");
  });

  it("passes unknown agy tools through unchanged (MCP, future tools)", () => {
    expect(canonicalizeToolName("mcp__server__tool", "antigravity")).toBe("mcp__server__tool");
    expect(canonicalizeToolName("some_future_tool", "antigravity")).toBe("some_future_tool");
  });

  it("maps every ANTIGRAVITY_TOOL_MAP key to a non-empty canonical name", () => {
    for (const [raw, canonical] of Object.entries(ANTIGRAVITY_TOOL_MAP)) {
      expect(canonicalizeToolName(raw, "antigravity")).toBe(canonical);
    }
  });
});

describe("Antigravity tool-input canonicalization", () => {
  it("maps run_command's PascalCase args (CommandLine/Cwd) to command/cwd on Bash", () => {
    const out = canonicalizeToolInput(
      "Bash",
      { CommandLine: "npm test", Cwd: "/repo", WaitMsBeforeAsync: 5000 },
      "antigravity",
    ) as Record<string, unknown>;
    expect(out.command).toBe("npm test");
    expect(out.cwd).toBe("/repo");
    // unknown keys pass through unchanged
    expect(out.WaitMsBeforeAsync).toBe(5000);
  });

  it("maps write_to_file's TargetFile/CodeContent to file_path/content on Write", () => {
    // Regression: without this, block-env-files/block-secrets-write never saw a
    // file_path and silently allowed Antigravity .env writes.
    const out = canonicalizeToolInput(
      "Write",
      { TargetFile: "/home/u/.env", CodeContent: "SECRET=x", Overwrite: true },
      "antigravity",
    ) as Record<string, unknown>;
    expect(out.file_path).toBe("/home/u/.env");
    expect(out.content).toBe("SECRET=x");
    // unknown keys pass through unchanged
    expect(out.Overwrite).toBe(true);
  });

  it("maps a file tool's TargetFile to file_path on Edit", () => {
    const out = canonicalizeToolInput("Edit", { TargetFile: "/repo/.env" }, "antigravity") as Record<string, unknown>;
    expect(out.file_path).toBe("/repo/.env");
  });

  it("leaves a tool with no map entry untouched (reference-equal)", () => {
    const input = { pattern: "TODO" };
    expect(canonicalizeToolInput("Grep", input, "antigravity")).toBe(input);
  });
});
