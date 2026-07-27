// @vitest-environment node
/**
 * AdaL payload canonicalization.
 *
 * AdaL is the only integration that needs NO event map: its lifecycle event
 * names are already the canonical PascalCase forms, so they must survive
 * canonicalization byte-for-byte. Tool names, however, are snake_case
 * internally and must map onto the Claude vocabulary that builtin policies
 * match on (Bash / Read / Write / Edit / …).
 */
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "../../src/hooks/tool-name-canonicalize";
import { ADAL_TOOL_MAP, HOOK_EVENT_TYPES } from "../../src/hooks/types";
import { adal } from "../../src/hooks/integrations";

describe("AdaL event names need no mapping", () => {
  it("every event AdaL fires is already a canonical HookEventType", () => {
    for (const event of adal.eventTypes) {
      expect(HOOK_EVENT_TYPES).toContain(event);
    }
  });
});

describe("canonicalizeToolName(cli: adal)", () => {
  it("maps AdaL shell and search tools onto the Claude vocabulary", () => {
    expect(canonicalizeToolName("bash", "adal")).toBe("Bash");
    expect(canonicalizeToolName("grep", "adal")).toBe("Grep");
    expect(canonicalizeToolName("glob", "adal")).toBe("Glob");
  });

  it("maps every AdaL file tool onto Read/Write/Edit", () => {
    expect(canonicalizeToolName("read_file", "adal")).toBe("Read");
    expect(canonicalizeToolName("read_image", "adal")).toBe("Read");
    expect(canonicalizeToolName("write_file", "adal")).toBe("Write");
    expect(canonicalizeToolName("create_file", "adal")).toBe("Write");
    expect(canonicalizeToolName("rewrite_file", "adal")).toBe("Write");
    expect(canonicalizeToolName("replace_by_string", "adal")).toBe("Edit");
    expect(canonicalizeToolName("delete_lines", "adal")).toBe("Edit");
  });

  it("maps AdaL web tools", () => {
    expect(canonicalizeToolName("fetch_url", "adal")).toBe("WebFetch");
    expect(canonicalizeToolName("web_search", "adal")).toBe("WebSearch");
  });

  it("passes unknown and MCP tool names through unchanged", () => {
    expect(canonicalizeToolName("mcp__my-server__exec", "adal")).toBe("mcp__my-server__exec");
    expect(canonicalizeToolName("some_future_tool", "adal")).toBe("some_future_tool");
  });

  it("leaves undefined alone", () => {
    expect(canonicalizeToolName(undefined, "adal")).toBeUndefined();
  });

  it("every ADAL_TOOL_MAP target is a name builtin policies recognise", () => {
    for (const canonical of Object.values(ADAL_TOOL_MAP)) {
      expect(canonical[0]).toBe(canonical[0].toUpperCase());
    }
  });
});

describe("canonicalizeToolInput(cli: adal)", () => {
  it("maps create_file's new_string body onto content so write builtins fire", () => {
    const out = canonicalizeToolInput("Write", { file_path: "/tmp/a.txt", new_string: "secret" }, "adal");
    expect(out).toEqual({ file_path: "/tmp/a.txt", content: "secret" });
  });

  it("leaves already-canonical file paths untouched", () => {
    const input = { file_path: "/tmp/a.txt" };
    expect(canonicalizeToolInput("Read", input, "adal")).toEqual(input);
  });

  it("leaves bash command input untouched", () => {
    const input = { command: "ls -la" };
    expect(canonicalizeToolInput("Bash", input, "adal")).toEqual(input);
  });

  it("passes arrays and non-objects through verbatim", () => {
    expect(canonicalizeToolInput("Write", ["a", "b"], "adal")).toEqual(["a", "b"]);
    expect(canonicalizeToolInput("Write", undefined, "adal")).toBeUndefined();
  });

  it("is idempotent when input is already canonical", () => {
    const once = canonicalizeToolInput("Write", { content: "x" }, "adal");
    expect(canonicalizeToolInput("Write", once, "adal")).toEqual({ content: "x" });
  });
});
