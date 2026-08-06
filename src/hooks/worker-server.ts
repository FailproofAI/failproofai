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
    // `null` as well as `undefined`. The sender is Rust, and `json!({"cwd":
    // cwd})` with an `Option::None` emits `"cwd": null` — JSON has no way to
    // spell `undefined`. Accepting only `undefined` therefore rejected every
    // request that legitimately had no cwd, with "unrecognized request shape".
    //
    // Exactly one caller omits it — `probeDaemonEndToEnd()` — so the effect was
    // that the health probe failed against a PERFECTLY HEALTHY daemon, the
    // wizard read that as "installed but cannot evaluate", and setup aborted
    // writing nothing. On a machine where the daemon is required, that made
    // first-run setup impossible to complete, while every manual check of the
    // daemon said it was fine.
    (m.cwd === undefined || m.cwd === null || typeof m.cwd === "string")
  );
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Last-resort deadline on a single queued task.
 *
 * Deliberately far above `daemon-client.ts`'s 30s `DAEMON_RESPONSE_TIMEOUT_MS`:
 * by the time this fires the client has long since given up and fail-closed, so
 * nothing legitimate is waiting. It exists only to detect a task that will never
 * settle at all.
 */
const TASK_DEADLINE_MS = 60_000;

/**
 * Serializes every request across every connection through one chain, so
 * `evaluateHookEvent` calls never overlap. `.catch()` on each link keeps the
 * chain alive even if a handler throws unexpectedly — one bad request must
 * never wedge every request queued behind it.
 *
 * `.catch()` covers a task that REJECTS. It does nothing for one that never
 * SETTLES, and that state is reachable: a policy file with a top-level `await`
 * that never resolves hangs its `import()`, so the task neither resolves nor
 * rejects and every hook queued behind it waits forever. Each client then burns
 * its own 30s budget and fail-closed denies — every tool call, every CLI on the
 * machine, until someone restarts the daemon. This is a class the warm worker
 * creates: in the one-shot path the identical file hangs one hook process and
 * the agent CLI's own timeout reaps it.
 *
 * `custom-hooks-loader.ts` bounds that import directly, which is the graceful
 * fix and covers the known cause. This is the backstop for the ones nobody
 * thought of, and it EXITS rather than continuing: the orphaned task is still
 * running and still holds the `globalThis` policy registry this chain exists to
 * serialize access to, so letting the next request proceed would trade a wedge
 * for silent cross-request registry corruption. Exiting hands the supervisor a
 * process it will respawn clean (`worker.rs`'s `ensure_started` respawns a
 * worker whose `try_wait()` reports it gone), which costs one cold start and
 * denies the in-flight requests — the same fail-closed outcome they were headed
 * for anyway, but recovered on the next call instead of never.
 */
const WEDGED_EXIT_CODE = 75;

let processingChain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  processingChain = processingChain
    .then(
      () =>
        new Promise<void>((settle) => {
          const timer = setTimeout(() => {
            hookLogWarn(
              `worker: a request did not settle within ${TASK_DEADLINE_MS}ms; ` +
                `exiting so the supervisor can respawn a clean worker`,
            );
            process.exit(WEDGED_EXIT_CODE);
          }, TASK_DEADLINE_MS);
          // Never let the deadline itself hold the event loop open.
          timer.unref?.();
          const done = () => {
            clearTimeout(timer);
            settle();
          };
          void task().then(done, done);
        }),
    )
    .catch(() => {});
}

function handleConnection(socket: Socket): void {
  let recvBuf = Buffer.alloc(0);
  let declaredLen: number | null = null;

  socket.on("data", (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);

    // Drain every *complete* frame this read made available, not just the
    // first. Two requests written back-to-back on one persistent connection
    // routinely coalesce into a single `data` event; decoding one and
    // leaving the rest in `recvBuf` would strand the second request until
    // some later write happened to arrive, and the caller would meanwhile
    // hit its own fail-closed timeout on a daemon that was working fine.
    for (;;) {
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
        continue;
      }

      if (!isWorkerHookRequest(message)) {
        socket.write(encodeFrame({ type: "error", message: "unrecognized request shape" }));
        continue;
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
    }
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
