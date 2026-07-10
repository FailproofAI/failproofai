// @vitest-environment node
//
// Locks in Hermes tool NAME + INPUT canonicalization so builtin policies fire.
// Arg shapes were verified against a live ~/.hermes/state.db: read_file /
// write_file / patch deliver the file path as `path` (Claude builtins read
// `file_path`); search_files already uses `path`/`pattern`.
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";

describe("Hermes tool canonicalization", () => {
  it("canonicalizes Hermes tool names to Claude builtins", () => {
    expect(canonicalizeToolName("terminal", "hermes")).toBe("Bash");
    expect(canonicalizeToolName("read_file", "hermes")).toBe("Read");
    expect(canonicalizeToolName("write_file", "hermes")).toBe("Write");
    expect(canonicalizeToolName("patch", "hermes")).toBe("Edit");
    expect(canonicalizeToolName("search_files", "hermes")).toBe("Grep");
  });

  it("maps Hermes's `path` arg to `file_path` for Read/Write/Edit so path builtins fire", () => {
    // Input keys are canonicalized under the CANONICAL tool name (the handler
    // canonicalizes the name first).
    expect(canonicalizeToolInput("Read", { path: "/srv/.env" }, "hermes")).toEqual({ file_path: "/srv/.env" });
    expect(canonicalizeToolInput("Write", { path: "/srv/x", content: "secret" }, "hermes")).toEqual({
      file_path: "/srv/x",
      content: "secret",
    });
    expect(canonicalizeToolInput("Edit", { path: "/srv/x", old_string: "a", new_string: "b" }, "hermes")).toEqual({
      file_path: "/srv/x",
      old_string: "a",
      new_string: "b",
    });
  });

  it("leaves already-canonical Grep and Bash inputs unchanged", () => {
    // search_files delivers `path`/`pattern` — already the Claude Grep keys.
    expect(canonicalizeToolInput("Grep", { path: "/srv", pattern: "TODO" }, "hermes")).toEqual({
      path: "/srv",
      pattern: "TODO",
    });
    expect(canonicalizeToolInput("Bash", { command: "sudo rm -rf /" }, "hermes")).toEqual({
      command: "sudo rm -rf /",
    });
  });
});
