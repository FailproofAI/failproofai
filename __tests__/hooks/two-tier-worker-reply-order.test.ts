// @vitest-environment node
/**
 * The warm worker lets a two-tier task hand its place in the queue back
 * (`releaseRegistry`) while it waits on Jev, so a request that arrived behind
 * it on the same connection can finish first. The wire has no request id — a
 * client pipelining requests matches replies by order — so every reply,
 * the ERROR reply of a request whose evaluation threw included, must leave in
 * request order.
 *
 * `evaluateHookEvent` is replaced so the test controls exactly when each
 * request finishes and which one throws; the socket, framing, queue and reply
 * chain are the real worker's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Lets the slow request finish once the test says so. */
let finishSlow!: () => void;
vi.mock("../../src/hooks/handler", () => ({
  evaluateHookEvent: vi.fn(
    async (hookEvent: string, _cli: string, stdin: string, opts?: { releaseRegistry?: () => void }) => {
      const { id } = JSON.parse(stdin) as { id: string };
      if (id === "slow") {
        // Like a two-tier call: hand the queue back, then wait on "the network".
        opts?.releaseRegistry?.();
        await new Promise<void>((r) => (finishSlow = r));
        return { exitCode: 0, stdout: "slow-done", stderr: "", evaluation: { decision: "allow", policyName: null } };
      }
      if (id === "boom") throw new Error(`evaluation of ${hookEvent} blew up`);
      return { exitCode: 0, stdout: `${id}-done`, stderr: "", evaluation: { decision: "allow", policyName: null } };
    },
  ),
}));

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

const hook = (id: string) => ({ type: "hook", hookEvent: "PreToolUse", cli: "claude", stdin: JSON.stringify({ id }) });

/** Writes every frame on ONE connection at once; resolves with the replies in arrival order. */
function pipeline(
  socketPath: string,
  frames: unknown[],
  onFirstRequestQueued: () => void,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath }, () => {
      socket.write(Buffer.concat(frames.map(encodeFrame)));
      onFirstRequestQueued();
    });
    const replies: Array<Record<string, unknown>> = [];
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
        replies.push(JSON.parse(buf.subarray(0, declaredLen).toString("utf8")));
        buf = buf.subarray(declaredLen);
        declaredLen = null;
        if (replies.length === frames.length) {
          socket.end();
          resolvePromise(replies);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

describe("worker replies on one connection leave in request order", () => {
  let socketPath: string;
  let server: import("node:net").Server;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `fpai-reply-order-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(socketPath);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("an evaluation that THROWS behind a released one still gets its error reply in order", async () => {
    const { evaluateHookEvent } = await import("../../src/hooks/handler");
    const replies = pipeline(socketPath, [hook("slow"), hook("boom"), hook("fast")], () => {
      // Once "boom" and "fast" have both been evaluated (they run while "slow"
      // waits), let "slow" finish. Their replies must still wait for it.
      const poll = setInterval(() => {
        if (vi.mocked(evaluateHookEvent).mock.calls.length === 3) {
          clearInterval(poll);
          setTimeout(() => finishSlow(), 50);
        }
      }, 5);
    });
    const got = await replies;
    expect(got.map((r) => r.type)).toEqual(["hookResult", "error", "hookResult"]);
    expect(got[0].stdout).toBe("slow-done");
    expect(got[1].message).toBe("evaluation of PreToolUse blew up");
    expect(got[2].stdout).toBe("fast-done");
  });
});
