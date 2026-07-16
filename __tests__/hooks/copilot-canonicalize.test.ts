// @vitest-environment node
//
// Locks in Copilot CLI tool-INPUT canonicalization (verified live against
// Copilot CLI 1.0.71). The snake_case hook events deliver `tool_name` already
// canonical (`Bash`, `Read`, `Write`, `Edit`, `Grep`), but the file tools'
// input keys are Copilot's own: `path` instead of `file_path`, Write's content
// as `file_text`, Edit's strings as `old_str`/`new_str`. Without the map, a
// live `.env` read was observed sailing past block-env-files.
//
// Fixtures below are verbatim captures from a real 1.0.71 session
// (recorder hook, 2026-07-16).
import { describe, it, expect } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";
import { COPILOT_TOOL_INPUT_MAP } from "@/src/hooks/types";

describe("Copilot tool-input canonicalization (verified 1.0.71 captures)", () => {
  it("maps Read's `path` to `file_path` (the .env-read bypass)", () => {
    const captured = { path: "/home/user/project/.env" };
    expect(canonicalizeToolInput("Read", captured, "copilot")).toEqual({
      file_path: "/home/user/project/.env",
    });
  });

  it("maps Write's `path`/`file_text` to `file_path`/`content`", () => {
    const captured = { path: "/home/user/project/demo.txt", file_text: "hello" };
    expect(canonicalizeToolInput("Write", captured, "copilot")).toEqual({
      file_path: "/home/user/project/demo.txt",
      content: "hello",
    });
  });

  it("maps Edit's `path`/`old_str`/`new_str` to canonical keys", () => {
    const captured = { path: "/home/user/project/demo.txt", old_str: "hello", new_str: "world" };
    expect(canonicalizeToolInput("Edit", captured, "copilot")).toEqual({
      file_path: "/home/user/project/demo.txt",
      old_string: "hello",
      new_string: "world",
    });
  });

  it("leaves Bash input untouched (`command` is already canonical)", () => {
    const captured = { command: "sudo whoami", description: "Run sudo whoami" };
    expect(canonicalizeToolInput("Bash", captured, "copilot")).toEqual(captured);
  });

  it("leaves Grep input untouched (`pattern` is already canonical)", () => {
    const captured = { pattern: "world", output_mode: "files_with_matches" };
    expect(canonicalizeToolInput("Grep", captured, "copilot")).toEqual(captured);
  });

  it("passes canonical PreToolUse tool names through unchanged", () => {
    // 1.0.71's snake_case events send canonical names — COPILOT_TOOL_MAP's
    // lowercase entries must not mangle them.
    for (const name of ["Bash", "Read", "Write", "Edit", "Grep"]) {
      expect(canonicalizeToolName(name, "copilot")).toBe(name);
    }
  });

  it("still canonicalizes lowercase names (permissionRequest + older CLIs)", () => {
    // permissionRequest delivers `toolName: "bash"` (lowercase) even on 1.0.71.
    expect(canonicalizeToolName("bash", "copilot")).toBe("Bash");
    expect(canonicalizeToolName("view", "copilot")).toBe("Read");
  });

  it("only maps the three file tools (no accidental key rewrites elsewhere)", () => {
    expect(Object.keys(COPILOT_TOOL_INPUT_MAP).sort()).toEqual(["Edit", "Read", "Write"]);
  });
});
