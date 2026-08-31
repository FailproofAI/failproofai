// @vitest-environment node
/**
 * Ori's wire contract, pinned against what was captured off a LIVE agent run.
 *
 * Every expectation below is a transcription of a real approval-gate payload
 * from ori 0.12.0+68f9a36 driving nvidia/nemotron-3.5-lightning:free — not a
 * guess from the SDK's type declarations. That distinction is the point: the
 * `edit` case in particular could not have been derived from types, because the
 * path is inside a patch blob rather than in a field.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalizeToolName,
  canonicalizeToolInput,
  oriPatchFilePaths,
} from "@/src/hooks/tool-name-canonicalize";
import { evaluatePolicies } from "@/src/hooks/policy-evaluator";
import { registerPolicy, clearPolicies } from "@/src/hooks/policy-registry";
import { deny, instruct } from "@/src/hooks/policy-helpers";
import type { SessionMetadata } from "@/src/hooks/types";

const oriSession: SessionMetadata = {
  sessionId: "t",
  transcriptPath: "/dev/null",
  cwd: "/tmp",
  cli: "ori",
};

describe("ori tool-name canonicalization", () => {
  // All six were observed at the live gate; ori delivers them lowercase.
  it.each([
    ["bash", "Bash"],
    ["read", "Read"],
    ["write", "Write"],
    ["edit", "Edit"],
    ["glob", "Glob"],
    ["grep", "Grep"],
  ])("maps %s → %s", (raw, canonical) => {
    expect(canonicalizeToolName(raw, "ori")).toBe(canonical);
  });

  it("passes an unknown tool through unchanged so it still reaches the audit", () => {
    expect(canonicalizeToolName("some_future_tool", "ori")).toBe("some_future_tool");
  });
});

describe("ori tool-input canonicalization", () => {
  it("maps read's `path` onto file_path so path builtins fire", () => {
    expect(canonicalizeToolInput("Read", { path: ".env" }, "ori")).toEqual({ file_path: ".env" });
  });

  it("maps write's `path` and leaves `content` alone", () => {
    expect(canonicalizeToolInput("Write", { path: "a.txt", content: "x" }, "ori")).toEqual({
      file_path: "a.txt",
      content: "x",
    });
  });

  it("leaves bash/glob/grep untouched — they already arrive canonical", () => {
    expect(canonicalizeToolInput("Bash", { command: "ls" }, "ori")).toEqual({ command: "ls" });
    expect(canonicalizeToolInput("Glob", { pattern: "*" }, "ori")).toEqual({ pattern: "*" });
    expect(canonicalizeToolInput("Grep", { pattern: "a", path: "f" }, "ori")).toEqual({
      pattern: "a",
      path: "f",
    });
  });
});

describe("ori edit patches", () => {
  // Captured verbatim from the live gate.
  const LIVE_PATCH = [
    "*** Begin Patch",
    "*** Update File: data.txt",
    "@@",
    '-["text":"alpha',
    '+["text":"omega',
    "*** End Patch",
  ].join("\n");

  it("recovers the path from a real captured patch", () => {
    expect(oriPatchFilePaths(LIVE_PATCH)).toEqual(["data.txt"]);
  });

  it("recovers Add / Delete / Move paths too", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "*** Delete File: old.ts",
      "*** Move to: moved.ts",
      "*** End Patch",
    ].join("\n");
    expect(oriPatchFilePaths(patch)).toEqual(["new.ts", "old.ts", "moved.ts"]);
  });

  it("returns nothing for a patch with no file header", () => {
    expect(oriPatchFilePaths("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("derives file_path from the patch so path builtins fire on an edit", () => {
    // Without this, `edit` carries no path at all and block-env-files,
    // block-secrets-write and every other path builtin silently no-op.
    const patch = "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch";
    const out = canonicalizeToolInput("Edit", { patch }, "ori") as Record<string, unknown>;
    expect(out.file_path).toBe(".env");
    expect(out.ori_patch_files).toEqual([".env"]);
    expect(out.patch).toBe(patch);
  });

  it("KNOWN GAP: a multi-file patch exposes only the first path as file_path", () => {
    // Asserted so the limitation is visible and cannot rot into a silent
    // surprise. The full list stays available to custom policies.
    const patch = [
      "*** Begin Patch",
      "*** Update File: safe.ts",
      "*** Update File: .env",
      "*** End Patch",
    ].join("\n");
    const out = canonicalizeToolInput("Edit", { patch }, "ori") as Record<string, unknown>;
    expect(out.file_path).toBe("safe.ts");
    expect(out.ori_patch_files).toEqual(["safe.ts", ".env"]);
  });

  it("leaves a non-string patch alone rather than throwing", () => {
    expect(canonicalizeToolInput("Edit", { patch: 42 }, "ori")).toEqual({ patch: 42 });
  });
});

describe("ori verdict shapes", () => {
  it("deny emits the flat {permission:'deny'} the ori feature parses", async () => {
    clearPolicies();
    registerPolicy("test/blocker", "blocks", async () => deny("nope"), {}, 0);
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, oriSession);
    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(result.stdout as string);
    expect(stdout.permission).toBe("deny");
    expect(typeof stdout.reason).toBe("string");
    expect(stdout.reason.length).toBeGreaterThan(0);
  });

  it("instruct degrades to allow + a stderr note — ori has no context channel", async () => {
    clearPolicies();
    registerPolicy("test/instructor", "instructs", async () => instruct("do the thing"), {}, 0);
    const result = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, oriSession);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("do the thing");
  });
});
