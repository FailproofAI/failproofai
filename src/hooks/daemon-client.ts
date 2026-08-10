/**
 * Thin client for talking to the failproofaid Rust daemon over its Unix
 * socket. Used by `bin/failproofai.mjs`'s `--hook` path.
 *
 * Wire format matches `crates/PROTOCOL.md` exactly: one connection per
 * request, a 4-byte big-endian u32 length prefix followed by that many
 * bytes of UTF-8 JSON, camelCase fields, `"type"` as the tag.
 *
 * This module reports whether a daemon request succeeded, was unreachable, or
 * used an incompatible protocol. The caller (`bin/failproofai.mjs`) owns the
 * fail-closed response for daemon-configured machines.
 */
import { createConnection } from "node:net";
import type { IntegrationType } from "./types";
import { existsSync } from "node:fs";
import { daemonSocket as daemonSocketPath } from "./fp-home";
import { readConfig } from "./fp-config";

const PROTOCOL_VERSION = 1;

/**
 * Reaching the daemon and getting an answer out of it are two different
 * questions, and the caller's fail-closed policy makes conflating them
 * expensive: on a daemon-configured machine a timeout here is a *deny*, not
 * a fallback.
 *
 * `CONNECT` is the "is anything listening?" budget. Generous for a local
 * Unix socket (sub-millisecond, no network); a daemon that can't answer an
 * accept inside this is unhealthy, and failing fast is exactly right — this
 * is the budget that keeps a dead daemon from adding latency to every hook.
 *
 * `RESPONSE` starts once the connection is established, and must cover the
 * whole evaluation the daemon runs on our behalf: `handler.ts` allows each
 * custom policy up to 10s, `worker-server.ts` serializes requests so one
 * can queue behind another, and a project with many convention policies
 * pays real file I/O on its first evaluation. Budgeting those at connect
 * speed turned a slow-but-correct evaluation into an intermittent denial of
 * a legitimate tool call. Matched to the daemon's own ceiling for the same
 * roundtrip (`worker.rs` sets a 30s read timeout on the worker socket), so
 * this side never gives up on a request the daemon is still honestly
 * working on.
 */
const DAEMON_CONNECT_TIMEOUT_MS = 150;
const DAEMON_RESPONSE_TIMEOUT_MS = 30_000;

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

/**
 * Why an attempt failed. BOTH cases deny; they differ only in what the user is
 * told to do about it.
 *
 * `protocol-mismatch` means a daemon answered, so it is alive — we simply
 * cannot speak its wire format. The cause is known and benign: the CLI upgraded
 * via npm and the daemon has not been reinstalled yet, so the remedy is
 * `failproofai config`, and naming it is the difference between a one-command
 * fix and a support ticket.
 *
 * `unreachable` means nothing answered. A stopped service, a deleted socket and
 * deliberate tampering are indistinguishable from here.
 *
 * This comment used to say a mismatch should FALL BACK to in-process
 * evaluation, "because denying every tool call over it would take a working
 * machine offline to protect nothing". `2926252` deliberately reversed that,
 * and `bin/failproofai.mjs` now routes both failures to the same forced deny:
 * on a daemon-configured machine the daemon is the ONLY evaluator, and a second
 * policy engine reachable by breaking the first is not a guarantee. The
 * distinction survives in the MESSAGE and nowhere else. Do not restore the
 * fallback without revisiting that decision — the comment outliving the code is
 * exactly how it would come back by accident.
 */
export type DaemonFailure = "unreachable" | "protocol-mismatch";

export type DaemonAttempt =
  | { ok: true; response: DaemonHookResponse }
  | { ok: false; failure: DaemonFailure };

/**
 * Whether a daemon is listening, regardless of how it was started.
 *
 * Distinct from `daemonServiceStatus()`, which asks the service manager. A
 * daemon run by hand — during development, or from a container — is invisible
 * to that check but is very much running and pulling policy, so reporting "not
 * installed, so nothing will be pulled" at someone whose machine is actively
 * enforcing is simply false.
 */
export function daemonSocketPresent(): boolean {
  try {
    return existsSync(socketPath());
  } catch {
    return false;
  }
}

/**
 * Whether the daemon socket accepts a connection *right now*.
 *
 * Narrower than `daemonSocketPresent()` (a stale socket file outlives the
 * process that made it) and narrower than `attemptDaemonHook`, which reports
 * `"unreachable"` for BOTH a refused connection and a request that was accepted
 * and then never answered. Those two have different causes and different
 * remedies — a socket that is not up yet versus a worker that cannot run — and
 * telling them apart is the whole point of this function.
 *
 * Connect budget only; nothing is sent. Used by the health probe, never on the
 * hook path.
 */
export async function daemonAcceptsConnections(
  timeoutMs = DAEMON_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  if (process.platform === "win32") return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(v);
    };
    const socket = createConnection({ path: socketPath() });
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

function socketPath(): string {
  if (process.env.FAILPROOFAI_DAEMON_SOCKET) return process.env.FAILPROOFAI_DAEMON_SOCKET;
  return daemonSocketPath();
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
    return readConfig().daemon.configured === true;
  } catch {
    // Unreadable config reads as NOT daemon-configured. The failure direction
    // is deliberate: the alternative is a machine that fails closed on every
    // tool call because a config file got truncated.
    return false;
  }
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Attempts a daemon evaluation while preserving the failure category. */
export async function attemptDaemonHook(
  req: DaemonHookRequest,
  opts?: {
    /**
     * Override the RESPONSE budget only — the connect budget is never
     * relaxed. Used by the health probe (`probeDaemonEndToEnd`), which runs
     * from an interactive command rather than a hook and must not make a
     * person wait out the full 30s hook budget to be told their daemon is
     * broken. Never set this on the hook path: 30s is matched to the
     * daemon's own read timeout so this side never gives up on a request the
     * daemon is still honestly working on.
     */
    responseTimeoutMs?: number;
  },
): Promise<DaemonAttempt> {
  // Windows never has a daemon in this phase (see the plan's platform
  // scope) — skip the attempt outright rather than depending on however
  // Node happens to behave when handed a POSIX socket path on Windows.
  if (process.platform === "win32") return { ok: false, failure: "unreachable" };
  const responseBudget = opts?.responseTimeoutMs ?? DAEMON_RESPONSE_TIMEOUT_MS;

  return new Promise<DaemonAttempt>((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail("unreachable"), ms);
      // Don't let this timer alone keep the process alive if everything else
      // has already finished — it's always cleared on the success/failure
      // paths below, this just avoids it being the sole reason a --hook
      // process lingers if something upstream forgets to await us.
      timer.unref?.();
    };
    const finish = (result: DaemonAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(result);
    };
    const fail = (failure: DaemonFailure) => finish({ ok: false, failure });

    const socket = createConnection({ path: socketPath() });
    arm(DAEMON_CONNECT_TIMEOUT_MS);

    let recvBuf = Buffer.alloc(0);
    let declaredLen: number | null = null;

    socket.on("connect", () => {
      // Connected: the daemon is demonstrably reachable, so the question is
      // no longer "is it there" but "how long does this evaluation take".
      arm(responseBudget);
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
          fail("unreachable");
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
        fail("unreachable");
        return;
      }

      if (message.protocolVersion !== PROTOCOL_VERSION) {
        // Catches BOTH directions. A newer CLI sends v2 and the daemon replies
        // with an error stamped v1; an older CLI sends v1 and a newer daemon
        // replies stamped v2. Either way the versions disagree here, and either
        // way a daemon answered — so this is skew, not absence.
        fail("protocol-mismatch");
        return;
      }
      if (
        message.type === "hookResult" &&
        typeof message.exitCode === "number" &&
        typeof message.stdout === "string" &&
        typeof message.stderr === "string"
      ) {
        finish({
          ok: true,
          response: {
            exitCode: message.exitCode,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      }
      // Anything else — an explicit `error` message at a MATCHING protocol
      // version, a `pong` (protocol confusion), or a well-formed-but-wrong-shape
      // body — is treated identically to a connection failure: no partial trust.
      fail("unreachable");
    });

    socket.on("error", () => fail("unreachable"));
    socket.on("close", () => fail("unreachable"));
  });
}
