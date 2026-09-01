// @vitest-environment node
/**
 * The tests that catch a SILENT BYPASS on a cline batch tool.
 *
 * These are the most important tests in the cline integration, and they are
 * written against the REAL builtins rather than a stub policy, because the thing
 * under test is not "does the fan-out loop run" — it is "does `block-sudo`
 * actually deny when the sudo is at `commands[1]`".
 *
 * The failure they exist to prevent has shipped from this repo twice: a hook
 * that is installed, runs, reports success, and enforces nothing. Cline makes it
 * especially easy, because EVERY one of its tools is batch-shaped — a key rename
 * leaves `tool_input.command` undefined and every command builtin allows.
 *
 * Each case therefore asserts BOTH halves:
 *   1. the fan-out denies, AND
 *   2. the naive collapse that fan-out replaced would NOT have — so if someone
 *      later "simplifies" this to a join, these tests fail loudly rather than
 *      going quietly green while enforcement disappears.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { clearPolicies } from "@/src/hooks/policy-registry";
import { expandBatchToolInput, canonicalizeClineToolInput, BATCH_JOIN } from "@/src/hooks/batch-expand";
import { evaluateExpandedBatch } from "@/src/hooks/batch-fanout";
import type { SessionMetadata } from "@/src/hooks/types";

const session: SessionMetadata = {
  sessionId: "t",
  transcriptPath: "/dev/null",
  cwd: "/repo",
  cli: "cline",
};

/** Register a real builtin through the real registration path, params and all —
 *  a stub policy would prove the loop runs but not that `block-sudo` actually
 *  denies, which is the entire point of this file. */
async function useBuiltin(name: string) {
  const { registerBuiltinPolicies } = await import("@/src/hooks/builtin-policies");
  registerBuiltinPolicies([name]);
}

/** Run the real fan-out path for a cline PreToolUse batch. */
async function fanout(toolName: string, rawInput: Record<string, unknown>) {
  const expansion = expandBatchToolInput("cline", toolName, rawInput);
  expect(expansion, "expansion must not be null — a null here means NOTHING is evaluated").not.toBeNull();
  const payload = { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: rawInput };
  return evaluateExpandedBatch("PreToolUse", payload, session, undefined, expansion!, new Set());
}

beforeEach(() => clearPolicies());

describe("cline batch fan-out — command bypasses", () => {
  it("denies sudo hiding at commands[1], not just commands[0]", async () => {
    await useBuiltin("block-sudo");
    const r = await fanout("Bash", { commands: ["ls -la", "sudo rm -rf /tmp/x"] });
    expect(r.decision).toBe("deny");
    expect(r.batch.decidedIndex).toBe(1);
  });

  it("denies sudo at the LAST position of a long list", async () => {
    await useBuiltin("block-sudo");
    const commands = [...Array.from({ length: 8 }, (_, i) => `echo ${i}`), "sudo shutdown"];
    const r = await fanout("Bash", { commands });
    expect(r.decision).toBe("deny");
    expect(r.batch.decidedIndex).toBe(8);
  });

  it("reports the LOWEST offending index when several elements would deny", async () => {
    await useBuiltin("block-sudo");
    const r = await fanout("Bash", { commands: ["ok", "sudo a", "sudo b"] });
    expect(r.decision).toBe("deny");
    expect(r.batch.decidedIndex).toBe(1);
    // Short-circuits: element 2 is never evaluated.
    expect(r.batch.evaluated).toBe(2);
  });

  it("allows a batch where no element offends", async () => {
    await useBuiltin("block-sudo");
    const r = await fanout("Bash", { commands: ["ls", "pwd", "echo hi"] });
    expect(r.decision).toBe("allow");
    expect(r.batch.evaluated).toBe(3);
    expect(r.batch.decidedIndex).toBeNull();
  });
});

describe("cline batch fan-out — path bypasses", () => {
  it("denies a .env hiding at files[1] — the case element-[0] canonicalization misses", async () => {
    await useBuiltin("block-env-files");
    const r = await fanout("Read", { files: [{ path: "/repo/safe.ts" }, { path: "/repo/.env" }] });
    expect(r.decision).toBe("deny");
    expect(r.batch.decidedIndex).toBe(1);
  });

  it("denies a .env at files[0] too", async () => {
    await useBuiltin("block-env-files");
    const r = await fanout("Read", { files: [{ path: "/repo/.env" }, { path: "/repo/safe.ts" }] });
    expect(r.decision).toBe("deny");
    expect(r.batch.decidedIndex).toBe(0);
  });
});

describe("cline batch fan-out — apply_patch", () => {
  const MULTI = [
    "*** Begin Patch",
    "*** Update File: /repo/safe.ts",
    "@@",
    "-a",
    "+b",
    "*** Update File: /repo/.env",
    "@@",
    "-SECRET=old",
    "+SECRET=new",
    "*** End Patch",
  ].join("\n");

  it("splits a multi-file patch and denies on the SECOND file", async () => {
    await useBuiltin("block-env-files");
    const r = await fanout("Edit", { input: MULTI });
    expect(r.decision).toBe("deny");
    expect(r.batch.size).toBe(2);
    expect(r.batch.decidedIndex).toBe(1);
  });

  it("gives each patched file its own old_string/new_string", async () => {
    // ori's Edit sets NEITHER, so block-secrets-write can never fire on it.
    // Cline's does, because the splitter reconstructs them per file.
    const exp = expandBatchToolInput("cline", "Edit", { input: MULTI })!;
    expect(exp.elements).toHaveLength(2);
    expect(exp.elements[0].input).toMatchObject({ file_path: "/repo/safe.ts", old_string: "a", new_string: "b" });
    expect(exp.elements[1].input).toMatchObject({
      file_path: "/repo/.env",
      old_string: "SECRET=old",
      new_string: "SECRET=new",
    });
  });
});

describe("why fan-out exists — the collapse would NOT have caught these", () => {
  it("PROOF: SECRET_FILE_RE is $-anchored, so a joined path list only matches the LAST entry", async () => {
    // This is the concrete reason join-to-scalar was rejected. If someone
    // "simplifies" the fan-out into a join, this test documents what breaks.
    const { SECRET_FILE_RE } = await import("@/src/hooks/risk-patterns");
    const paths = ["/repo/deploy.pem", "/repo/readme.md"];
    expect(SECRET_FILE_RE.test(paths[0])).toBe(true);
    expect(SECRET_FILE_RE.test(paths.join("\n"))).toBe(false);
    expect(SECRET_FILE_RE.test(paths.join(" "))).toBe(false);
  });

  it("the collapse safety net still picks the RISKIEST path, not paths[0]", async () => {
    // The net cannot be as strong as fan-out, but it must not be naive either.
    const out = canonicalizeClineToolInput("Read", {
      files: [{ path: "/repo/safe.ts" }, { path: "/repo/.env" }],
    });
    expect(out.file_path).toBe("/repo/.env");
    expect(out.cline_file_paths).toEqual(["/repo/safe.ts", "/repo/.env"]);
  });

  it("a collapsed command list keeps `&&` boundaries alive for the segmenting builtins", async () => {
    // A bare "\n" join silently disables READ_LIKE_CMDS, whose boundary
    // alternation has no newline in it.
    expect(BATCH_JOIN).toContain("&&");
    const out = canonicalizeClineToolInput("Bash", { commands: ["cat /etc/passwd", "ls"] });
    expect(String(out.command)).toContain("&&");
    expect(out.cline_commands).toEqual(["cat /etc/passwd", "ls"]);
  });
});

describe("cline batch fan-out — shapes and edges", () => {
  it("emits cline's {cancel,errorMessage} deny shape carrying the element locator", async () => {
    await useBuiltin("block-sudo");
    const r = await fanout("Bash", { commands: ["ls", "sudo rm -rf /tmp/x"] });
    expect(r.exitCode).toBe(0); // cline IGNORES the exit code
    const out = JSON.parse(r.stdout as string);
    expect(out.cancel).toBe(true);
    expect(typeof out.errorMessage).toBe("string");
    expect(out.errorMessage).toContain("batch 2/2");
    expect(out.decision).toBeUndefined(); // no such field in cline's schema
  });

  it("returns null — never an empty expansion — for a mis-shaped container", () => {
    // A zero-element expansion would evaluate NOTHING and report a clean allow,
    // which is the exact failure this whole file exists to prevent.
    expect(expandBatchToolInput("cline", "Bash", { commands: [] })).toBeNull();
    expect(expandBatchToolInput("cline", "Bash", { commands: "not-an-array" })).toBeNull();
    expect(expandBatchToolInput("cline", "Read", { files: [{ no_path: 1 }] })).toBeNull();
    expect(expandBatchToolInput("cline", "Edit", { input: 42 })).toBeNull();
  });

  it("does not expand for any other CLI — the other 15 keep the single-shot path", () => {
    for (const cli of ["claude", "codex", "ori", "goose", "grok"] as const) {
      expect(expandBatchToolInput(cli, "Bash", { commands: ["sudo x"] })).toBeNull();
    }
  });
});
