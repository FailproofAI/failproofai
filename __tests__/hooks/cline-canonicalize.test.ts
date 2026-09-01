// @vitest-environment node
/**
 * Cline's wire contract, pinned against what was captured off a LIVE run.
 *
 * Every expectation here is a transcription of a real cline v3.0.60 payload or
 * a real observed behaviour, not a reading of its docs — which is the point,
 * because the docs describe hook policies (`failureMode`, `mode: blocking`) that
 * the shipped CLI does not have, and describe the hook surface in terms of an
 * SDK plugin API that cannot register a tool gate at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { canonicalizeToolName, canonicalizeToolInput } from "@/src/hooks/tool-name-canonicalize";
import { normalizeCliPayload } from "@/src/hooks/normalize-cli-payload";
import { evaluatePolicies } from "@/src/hooks/policy-evaluator";
import { registerPolicy, clearPolicies } from "@/src/hooks/policy-registry";
import { deny, instruct } from "@/src/hooks/policy-helpers";
import { CLINE_EVENT_MAP, CLINE_HOOK_EVENT_TYPES } from "@/src/hooks/types";
import { splitApplyPatch } from "@/src/hooks/batch-expand";
import type { SessionMetadata } from "@/src/hooks/types";

const session: SessionMetadata = {
  sessionId: "t",
  transcriptPath: "/dev/null",
  cwd: "/repo",
  cli: "cline",
};

describe("cline tool names", () => {
  it.each([
    ["run_commands", "Bash"],
    ["read_files", "Read"],
    ["search_codebase", "Grep"],
    ["apply_patch", "Edit"],
  ])("maps %s → %s", (raw, canonical) => {
    expect(canonicalizeToolName(raw, "cline")).toBe(canonical);
  });

  it("passes an unknown tool through so it still reaches the audit", () => {
    expect(canonicalizeToolName("browser_action", "cline")).toBe("browser_action");
  });
});

describe("cline event map", () => {
  it("excludes PreCompact — it maps to undefined upstream and is skipped", () => {
    // Installing a file for it costs a subprocess per compaction and buys
    // nothing, so it is deliberately not one of the nine we write.
    expect(CLINE_HOOK_EVENT_TYPES).not.toContain("PreCompact");
    expect(CLINE_HOOK_EVENT_TYPES).toHaveLength(9);
  });

  it("maps every installed event onto an existing canonical event", async () => {
    const { HOOK_EVENT_TYPES } = await import("@/src/hooks/types");
    for (const e of CLINE_HOOK_EVENT_TYPES) {
      expect(HOOK_EVENT_TYPES).toContain(CLINE_EVENT_MAP[e]);
    }
  });

  it("collapses the two session-ending events onto SessionEnd", () => {
    expect(CLINE_EVENT_MAP.TaskCancel).toBe("SessionEnd");
    expect(CLINE_EVENT_MAP.SessionShutdown).toBe("SessionEnd");
    expect(CLINE_EVENT_MAP.TaskStart).toBe("SessionStart");
    expect(CLINE_EVENT_MAP.TaskResume).toBe("SessionStart");
  });
});

describe("cline payload normalization", () => {
  /** Captured verbatim from a live PreToolUse hook on cline v3.0.60. */
  const LIVE = {
    hookName: "tool_call",
    iteration: 1,
    taskId: "conv_1788255622579_zzx8kw9",
    userId: "chetan",
    workspaceRoots: ["/repo"],
    workspaceInfo: { rootPath: "/repo", hint: "repo" },
    agent_id: "agent_1",
    parent_agent_id: null,
    sessionContext: { rootSessionId: "1788255622392_vg8rv" },
    tool_call: { id: "call_9Nc", name: "run_commands", input: { commands: ["echo hookprobe"] } },
    preToolUse: { toolName: "run_commands", parameters: { commands: '["echo hookprobe"]' } },
  };

  it("reads tool_call.input, NOT preToolUse.parameters", () => {
    // preToolUse.parameters JSON-STRINGIFIES arrays. Reading it would hand the
    // batch expander a string and silently drop the entire fan-out.
    const p: Record<string, unknown> = { ...LIVE };
    normalizeCliPayload("cline", p);
    expect(p.tool_name).toBe("run_commands");
    expect(p.tool_input).toEqual({ commands: ["echo hookprobe"] });
    expect(Array.isArray((p.tool_input as Record<string, unknown>).commands)).toBe(true);
  });

  it("derives session_id from taskId and cwd from workspaceRoots[0]", () => {
    const p: Record<string, unknown> = { ...LIVE };
    normalizeCliPayload("cline", p);
    expect(p.session_id).toBe("conv_1788255622579_zzx8kw9");
    expect(p.cwd).toBe("/repo");
  });

  it("falls back to workspaceInfo.rootPath when workspaceRoots is absent", () => {
    const p: Record<string, unknown> = { ...LIVE, workspaceRoots: undefined };
    normalizeCliPayload("cline", p);
    expect(p.cwd).toBe("/repo");
  });

  it("falls back to preToolUse only when tool_call is missing entirely", () => {
    const p: Record<string, unknown> = { ...LIVE, tool_call: undefined };
    normalizeCliPayload("cline", p);
    expect(p.tool_name).toBe("run_commands");
  });

  it("does NOT map hookName onto hook_event_name", () => {
    // hookName is cline's INTERNAL name ("tool_call"), not the filename event;
    // the --hook argument already carries the canonical one.
    const p: Record<string, unknown> = { ...LIVE };
    normalizeCliPayload("cline", p);
    expect(p.hook_event_name).toBeUndefined();
  });
});

describe("cline apply_patch splitting", () => {
  it("keeps paths in literal file order across Add / Delete / Move", () => {
    // Move-to is a rename MODIFIER: the section being renamed flushes first, so
    // `Update File: a` + `Move to: b` yields [a, b] and never [b, a].
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "*** Update File: a.ts",
      "@@",
      "-x",
      "+y",
      "*** Move to: b.ts",
      "*** End Patch",
    ].join("\n");
    expect(splitApplyPatch(patch).map((s) => s.path)).toEqual(["new.ts", "a.ts", "b.ts"]);
  });

  it("sees a rename INTO a sensitive path as its own element", () => {
    const patch = ["*** Begin Patch", "*** Update File: ok.ts", "@@", "-x", "+y", "*** Move to: .env", "*** End Patch"].join("\n");
    expect(splitApplyPatch(patch).map((s) => s.path)).toContain(".env");
  });
});

describe("cline verdict shapes", () => {
  beforeEach(() => clearPolicies());

  it("deny emits {cancel:true, errorMessage} at exit 0 — cline ignores the exit code", async () => {
    registerPolicy("test/blocker", "blocks", async () => deny("nope"), {}, 0);
    const r = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, session, undefined);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout as string);
    expect(out).toMatchObject({ cancel: true });
    expect(typeof out.errorMessage).toBe("string");
    // cline's schema has no decision/block/permissionDecision field at all.
    expect(out.decision).toBeUndefined();
    expect(out.permissionDecision).toBeUndefined();
  });

  it("Stop does NOT cancel — that would kill an already-completed run", async () => {
    registerPolicy("test/blocker", "blocks", async () => deny("finish up"), { events: ["Stop"] }, 0);
    const r = await evaluatePolicies("Stop", {}, session, undefined);
    const out = JSON.parse(r.stdout as string);
    expect(out.cancel).toBeUndefined();
    expect(typeof out.context).toBe("string");
    expect(out.context).toContain("MANDATORY ACTION REQUIRED");
  });

  it("instruct uses cline's real context channel, and mirrors to stderr", async () => {
    registerPolicy("test/instructor", "instructs", async () => instruct("do the thing"), {}, 0);
    const r = await evaluatePolicies("PreToolUse", { tool_name: "Bash" }, session, undefined);
    const out = JSON.parse(r.stdout as string);
    expect(out.context).toContain("do the thing");
    expect(r.stderr).toContain("do the thing");
  });
});

describe("cline safety net (non-fan-out paths)", () => {
  it("collapses search queries into one alternation", () => {
    const out = canonicalizeToolInput("Grep", { queries: ["alpha", "beta"] }, "cline") as Record<string, unknown>;
    expect(out.pattern).toBe("alpha|beta");
    expect(out.cline_queries).toEqual(["alpha", "beta"]);
  });

  it("leaves an unrecognised cline tool input untouched", () => {
    expect(canonicalizeToolInput("browser_action", { url: "x" }, "cline")).toEqual({ url: "x" });
  });
});
