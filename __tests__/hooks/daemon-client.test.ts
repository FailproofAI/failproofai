// @vitest-environment node
/**
 * Tests daemon-client.ts against a REAL net.Server speaking the actual
 * length-prefixed framing — not a mock of node:net. The point is catching a
 * bug in daemon-client.ts's OWN framing/parsing code, which a mocked socket
 * cannot do (see the plan's Verification section).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogInfo: vi.fn(),
  hookLogWarn: vi.fn(),
  hookLogError: vi.fn(),
}));

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reads exactly one length-prefixed frame off a connected socket. */
function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let buf = Buffer.alloc(0);
    let declaredLen: number | null = null;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (declaredLen === null) {
        if (buf.length < 4) return;
        declaredLen = buf.readUInt32BE(0);
        buf = buf.subarray(4);
      }
      if (buf.length < declaredLen) return;
      socket.off("data", onData);
      resolvePromise(JSON.parse(buf.subarray(0, declaredLen).toString("utf8")));
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

describe("hooks/daemon-client", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server | null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fpai-daemon-client-test-"));
    socketPath = join(tmpDir, "test.sock");
    server = null;
    process.env.FAILPROOFAI_DAEMON_SOCKET = socketPath;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.FAILPROOFAI_DAEMON_SOCKET;
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Starts a real Unix-socket server driven by a per-connection handler. */
  async function startServer(onConnection: (socket: Socket) => void): Promise<void> {
    server = createServer(onConnection);
    await new Promise<void>((resolvePromise) => server!.listen(socketPath, resolvePromise));
  }

  it("returns the parsed result on a real hookResult response", async () => {
    await startServer(async (socket) => {
      const req = await readFrame(socket);
      expect(req.type).toBe("hook");
      expect(req.protocolVersion).toBe(1);
      expect(req.hookEvent).toBe("PreToolUse");
      expect(req.cli).toBe("claude");
      socket.end(
        encodeFrame({
          type: "hookResult",
          protocolVersion: 1,
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      );
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: "{}",
      cwd: "/repo",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("round-trips a deny response with real stdout/stderr content", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      socket.end(
        encodeFrame({
          type: "hookResult",
          protocolVersion: 1,
          exitCode: 2,
          stdout: "",
          stderr: "blocked: sudo is not allowed",
        }),
      );
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "blocked: sudo is not allowed" });
  });

  it("returns null when the daemon sends an error-type message", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      socket.end(encodeFrame({ type: "error", protocolVersion: 1, message: "daemon unreachable" }));
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({ hookEvent: "Stop", cli: "codex", stdin: "{}" });
    expect(result).toBeNull();
  });

  it("returns null on a protocol-version mismatch", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      socket.end(
        encodeFrame({ type: "hookResult", protocolVersion: 999, exitCode: 0, stdout: "", stderr: "" }),
      );
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    expect(result).toBeNull();
  });

  it("returns null on a well-formed but wrong-shape response (no partial trust)", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      // Right protocol version, right general shape, but missing exitCode.
      socket.end(encodeFrame({ type: "hookResult", protocolVersion: 1, stdout: "", stderr: "" }));
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    expect(result).toBeNull();
  });

  it("returns null immediately when no socket file exists at all", async () => {
    // No server started — socketPath was never bound.
    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const start = Date.now();
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    const elapsedMs = Date.now() - start;
    expect(result).toBeNull();
    // ENOENT/ECONNREFUSED on a nonexistent socket is a kernel-level rejection,
    // not a real network timeout — should resolve in well under the 150ms
    // attempt budget, not wait for it to expire.
    expect(elapsedMs).toBeLessThan(100);
  });

  it("returns null and does not hang when the server never responds", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      // Deliberately never write a response.
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const start = Date.now();
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    const elapsedMs = Date.now() - start;
    expect(result).toBeNull();
    // Must hit (roughly) the attempt timeout, not hang indefinitely.
    expect(elapsedMs).toBeGreaterThanOrEqual(140);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("returns null on a garbage (non-JSON) frame body", async () => {
    await startServer(async (socket) => {
      await readFrame(socket);
      const body = Buffer.from("not json", "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      socket.end(Buffer.concat([header, body]));
    });

    const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
    const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
    expect(result).toBeNull();
  });

  it("skips the attempt entirely on win32, never touching the socket", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { tryDaemonHook } = await import("../../src/hooks/daemon-client");
      const start = Date.now();
      const result = await tryDaemonHook({ hookEvent: "PreToolUse", cli: "claude", stdin: "{}" });
      const elapsedMs = Date.now() - start;
      expect(result).toBeNull();
      expect(elapsedMs).toBeLessThan(20);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  describe("isDaemonConfigured", () => {
    let globalConfigDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      globalConfigDir = mkdtempSync(join(tmpdir(), "fpai-daemon-configured-test-"));
      originalHome = process.env.HOME;
      process.env.HOME = globalConfigDir;
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      rmSync(globalConfigDir, { recursive: true, force: true });
    });

    it("is false when no global config file exists", async () => {
      const { isDaemonConfigured } = await import("../../src/hooks/daemon-client");
      expect(isDaemonConfigured()).toBe(false);
    });

    it("is true when the global config has daemonConfigured: true", async () => {
      const dir = join(globalConfigDir, ".failproofai");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "policies-config.json"),
        JSON.stringify({ enabledPolicies: [], daemonConfigured: true }),
      );
      const { isDaemonConfigured } = await import("../../src/hooks/daemon-client");
      expect(isDaemonConfigured()).toBe(true);
    });

    it("is false when daemonConfigured is explicitly false", async () => {
      const dir = join(globalConfigDir, ".failproofai");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "policies-config.json"),
        JSON.stringify({ enabledPolicies: [], daemonConfigured: false }),
      );
      const { isDaemonConfigured } = await import("../../src/hooks/daemon-client");
      expect(isDaemonConfigured()).toBe(false);
    });

    it("is false and does not throw when the config file is malformed JSON", async () => {
      const dir = join(globalConfigDir, ".failproofai");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policies-config.json"), "{ not valid json");
      const { isDaemonConfigured } = await import("../../src/hooks/daemon-client");
      expect(isDaemonConfigured()).toBe(false);
    });
  });
});
