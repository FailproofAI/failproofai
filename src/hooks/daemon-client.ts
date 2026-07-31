/**
 * Thin client for talking to the failproofaid Rust daemon over its Unix
 * socket. Used by `bin/failproofai.mjs`'s `--hook` path.
 *
 * Wire format matches `crates/PROTOCOL.md` exactly: one connection per
 * request, a 4-byte big-endian u32 length prefix followed by that many
 * bytes of UTF-8 JSON, camelCase fields, `"type"` as the tag.
 *
 * This module makes NO decision about what to do when the daemon can't be
 * reached — `tryDaemonHook` just returns `null` on any failure. The caller
 * (`bin/failproofai.mjs`) decides: fall back to full in-process evaluation
 * on a machine that was never daemon-configured, or fail closed on one that
 * was. See `isDaemonConfigured`.
 */
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { IntegrationType } from "./types";
import { readHooksConfig } from "./hooks-config";

const PROTOCOL_VERSION = 1;

/**
 * Generous for a healthy warm daemon over a local Unix socket (sub-
 * millisecond connect, no network) — if a healthy daemon needs anywhere
 * near this, something is already wrong and falling through to the
 * caller's fail-closed/in-process path is the correct response. Covers
 * connect + roundtrip as a single budget rather than two separately
 * tracked sub-timeouts: a slow connect and a slow roundtrip are correlated
 * symptoms of the same "daemon unhealthy" state, so splitting them buys
 * little in practice.
 */
const DAEMON_ATTEMPT_TIMEOUT_MS = 150;

const MAX_FRAME_LEN = 16 * 1024 * 1024;

export interface DaemonHookRequest {
  hookEvent: string;
  cli: IntegrationType;
  stdin: string;
  /**
   * Best-effort cwd of the *originating* CLI process (parsed from the
   * hook's own stdin payload by the caller) — never the daemon's or this
   * client process's own cwd. See PROTOCOL.md's note on the process.cwd()
   * hazard.
   */
  cwd?: string;
}

export interface DaemonHookResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function socketPath(): string {
  if (process.env.FAILPROOFAI_DAEMON_SOCKET) return process.env.FAILPROOFAI_DAEMON_SOCKET;
  return resolve(homedir(), ".failproofai", "run", "failproofaid.sock");
}

/**
 * `true` once `failproofai config` has installed and started the daemon for
 * this machine (global scope only — see `HooksConfig.daemonConfigured`).
 * Deliberately a single cheap global-only file read (`readHooksConfig`),
 * not the merged project+local+global reader — whether *this machine* has a
 * daemon is not a per-project setting, and the merge logic doesn't know
 * about this key at all.
 */
export function isDaemonConfigured(): boolean {
  try {
    return readHooksConfig().daemonConfigured === true;
  } catch {
    return false;
  }
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Attempts one hook evaluation via the daemon. Returns `null` on **any**
 * failure — no socket, connection refused, timeout, malformed response,
 * protocol-version mismatch, or an explicit `error` message from the
 * daemon. The caller never needs to distinguish failure modes; it just
 * falls through to whatever its own fallback policy is.
 */
export async function tryDaemonHook(req: DaemonHookRequest): Promise<DaemonHookResponse | null> {
  // Windows never has a daemon in this phase (see the plan's platform
  // scope) — skip the attempt outright rather than depending on however
  // Node happens to behave when handed a POSIX socket path on Windows.
  if (process.platform === "win32") return null;

  return new Promise<DaemonHookResponse | null>((resolvePromise) => {
    let settled = false;
    const finish = (result: DaemonHookResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(result);
    };

    const socket = createConnection({ path: socketPath() });

    const timer = setTimeout(() => finish(null), DAEMON_ATTEMPT_TIMEOUT_MS);
    // Don't let this timer alone keep the process alive if everything else
    // has already finished — it's always cleared on the success/failure
    // paths above, this just avoids it being the sole reason a --hook
    // process lingers if something upstream forgets to await us.
    timer.unref?.();

    let recvBuf = Buffer.alloc(0);
    let declaredLen: number | null = null;

    socket.on("connect", () => {
      socket.write(
        encodeFrame({
          type: "hook",
          protocolVersion: PROTOCOL_VERSION,
          hookEvent: req.hookEvent,
          cli: req.cli,
          stdin: req.stdin,
          cwd: req.cwd,
        }),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      if (declaredLen === null) {
        if (recvBuf.length < 4) return;
        declaredLen = recvBuf.readUInt32BE(0);
        if (declaredLen > MAX_FRAME_LEN) {
          finish(null);
          return;
        }
        recvBuf = recvBuf.subarray(4);
      }

      if (recvBuf.length < declaredLen) return;

      const body = recvBuf.subarray(0, declaredLen);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        finish(null);
        return;
      }

      if (message.protocolVersion !== PROTOCOL_VERSION) {
        finish(null);
        return;
      }
      if (
        message.type === "hookResult" &&
        typeof message.exitCode === "number" &&
        typeof message.stdout === "string" &&
        typeof message.stderr === "string"
      ) {
        finish({ exitCode: message.exitCode, stdout: message.stdout, stderr: message.stderr });
        return;
      }
      // Anything else — an explicit `error` message, a `pong` (protocol
      // confusion), or a well-formed-but-wrong-shape body — is treated
      // identically to a connection failure: no partial trust.
      finish(null);
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
