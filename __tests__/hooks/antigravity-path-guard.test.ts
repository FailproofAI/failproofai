// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  ANTIGRAVITY_PATH_GUARD_MATCH,
  antigravityCallLacksPath,
  antigravityPathGuard,
} from "../../src/hooks/antigravity-path-guard";
import { canonicalizeToolInput, canonicalizeToolName } from "../../src/hooks/tool-name-canonicalize";
import type { PolicyContext } from "../../src/hooks/policy-types";

/** The call as a policy sees it, after the same canonicalization the handler runs. */
function ctxFor(rawTool: string, rawInput: unknown): PolicyContext {
  const toolName = canonicalizeToolName(rawTool, "antigravity");
  return {
    eventType: "PreToolUse",
    payload: {},
    toolName,
    toolInput: canonicalizeToolInput(toolName, rawInput, "antigravity") as Record<string, unknown> | undefined,
    cli: "antigravity",
  };
}

describe("antigravity path guard", () => {
  it.each([
    ["no arguments", "read_file", undefined],
    ["an unknown path key", "read_file", { FilePath: "/x/.env" }],
    ["content but no path", "write_file", { Content: "x" }],
    ["strings to replace but no path", "edit_file", { Target: "a", Replacement: "b" }],
    ["an empty path", "read_file", { Path: "" }],
    ["a blank path", "write_file", { Path: "   ", Content: "x" }],
    ["a path that is not a string", "edit_file", { Path: ["/x/.env"] }],
  ])("refuses %s", (_label, tool, input) => {
    const result = antigravityPathGuard(ctxFor(tool, input));
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/could not find a file path/);
  });

  // Every spelling in ANTIGRAVITY_TOOL_INPUT_MAP, so a mapped call is never refused.
  it.each([
    ["read_file", { Path: "/p/a" }],
    ["view_file", { AbsolutePath: "/p/a" }],
    ["view_file", { File: "/p/a" }],
    ["view_file", { TargetFile: "/p/a" }],
    ["write_file", { Path: "/p/a", Content: "x" }],
    ["write_to_file", { TargetFile: "/p/a", CodeContent: "x" }],
    ["edit_file", { Path: "/p/a", Target: "a", Replacement: "b" }],
    ["replace_file_content", { TargetFile: "/p/a" }],
  ])("allows %s with %j", (tool, input) => {
    expect(antigravityPathGuard(ctxFor(tool, input)).decision).toBe("allow");
  });

  it("registers only for a call that needs refusing, so normal calls' activity rows do not change", () => {
    expect(antigravityCallLacksPath("PreToolUse", "Read", { file_path: "/p/a" })).toBe(false);
    expect(antigravityCallLacksPath("PreToolUse", "Read", {})).toBe(true);
    expect(antigravityCallLacksPath("PreToolUse", "Read", undefined)).toBe(true);
    expect(antigravityCallLacksPath("PostToolUse", "Read", {})).toBe(false);
    expect(antigravityCallLacksPath("PreToolUse", "Bash", {})).toBe(false);
    expect(antigravityCallLacksPath("PreToolUse", "ask_question", {})).toBe(false);
    expect(antigravityCallLacksPath("PreToolUse", undefined, {})).toBe(false);
  });

  it("routes only to the file tools, before they run", () => {
    expect(ANTIGRAVITY_PATH_GUARD_MATCH).toEqual({ events: ["PreToolUse"], toolNames: ["Read", "Write", "Edit"] });
  });
});
