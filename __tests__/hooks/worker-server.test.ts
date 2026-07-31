// @vitest-environment node
/**
 * End-to-end test of the warm worker's real server loop: real socket, real
 * framing, real policy evaluation (not mocked) — proves the worker
 * genuinely reuses the unchanged evaluation engine rather than a stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

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

/**
 * Claude's PreToolUse deny contract is JSON on stdout at exit code 0
 * (`hookSpecificOutput.permissionDecision`), not a nonzero exit code — see
 * policy-evaluator.ts. Parse it out rather than asserting on exitCode.
 */
function permissionDecisionOf(response: Record<string, unknown>): string | undefined {
  const stdout = response.stdout;
  if (typeof stdout !== "string" || !stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return parsed.hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
}

async function sendRequest(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath }, () => {
      socket.write(encodeFrame(request));
    });
    readFrame(socket)
      .then((msg) => {
        socket.end();
        resolvePromise(msg);
      })
      .catch(reject);
    socket.on("error", reject);
  });
}

describe("hooks/worker-server (real socket, real evaluation)", () => {
  let projectDir: string;
  let workerSocketPath: string;
  let server: import("node:net").Server;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "fpai-worker-server-test-"));
    mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );

    workerSocketPath = join(tmpdir(), `fpai-worker-server-test-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(workerSocketPath);
    await new Promise<void>((resolvePromise) => {
      if (server.listening) resolvePromise();
      else server.once("listening", () => resolvePromise());
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("denies a sudo command via the real, unmodified builtin policy engine", async () => {
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({
        cwd: projectDir,
        tool_name: "Bash",
        tool_input: { command: "sudo rm -rf /" },
      }),
    });
    expect(response.type).toBe("hookResult");
    expect(response.exitCode).toBe(0);
    expect(permissionDecisionOf(response)).toBe("deny");
  });

  it("allows a benign command through the real policy engine", async () => {
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({
        cwd: projectDir,
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    });
    expect(response.type).toBe("hookResult");
    expect(response.exitCode).toBe(0);
  });

  it("handles multiple requests on the same connection-per-request pattern sequentially and correctly", async () => {
    const results = await Promise.all([
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "sudo ls" } }),
      }),
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "echo hi" } }),
      }),
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "sudo whoami" } }),
      }),
    ]);
    expect(permissionDecisionOf(results[0])).toBe("deny"); // sudo -> deny
    expect(permissionDecisionOf(results[1])).toBeUndefined(); // echo -> allow
    expect(permissionDecisionOf(results[2])).toBe("deny"); // sudo -> deny
  });

  it("uses fallbackCwd when the stdin payload carries no cwd at all", async () => {
    // No cwd in the payload — the worker must inject the client-forwarded
    // cwd rather than resolving project config against its own process.cwd().
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      cwd: projectDir,
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo ls" } }),
    });
    expect(response.type).toBe("hookResult");
    expect(permissionDecisionOf(response)).toBe("deny");
  });

  it("returns an error response for a malformed (non-JSON) frame body, without crashing the server", async () => {
    const response = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const socket = createConnection({ path: workerSocketPath }, () => {
        const body = Buffer.from("not json", "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.write(Buffer.concat([header, body]));
      });
      readFrame(socket)
        .then((msg) => {
          socket.end();
          resolvePromise(msg);
        })
        .catch(reject);
      socket.on("error", reject);
    });
    expect(response.type).toBe("error");

    // The server must still be alive and answer a subsequent valid request.
    const followUp = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "echo still-alive" } }),
    });
    expect(followUp.type).toBe("hookResult");
    expect(followUp.exitCode).toBe(0);
  });

  it("returns an error response for an unrecognized request shape", async () => {
    const response = await sendRequest(workerSocketPath, { type: "ping" });
    expect(response.type).toBe("error");
  });

  it("answers both requests when two frames arrive coalesced in one read", async () => {
    // Two requests written back-to-back on one connection routinely land in
    // a single `data` event. Decoding only the first leaves the second
    // stranded in the receive buffer until some *later* write happens to
    // arrive — meanwhile the caller sees no response and hits its own
    // fail-closed timeout against a daemon that is working fine.
    const frame = (command: string) =>
      encodeFrame({
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command } }),
      });

    const responses = await new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
      const socket = createConnection({ path: workerSocketPath }, () => {
        // One write, both frames — the coalesced case, deterministically.
        socket.write(Buffer.concat([frame("sudo rm -rf /"), frame("echo hi")]));
      });
      const collected: Record<string, unknown>[] = [];
      let buf = Buffer.alloc(0);
      let declaredLen: number | null = null;
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (declaredLen === null) {
            if (buf.length < 4) return;
            declaredLen = buf.readUInt32BE(0);
            buf = buf.subarray(4);
          }
          if (buf.length < declaredLen) return;
          collected.push(JSON.parse(buf.subarray(0, declaredLen).toString("utf8")));
          buf = buf.subarray(declaredLen);
          declaredLen = null;
          if (collected.length === 2) {
            socket.end();
            resolvePromise(collected);
            return;
          }
        }
      });
      socket.on("error", reject);
    });

    expect(responses.map((r) => r.type)).toEqual(["hookResult", "hookResult"]);
    expect(permissionDecisionOf(responses[0])).toBe("deny"); // sudo
    expect(permissionDecisionOf(responses[1])).toBeUndefined(); // echo
  });
});
