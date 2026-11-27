// @vitest-environment node
/**
 * Lean Self Reports output and the daemon-log events:
 * - the one summary line install, config, uninstall, enable and disable print;
 * - the sync result line the daemon logs;
 * - `selfReportLog` frames from the stdio server and syncs, over the daemon
 *   socket, fire-and-forget (no daemon, a dead socket, an old daemon: dropped);
 * - setup's finish step: one spinner, then only what needs the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  selfReportSummaryLine,
  selfReportSyncLogLine,
  type SelfReportMcpResult,
} from "../../src/hooks/self-report-install";
import { SELF_REPORT_LOG_BUDGET_MS, flushSelfReportLogs, sendSelfReportLog } from "../../src/hooks/self-report-log";
import { handleSelfReportRpc, runSelfReportMcpServer } from "../../src/hooks/self-report-mcp";
import { writeEffectiveSelfReport } from "../../src/hooks/self-report";
import { progressLine } from "../../src/hooks/tui";
import { PassThrough } from "node:stream";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-srlog-"));
  for (const k of ["FAILPROOFAI_HOME", "FAILPROOFAI_DAEMON_SOCKET", "FAILPROOFAI_CLOUD_URL", "FAILPROOFAI_SELF_REPORT_SYNC_LOG"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_DAEMON_SOCKET = join(home, "d.sock");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const r = (agent: string, action: string, extra: Partial<SelfReportMcpResult> = {}): SelfReportMcpResult =>
  ({ agent, path: `/h/${agent}.json`, action, transport: action === "removed" ? "stdio" : "stdio", status: "ok", ...extra }) as SelfReportMcpResult;

describe("the one Self Reports line", () => {
  it("counts the agents left registered, once each", () => {
    const results = [r("claude", "added"), r("codex", "unchanged"), r("hermes", "added"), r("hermes", "updated"), r("pi", "unchanged", { transport: "extension" })];
    expect(selfReportSummaryLine(results, "on")).toBe("✓ Self Reports: on for 4 agents");
    expect(selfReportSummaryLine([r("claude", "unchanged")], "on")).toBe("✓ Self Reports: on for 1 agent");
    // On with nothing hooked: nothing to say.
    expect(selfReportSummaryLine([r("goose", "skipped", { transport: null, status: "not-hooked" })], "on")).toBeNull();
  });

  it("off is one line whatever was removed, and names Cloud while it waits for it", () => {
    const removed = Array.from({ length: 12 }, (_, i) => r(`a${i}`, "removed"));
    expect(selfReportSummaryLine(removed, "off")).toBe("✓ Self Reports: off");
    expect(selfReportSummaryLine(removed, "waiting")).toBe("✓ Self Reports: off until Cloud sends this machine's setting");
    expect(selfReportSummaryLine([r("claude", "removed"), r("codex", "removed")], "removed")).toBe("✓ Self Reports: removed from 2 agents");
    expect(selfReportSummaryLine([r("claude", "unchanged", { transport: null })], "removed")).toBeNull();
  });

  it("names the agents that failed in the same line, with the fix", () => {
    const results = [
      r("claude", "added"),
      r("codex", "skipped", { transport: null, status: "error", detail: "EACCES" }),
      r("cursor", "skipped", { transport: null, status: "conflict" }),
    ];
    expect(selfReportSummaryLine(results, "on")).toBe(
      "▲ Self Reports: on for 1 agent; not updated for OpenAI Codex, Cursor Agent  ·  failproofai self-report sync",
    );
    expect(selfReportSummaryLine([results[1]], "removed")).toBe(
      "▲ Self Reports: not updated for OpenAI Codex  ·  failproofai self-report sync",
    );
  });
});

describe("the sync line the daemon logs", () => {
  it("names agents and transports, never a path, and nothing when nothing changed", () => {
    const line = selfReportSyncLogLine([
      r("claude", "added", { transport: "http" }),
      r("cursor", "updated"),
      r("pi", "removed"),
      r("codex", "unchanged"),
      r("factory", "skipped", { transport: null, status: "error", detail: "no daemon is answering here" }),
    ]);
    expect(line).toBe("added claude (http); updated cursor (stdio); removed pi; failed factory (no daemon is answering here)");
    expect(line).not.toContain("/h/");
    expect(selfReportSyncLogLine([r("codex", "unchanged")])).toBeNull();
  });
});

/** A fake daemon socket that records every frame it is sent. */
function fakeDaemon(path: string): Promise<{ server: Server; frames: Array<Record<string, unknown>> }> {
  const frames: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        frames.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((ok) => server.listen(path, () => ok({ server, frames })));
}

describe("selfReportLog over the daemon socket", () => {
  it("sends one framed selfReportLog and cuts the preview", async () => {
    const { server, frames } = await fakeDaemon(process.env.FAILPROOFAI_DAEMON_SOCKET!);
    try {
      await sendSelfReportLog({ event: "tools/call", agent: "hermes", transport: "stdio", outcome: "recorded", preview: "x".repeat(500) });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({ type: "selfReportLog", protocolVersion: 2, event: { event: "tools/call", agent: "hermes", outcome: "recorded" } });
      expect(((frames[0].event as Record<string, string>).preview).length).toBe(200);
    } finally {
      server.close();
    }
  });

  it("never waits on a daemon: none, a dead socket, or one that never reads", async () => {
    // None.
    let t = Date.now();
    await sendSelfReportLog({ event: "initialize" });
    expect(Date.now() - t).toBeLessThan(50);
    // A socket file nobody listens on.
    writeFileSync(process.env.FAILPROOFAI_DAEMON_SOCKET!, "");
    t = Date.now();
    await sendSelfReportLog({ event: "initialize" });
    expect(Date.now() - t).toBeLessThan(SELF_REPORT_LOG_BUDGET_MS + 100);
    rmSync(process.env.FAILPROOFAI_DAEMON_SOCKET!);
    // A listener that accepts and never answers (an old daemon reads, fails to
    // parse, and closes; this one does not even close).
    const held = createServer(() => {});
    await new Promise<void>((ok) => held.listen(process.env.FAILPROOFAI_DAEMON_SOCKET!, () => ok()));
    try {
      t = Date.now();
      await sendSelfReportLog({ event: "initialize" });
      await flushSelfReportLogs();
      expect(Date.now() - t).toBeLessThan(SELF_REPORT_LOG_BUDGET_MS + 100);
    } finally {
      held.close();
    }
  });

  it("the stdio server logs initialize, tools/list and each call: recorded, with its session, or skipped and why", async () => {
    const { server, frames } = await fakeDaemon(process.env.FAILPROOFAI_DAEMON_SOCKET!);
    try {
      writeEffectiveSelfReport({ enabled: true });
      const opts = { agent: "copilot", cwd: home };
      await handleSelfReportRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, opts);
      await handleSelfReportRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, opts);
      const call = (args: Record<string, unknown>) =>
        handleSelfReportRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report", arguments: args } }, opts);
      await call({ category: "looping", detail: "stuck" });
      await call({ category: "made_up", detail: "odd" });
      writeEffectiveSelfReport({ enabled: false });
      await call({ category: "looping", detail: "off now" });
      writeFileSync(join(home, "self-report.json"), "{broken");
      await call({ category: "looping", detail: "broken" });
      await handleSelfReportRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "report", arguments: {} } }, { cwd: home });
      await flushSelfReportLogs(1000);
      await vi.waitFor(() => expect(frames).toHaveLength(7));
      const events = frames.map((f) => f.event as Record<string, unknown>);
      expect(events[0]).toMatchObject({ event: "initialize", agent: "copilot", transport: "stdio", outcome: "on" });
      expect(events[1]).toMatchObject({ event: "tools/list", outcome: "report" });
      expect(events[2]).toMatchObject({ event: "tools/call", outcome: "recorded", category: "looping", knownCategory: true, session: "unattributed", preview: "stuck" });
      expect(events[3]).toMatchObject({ outcome: "recorded", category: "made_up", knownCategory: false });
      expect(events[4]).toMatchObject({ outcome: "skipped", reason: "Self Reports is off" });
      expect(events[5]).toMatchObject({ outcome: "skipped", reason: "settings unreadable" });
      expect(events[6]).toMatchObject({ outcome: "skipped", reason: "no --agent" });
      // Two reports were written, as before.
      expect(readdirSync(join(home, "custom-agents", "events")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it("the stdio server's run waits for its events, at most the budget, before it ends", async () => {
    const { server, frames } = await fakeDaemon(process.env.FAILPROOFAI_DAEMON_SOCKET!);
    try {
      writeEffectiveSelfReport({ enabled: true });
      const input = new PassThrough();
      const output = new PassThrough();
      const run = runSelfReportMcpServer({ agent: "goose", cwd: home, input, output });
      input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
      await run;
      await vi.waitFor(() => expect(frames.map((f) => (f.event as { event: string }).event)).toEqual(["initialize"]));
    } finally {
      server.close();
    }
  });
});

describe("progressLine", () => {
  it("piped: draws nothing while it runs, then prints only the lines to keep", () => {
    let out = "";
    const stream = { isTTY: false, write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
    const p = progressLine(stream, "Working…");
    p.set("Still working…");
    p.done(["✓ Self Reports: on for 3 agents"]);
    expect(out).toBe("✓ Self Reports: on for 3 agents\n");
    out = "";
    const q = progressLine(stream, "Working…");
    q.done([]);
    expect(out).toBe("");
  });

  it("on a terminal: one spinner line, erased when there is nothing to keep", () => {
    const noColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    let out = "";
    const stream = { isTTY: true, columns: 80, write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
    const p = progressLine(stream, "Restarting agent gateways…");
    expect(out).toContain("Restarting agent gateways…");
    out = "";
    p.done([]);
    // Up one line, clear to the end, cursor back; nothing printed.
    expect(out).toBe("\x1b[1A\x1b[J\x1b[?25h");
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
  });
});

describe("setup's finish step", () => {
  it("leaves the Self Reports line and only what needs the user", async () => {
    vi.resetModules();
    const realUpdateRun = await vi.importActual<typeof import("../../src/hooks/update-run")>("../../src/hooks/update-run");
    vi.doMock("../../src/hooks/update-run", () => ({
      setupNeedsUpdateSteps: () => true,
      runUpdateSteps: async () => ({
        ok: true,
        lines: ["  hermes/default  already current, gateway restarting", "✕ Hermes: plugin could not be updated"],
        restarts: [
          { host: "openclaw", profile: "default", status: "restarting" },
          { host: "hermes", profile: "work", status: "not-supervised" },
        ],
      }),
      setupGatewayLine: realUpdateRun.setupGatewayLine,
      restartNewlyPlugged: async () => [],
      markUpdated: vi.fn(),
    }));
    vi.doMock("../../src/hooks/self-report-install", async () => ({
      ...(await vi.importActual<object>("../../src/hooks/self-report-install")),
      syncSelfReportMcp: async () => Array.from({ length: 12 }, (_, i) => r(`a${i}`, "added")),
    }));
    try {
      writeEffectiveSelfReport({ enabled: true });
      const { finishSetup } = await import("../../src/hooks/setup-finish");
      let out = "";
      const stream = { isTTY: false, write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
      expect(await finishSetup({ version: "9.9.9", pluggedBefore: [], out: stream })).toBe(0);
      expect(out.trimEnd().split("\n")).toEqual([
        "✕ Hermes: plugin could not be updated",
        "▲ hermes/work: restart the gateway",
        "✓ Self Reports: on for 12 agents",
      ]);
      expect(out).not.toContain("gateway restarting");
      expect(out).not.toContain("MCP server");
    } finally {
      vi.doUnmock("../../src/hooks/update-run");
      vi.doUnmock("../../src/hooks/self-report-install");
      vi.resetModules();
    }
  });
});
