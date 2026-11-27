// @vitest-environment node
/**
 * The Self Reports short-circuit in evaluateHookEvent: a call to the report
 * tool is allowed before ANY policy, pause, fail-closed or Jev logic, and is
 * recorded on its activity row. The control call in each case (a plain Bash
 * call) shows the same setup really does deny, so an allow is not vacuous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { HEALTH_PROBE_SOURCE } from "../../src/hooks/health-probe";
import { writeEffectiveSelfReport } from "../../src/hooks/self-report";

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
  // Self Reports on: the hook records a report only while the setting says so.
  writeEffectiveSelfReport({ enabled: true });
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

  describe("the current Self Reports setting", () => {
    const settings = () => join(home, "self-report.json");

    it.each([
      ["missing", () => rmSync(settings(), { force: true })],
      ["disabled", () => writeEffectiveSelfReport({ enabled: false })],
      ["malformed", () => writeFileSync(settings(), "{ not json")],
      ["of another version", () => writeFileSync(settings(), JSON.stringify({ version: 2, enabled: true }))],
    ])("%s: still allows the call (Claude and Codex) but records no report", async (_name, setUp) => {
      setUp();
      for (const [event, cli] of [["PreToolUse", "claude"], ["pre_tool_use", "codex"]] as const) {
        const out = await evaluateHookEvent(event, cli, report());
        expect(out.evaluation?.decision).toBe("allow");
        expect(loadAllCustomHooks).not.toHaveBeenCalled();
      }
      const all = rows();
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.selfReport === undefined)).toBe(true);
    });

    it("disabling during a session stops the next call's report, and enabling brings it back", async () => {
      await evaluateHookEvent("PreToolUse", "claude", report());
      writeEffectiveSelfReport({ enabled: false });
      expect((await evaluateHookEvent("PreToolUse", "claude", report())).evaluation?.decision).toBe("allow");
      writeEffectiveSelfReport({ enabled: true });
      await evaluateHookEvent("PreToolUse", "claude", report());
      expect(rows().map((r) => r.selfReport !== undefined)).toEqual([true, false, true]);
    });
  });

  it("cuts detail at 2000 code points, never through a surrogate pair", async () => {
    const detail = `${"a".repeat(1999)}\u{1F600} and more text`;
    await evaluateHookEvent("PreToolUse", "claude", payload("mcp__failproofai__report", { category: "looping", detail }));
    const line = readFileSync(join(home, "hook-activity", "current.jsonl"), "utf8").trim().split("\n").pop()!;
    // The row is valid UTF-8 JSON with no lone surrogate escape, which the
    // Rust collector would reject along with every hook event on the row.
    expect(line).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const kept = (JSON.parse(line).selfReport as { detail: string }).detail;
    expect(kept).toBe(`${"a".repeat(1999)}\u{1F600}`);
    expect([...kept]).toHaveLength(2000);
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

  it.each([
    ["factory", "failproofai___report"],
    ["hermes", "mcp_failproofai_report"],
    ["antigravity", "mcp_failproofai_report"],
    ["opencode", "failproofai_report"],
    ["openclaw", "failproofai__report"],
    ["goose", "failproofai__report"],
    ["pi", "mcp__failproofai__report"],
    ["devin", "mcp__failproofai__report"],
    ["copilot", "failproofai-report"],
    ["copilot", "failproofai/report"],
  ] as const)("allows %s's spelling %s past a deny-everything policy", async (cli, name) => {
    const out = await evaluateHookEvent(
      "PreToolUse",
      cli,
      payload(name, { category: "looping", detail: "again" }),
    );
    expect(out.evaluation?.decision).toBe("allow");
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
  });

  it("allows Cursor's beforeMCPExecution for the failproofai server, with a schema-valid answer, leaving the report to the server", async () => {
    const out = await evaluateHookEvent(
      "beforeMCPExecution",
      "cursor",
      payload("report", JSON.stringify({ category: "missing_context", detail: "no repo access" }), {
        mcp_server_name: "failproofai",
        url: "http://127.0.0.1:4319/mcp?agent=cursor",
      }),
    );
    expect(out.evaluation?.decision).toBe("allow");
    expect(JSON.parse(out.stdout)).toEqual({ permission: "allow" });
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
    const [row] = rows();
    // Cursor is server-recorded: the MCP server writes the report, so the
    // hook row must not carry a second one.
    expect(row).toMatchObject({ eventType: "PreToolUse", integration: "cursor", toolName: "mcp__failproofai__report" });
    expect(row.selfReport).toBeUndefined();
  });

  it("does not early-allow Cursor's bare MCP:report without a server name", async () => {
    const out = await evaluateHookEvent("preToolUse", "cursor", payload("MCP:report", { category: "looping", detail: "x" }));
    expect(out.evaluation?.decision).toBe("deny");
  });

  it("early-allows Cursor's preToolUse MCP:report only when the payload names server failproofai", async () => {
    const ours = await evaluateHookEvent(
      "preToolUse",
      "cursor",
      payload("MCP:report", { category: "looping", detail: "x" }, { mcp_server_name: "failproofai" }),
    );
    expect(ours.evaluation?.decision).toBe("allow");
    expect(rows().pop()!.selfReport).toBeUndefined();
    const theirs = await evaluateHookEvent(
      "preToolUse",
      "cursor",
      payload("MCP:report", { category: "looping", detail: "x" }, { mcp_server_name: "linear" }),
    );
    expect(theirs.evaluation?.decision).toBe("deny");
  });

  it("never lets a Cursor call that fails the server check through by its name alone", async () => {
    // Another server's tool, or one with no server named, spelled like ours:
    // it keeps its own name, is not recorded as a report, and the policies run.
    for (const name of ["mcp__failproofai__report", "failproofai__report", "failproofai-report", "mcp_failproofai_report"]) {
      for (const extra of [{ mcp_server_name: "linear" }, {}]) {
        vi.mocked(loadAllCustomHooks).mockClear();
        for (const event of ["preToolUse", "beforeMCPExecution"]) {
          const out = await evaluateHookEvent(event, "cursor", payload(name, { category: "looping", detail: "x" }, extra));
          expect(out.evaluation?.decision, `${event} ${name} ${JSON.stringify(extra)}`).toBe("deny");
          expect(out.evaluation?.toolName).toBe(name);
        }
        expect(loadAllCustomHooks).toHaveBeenCalled();
      }
    }
    expect(rows().some((r) => r.selfReport !== undefined)).toBe(false);
    // The same spelling WITH our server is still ours.
    const ours = await evaluateHookEvent(
      "preToolUse", "cursor",
      payload("mcp__failproofai__report", { category: "looping", detail: "x" }, { mcp_server_name: "failproofai" }),
    );
    expect(ours.evaluation?.decision).toBe("allow");
  });

  describe("Antigravity's lazy MCP path (call_mcp_tool)", () => {
    const agy = (args: Record<string, unknown>) =>
      JSON.stringify({ conversationId: SESSION, workspacePaths: ["/tmp/project"], toolCall: { name: "call_mcp_tool", args } });

    it("early-allows the wrapper when it names server failproofai and tool report", async () => {
      const out = await evaluateHookEvent(
        "PreToolUse",
        "antigravity",
        agy({ ServerName: "failproofai", ToolName: "report", Arguments: { category: "looping", detail: "again" } }),
      );
      expect(out.evaluation?.decision).toBe("allow");
      expect(loadAllCustomHooks).not.toHaveBeenCalled();
      const row = rows().pop()!;
      expect(row).toMatchObject({ integration: "antigravity", toolName: "mcp__failproofai__report", sessionId: SESSION });
      // Antigravity is server-recorded: the MCP server writes the report.
      expect(row.selfReport).toBeUndefined();
    });

    it("accepts the wrapped arguments as a JSON string", async () => {
      const out = await evaluateHookEvent(
        "PreToolUse",
        "antigravity",
        agy({ ServerName: "failproofai", ToolName: "report", Arguments: JSON.stringify({ category: "looping", detail: "x" }) }),
      );
      expect(out.evaluation?.decision).toBe("allow");
    });

    it.each([
      [{ ServerName: "linear", ToolName: "report", Arguments: {} }],
      [{ ServerName: "failproofai", ToolName: "search", Arguments: {} }],
      [{ ToolName: "report", Arguments: {} }],
      [{ ServerName: "failproofai-evil", ToolName: "report" }],
    ])("keeps any other wrapped call on the policy path: %j", async (args) => {
      const out = await evaluateHookEvent("PreToolUse", "antigravity", agy(args));
      expect(out.evaluation?.decision).toBe("deny");
    });

    it("does not unwrap call_mcp_tool for any other agent", async () => {
      const out = await evaluateHookEvent(
        "PreToolUse",
        "claude",
        payload("call_mcp_tool", { ServerName: "failproofai", ToolName: "report", Arguments: {} }),
      );
      expect(out.evaluation?.decision).toBe("deny");
    });
  });

  it("answers the native policy-evaluation health probe with an allow and writes no activity row", async () => {
    const out = await evaluateHookEvent(
      "on_session_start",
      "hermes",
      JSON.stringify({ hook_event_name: "on_session_start", source: HEALTH_PROBE_SOURCE }),
    );
    expect(out.evaluation?.decision).toBe("allow");
    expect(rows()).toEqual([]);
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
  });
});
