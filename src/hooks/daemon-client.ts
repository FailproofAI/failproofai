/**
 * The Stage 1 hook-side client for `failproofaid`.
 *
 * Wire contract: `crates/PROTOCOL.md`. That file is the single source of truth
 * shared by this module, `fpai-ipc` (Rust), and the daemon; anything this file
 * infers rather than reads from there is a silent interop bug waiting to
 * happen, so every shape below is transcribed, not invented.
 *
 * ## The governing rule
 *
 * {@link tryDaemonEvaluate} returns `null` on **any** failure and never throws.
 * Socket missing, connect refused, handshake mismatch, timeout, framing error,
 * malformed JSON, an `error` result, a non-empty `needs_user_context` — all
 * `null`. The caller's fallback is not a second implementation of anything: it
 * is "keep executing the same function `handleHookEvent` executes today". A
 * client that throws breaks every hook on the machine; a client that guesses
 * returns a wrong verdict, which is worse.
 *
 * ## Dead by default
 *
 * `FAILPROOFAI_DAEMON_MODE` is read first, at the very top, before a socket is
 * opened and before any other environment variable is read. Unset or `off` and
 * this module does nothing observable — no `stat`, no `connect`, no allocation.
 * A field rollback is one environment variable rather than a release.
 */
import net from "node:net";
import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { version } from "../../package.json";
import { ENV_FACT_KEYS, type EvaluationRequest } from "./request-envelope";
import type { EvaluationResult } from "./policy-evaluator";

/** `protocol_version` carried in the handshake. Bumped with the wire shape. */
const PROTOCOL_VERSION = 1;

/** `client` field of the hello frame — identifies this implementation. */
const CLIENT_NAME = "failproofai-hook";

/**
 * Maximum body of a single frame, both directions: 1 MiB.
 *
 * Same number as `handleHookEvent`'s stdin cap on purpose — a payload the
 * legacy path would have discarded must not become a daemon-path OOM instead.
 * A declared length above this is a framing error and we stop reading; we never
 * allocate the declared size to find out.
 */
const MAX_FRAME_BYTES = 1_048_576;

/** Default socket path when `$FAILPROOFAI_DAEMON_SOCKET` is unset. */
const DEFAULT_SOCKET_PATH = "/run/failproofai/failproofaid.sock";

/**
 * The end-to-end budget handed to the daemon, in milliseconds.
 *
 * Also the wall-clock cost of a hung daemon: the socket is destroyed and the
 * legacy path runs when it expires, so a hook event costs at most this much
 * extra before behaving exactly as it does today. PROTOCOL.md's `EvaluateHook`
 * example uses the same number; no design doc mandates one, and Stage 4 is
 * where the end-to-end latency target is actually gated.
 */
export const DEFAULT_DAEMON_DEADLINE_MS = 800;

/**
 * Root-owned installation manifest, which records the service account's UID.
 *
 * `$FAILPROOFAI_INSTALL_JSON` wins so tests and non-standard installs can point
 * at their own copy; the platform defaults follow.
 */
function installJsonPath(): string {
  const override = process.env.FAILPROOFAI_INSTALL_JSON;
  if (override) return override;
  return process.platform === "darwin"
    ? "/Library/Application Support/failproofai/install.json"
    : "/var/lib/failproofai/install.json";
}

/**
 * The service account UID recorded by the privileged installer, or `null` when
 * the manifest is missing, unreadable, or does not carry one.
 *
 * `null` is never "proceed unverified" — the caller falls back to legacy.
 */
function readServiceUid(): number | null {
  try {
    const raw = readFileSync(installJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as { service_uid?: unknown };
    const uid = parsed.service_uid;
    return typeof uid === "number" && Number.isInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

/**
 * Verify the peer before speaking to it.
 *
 * **This is weaker than `SO_PEERCRED`.** Node exposes no way to read the peer
 * credentials of a connected Unix socket, so we compare the *socket file's*
 * owner against the `service_uid` in root-owned `install.json` instead of
 * asking the kernel who is on the other end. That is a defence against a stray
 * or stale socket — a daemon from a different install, a leftover path, a file
 * some unprivileged process bound. It is **not** a defence against a local
 * attacker who already has root, who could simply chown the socket, nor against
 * a TOCTOU race between this `stat` and the `connect` below. The real check
 * runs on the daemon side, which reads `SO_PEERCRED`/`getpeereid` for the
 * authorization context of every request; Stage 4's native client is where the
 * client side gets the equivalent.
 */
function socketOwnerMatchesService(socketPath: string, serviceUid: number): boolean {
  try {
    return statSync(socketPath).uid === serviceUid;
  } catch {
    return false;
  }
}

// ── Wire shapes ────────────────────────────────────────────────────────────

/**
 * Project the envelope onto the `evaluate_hook` op body.
 *
 * `host.home` is **always `null`**, and that is load-bearing rather than a
 * defaulted field: the daemon derives home from `getpwuid_r(peer_uid)`, and a
 * client-asserted home is a `client_asserted_home` protocol error. It is not
 * pedantry — `isAgentInternalPath` and `block-read-outside-cwd` both *widen*
 * the allow set, so a client asserting `home: "/"` would make every path on the
 * machine "agent internal" and relax a sealed verdict.
 *
 * `env_facts` is emitted as exactly {@link ENV_FACT_KEYS}, with `null` for
 * absent values. The daemon rejects unknown keys, and the hook client's
 * environment originates inside the agent's process — under the agent's own
 * control — so it must never become an injection channel.
 *
 * Absent optional values are explicit `null` rather than omitted keys: `null`
 * deserializes into a Rust `Option` unconditionally, whereas a missing key
 * needs `#[serde(default)]` on the far side. PROTOCOL.md does not say which,
 * and this is the choice that cannot silently fail.
 */
function toEvaluateHookOp(
  request: EvaluationRequest,
  deadlineMs: number,
): Record<string, unknown> {
  const envFacts: Record<string, string | null> = {};
  for (const key of ENV_FACT_KEYS) {
    envFacts[key] = request.host.envFacts.value[key] ?? null;
  }
  return {
    cli: request.cli,
    event_type: request.eventType,
    raw_event_type: request.rawEventType,
    payload: request.payload,
    session: {
      session_id: request.session.sessionId ?? null,
      transcript_path: request.session.transcriptPath ?? null,
      permission_mode: request.session.permissionMode ?? null,
      hook_event_name: request.session.hookEventName ?? null,
    },
    host: {
      home: null,
      cwd: request.host.cwd.value ?? null,
      project_dir: request.host.projectDir.value ?? null,
      env_facts: envFacts,
    },
    deadline_ms: deadlineMs,
    // Stage 1 `enforce` only. `shadow: true` is Stage 2, where the caller
    // discards the answer and the daemon must not run anything with side
    // effects (running both paths would double `warn-repeated-tool-calls`'
    // counter and fire the `require-*-before-stop` subprocesses twice).
    shadow: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `hello_ack` — anything else (including `version_mismatch`) is a fallback. */
function isHelloAck(frame: unknown): boolean {
  if (!isRecord(frame) || !isRecord(frame.hello_ack)) return false;
  return frame.hello_ack.protocol_version === PROTOCOL_VERSION;
}

/**
 * Decode a response frame into an {@link EvaluationResult}, or `null`.
 *
 * `exit_code` / `stdout` / `stderr` / `decision` / `policy_name` /
 * `policy_names` / `reason` are byte-for-byte the fields `EvaluationResult`
 * already has, and the handler writes them out unchanged — that is what makes
 * byte-exact parity against the TypeScript oracle a meaningful assertion rather
 * than a shape check. So every field is type-checked here: a wrong type is a
 * malformed frame, never a coerced value.
 */
function decodeEvaluated(frame: unknown, expectedRequestId: string): EvaluationResult | null {
  if (!isRecord(frame)) return null;
  // Stage 1 is strictly request/response over one connection with no
  // pipelining, so a mismatched request_id is a protocol error, not a frame to
  // skip past.
  if (frame.request_id !== expectedRequestId) return null;
  if (!isRecord(frame.result)) return null;

  const evaluated = frame.result.evaluated;
  // `{ error: { code, message } }` lands here too: every error is a client
  // fallback to legacy, never a failed hook.
  if (!isRecord(evaluated)) return null;

  // Stage 1 always returns this empty and the daemon evaluates sealed-only. A
  // non-empty list means policies matched that nothing evaluated; falling back
  // is mandatory, because otherwise upgrading would silently drop enforcement
  // for a user's mutable policies — precisely the failure this product exists
  // to prevent. The one-shot continuation path lands at Stage 4.
  const needsUserContext = evaluated.needs_user_context;
  if (!Array.isArray(needsUserContext) || needsUserContext.length > 0) return null;

  const { exit_code, stdout, stderr, decision, policy_name, policy_names, reason } = evaluated;
  if (typeof exit_code !== "number" || !Number.isInteger(exit_code)) return null;
  if (typeof stdout !== "string" || typeof stderr !== "string") return null;
  if (decision !== "allow" && decision !== "deny" && decision !== "instruct") return null;
  if (policy_name !== null && typeof policy_name !== "string") return null;
  if (reason !== null && typeof reason !== "string") return null;

  const result: EvaluationResult = {
    exitCode: exit_code,
    stdout,
    stderr,
    policyName: policy_name,
    reason,
    decision,
  };

  // `policyNames` is optional on `EvaluationResult` and the encoder only sets
  // it for multi-policy verdicts, so `null` must leave the key absent rather
  // than present-and-undefined.
  if (policy_names !== null && policy_names !== undefined) {
    if (!Array.isArray(policy_names)) return null;
    if (!policy_names.every((n): n is string => typeof n === "string")) return null;
    result.policyNames = policy_names;
  }

  return result;
}

// ── Framing ────────────────────────────────────────────────────────────────

function encodeFrame(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

// ── The client ─────────────────────────────────────────────────────────────

/**
 * Ask `failproofaid` to evaluate one hook event.
 *
 * @param request  The canonical evaluation envelope `handleHookEvent` already
 *                 built. The payload is already canonicalized; `fpai-canon`
 *                 re-derives and asserts equality rather than trusting it.
 * @param deadlineMs  The **remaining** end-to-end budget, not a per-hop
 *                 timeout. Measured against `performance.now()` — a monotonic
 *                 clock — so a wall-clock step (NTP, suspend/resume, a manual
 *                 `date`) cannot stretch or collapse it.
 * @returns The daemon's verdict, or `null` meaning "fall back to legacy". Never
 *          throws.
 */
export async function tryDaemonEvaluate(
  request: EvaluationRequest,
  deadlineMs: number = DEFAULT_DAEMON_DEADLINE_MS,
): Promise<EvaluationResult | null> {
  // ── Kill switch, first, before anything else is read or opened ──────────
  const mode = process.env.FAILPROOFAI_DAEMON_MODE;
  if (mode === undefined || mode === "" || mode === "off") return null;
  if (mode === "shadow") {
    // Stage 2. Shadow mode runs legacy, then the daemon with `shadow: true`,
    // returns *legacy*, and records the diff — none of which exists yet, so it
    // is treated as `off` rather than silently behaving like `enforce`.
    return null;
  }
  // Anything other than an understood mode falls back too: an unrecognized
  // value must never be more permissive than `off`.
  if (mode !== "enforce") return null;

  try {
    const socketPath = process.env.FAILPROOFAI_DAEMON_SOCKET || DEFAULT_SOCKET_PATH;

    const serviceUid = readServiceUid();
    if (serviceUid === null) return null;
    if (!socketOwnerMatchesService(socketPath, serviceUid)) return null;

    return await roundTrip(socketPath, request, deadlineMs);
  } catch {
    return null;
  }
}

/**
 * One connection, one handshake, one `EvaluateHook`, one response.
 *
 * The socket is destroyed on every exit path including the timeout, so a hung
 * daemon cannot leak a handle per hook event.
 */
function roundTrip(
  socketPath: string,
  request: EvaluationRequest,
  deadlineMs: number,
): Promise<EvaluationResult | null> {
  return new Promise<EvaluationResult | null>((resolve) => {
    const startedAt = performance.now();
    const requestId = randomUUID();

    let settled = false;
    let handshakeAcked = false;
    let buffered: Buffer = Buffer.alloc(0);

    const socket = net.createConnection({ path: socketPath });

    const timer = setTimeout(() => finish(null), Math.max(0, deadlineMs));
    // Never hold the process open on the daemon's account.
    timer.unref?.();

    function finish(result: EvaluationResult | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Listeners stay attached deliberately: removing them would leave a
      // later `error` emission unhandled, which Node turns into an uncaught
      // exception. `settled` makes every one of them a no-op instead.
      try {
        socket.destroy();
      } catch {
        // Nothing left to do — the answer is already `null`.
      }
      resolve(result);
    }

    function send(body: unknown): boolean {
      try {
        socket.write(encodeFrame(body));
        return true;
      } catch {
        return false;
      }
    }

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("end", () => finish(null));

    socket.on("connect", () => {
      const sent = send({
        hello: {
          protocol_version: PROTOCOL_VERSION,
          client: CLIENT_NAME,
          client_version: version,
        },
      });
      if (!sent) finish(null);
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

        for (;;) {
          if (buffered.length < 4) return;
          const bodyLength = buffered.readUInt32BE(0);
          // Validate before allocating anything of the declared size, and stop
          // reading entirely rather than trying to resynchronize: the stream is
          // no longer trustworthy once a frame header is out of contract.
          if (bodyLength > MAX_FRAME_BYTES) {
            finish(null);
            return;
          }
          // Short read — wait for the rest. A frame is never zero-filled to
          // length; EOF mid-frame arrives as `close`, which resolves `null`.
          if (buffered.length < 4 + bodyLength) return;

          const body = buffered.subarray(4, 4 + bodyLength).toString("utf8");
          buffered = buffered.subarray(4 + bodyLength);

          let frame: unknown;
          try {
            frame = JSON.parse(body);
          } catch {
            finish(null);
            return;
          }

          if (!handshakeAcked) {
            // A `version_mismatch` (or any non-`hello_ack`) ends the exchange
            // here: never guess, never retry with another version, never fail
            // the hook. In particular no `EvaluateHook` frame is sent.
            if (!isHelloAck(frame)) {
              finish(null);
              return;
            }
            handshakeAcked = true;

            // `deadline_ms` is what is *left* of the budget at send time, on a
            // monotonic clock, not the budget we started with.
            const remainingMs = Math.round(deadlineMs - (performance.now() - startedAt));
            if (remainingMs <= 0) {
              finish(null);
              return;
            }
            if (!send({ request_id: requestId, op: { evaluate_hook: toEvaluateHookOp(request, remainingMs) } })) {
              finish(null);
            }
            continue;
          }

          finish(decodeEvaluated(frame, requestId));
          return;
        }
      } catch {
        finish(null);
      }
    });
  });
}
