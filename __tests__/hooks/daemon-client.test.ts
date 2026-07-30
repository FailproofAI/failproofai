// @vitest-environment node
/**
 * `src/hooks/daemon-client.ts` — driven against a REAL Unix socket server.
 *
 * There is no mock of `node:net` here on purpose. The failure mode this client
 * guards against is silent: a client that throws or hangs breaks every hook on
 * the machine, and a client that returns a wrong answer is worse than either.
 * A mocked socket would happily prove properties of the mock. So every case
 * below stands up an actual `net.Server`, speaks the actual framing from
 * `crates/PROTOCOL.md`, and asserts on the bytes that crossed the wire.
 *
 * The framing helpers are written out again rather than imported from the
 * client, so a bug in the client's framing cannot cancel itself out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryDaemonEvaluate } from "../../src/hooks/daemon-client";
import { buildLocalEnvelope, ENV_FACT_KEYS } from "../../src/hooks/request-envelope";
import type { EvaluationRequest } from "../../src/hooks/request-envelope";

// ── handler-level mocks (used only by the last describe block) ─────────────
// Hoisted file-wide by vitest. None of them is reachable from daemon-client.ts,
// which imports `EvaluationResult` from policy-evaluator as a *type* only.
vi.mock("../../src/hooks/hooks-config", () => ({
  readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: ["block-sudo"] })),
}));
vi.mock("../../src/hooks/builtin-policies", () => ({
  registerBuiltinPolicies: vi.fn(),
}));
vi.mock("../../src/hooks/policy-evaluator", () => ({
  evaluatePolicies: vi.fn(),
}));
vi.mock("../../src/hooks/policy-registry", () => ({
  clearPolicies: vi.fn(),
  registerPolicy: vi.fn(),
  getPoliciesForEvent: vi.fn(() => []),
}));
vi.mock("../../src/hooks/custom-hooks-loader", () => ({
  loadAllCustomHooks: vi.fn(() => Promise.resolve({ hooks: [], conventionSources: [] })),
}));
vi.mock("../../src/hooks/hook-activity-store", () => ({
  persistHookActivity: vi.fn(),
}));
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/telemetry-id", () => ({
  getInstanceId: vi.fn(() => "test-instance-id"),
}));
vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogInfo: vi.fn(),
  hookLogWarn: vi.fn(),
  hookLogError: vi.fn(),
}));

// ── framing, transcribed from PROTOCOL.md ──────────────────────────────────

function frame(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** A header declaring `length` with no body — for the framing-error cases. */
function header(length: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(length, 0);
  return buf;
}

/**
 * A non-empty resolved enabled set, as every real caller now supplies.
 *
 * `tryDaemonEvaluate` refuses an empty set before opening a socket: the daemon
 * rejects it (there is nothing to evaluate, and backfilling its own defaults
 * would enforce a set the user never configured), and a caller that forgot to
 * pass one would otherwise get a confident `allow` built from evaluating
 * nothing. These tests are about transport and framing rather than policy, so
 * the contents do not matter — only that it is non-empty and real.
 */
const ENABLED = ["block-sudo", "block-env-files"] as const;

const HELLO_ACK = {
  hello_ack: { protocol_version: 1, daemon_version: "0.0.16-beta.0", generation_id: "gen-abc" },
};

/** The `evaluated` payload PROTOCOL.md documents, minus `request_id`. */
function evaluatedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: "dec-1",
    generation_id: "gen-abc",
    exit_code: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
    stderr: "",
    decision: "deny",
    policy_name: "failproofai/block-sudo",
    policy_names: null,
    reason: "sudo commands are blocked",
    attestation: "sealed",
    matched_policies: ["failproofai/block-sudo"],
    needs_user_context: [],
    ...overrides,
  };
}

// ── test server ────────────────────────────────────────────────────────────

interface TestServer {
  readonly path: string;
  /** How many times a client connected. Zero proves the path is dead code. */
  connections: number;
  /** Every frame body the server decoded off the wire, in order. */
  received: Record<string, unknown>[];
  /** How many peers hung up — proves the client destroys its socket. */
  disconnects: number;
  close(): Promise<void>;
}

type ConnectionHandler = (socket: net.Socket, state: TestServer) => void;

async function startServer(dir: string, onConnection: ConnectionHandler): Promise<TestServer> {
  const path = join(dir, "d.sock");
  const server = net.createServer();

  const state: TestServer = {
    path,
    connections: 0,
    received: [],
    disconnects: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };

  server.on("connection", (socket) => {
    state.connections += 1;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 4) return;
        const len = buffered.readUInt32BE(0);
        if (buffered.length < 4 + len) return;
        const body = buffered.subarray(4, 4 + len).toString("utf8");
        buffered = buffered.subarray(4 + len);
        state.received.push(JSON.parse(body) as Record<string, unknown>);
      }
    });
    socket.on("close", () => {
      state.disconnects += 1;
    });
    socket.on("error", () => {
      /* client hangups are expected in several cases */
    });
    onConnection(socket, state);
  });

  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return state;
}

/** The standard daemon: ack the handshake, then answer the evaluate frame. */
function respondWith(evaluated: Record<string, unknown>): ConnectionHandler {
  return (socket, state) => {
    socket.on("data", () => {
      // `state.received` is appended by the server's own decoder above, which
      // runs on the same 'data' event registered first, so it is already
      // populated by the time this listener sees the chunk.
      const last = state.received[state.received.length - 1];
      if (!last) return;
      if ("hello" in last) {
        socket.write(frame(HELLO_ACK));
        return;
      }
      if ("op" in last) {
        socket.write(frame({ request_id: last.request_id, result: { evaluated } }));
      }
    });
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────

function makeRequest(): EvaluationRequest {
  return buildLocalEnvelope({
    cli: "claude",
    eventType: "PreToolUse",
    rawEventType: "PreToolUse",
    payload: { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } },
    cwd: "/home/u/project",
    sessionId: "sess-1",
    transcriptPath: "/home/u/.claude/projects/x/sess-1.jsonl",
    permissionMode: "default",
    hookEventName: "PreToolUse",
    // A real home — the client must still send `null`.
    host: { home: "/home/u", envFacts: { CLAUDE_PROJECT_DIR: "/home/u/project" } },
  });
}

const ENV_KEYS = [
  "FAILPROOFAI_DAEMON_MODE",
  "FAILPROOFAI_DAEMON_SOCKET",
  "FAILPROOFAI_INSTALL_JSON",
] as const;

describe("hooks/daemon-client", () => {
  let dir: string;
  let servers: TestServer[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-daemon-"));
    servers = [];
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Point the client at a live server and a matching, readable install.json. */
  async function serve(handler: ConnectionHandler): Promise<TestServer> {
    const server = await startServer(dir, handler);
    servers.push(server);
    process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
    writeInstallJson(process.getuid?.() ?? 0);
    return server;
  }

  function writeInstallJson(serviceUid: number): string {
    const path = join(dir, "install.json");
    writeFileSync(path, JSON.stringify({ service_uid: serviceUid }), "utf8");
    process.env.FAILPROOFAI_INSTALL_JSON = path;
    return path;
  }

  // ── the kill switch ──────────────────────────────────────────────────────

  describe("FAILPROOFAI_DAEMON_MODE (dead code by default)", () => {
    it("returns null with the mode unset AND never connects", async () => {
      const server = await serve(respondWith(evaluatedResult()));
      delete process.env.FAILPROOFAI_DAEMON_MODE;

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();

      // The point of the assertion: not "null was returned", but "the socket
      // was never opened". Returning null *after* connecting would still be a
      // per-hook-event syscall on every machine that has a daemon installed.
      expect(server.connections).toBe(0);
    });

    it("returns null with mode=off AND never connects", async () => {
      const server = await serve(respondWith(evaluatedResult()));
      process.env.FAILPROOFAI_DAEMON_MODE = "off";

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(0);
    });

    it("treats mode=shadow as off until Stage 2 lands the differ", async () => {
      const server = await serve(respondWith(evaluatedResult()));
      process.env.FAILPROOFAI_DAEMON_MODE = "shadow";

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(0);
    });

    it("treats an unrecognized mode as off (never more permissive)", async () => {
      const server = await serve(respondWith(evaluatedResult()));
      process.env.FAILPROOFAI_DAEMON_MODE = "ENFORCE"; // wrong case, not a mode

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(0);
    });
  });

  // ── the happy path ───────────────────────────────────────────────────────

  describe("mode=enforce", () => {
    beforeEach(() => {
      process.env.FAILPROOFAI_DAEMON_MODE = "enforce";
    });

    it("returns the daemon's EvaluationResult exactly", async () => {
      await serve(respondWith(evaluatedResult()));

      const result = await tryDaemonEvaluate(makeRequest(), 1000, ENABLED);

      // Byte-for-byte the fields `EvaluationResult` already has. `policy_names`
      // was null, so `policyNames` is absent rather than present-and-undefined.
      expect(result).toEqual({
        exitCode: 0,
        stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
        stderr: "",
        policyName: "failproofai/block-sudo",
        reason: "sudo commands are blocked",
        decision: "deny",
      });
      expect(Object.keys(result!).sort()).toEqual(
        ["decision", "exitCode", "policyName", "reason", "stderr", "stdout"],
      );
    });

    it("carries policy_names through when the verdict names several policies", async () => {
      await serve(
        respondWith(
          evaluatedResult({
            decision: "instruct",
            policy_name: "failproofai/a",
            policy_names: ["failproofai/a", "failproofai/b"],
          }),
        ),
      );

      const result = await tryDaemonEvaluate(makeRequest(), 1000, ENABLED);

      expect(result?.policyNames).toEqual(["failproofai/a", "failproofai/b"]);
      expect(result?.decision).toBe("instruct");
    });

    // ── the request bytes ──────────────────────────────────────────────────

    it("sends host.home as null even though the envelope carries a real home", async () => {
      const server = await serve(respondWith(evaluatedResult()));

      await tryDaemonEvaluate(makeRequest(), 1000, ENABLED);

      const op = server.received[1].op as { evaluate_hook: Record<string, unknown> };
      const host = op.evaluate_hook.host as Record<string, unknown>;
      // A non-null home is `client_asserted_home` and the request is REJECTED,
      // because isAgentInternalPath and block-read-outside-cwd both widen the
      // allow set — a client asserting `home: "/"` would relax a sealed verdict.
      expect(host.home).toBeNull();
      expect("home" in host).toBe(true); // present-and-null, not omitted
    });

    it("sends env_facts containing only keys from the closed set", async () => {
      const server = await serve(respondWith(evaluatedResult()));
      const request = makeRequest();

      await tryDaemonEvaluate(request, 1000, ENABLED);

      const op = server.received[1].op as { evaluate_hook: Record<string, unknown> };
      const host = op.evaluate_hook.host as Record<string, unknown>;
      const envFacts = host.env_facts as Record<string, unknown>;
      // The hook client's environment originates in the agent's process and is
      // therefore under the agent's control; the daemon rejects unknown keys
      // rather than passing them through, so an extra key here is an outage.
      expect(Object.keys(envFacts).sort()).toEqual([...ENV_FACT_KEYS].sort());
      expect(envFacts.CLAUDE_PROJECT_DIR).toBe("/home/u/project");
    });

    it("sends the canonicalized payload and session verbatim, plus a positive deadline", async () => {
      const server = await serve(respondWith(evaluatedResult()));

      await tryDaemonEvaluate(makeRequest(), 1000, ENABLED);

      expect(server.received[0]).toEqual({
        hello: {
          protocol_version: 1,
          client: "failproofai-hook",
          client_version: expect.any(String),
        },
      });
      const request = server.received[1];
      expect(typeof request.request_id).toBe("string");
      const evaluateHook = (request.op as { evaluate_hook: Record<string, unknown> }).evaluate_hook;
      expect(evaluateHook.cli).toBe("claude");
      expect(evaluateHook.event_type).toBe("PreToolUse");
      expect(evaluateHook.raw_event_type).toBe("PreToolUse");
      expect(evaluateHook.payload).toEqual({
        tool_name: "Bash",
        tool_input: { command: "sudo rm -rf /" },
      });
      expect(evaluateHook.session).toEqual({
        session_id: "sess-1",
        transcript_path: "/home/u/.claude/projects/x/sess-1.jsonl",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
      });
      expect(evaluateHook.shadow).toBe(false);
      // The REMAINING budget, so strictly less than what we started with.
      expect(evaluateHook.deadline_ms).toBeGreaterThan(0);
      expect(evaluateHook.deadline_ms as number).toBeLessThanOrEqual(1000);
    });

    it("echoes the response only when request_id matches", async () => {
      await serve((socket, state) => {
        socket.on("data", () => {
          const last = state.received[state.received.length - 1];
          if (!last) return;
          if ("hello" in last) socket.write(frame(HELLO_ACK));
          else socket.write(frame({ request_id: "some-other-id", result: { evaluated: evaluatedResult() } }));
        });
      });

      expect(await tryDaemonEvaluate(makeRequest(), 1000, ENABLED)).toBeNull();
    });

    // ── failure modes: every one of them falls back ────────────────────────

    it("returns null when the socket path does not exist", async () => {
      writeInstallJson(process.getuid?.() ?? 0);
      process.env.FAILPROOFAI_DAEMON_SOCKET = join(dir, "absent.sock");

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it("returns null when the connection is refused (path is not a live socket)", async () => {
      const path = join(dir, "not-a-socket");
      writeFileSync(path, "", "utf8");
      writeInstallJson(process.getuid?.() ?? 0);
      process.env.FAILPROOFAI_DAEMON_SOCKET = path;

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it("returns null when the server closes immediately after accepting", async () => {
      const server = await serve((socket) => socket.destroy());

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(1);
    });

    it("returns null on version_mismatch AND does not send an EvaluateHook frame", async () => {
      const server = await serve((socket) => {
        socket.write(frame({ version_mismatch: { supported: [1], received: 2 } }));
      });

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();

      // Never guess, never retry with a different version, never fail the hook
      // — and above all never submit the event to a daemon whose contract we do
      // not share. Only the hello frame was ever written.
      await vi.waitFor(() => expect(server.disconnects).toBe(1));
      expect(server.received).toHaveLength(1);
      expect(Object.keys(server.received[0])).toEqual(["hello"]);
    });

    it("returns null on a hello_ack declaring a different protocol version", async () => {
      const server = await serve((socket) => {
        socket.write(frame({ hello_ack: { protocol_version: 2, daemon_version: "9.9.9" } }));
      });

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      await vi.waitFor(() => expect(server.received).toHaveLength(1));
    });

    it("returns null within the deadline and destroys the socket when the daemon never responds", async () => {
      // The hang case: accept, ack nothing, write nothing, hold the connection.
      const server = await serve(() => {
        /* deliberately silent */
      });

      const startedAt = performance.now();
      const result = await tryDaemonEvaluate(makeRequest(), 200, ENABLED);
      const elapsed = performance.now() - startedAt;

      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2000);
      // The socket must be destroyed on the timeout path too, or a hung daemon
      // leaks one handle per hook event for the life of the process.
      await vi.waitFor(() => expect(server.disconnects).toBe(1));
    });

    it("returns null without allocating when a frame declares a length above 1 MiB", async () => {
      const server = await serve((socket) => {
        socket.on("data", () => {
          // 2 MiB declared, zero bytes of body delivered. A client that trusted
          // the header would allocate 2 MiB and then block until the deadline.
          socket.write(header(2 * 1024 * 1024));
        });
      });

      const startedAt = performance.now();
      const result = await tryDaemonEvaluate(makeRequest(), 5000, ENABLED);
      const elapsed = performance.now() - startedAt;

      expect(result).toBeNull();
      // Rejected off the header alone: it did not wait for a body that a
      // conforming daemon would never send.
      expect(elapsed).toBeLessThan(2000);
      await vi.waitFor(() => expect(server.disconnects).toBe(1));
    });

    it("returns null on a truncated frame (EOF mid-body)", async () => {
      await serve((socket) => {
        socket.on("data", () => {
          const full = frame(HELLO_ACK);
          socket.write(full.subarray(0, full.length - 5));
          socket.end();
        });
      });

      // A short read is a framing error, never a zero-filled frame.
      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it("returns null on a body that is not valid JSON", async () => {
      await serve((socket) => {
        socket.on("data", () => {
          const body = Buffer.from("{not json", "utf8");
          socket.write(Buffer.concat([header(body.length), body]));
        });
      });

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it("returns null when the daemon answers with an error result", async () => {
      await serve(
        (socket, state) => {
          socket.on("data", () => {
            const last = state.received[state.received.length - 1];
            if (!last) return;
            if ("hello" in last) socket.write(frame(HELLO_ACK));
            else {
              socket.write(
                frame({
                  request_id: last.request_id,
                  result: { error: { code: "canonicalization_mismatch", message: "no" } },
                }),
              );
            }
          });
        },
      );

      // Every error is a client fallback to legacy, never a failed hook.
      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it("returns null when needs_user_context is non-empty", async () => {
      await serve(
        respondWith(evaluatedResult({ needs_user_context: ["custom/my-policy"] })),
      );

      // Accepting this would silently drop enforcement for a user's mutable
      // policies — precisely the failure this product exists to prevent.
      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    it.each([
      ["exit_code is not an integer", { exit_code: "0" }],
      ["stdout is not a string", { stdout: 42 }],
      ["stderr is missing", { stderr: undefined }],
      ["decision is unknown", { decision: "maybe" }],
      ["policy_name is not a string or null", { policy_name: 7 }],
      ["reason is not a string or null", { reason: {} }],
      ["policy_names is not an array of strings", { policy_names: [1, 2] }],
      ["needs_user_context is not an array", { needs_user_context: "none" }],
    ])("returns null when %s", async (_label, overrides) => {
      await serve(respondWith(evaluatedResult(overrides)));
      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
    });

    // ── peer verification ─────────────────────────────────────────────────

    it("returns null and never connects when install.json is missing", async () => {
      const server = await startServer(dir, respondWith(evaluatedResult()));
      servers.push(server);
      process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
      process.env.FAILPROOFAI_INSTALL_JSON = join(dir, "no-such-install.json");

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();

      // Unverified is never "proceed anyway": no socket is opened at all.
      expect(server.connections).toBe(0);
    });

    it("returns null and never connects when install.json has no service_uid", async () => {
      const server = await startServer(dir, respondWith(evaluatedResult()));
      servers.push(server);
      process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
      const path = join(dir, "install.json");
      writeFileSync(path, JSON.stringify({ version: "1.0.0" }), "utf8");
      process.env.FAILPROOFAI_INSTALL_JSON = path;

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(0);
    });

    it("returns null and never connects when the socket owner is not the service UID", async () => {
      const server = await startServer(dir, respondWith(evaluatedResult()));
      servers.push(server);
      process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
      // The socket is owned by whoever runs the test; claim a different UID.
      writeInstallJson((process.getuid?.() ?? 0) + 4242);

      expect(await tryDaemonEvaluate(makeRequest(), 500, ENABLED)).toBeNull();
      expect(server.connections).toBe(0);
    });
  });
});

// ── the handler insertion point ────────────────────────────────────────────

describe("handleHookEvent × daemon-client", () => {
  const originalStdin = process.stdin;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;
  let servers: TestServer[];
  let savedEnv: Record<string, string | undefined>;

  function mockStdin(payload?: string): void {
    Object.defineProperty(process, "stdin", {
      value: {
        setEncoding: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn((event: string, cb: (data?: string) => void) => {
          if (event === "data" && payload) cb(payload);
          if (event === "end") cb();
        }),
        readableEnded: !payload,
      },
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-handler-"));
    servers = [];
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });

  const DENY_PAYLOAD = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "sudo rm -rf /" },
    session_id: "sess-abc",
    transcript_path: "/tmp/does-not-need-to-exist.jsonl",
    cwd: "/home/user/project",
    hook_event_name: "PreToolUse",
  });

  it("routes a daemon hit through the same stdout / activity / telemetry code", async () => {
    const daemonStdout = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"daemon says no"}}';
    const server = await startServer(
      dir,
      respondWith(
        evaluatedResult({
          exit_code: 0,
          stdout: daemonStdout,
          stderr: "",
          decision: "deny",
          policy_name: "failproofai/block-sudo",
          reason: "daemon says no",
        }),
      ),
    );
    servers.push(server);
    process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
    const installPath = join(dir, "install.json");
    writeFileSync(installPath, JSON.stringify({ service_uid: process.getuid?.() ?? 0 }), "utf8");
    process.env.FAILPROOFAI_INSTALL_JSON = installPath;
    process.env.FAILPROOFAI_DAEMON_MODE = "enforce";

    const { handleHookEvent } = await import("../../src/hooks/handler");
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
    const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    mockStdin(DENY_PAYLOAD);
    const exitCode = await handleHookEvent("PreToolUse");

    // `readMergedHooksConfig` DOES run on the daemon path, and must: the daemon
    // evaluates the client's resolved enabled set, so the client has to resolve
    // it. When the daemon supplied its own set instead, a user with 30 policies
    // enabled silently got the 11 builtin defaults.
    //
    // What the daemon actually removes is everything below it. The expensive
    // half is `loadAllCustomHooks`, which writes `.__failproofai_tmp__.mjs`
    // files next to the user's source on every tool call; the config read is a
    // few JSON reads by comparison.
    expect(readMergedHooksConfig).toHaveBeenCalledTimes(1);
    expect(loadAllCustomHooks).not.toHaveBeenCalled();
    expect(evaluatePolicies).not.toHaveBeenCalled();

    // …and everything the handler does with a result still happens, once.
    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(daemonStdout);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(persistHookActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistHookActivity).mock.calls[0][0]).toMatchObject({
      eventType: "PreToolUse",
      integration: "claude",
      toolName: "Bash",
      policyName: "failproofai/block-sudo",
      decision: "deny",
      reason: "daemon says no",
      sessionId: "sess-abc",
      evaluator: "daemon",
    });
    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "hook_policy_triggered",
      expect.objectContaining({
        policy_name: "failproofai/block-sudo",
        decision: "deny",
        has_custom_params: false,
        param_keys_overridden: [],
      }),
    );
  });

  it("falls back to the legacy path when the daemon hangs, and still answers", async () => {
    const server = await startServer(dir, () => {
      /* accept and go silent — the hang case, end to end */
    });
    servers.push(server);
    process.env.FAILPROOFAI_DAEMON_SOCKET = server.path;
    const installPath = join(dir, "install.json");
    writeFileSync(installPath, JSON.stringify({ service_uid: process.getuid?.() ?? 0 }), "utf8");
    process.env.FAILPROOFAI_INSTALL_JSON = installPath;
    process.env.FAILPROOFAI_DAEMON_MODE = "enforce";

    const { handleHookEvent } = await import("../../src/hooks/handler");
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");
    vi.mocked(evaluatePolicies).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "legacy-answered",
      stderr: "",
      policyName: "block-sudo",
      reason: "sudo blocked",
      decision: "deny",
    });

    mockStdin(DENY_PAYLOAD);
    const exitCode = await handleHookEvent("PreToolUse");

    expect(exitCode).toBe(0);
    expect(evaluatePolicies).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith("legacy-answered");
    expect(vi.mocked(persistHookActivity).mock.calls[0][0]).toMatchObject({
      evaluator: "legacy",
      decision: "deny",
    });
  }, 20_000);

  it("produces the same output for a representative deny as it does on main", async () => {
    delete process.env.FAILPROOFAI_DAEMON_MODE;

    const { handleHookEvent } = await import("../../src/hooks/handler");
    const { evaluatePolicies } = await import("../../src/hooks/policy-evaluator");
    const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
    const { persistHookActivity } = await import("../../src/hooks/hook-activity-store");
    const { trackHookEvent } = await import("../../src/hooks/hook-telemetry");

    const denyStdout = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"sudo blocked"}}';
    vi.mocked(evaluatePolicies).mockResolvedValueOnce({
      exitCode: 0,
      stdout: denyStdout,
      stderr: "",
      policyName: "block-sudo",
      reason: "sudo blocked",
      decision: "deny",
    });
    mockStdin(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "sudo rm -rf /" },
        session_id: "sess-abc",
        cwd: "/home/user/project",
        hook_event_name: "PreToolUse",
      }),
    );

    const exitCode = await handleHookEvent("PreToolUse");

    // 1. The legacy path ran — the daemon branch did not divert it.
    expect(readMergedHooksConfig).toHaveBeenCalledWith("/home/user/project");
    expect(evaluatePolicies).toHaveBeenCalledTimes(1);

    // 2. The bytes written are exactly the evaluator's, unchanged.
    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(denyStdout);
    expect(stderrSpy).not.toHaveBeenCalled();

    // 3. Activity and telemetry are unchanged apart from the one added field,
    //    `evaluator`, which must read "legacy" whenever the daemon is off.
    expect(persistHookActivity).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(persistHookActivity).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      eventType: "PreToolUse",
      integration: "claude",
      toolName: "Bash",
      policyName: "block-sudo",
      policyNames: undefined,
      matchedPolicies: [],
      decision: "deny",
      reason: "sudo blocked",
      sessionId: "sess-abc",
      cwd: "/home/user/project",
      hookEventName: "PreToolUse",
      evaluator: "legacy",
    });
    expect(trackHookEvent).toHaveBeenCalledWith(
      "test-instance-id",
      "hook_policy_triggered",
      {
        event_type: "PreToolUse",
        cli: "claude",
        tool_name: "Bash",
        policy_name: "block-sudo",
        decision: "deny",
        is_custom_hook: false,
        is_convention_policy: false,
        convention_scope: null,
        has_custom_params: false,
        param_keys_overridden: [],
      },
    );
  });
});
