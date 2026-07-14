// @vitest-environment node
//
// Locks in Devin (Cognition) tool NAME canonicalization (verified live against
// devin v3000.1.27: the shell tool runs as `exec` with `tool_input.command`).
// tool_input keys are already canonical, so there is no DEVIN_TOOL_INPUT_MAP.
import { describe, it, expect } from "vitest";
import { canonicalizeToolName } from "@/src/hooks/tool-name-canonicalize";
import {
  DEVIN_HOOK_EVENT_TYPES,
  DEVIN_TOOL_MAP,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";

describe("Devin event types", () => {
  it("are all already-canonical PascalCase HookEventTypes (no event map needed)", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of DEVIN_HOOK_EVENT_TYPES) {
      expect(canonical.has(ev), `${ev} must be a HookEventType`).toBe(true);
    }
  });

  it("subscribes to the 7 verified devin events", () => {
    expect(DEVIN_HOOK_EVENT_TYPES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "Stop",
      "SessionEnd",
    ]);
  });
});

describe("Devin tool canonicalization", () => {
  it("canonicalizes the exec shell tool to Bash", () => {
    expect(canonicalizeToolName("exec", "devin")).toBe("Bash");
  });

  it("passes unknown/other devin tools through unchanged (MCP, extensions, file tools)", () => {
    expect(canonicalizeToolName("mcp__server__tool", "devin")).toBe("mcp__server__tool");
    expect(canonicalizeToolName("str_replace_editor", "devin")).toBe("str_replace_editor");
    expect(canonicalizeToolName("SomeFutureTool", "devin")).toBe("SomeFutureTool");
  });

  it("maps every DEVIN_TOOL_MAP key to a non-empty canonical name", () => {
    for (const [raw, canonical] of Object.entries(DEVIN_TOOL_MAP)) {
      expect(canonicalizeToolName(raw, "devin")).toBe(canonical);
    }
  });
});
