// @vitest-environment node
//
// Locks in Goose (codename goose, Block) tool NAME + tool-INPUT canonicalization
// (verified live against goose v1.43.0: developer tools arrive bare — `shell`,
// `write`, `edit`, `view`, `read_image`, `tree` — while other extensions
// namespace theirs, e.g. `todo__todo_write`; path-bearing tools deliver the path
// as `path` (or `source` for read_image), which builtins read as `file_path`).
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";
import {
  GOOSE_HOOK_EVENT_TYPES,
  GOOSE_TOOL_MAP,
  GOOSE_TOOL_INPUT_MAP,
  HOOK_EVENT_TYPES,
} from "@/src/hooks/types";

describe("Goose event types", () => {
  it("are all already-canonical PascalCase HookEventTypes (no event map needed)", () => {
    const canonical = new Set<string>(HOOK_EVENT_TYPES);
    for (const ev of GOOSE_HOOK_EVENT_TYPES) {
      expect(canonical.has(ev), `${ev} must be a HookEventType`).toBe(true);
    }
  });

  it("subscribes to the 5 events failproofai installs (no Stop — goose has none)", () => {
    expect(GOOSE_HOOK_EVENT_TYPES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SessionEnd",
    ]);
    // Goose 1.43.0 has NO Stop event — the require-*-before-stop builtins are
    // inapplicable, so Stop must not be installed.
    expect(GOOSE_HOOK_EVENT_TYPES).not.toContain("Stop");
  });
});

describe("Goose tool-name canonicalization", () => {
  it("canonicalizes bare developer tool ids to Claude builtins", () => {
    expect(canonicalizeToolName("shell", "goose")).toBe("Bash");
    expect(canonicalizeToolName("write", "goose")).toBe("Write");
    expect(canonicalizeToolName("edit", "goose")).toBe("Edit");
    expect(canonicalizeToolName("view", "goose")).toBe("Read");
    expect(canonicalizeToolName("read_image", "goose")).toBe("Read");
    expect(canonicalizeToolName("glob", "goose")).toBe("Glob");
    expect(canonicalizeToolName("grep", "goose")).toBe("Grep");
    expect(canonicalizeToolName("tree", "goose")).toBe("LS");
    expect(canonicalizeToolName("delegate", "goose")).toBe("Task");
  });

  it("canonicalizes namespaced extension tools (<ext>__<tool>)", () => {
    expect(canonicalizeToolName("todo__todo_write", "goose")).toBe("TodoWrite");
  });

  it("passes unknown / other-extension tools through unchanged", () => {
    expect(canonicalizeToolName("analyze", "goose")).toBe("analyze");
    expect(canonicalizeToolName("mcp__server__tool", "goose")).toBe("mcp__server__tool");
    expect(canonicalizeToolName("SomeFutureTool", "goose")).toBe("SomeFutureTool");
  });

  it("maps every GOOSE_TOOL_MAP key to its declared canonical name", () => {
    for (const [raw, canonical] of Object.entries(GOOSE_TOOL_MAP)) {
      expect(canonicalizeToolName(raw, "goose")).toBe(canonical);
    }
  });
});

describe("Goose tool-input canonicalization", () => {
  it("maps write/edit `path` → `file_path` so path builtins fire", () => {
    expect(canonicalizeToolInput("Write", { path: "/tmp/x", content: "hi" }, "goose")).toEqual({
      file_path: "/tmp/x",
      content: "hi",
    });
    expect(canonicalizeToolInput("Edit", { path: "/tmp/x", before: "a", after: "b" }, "goose")).toEqual({
      file_path: "/tmp/x",
      before: "a",
      after: "b",
    });
  });

  it("maps read `path` AND read_image `source` → `file_path`", () => {
    expect(canonicalizeToolInput("Read", { path: "/tmp/f.txt" }, "goose")).toEqual({
      file_path: "/tmp/f.txt",
    });
    expect(canonicalizeToolInput("Read", { source: "/tmp/img.png" }, "goose")).toEqual({
      file_path: "/tmp/img.png",
    });
  });

  it("leaves shell `command` untouched (already canonical for Bash builtins)", () => {
    expect(canonicalizeToolInput("Bash", { command: "echo hi" }, "goose")).toEqual({
      command: "echo hi",
    });
  });

  it("has a GOOSE_TOOL_INPUT_MAP keyed by canonical tool names only", () => {
    for (const key of Object.keys(GOOSE_TOOL_INPUT_MAP)) {
      expect(["Read", "Write", "Edit", "LS"]).toContain(key);
    }
  });
});
