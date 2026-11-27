// @vitest-environment node
//
// Text an agent types into a running shell (FailproofAI/agenteye#1898): Codex's
// `write_stdin` sends it as `chars`, Copilot's `write_bash` as `input`, and every
// shell policy reads only `command`. Payload shapes are taken from the agents'
// own tool schemas: codex-cli 0.172 and Copilot CLI 1.0.114.
import { describe, it, expect } from "vitest";
import { readTypedText, typedShellInput, typedInputGuardFor, typedInputGuardActive } from "../../src/hooks/typed-shell-input";
import type { PolicyContext } from "../../src/hooks/policy-types";

describe("readTypedText", () => {
  it.each([
    ["one line", "rm -rf ~/.failproofai\n", "rm -rf ~/.failproofai"],
    ["several lines", "cd /tmp\nrm -rf x\n", "cd /tmp\nrm -rf x"],
    ["a carriage return as Enter", "ls\r", "ls"],
    ["CRLF line ends", "a\r\nb\r\n", "a\nb"],
    ["a heredoc sent whole", "cat > notes <<'EOF'\nline\nEOF\n", "cat > notes <<'EOF'\nline\nEOF"],
    ["an escaped backslash at the end", "echo a\\\\\n", "echo a\\\\"],
    ["a quote closed on the same line", "echo 'it''s'\n", "echo 'it''s'"],
    ["a comment with a quote in it", "ls # don't\n", "ls # don't"],
  ])("reads %s as the lines it runs", (_label, text, command) => {
    expect(readTypedText(text)).toEqual({ kind: "command", command });
  });

  it.each([
    ["an empty write, which polls for output", ""],
    ["Ctrl-C", "\u0003"],
    ["Ctrl-D", "\u0004"],
    ["an arrow key and Enter", "\u001b[A\n"],
    ["Enter alone", "\n"],
    // Every write it accepts ends its line and carries no editing keys, so the
    // shell's kill buffer only ever holds text that was already judged.
    ["Ctrl-Y alone", "\u0019\n"],
  ])("gives nothing to judge for %s", (_label, text) => {
    expect(readTypedText(text)).toEqual({ kind: "command", command: "" });
  });

  it.each([
    ["a partial line, which a later write would finish", "rm -rf ~/.fail"],
    ["text after the last line end", "ls\nrm -rf ~/.fail"],
    ["Tab completion", "rm -rf ~/.failpr\t\n"],
    ["Ctrl-W", "rm -rf ~/x\u0017~/.failproofai\n"],
    ["a cursor key mid-line", "rm -rf ~/.f\u001b[Dx\n"],
    ["a trailing backslash, continued in the next write", "cp source \\\n"],
    ["an unclosed quote", "cp source 'ho\n"],
    ["a heredoc whose closing line has not been sent", "cat > notes <<EOF\nline\n"],
    ["a non-string", 42],
    ["a missing field", undefined],
  ])("refuses %s", (_label, text) => {
    expect(readTypedText(text).kind).toBe("unreadable");
  });
});

describe("typedShellInput", () => {
  it("reads Codex write_stdin's chars", () => {
    expect(typedShellInput("codex", "write_stdin", "Bash", { session_id: 1, chars: "rm -rf x\n" })).toEqual({
      kind: "command",
      command: "rm -rf x",
    });
  });

  it.each(["write_bash", "write_powershell"])("reads Copilot %s's input", (tool) => {
    expect(typedShellInput("copilot", tool, "Bash", { shellId: "s1", input: "rm -rf x\n", delay: 1 })).toEqual({
      kind: "command",
      command: "rm -rf x",
    });
  });

  it("knows a typing call by its shape when the name already arrives as Bash", () => {
    expect(typedShellInput("copilot", "Bash", "Bash", { shellId: "s1", input: "rm -rf x\n" })?.kind).toBe("command");
    expect(typedShellInput("codex", "Bash", "Bash", { session_id: 3, chars: "rm -rf x" })?.kind).toBe("unreadable");
  });

  it.each([
    ["a Codex shell command", "codex", "Bash", { command: "ls" }],
    ["Copilot's read_bash, which types nothing", "copilot", "read_bash", { shellId: "s1", delay: 1 }],
    ["Copilot's bash with a shell id", "copilot", "bash", { command: "ls", shellId: "s1" }],
    ["another CLI's tool with an input field", "claude", "Bash", { input: "x", shellId: "s" }],
  ] as const)("leaves %s alone", (_label, cli, raw, input) => {
    expect(typedShellInput(cli, raw, "Bash", input)).toBeUndefined();
  });

  it("leaves a call that is not a shell call alone", () => {
    expect(typedShellInput("codex", "write_stdin", "Edit", { chars: "x" })).toBeUndefined();
  });
});

describe("the guard", () => {
  const ctx = (eventType: string): PolicyContext => ({ eventType, payload: {}, toolName: "Bash", toolInput: {} } as PolicyContext);

  it("denies on PreToolUse and says why", () => {
    const result = typedInputGuardFor("it does not end its line")(ctx("PreToolUse"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("it does not end its line");
  });

  it("allows on any other event", () => {
    expect(typedInputGuardFor("x")(ctx("PostToolUse")).decision).toBe("allow");
  });

  it("is lifted by a pause unless an enforcing Cloud policy is deployed", () => {
    expect(typedInputGuardActive(false, [])).toBe(true);
    expect(typedInputGuardActive(true, [])).toBe(false);
    expect(typedInputGuardActive(true, [{ effect: "observe" }])).toBe(false);
    expect(typedInputGuardActive(true, [{}])).toBe(true);
  });
});
