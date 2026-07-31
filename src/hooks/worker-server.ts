/**
 * The warm worker's own server loop — what `failproofaid` (the Rust
 * supervisor) actually spawns and talks to.
 *
 * Listens on a SECOND Unix socket, distinct from the daemon's client-facing
 * one (`daemon-client.ts`'s target) — the Rust process is the only ever
 * client of this socket. Deliberately not stdio-framed JSON-RPC: this
 * process's real stdout/stderr stay ordinary process logs, fully decoupled
 * from the request/response protocol. A stray `console.log` from a user's
 * custom policy file only pollutes a log line here, never desyncs a shared
 * framed channel every in-flight and future request depends on.
 *
 * Requests are processed strictly one at a time (an async queue below), not
 * concurrently, even though multiple connections can be accepted at once —
 * `policy-registry.ts`/`custom-hooks-registry.ts` are `globalThis`-scoped
 * singletons (`clearPolicies()` + register + evaluate), and two interleaved
 * evaluations could have request B's `clearPolicies()` wipe request A's
 * in-flight registration. Serializing keeps the existing registry code
 * correct with zero changes; a worker_threads/process pool is a valid
 * future enhancement if this becomes a real throughput bottleneck.
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { evaluateHookEvent } from "./handler";
import type { IntegrationType } from "./types";
import { hookLogWarn } from "./hook-logger";

const MAX_FRAME_LEN = 16 * 1024 * 1024;

interface WorkerHookRequest {
  type: "hook";
  hookEvent: string;
  cli: IntegrationType;
  stdin: string;
  cwd?: string;
}

function isWorkerHookRequest(msg: unknown): msg is WorkerHookRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === "hook" &&
    typeof m.hookEvent === "string" &&
    typeof m.cli === "string" &&
    typeof m.stdin === "string" &&
    (m.cwd === undefined || typeof m.cwd === "string")
  );
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Serializes every request across every connection through one chain, so
 * `evaluateHookEvent` calls never overlap. `.catch()` on each link keeps the
 * chain alive even if a handler throws unexpectedly — one bad request must
 * never wedge every request queued behind it.
 */
let processingChain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  processingChain = processingChain.then(task).catch(() => {});
}

function handleConnection(socket: Socket): void {
  let recvBuf = Buffer.alloc(0);
  let declaredLen: number | null = null;

  socket.on("data", (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);

    if (declaredLen === null) {
      if (recvBuf.length < 4) return;
      declaredLen = recvBuf.readUInt32BE(0);
      if (declaredLen > MAX_FRAME_LEN) {
        socket.destroy();
        return;
      }
      recvBuf = recvBuf.subarray(4);
    }

    if (recvBuf.length < declaredLen) return;

    const body = recvBuf.subarray(0, declaredLen);
    recvBuf = recvBuf.subarray(declaredLen);
    declaredLen = null;

    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      socket.write(encodeFrame({ type: "error", message: "malformed request frame" }));
      return;
    }

    if (!isWorkerHookRequest(message)) {
      socket.write(encodeFrame({ type: "error", message: "unrecognized request shape" }));
      return;
    }
    const request = message;

    enqueue(async () => {
      try {
        const result = await evaluateHookEvent(request.hookEvent, request.cli, request.stdin, {
          awaitTelemetryFlush: false,
          fallbackCwd: request.cwd,
        });
        socket.write(
          encodeFrame({
            type: "hookResult",
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hookLogWarn(`worker: evaluateHookEvent threw: ${msg}`);
        socket.write(encodeFrame({ type: "error", message: msg }));
      }
    });
  });

  socket.on("error", () => {
    // A client-side disconnect mid-request is not exceptional — the queued
    // task above still runs to completion (harmlessly, since the write
    // will just fail silently on a closed socket) rather than throwing.
  });
}

export function startWorkerServer(socketPath: string): Server {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Racing with something else clearing it — fine, bind will surface
      // any real problem.
    }
  }
  const server = createServer(handleConnection);
  server.listen(socketPath);
  return server;
}
