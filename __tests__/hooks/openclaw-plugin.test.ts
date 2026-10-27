// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  daemonSocketPath,
  openclawAgentSettingsPath,
  requestHookVerdict,
} from "../../openclaw-plugin/daemon-client.js";
import { registerFailproofaiHooks } from "../../openclaw-plugin/hooks.js";
import { daemonSocket } from "../../src/hooks/fp-home";
import { runtimeAgentSettingsPath } from "../../src/hooks/agent-roster";

const PLUGIN_DIR = resolve(__dirname, "../../openclaw-plugin");

type Reply = Record<string, unknown> | Buffer | "hang";

function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** A failproofaid stand-in: reads one frame, records it, answers with `reply`. */
async function fakeDaemon(socketPath: string, reply: (request: Record<string, unknown>) => Reply) {
  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk as Buffer]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (received.length < 4 + length) return;
      const request = JSON.parse(received.subarray(4, 4 + length).toString("utf8"));
      requests.push(request);
      const answer = reply(request);
      if (answer === "hang") return;
      socket.end(Buffer.isBuffer(answer) ? answer : frame(answer));
    });
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  return {
    requests,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

const hookResult = (stdout: string, exitCode = 0) => ({
  type: "hookResult",
  protocolVersion: 2,
  exitCode,
  stdout,
  stderr: "",
});

let dir: string;
let socketPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpoc-"));
  socketPath = join(dir, "d.sock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("openclaw-plugin daemon-client: paths", () => {
  it("resolves the daemon socket exactly as the CLI does", () => {
    const cases: Record<string, string>[] = [
      {},
      { FAILPROOFAI_HOME: "/srv/fp-home" },
      { FAILPROOFAI_DAEMON_SOCKET: "/run/custom/failproofaid.sock" },
      { FAILPROOFAI_HOME: "/srv/fp-home", FAILPROOFAI_DAEMON_SOCKET: "/run/custom/failproofaid.sock" },
    ];
    for (const env of cases) {
      vi.unstubAllEnvs();
      vi.stubEnv("FAILPROOFAI_HOME", env.FAILPROOFAI_HOME ?? "");
      vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", env.FAILPROOFAI_DAEMON_SOCKET ?? "");
      expect(daemonSocketPath(process.env)).toBe(daemonSocket());
    }
  });

  it("names the gateway profile's openclaw.json exactly as the spawned CLI did", () => {
    const home = "/home/gw";
    const keys = ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_PROFILE"];
    const cases: Record<string, string>[] = [
      {},
      { OPENCLAW_CONFIG_PATH: "/etc/openclaw/custom.json" },
      { OPENCLAW_STATE_DIR: "/var/lib/openclaw" },
      { OPENCLAW_HOME: "/opt/openclaw-home" },
      { OPENCLAW_PROFILE: "work" },
      { OPENCLAW_PROFILE: "default" },
      { OPENCLAW_PROFILE: "../escape" },
      { OPENCLAW_PROFILE: ".hidden" },
      { OPENCLAW_STATE_DIR: "/var/lib/openclaw", OPENCLAW_PROFILE: "work" },
    ];
    for (const env of cases) {
      vi.unstubAllEnvs();
      for (const key of keys) vi.stubEnv(key, env[key] ?? "");
      expect(openclawAgentSettingsPath(process.env, home)).toBe(runtimeAgentSettingsPath("openclaw", undefined, home));
    }
  });
});

describe("openclaw-plugin daemon-client: requestHookVerdict", () => {
  it("sends the CLI's hook request and reads the daemon's verdict", async () => {
    const daemon = await fakeDaemon(socketPath, () =>
      hookResult(JSON.stringify({ permission: "deny", reason: "nope" })),
    );
    try {
      const payload = { session_id: "s1", cwd: "/work", tool_name: "exec", tool_input: { command: "ls" } };
      const result = await requestHookVerdict({
        event: "before_tool_call",
        payload,
        cwd: "/work",
        agentSettingsPath: "/home/gw/.openclaw/openclaw.json",
        socketPath,
      });
      expect(result).toEqual({ ok: true, verdict: { permission: "deny", reason: "nope" } });
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]).toEqual({
        type: "hook",
        protocolVersion: 2,
        hookEvent: "before_tool_call",
        cli: "openclaw",
        stdin: JSON.stringify(payload),
        cwd: "/work",
        agentSettingsPath: "/home/gw/.openclaw/openclaw.json",
      });
    } finally {
      await daemon.close();
    }
  });

  it("treats empty stdout as allow", async () => {
    const daemon = await fakeDaemon(socketPath, () => hookResult(""));
    try {
      const result = await requestHookVerdict({ event: "after_tool_call", payload: {}, socketPath });
      expect(result).toEqual({ ok: true, verdict: { permission: "allow" } });
    } finally {
      await daemon.close();
    }
  });

  it("accepts the instruct verdict the evaluator prints", async () => {
    // policy-evaluator.ts's `cli === "openclaw"` PreToolUse instruct shape.
    const verdict = {
      permission: "instruct",
      reason: "Instruction from failproofai: re-read the ticket",
      policyName: "custom/read-first",
      policyNames: ["custom/read-first", "custom/cite-source"],
    };
    const daemon = await fakeDaemon(socketPath, () => hookResult(JSON.stringify(verdict)));
    try {
      const result = await requestHookVerdict({ event: "before_tool_call", payload: {}, socketPath });
      expect(result).toEqual({ ok: true, verdict });
    } finally {
      await daemon.close();
    }
  });

  it("reads a frame that arrives in pieces", async () => {
    const whole = frame(hookResult(JSON.stringify({ permission: "instruct", reason: "slow down" })));
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(whole.subarray(0, 2));
        setTimeout(() => socket.write(whole.subarray(2, 9)), 5);
        setTimeout(() => socket.end(whole.subarray(9)), 10);
      });
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    try {
      const result = await requestHookVerdict({ event: "before_tool_call", payload: {}, socketPath });
      expect(result).toEqual({ ok: true, verdict: { permission: "instruct", reason: "slow down" } });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it.each([
    ["an error frame", { type: "error", protocolVersion: 2, message: "worker is down" }, "evaluation"],
    ["another protocol version", { type: "hookResult", protocolVersion: 1, exitCode: 0, stdout: "" }, "protocol-mismatch"],
    ["an unknown message type", { type: "pong", protocolVersion: 2 }, "invalid"],
    ["a non-zero exit", hookResult("", 1), "evaluation"],
    ["stdout that is not JSON", hookResult("not json"), "invalid"],
    ["a verdict without a permission", hookResult(JSON.stringify({ reason: "x" })), "invalid"],
    ["a hookResult with no stdout", { type: "hookResult", protocolVersion: 2, exitCode: 0, stderr: "" }, "invalid"],
    ["a hookResult with no stderr", { type: "hookResult", protocolVersion: 2, exitCode: 0, stdout: "" }, "invalid"],
    ["a hookResult with no exitCode", { type: "hookResult", protocolVersion: 2, stdout: "", stderr: "" }, "invalid"],
    ["a non-string stdout", { type: "hookResult", protocolVersion: 2, exitCode: 0, stdout: 1, stderr: "" }, "invalid"],
    ["an unknown permission", hookResult(JSON.stringify({ permission: "unknown" })), "invalid"],
    ["a non-string reason", hookResult(JSON.stringify({ permission: "deny", reason: 7 })), "invalid"],
    ["non-string policyNames", hookResult(JSON.stringify({ permission: "instruct", policyNames: [1] })), "invalid"],
    ["a verdict that is an array", hookResult(JSON.stringify(["deny"])), "invalid"],
  ])("never reads %s as an allow", async (_label, reply, failure) => {
    const daemon = await fakeDaemon(socketPath, () => reply as Record<string, unknown>);
    try {
      const result = await requestHookVerdict({ event: "before_tool_call", payload: {}, socketPath });
      expect(result).toMatchObject({ ok: false, failure });
      expect((result as { message: string }).message).toBeTruthy();
    } finally {
      await daemon.close();
    }
  });

  it("refuses a declared response length over 16 MiB", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(16 * 1024 * 1024 + 1, 0);
    const daemon = await fakeDaemon(socketPath, () => header);
    try {
      const result = await requestHookVerdict({ event: "before_tool_call", payload: {}, socketPath });
      expect(result).toMatchObject({ ok: false, failure: "invalid" });
    } finally {
      await daemon.close();
    }
  });

  it("reports an absent daemon as unreachable", async () => {
    const result = await requestHookVerdict({ event: "before_tool_call", payload: {}, socketPath });
    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
  });

  it("gives up on a daemon that never answers", async () => {
    const daemon = await fakeDaemon(socketPath, () => "hang");
    try {
      const result = await requestHookVerdict({
        event: "before_tool_call",
        payload: {},
        socketPath,
        responseTimeoutMs: 50,
      });
      expect(result).toMatchObject({ ok: false, failure: "timeout" });
    } finally {
      await daemon.close();
    }
  });
});

type Handler = (payload: unknown, ctx: unknown) => Promise<unknown>;

function fakeApi() {
  const handlers = new Map<string, Handler>();
  const options = new Map<string, unknown>();
  const logged: string[] = [];
  return {
    handlers,
    options,
    logged,
    api: {
      config: {},
      logger: { info() {}, warn() {}, error: (line: string) => logged.push(line) },
      on(name: string, handler: Handler, opts: unknown) {
        handlers.set(name, handler);
        options.set(name, opts);
      },
    },
  };
}

const toolCall = { toolName: "exec", params: { command: "rm -rf /" } };
const ctx = { sessionKey: "agent:main:main", runId: "r1", agentId: "main" };

describe("openclaw-plugin hooks", () => {
  it("registers the eight hooks it maps", () => {
    const { api, handlers, options } = fakeApi();
    registerFailproofaiHooks(api, { evaluate: async () => ({ ok: true, verdict: { permission: "allow" } }) });
    expect([...handlers.keys()].sort()).toEqual([
      "after_tool_call",
      "before_agent_finalize",
      "before_agent_run",
      "before_compaction",
      "before_tool_call",
      "session_end",
      "session_start",
      "subagent_ended",
    ]);
    for (const opts of options.values()) expect(opts).toEqual({ priority: 100, timeoutMs: 60_000 });
  });

  it("forwards raw names in a Claude-shaped payload", async () => {
    const { api, handlers } = fakeApi();
    const evaluate = vi.fn(async () => ({ ok: true, verdict: { permission: "allow" } }));
    registerFailproofaiHooks(api, { evaluate });
    await handlers.get("before_tool_call")!(toolCall, ctx);
    expect(evaluate).toHaveBeenCalledWith(
      "before_tool_call",
      expect.objectContaining({
        session_id: "agent:main:main",
        tool_name: "exec",
        tool_input: { command: "rm -rf /" },
        hook_event_name: "before_tool_call",
      }),
    );
  });

  it("maps a deny to each gate's native shape", async () => {
    const { api, handlers } = fakeApi();
    registerFailproofaiHooks(api, {
      evaluate: async () => ({ ok: true, verdict: { permission: "deny", reason: "policy says no" } }),
    });
    expect(await handlers.get("before_tool_call")!(toolCall, ctx)).toEqual({
      block: true,
      blockReason: "policy says no",
    });
    expect(await handlers.get("before_agent_run")!({ prompt: "hi" }, ctx)).toEqual({
      outcome: "block",
      reason: "policy says no",
    });
    expect(await handlers.get("before_agent_finalize")!({}, ctx)).toEqual({
      action: "revise",
      reason: "policy says no",
    });
    expect(await handlers.get("after_tool_call")!(toolCall, ctx)).toBeUndefined();
  });

  it("blocks tool calls and prompts, and logs, when no verdict comes back", async () => {
    const { api, handlers, logged } = fakeApi();
    registerFailproofaiHooks(api, {
      evaluate: async () => ({ ok: false, failure: "unreachable", message: "failproofaid could not be reached." }),
    });
    expect(await handlers.get("before_tool_call")!(toolCall, ctx)).toEqual({
      block: true,
      blockReason: expect.stringContaining("failproofaid could not be reached."),
    });
    expect(await handlers.get("before_agent_run")!({ prompt: "hi" }, ctx)).toMatchObject({ outcome: "block" });
    // A revise cannot bring the daemon back; forcing one would only loop the turn.
    expect(await handlers.get("before_agent_finalize")!({}, ctx)).toBeUndefined();
    expect(await handlers.get("session_end")!({}, ctx)).toBeUndefined();
    expect(logged.length).toBe(4);
    expect(logged[0]).toContain("before_tool_call");
  });

  it.each([
    ["an unknown permission", hookResult(JSON.stringify({ permission: "unknown" }))],
    ["a hookResult with no stdout", { type: "hookResult", protocolVersion: 2, exitCode: 0, stderr: "" }],
  ])("blocks the gates, through the real daemon client, on %s", async (_label, reply) => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socketPath);
    const daemon = await fakeDaemon(socketPath, () => reply);
    try {
      const { api, handlers } = fakeApi();
      registerFailproofaiHooks(api);
      expect(await handlers.get("before_tool_call")!(toolCall, ctx)).toMatchObject({ block: true });
      expect(await handlers.get("before_agent_run")!({ prompt: "hi" }, ctx)).toMatchObject({ outcome: "block" });
    } finally {
      await daemon.close();
    }
  });

  it("blocks when the evaluator itself throws", async () => {
    const { api, handlers } = fakeApi();
    registerFailproofaiHooks(api, {
      evaluate: async () => {
        throw new Error("boom");
      },
    });
    expect(await handlers.get("before_tool_call")!(toolCall, ctx)).toEqual({
      block: true,
      blockReason: expect.stringContaining("boom"),
    });
  });
});

describe("openclaw-plugin under OpenClaw's plugin capture", () => {
  it("imports nothing from outside its own directory", () => {
    for (const file of readdirSync(PLUGIN_DIR).filter((name) => name.endsWith(".js"))) {
      const source = readFileSync(join(PLUGIN_DIR, file), "utf8");
      const specifiers = [...source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const specifier of specifiers) {
        const allowed =
          specifier.startsWith("node:") ||
          (specifier.startsWith("./") && !specifier.includes("..")) ||
          specifier === "openclaw/plugin-sdk/plugin-entry";
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("still enforces when loaded from a copy of the plugin directory", async () => {
    // OpenClaw ≥ 2026.9.6 imports plugins from …/plugin-captures/<id>/…/node_modules/<dir>/,
    // a copy holding only the plugin's own files. Nothing beside it exists there.
    const capture = join(dir, "captures", "build", "package-0", "node_modules", "openclaw-plugin");
    cpSync(PLUGIN_DIR, capture, { recursive: true });
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socketPath);
    const daemon = await fakeDaemon(socketPath, () =>
      hookResult(JSON.stringify({ permission: "deny", reason: "Blocked Bash by failproofai" })),
    );
    try {
      const copied = await import(pathToFileURL(join(capture, "hooks.js")).href);
      const { api, handlers } = fakeApi();
      copied.registerFailproofaiHooks(api);
      expect(await handlers.get("before_tool_call")!(toolCall, ctx)).toEqual({
        block: true,
        blockReason: "Blocked Bash by failproofai",
      });
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]).toMatchObject({ type: "hook", cli: "openclaw", hookEvent: "before_tool_call" });
    } finally {
      await daemon.close();
    }
  });
});
