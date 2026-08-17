// @vitest-environment node
/**
 * The one property that makes the contract observer safe to ship.
 *
 * It runs inside the warm worker's serialized chain on a daemon-configured
 * machine, where the daemon is the ONLY evaluator and every way of not getting
 * an answer is a deny. So a bug in a diagnostic could deny real tool calls
 * across all twelve CLIs. Three distinct failure shapes were reachable, and the
 * guard in `worker-server.ts` has to cover all of them:
 *
 *  - a throw ABOVE the enqueue callback's `try` writes NO frame at all, and the
 *    client burns its full 30s budget before failing closed;
 *  - a throw INSIDE that `try` reaches the outer catch, which answers
 *    `{type:"error"}` — and `daemon-client.ts` treats that identically to an
 *    unreachable daemon, i.e. deny;
 *  - so the call needs its own catch, which is what this asserts.
 *
 * The fault is injected through an environment variable read inside the shipped
 * function rather than through `vi.spyOn`, because a spy only patches the module
 * graph of whichever process evaluates the assertion. The same test written with
 * a spy would pass against a build with the guard deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection, type Socket, type Server } from "node:net";
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

function sendRequest(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
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

describe("contract-observer cannot change a verdict", () => {
  let projectDir: string;
  let homeDir: string;
  let socketPath: string;
  let server: Server;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "fpai-observer-safety-"));
    homeDir = mkdtempSync(join(tmpdir(), "fpai-observer-safety-home-"));
    process.env.FAILPROOFAI_HOME = homeDir;
    process.env.FAILPROOFAI_OBSERVE_VERSIONS = "0";
    mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );

    socketPath = join(tmpdir(), `fpai-observer-safety-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(socketPath);
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.FAILPROOFAI_HOME;
    delete process.env.FAILPROOFAI_OBSERVE_VERSIONS;
    delete process.env.FAILPROOFAI_OBSERVE_FAULT;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  const DENY = {
    type: "hook",
    hookEvent: "PreToolUse",
    cli: "claude",
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } }),
  };

  const ALLOW = {
    type: "hook",
    hookEvent: "PreToolUse",
    cli: "claude",
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }),
  };

  for (const [name, request] of [
    ["a denied call", DENY],
    ["an allowed call", ALLOW],
  ] as const) {
    it(`answers ${name} byte-identically whether or not the observer throws`, async () => {
      const clean = await sendRequest(socketPath, { ...request, cwd: projectDir });

      process.env.FAILPROOFAI_OBSERVE_FAULT = "throw";
      const faulted = await sendRequest(socketPath, { ...request, cwd: projectDir });
      delete process.env.FAILPROOFAI_OBSERVE_FAULT;

      expect(faulted.type).toBe("hookResult");
      expect(faulted.exitCode).toBe(clean.exitCode);
      expect(faulted.stdout).toBe(clean.stdout);
      expect(faulted.stderr).toBe(clean.stderr);
    });
  }

  it("still enforces the deny while the observer is throwing on every event", async () => {
    // Byte-identity alone would also be satisfied if BOTH runs failed open, so
    // assert the deny is really there.
    process.env.FAILPROOFAI_OBSERVE_FAULT = "throw";
    const response = await sendRequest(socketPath, { ...DENY, cwd: projectDir });
    const stdout = typeof response.stdout === "string" ? response.stdout : "";
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("keeps answering after the observer has thrown many times", async () => {
    // A guard that leaks a rejected promise would take the process out on the
    // first event, not the tenth — but a leak that only fires under repetition
    // (an unhandled rejection queued per call) would still be caught here.
    process.env.FAILPROOFAI_OBSERVE_FAULT = "throw";
    for (let i = 0; i < 10; i++) {
      const response = await sendRequest(socketPath, { ...ALLOW, cwd: projectDir });
      expect(response.type).toBe("hookResult");
    }
  });

  it("records the shape on the happy path, proving the call site is live", async () => {
    // Without this the byte-identity assertions above would still pass on a
    // build where the observer call was never wired in at all.
    const { contractTableSnapshot, resetContractObserverForTests } = await import(
      "../../src/hooks/contract-observer"
    );
    resetContractObserverForTests();
    await sendRequest(socketPath, { ...ALLOW, cwd: projectDir });
    expect(contractTableSnapshot().clis.claude?.hooks?.PreToolUse?.tools?.Bash).toEqual(["command"]);
  });
});
