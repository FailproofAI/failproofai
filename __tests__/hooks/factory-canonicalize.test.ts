// @vitest-environment node
//
// Locks in Factory (droid) tool NAME canonicalization (verified live against
// droid v0.171.0: shell runs as `Execute`, file writes as `Create`, URL fetches
// as `FetchUrl`). tool_input keys are already canonical (`command`, `file_path`),
// so there is no FACTORY_TOOL_INPUT_MAP.
import { describe, it, expect } from "vitest";
import { canonicalizeToolName } from "@/src/hooks/tool-name-canonicalize";
import {
  FACTORY_HOOK_EVENT_TYPES,
  FACTORY_TOOL_MAP,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";

describe("Factory event types", () => {
  it("are all already-canonical PascalCase HookEventTypes (no event map needed)", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of FACTORY_HOOK_EVENT_TYPES) {
      expect(canonical.has(ev), `${ev} must be a HookEventType`).toBe(true);
    }
  });

  it("subscribes to the 9 verified droid events", () => {
    expect(FACTORY_HOOK_EVENT_TYPES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "SessionEnd",
    ]);
  });
});

describe("Factory tool canonicalization", () => {
  it("canonicalizes droid tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("Execute", "factory")).toBe("Bash");
    expect(canonicalizeToolName("Read", "factory")).toBe("Read");
    expect(canonicalizeToolName("Edit", "factory")).toBe("Edit");
    expect(canonicalizeToolName("Create", "factory")).toBe("Write");
    expect(canonicalizeToolName("Grep", "factory")).toBe("Grep");
    expect(canonicalizeToolName("Glob", "factory")).toBe("Glob");
    expect(canonicalizeToolName("LS", "factory")).toBe("LS");
    expect(canonicalizeToolName("FetchUrl", "factory")).toBe("WebFetch");
    expect(canonicalizeToolName("WebSearch", "factory")).toBe("WebSearch");
    expect(canonicalizeToolName("TodoWrite", "factory")).toBe("TodoWrite");
    expect(canonicalizeToolName("Task", "factory")).toBe("Task");
  });

  it("passes unknown droid tools through unchanged (MCP, extensions)", () => {
    expect(canonicalizeToolName("mcp__server__tool", "factory")).toBe("mcp__server__tool");
    expect(canonicalizeToolName("SomeFutureTool", "factory")).toBe("SomeFutureTool");
  });

  it("maps every FACTORY_TOOL_MAP key to a non-empty canonical name", () => {
    for (const [raw, canonical] of Object.entries(FACTORY_TOOL_MAP)) {
      expect(canonicalizeToolName(raw, "factory")).toBe(canonical);
    }
  });
});
