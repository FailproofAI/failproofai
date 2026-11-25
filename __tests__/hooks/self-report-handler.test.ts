// @vitest-environment node
/**
 * The Self Reports short-circuit in evaluateHookEvent: a call to the report
 * tool is allowed before ANY policy, pause, fail-closed or Jev logic, and is
 * recorded on its activity row. The control call in each case (a plain Bash
 * call) shows the same setup really does deny, so an allow is not vacuous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hooks-config", () => ({
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })),
}));
vi.mock("../../src/hooks/custom-hooks-loader", () => ({ loadAllCustomHooks: vi.fn() }));
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-instance-id") }));
vi.mock("../../src/hooks/untraced-note", () => ({ noteUntracedAgent: vi.fn(() => false) }));
vi.mock("../../src/hooks/pack-manifest", () => ({
  readInstalledPacks: vi.fn(() => ({ packs: [], errors: [] })),
  hasInstalledPacks: vi.fn(() => false),
  hasInstalledRegexPacks: vi.fn(() => false),
}));
vi.mock("../../src/hooks/effective-reviewers", async (orig) => {
  const real = await orig<typeof import("../../src/hooks/effective-reviewers")>();
  // "Jev is configured": every gate that reaches the two-tier path asks this.
  return { ...real, jevChecksInstalled: vi.fn(() => true), packJevChecksInstalled: vi.fn(() => true) };
});

import { evaluateHookEvent } from "../../src/hooks/handler";
import { loadAllCustomHooks } from "../../src/hooks/custom-hooks-loader";
import { readMergedHooksConfig } from "../../src/hooks/hooks-config";
import { jevChecksInstalled } from "../../src/hooks/effective-reviewers";
import { writePause } from "../../src/hooks/session-pause";
import { _resetForTest } from "../../src/hooks/hook-activity-store";

const SESSION = "sr-session";
let home: string;

function payload(toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SESSION, cwd: "/tmp/project", tool_name: toolName, tool_input: toolInput, ...extra });
}
const report = (extra: Record<string, unknown> = {}) =>
  payload("mcp__failproofai__report", { category: "invalid_tool_or_credential", detail: "tracker rejected its API key" }, extra);
const bash = () => payload("Bash", { command: "echo hi" });

function rows(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(home, "hook-activity", "current.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "fpai-sr-handler-"));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_STATE_DIR = join(home, "state");
  _resetForTest(join(home, "hook-activity"));
  // A custom policy that denies everything, on every event.
  vi.mocked(loadAllCustomHooks).mockImplementation((async () => ({
    hooks: [
      Object.assign(
        { name: "deny-all", description: "", match: {}, fn: async () => ({ decision: "deny", reason: "nothing passes" }) },
        { __policyId: "custom:/tmp/deny.mjs:deny-all" },
      ),
    ],
    conventionSources: [],
  })) as never);
});

afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_STATE_DIR;
  _resetForTest();
  rmSync(home, { recursive: true, force: true });
});

describe("Self Reports short-circuit", () => {
  it("control: the deny-everything policy really denies an ordinary call", async () => {
    const out = await evaluateHookEvent("PreToolUse", "claude", bash());
    expect(out.evaluation?.decision).toBe("deny");
    expect(out.stdout).toContain("deny");
  });

  it("allows the report tool even with a deny-everything custom policy, and loads no policy at all", async () => {
    const out = await evaluateHookEvent("PreToolUse", "claude", report());
    expect(out).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    expect(out.evaluation?.decision).toBe("allow");
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
    expect(readMergedHooksConfig).not.toHaveBeenCalled();
  });

  it("records the report on its activity row", async () => {
    await evaluateHookEvent("PreToolUse", "claude", report({ tool_use_id: "toolu_1" }));
    const [row] = rows();
    expect(row).toMatchObject({
      eventType: "PreToolUse",
      integration: "claude",
      toolName: "mcp__failproofai__report",
      decision: "allow",
      policyName: null,
      sessionId: SESSION,
      toolCallId: "toolu_1",
      selfReport: { category: "invalid_tool_or_credential", detail: "tracker rejected its API key", source: "mcp" },
    });
  });

  it("allows it with fail-closed forced (daemon unreachable), while the control call is denied", async () => {
    const force = { forceDecision: { decision: "deny" as const, reason: "daemon down" } };
    expect((await evaluateHookEvent("PreToolUse", "claude", bash(), force)).evaluation?.decision).toBe("deny");
    const out = await evaluateHookEvent("PreToolUse", "claude", report(), force);
    expect(out.evaluation?.decision).toBe("allow");
    expect(out.stdout).toBe("");
  });

  it("allows it while the session is paused, and the row carries no pause fields", async () => {
    writePause({ sessionId: SESSION, durationMs: 600_000 });
    const out = await evaluateHookEvent("PreToolUse", "claude", report());
    expect(out.evaluation?.decision).toBe("allow");
    const row = rows().pop()!;
    expect(row.pausedBy).toBeUndefined();
    expect(row.selfReport).toBeDefined();
  });

  it("never reaches Jev, which a gate otherwise consults", async () => {
    await evaluateHookEvent("PreToolUse", "claude", bash());
    expect(jevChecksInstalled).toHaveBeenCalled();
    vi.mocked(jevChecksInstalled).mockClear();
    await evaluateHookEvent("PreToolUse", "claude", report());
    expect(jevChecksInstalled).not.toHaveBeenCalled();
  });

  it("allows on PermissionRequest too, persisting the row without a second report", async () => {
    const out = await evaluateHookEvent("PermissionRequest", "claude", report());
    expect(out.evaluation?.decision).toBe("allow");
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
    const row = rows().pop()!;
    expect(row.eventType).toBe("PermissionRequest");
    expect(row.selfReport).toBeUndefined();
  });

  it("one call (PreToolUse + PermissionRequest + PostToolUse) yields exactly one row with selfReport", async () => {
    for (const ev of ["PreToolUse", "PermissionRequest", "PostToolUse"]) {
      expect((await evaluateHookEvent(ev, "claude", report())).evaluation?.decision).toBe("allow");
    }
    const all = rows();
    expect(all.map((r) => r.eventType)).toEqual(["PreToolUse", "PermissionRequest", "PostToolUse"]);
    expect(all.filter((r) => r.selfReport !== undefined).map((r) => r.eventType)).toEqual(["PreToolUse"]);
  });

  it("records PostToolUse without evaluating it and without a second report", async () => {
    const out = await evaluateHookEvent("PostToolUse", "claude", report());
    expect(out.evaluation?.decision).toBe("allow");
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
    const row = rows().pop()!;
    expect(row.eventType).toBe("PostToolUse");
    expect(row.selfReport).toBeUndefined();
  });

  it("recognises Codex's snake_case event and its name for the tool", async () => {
    const out = await evaluateHookEvent("pre_tool_use", "codex", report());
    expect(out.evaluation?.decision).toBe("allow");
    expect(rows().pop()!.selfReport).toMatchObject({ category: "invalid_tool_or_credential" });
  });

  it("files another agent's spelling under the canonical name", async () => {
    const out = await evaluateHookEvent("PreToolUse", "claude", payload("failproofai__report", { category: "looping", detail: "x" }));
    expect(out.evaluation?.decision).toBe("allow");
    expect(rows().pop()!.toolName).toBe("mcp__failproofai__report");
  });

  it("for an agent whose MCP server records, allows but leaves the report to the server", async () => {
    const out = await evaluateHookEvent("PreToolUse", "factory", report());
    expect(out.evaluation?.decision).toBe("allow");
    const row = rows().pop()!;
    expect(row.integration).toBe("factory");
    expect(row.selfReport).toBeUndefined();
  });

  it("records an unknown category as-is, a missing detail as empty, and cuts detail at 2000", async () => {
    await evaluateHookEvent("PreToolUse", "claude", payload("mcp__failproofai__report", { category: "made_up" }));
    expect(rows().pop()!.selfReport).toEqual({ category: "made_up", detail: "", source: "mcp" });
    await evaluateHookEvent("PreToolUse", "claude", payload("mcp__failproofai__report", { category: "looping", detail: "y".repeat(5000) }));
    expect((rows().pop()!.selfReport as { detail: string }).detail).toHaveLength(2000);
  });

  it("does not exempt a lookalike tool name", async () => {
    const out = await evaluateHookEvent("PreToolUse", "claude", payload("mcp__failproofai__report_evil", {}));
    expect(out.evaluation?.decision).toBe("deny");
  });
});
