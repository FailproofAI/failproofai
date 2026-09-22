// @vitest-environment node
/**
 * The warm worker serializes hook requests around the process-global policy
 * registry. A two-tier call must not hold that queue while it waits on Jev's
 * network answer: otherwise every hook on the machine queues behind each
 * gated call's round trip, and a slow or unreachable provider turns the
 * promised fallback into the daemon client's 30 s fail-closed deny for
 * whatever is at the back of the queue.
 *
 * Real socket, real framing, real worker loop, real evaluation. Only the
 * contract boundaries are faked: a Jev config exists (T1's loader) and the
 * provider never answers (T1's transport), so every gated call waits out its
 * full timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig } from "../../src/hooks/semantic/jev-config";
import type { JevRequest, JevResponse } from "../../src/hooks/semantic/types";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

const JEV_TIMEOUT_MS = 1_200;
const CFG: JevConfig = { provider: "cloudflare", apiKey: "not-a-real-key", accountId: "0".repeat(32), timeoutMs: JEV_TIMEOUT_MS };
vi.mock("../../src/hooks/semantic/jev-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-config")>();
  return { ...actual, loadJevConfig: vi.fn(() => CFG) };
});

const jevCalls: AbortSignal[] = [];
/** Jev requests in flight right now, and the most there ever were at once. */
const inFlight = { now: 0, max: 0 };
vi.mock("../../src/hooks/semantic/jev-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-client")>();
  return {
    ...actual,
    transportForConfig: vi.fn((cfg: JevConfig) => ({
      // A provider that never answers; only the timeout (or an abort) ends it.
      transport: (_request: JevRequest, signal: AbortSignal) =>
        new Promise<JevResponse>((_, reject) => {
          jevCalls.push(signal);
          inFlight.now += 1;
          inFlight.max = Math.max(inFlight.max, inFlight.now);
          signal.addEventListener("abort", () => {
            inFlight.now -= 1;
            reject(new DOMException("stopped", "AbortError"));
          });
        }),
      via: cfg.provider,
      model: "jev-1.13.0",
    })),
  };
});

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

/** Sends one request; resolves with the response and when it arrived. */
function send(socketPath: string, request: unknown): Promise<{ response: Record<string, unknown>; at: number }> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath }, () => socket.write(encodeFrame(request)));
    readFrame(socket)
      .then((response) => {
        socket.end();
        resolvePromise({ response, at: performance.now() });
      })
      .catch(reject);
    socket.on("error", reject);
  });
}

describe("two-tier in the warm worker: the Jev wait does not hold the queue", () => {
  let projectDir: string;
  let homeDir: string;
  let socketPath: string;
  let server: import("node:net").Server;

  beforeEach(async () => {
    jevCalls.length = 0;
    inFlight.now = 0;
    inFlight.max = 0;
    projectDir = mkdtempSync(join(tmpdir(), "fpai-two-tier-queue-"));
    homeDir = mkdtempSync(join(tmpdir(), "fpai-two-tier-queue-home-"));
    process.env.FAILPROOFAI_HOME = homeDir;
    mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
    writeFileSync(join(projectDir, ".failproofai", "policies-config.json"), JSON.stringify({ enabledPolicies: ["block-sudo"] }));
    socketPath = join(tmpdir(), `fpai-two-tier-queue-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(socketPath);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.FAILPROOFAI_HOME;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  const hook = (hookEvent: string, payload: Record<string, unknown>) => ({
    type: "hook",
    hookEvent,
    cli: "claude",
    stdin: JSON.stringify({ cwd: projectDir, session_id: "queue-test", ...payload }),
    cwd: projectDir,
  });
  const decisionOf = (r: Record<string, unknown>) => (r.evaluation as { decision?: string } | undefined)?.decision;

  it("hooks queued behind a gated call are answered while it waits on Jev", async () => {
    const t0 = performance.now();
    // A: allowed by every regex policy, so it waits on Jev — the full timeout.
    const gated = send(socketPath, hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls -la" } }));
    // Let A reach its Jev wait, then queue three more behind it.
    while (jevCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
    const sudo = send(socketPath, hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "sudo whoami" } }));
    const post = send(socketPath, hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }));
    const prompt = send(socketPath, hook("UserPromptSubmit", { prompt: "carry on" }));

    const [a, b, c, d] = await Promise.all([gated, sudo, post, prompt]);

    // Every queued hook was answered while A was still waiting. Serialized,
    // all three would have queued behind A's full Jev timeout.
    for (const other of [b, c, d]) expect(other.at).toBeLessThan(a.at);
    // …and A really did wait out its timeout, then fell back to the regex result.
    expect(a.at - t0).toBeGreaterThanOrEqual(JEV_TIMEOUT_MS - 50);

    expect(decisionOf(a.response)).toBe("allow");
    expect(a.response.stdout).toBe("");
    expect(decisionOf(b.response)).toBe("deny");
    expect((b.response.evaluation as { policyName?: string }).policyName).toBe("failproofai/block-sudo");
    expect(decisionOf(c.response)).toBe("allow");
    expect(decisionOf(d.response)).toBe("allow");
    // A's own record is intact although other requests re-registered the
    // registry under it while it waited.
    expect((a.response.evaluation as { matchedPolicies?: string[] }).matchedPolicies).toContain("failproofai/block-sudo");
  }, 15_000);

  it("gated calls wait on Jev concurrently, not one after another", async () => {
    const calls = Array.from({ length: 4 }, (_, i) =>
      send(socketPath, hook("PreToolUse", { tool_name: "Bash", tool_input: { command: `ls -la dir${i}` } })),
    );
    const results = await Promise.all(calls);
    for (const r of results) expect(decisionOf(r.response)).toBe("allow");
    // All four were waiting on Jev at the same moment. Serialized, there is
    // never more than one request in flight.
    expect(jevCalls).toHaveLength(4);
    expect(inFlight.max).toBe(4);
    expect(inFlight.now).toBe(0);
  }, 15_000);

  it("replies on ONE connection still leave in request order, though a later request finished first", async () => {
    // The wire has no request id: a client pipelining requests on one
    // connection matches replies by order. A (gated, waits out Jev's timeout)
    // releases the queue, so B (a hard deny, instant) finishes long before it.
    const frames = [
      hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls -la pipelined" } }),
      hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "sudo whoami" } }),
    ];
    const replies = await new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
      const socket = createConnection({ path: socketPath }, () => socket.write(Buffer.concat(frames.map(encodeFrame))));
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
          if (collected.length === frames.length) {
            socket.end();
            resolvePromise(collected);
            return;
          }
        }
      });
      socket.on("error", reject);
    });
    expect(decisionOf(replies[0])).toBe("allow");
    expect(replies[0].stdout).toBe("");
    expect(decisionOf(replies[1])).toBe("deny");
    expect((replies[1].evaluation as { policyName?: string }).policyName).toBe("failproofai/block-sudo");
  }, 15_000);
});
