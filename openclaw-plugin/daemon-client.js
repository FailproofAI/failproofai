/**
 * Asks failproofaid for a verdict over its owner-only Unix socket — the same
 * `hook` request `failproofai --hook <event> --cli openclaw` sends to the
 * daemon (crates/PROTOCOL.md), made from inside the gateway instead of from a
 * process spawned per hook. The Hermes plugin (hermes-plugin/client.py) reaches
 * the daemon the same way.
 *
 * Why not spawn the CLI: OpenClaw ≥ 2026.9.6 imports this plugin from a copy
 * under ~/.openclaw/tmp/plugin-captures/…, and the copy holds only this
 * directory's files. A CLI path derived from import.meta.url (`../dist/cli.mjs`)
 * then points at nothing; the old shim read the spawn failure as "allow", so
 * every tool call ran unchecked and no hook activity was recorded. The socket
 * path depends only on the environment, never on where this file sits.
 *
 * Self-contained on purpose — node built-ins only, nothing imported from
 * outside this directory — because the capture copies nothing else.
 */
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PROTOCOL_VERSION = 2;
// Oldest daemon version this plugin falls back to (crates/fpai-ipc
// MIN_PROTOCOL_VERSION), and the first that carries agentSettingsPath.
export const MIN_PROTOCOL_VERSION = 1;
const AGENT_SETTINGS_PATH_SINCE = 2;
// The daemon's frame limit (crates/fpai-ipc/src/framing.rs), both ways.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// The payload limit the CLI applies to its stdin (handler.ts, read-stdin.ts).
// It bounds the RAW payload: the envelope carries it as an escaped JSON
// string plus routing fields, so it is larger, and only the frame limit
// applies to the envelope.
export const MAX_PAYLOAD_BYTES = 1_048_576;

// One budget for the whole request, matching the daemon's own read timeout on
// its worker (worker.rs).
//
// There is deliberately NO separate connect timeout. This client runs on the
// OpenClaw gateway's event loop, shared with every agent on the gateway. A
// Unix-socket connect to a live daemon completes in the kernel at once, but
// the gateway only learns of it on a later loop pass; while the gateway is
// busy (a cron burst, a large transcript, GC) a timer that is already overdue
// runs before that connect event. The 250 ms connect timer this replaced
// therefore measured gateway load, and reported a healthy daemon as
// unreachable (#1024). A daemon that is not there needs no timer: the connect
// fails at once with ENOENT or ECONNREFUSED. One that accepts and then hangs is
// caught by this budget.
export const RESPONSE_TIMEOUT_MS = 30_000;
// A connect that fails outright is retried once after this pause before the
// call fails closed: long enough to ride out a daemon restart re-binding its
// socket, short enough that a daemon that is really gone costs one tool call
// 100 ms.
export const UNREACHABLE_RETRY_DELAY_MS = 100;

const PROTOCOL_MISMATCH_MESSAGE =
  "failproofaid is running a different protocol version than this plugin, so it cannot " +
  "evaluate this call. Run `failproofai update` to update the daemon.";
const UNREACHABLE_MESSAGE =
  "failproofaid could not be reached. This machine is configured to run hooks through it " +
  "— check the daemon (see `failproofai config`) rather than retrying blindly.";

/** Mirrors `daemonSocket()` in src/hooks/fp-home.ts. */
export function daemonSocketPath(env = process.env, home = homedir()) {
  return (
    env.FAILPROOFAI_DAEMON_SOCKET ||
    resolve(env.FAILPROOFAI_HOME || resolve(home, ".failproofai"), "run", "failproofaid.sock")
  );
}

/**
 * The gateway profile's openclaw.json — what the spawned CLI computed from the
 * gateway's environment (`runtimeAgentSettingsPath("openclaw", …)` in
 * src/hooks/agent-roster.ts). Sent explicitly: left out, the daemon's worker
 * would resolve it from the DAEMON's environment and attribute a
 * `--profile <name>` gateway to the default profile.
 */
export function openclawAgentSettingsPath(env = process.env, home = homedir()) {
  const config = env.OPENCLAW_CONFIG_PATH;
  if (config?.trim()) return resolve(config);
  const state = env.OPENCLAW_STATE_DIR || env.OPENCLAW_HOME;
  if (state?.trim()) return resolve(state, "openclaw.json");
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile !== "default" && /^[A-Za-z0-9._-]{1,80}$/.test(profile) && !profile.startsWith(".")) {
    return resolve(home, `.openclaw-${profile}`, "openclaw.json");
  }
  return resolve(home, ".openclaw", "openclaw.json");
}

function failed(failure, message) {
  return { ok: false, failure, message };
}

/**
 * Turn the daemon's reply into a flat `{permission, reason}` verdict. For
 * OpenClaw the evaluator always exits 0 and prints either nothing (allow) or
 * one JSON object, so anything else is an evaluation failure — never an allow.
 */
function readHookResult(message, protocolVersion) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return failed("invalid", "failproofaid returned a non-object response");
  }
  if (message.protocolVersion !== protocolVersion) {
    return { ...failed("protocol-mismatch", PROTOCOL_MISMATCH_MESSAGE), daemonVersion: message.protocolVersion };
  }
  if (message.type === "error") {
    const detail = typeof message.message === "string" && message.message ? message.message : "no detail";
    return failed("evaluation", `failproofaid could not evaluate this call: ${detail}`);
  }
  if (message.type !== "hookResult") {
    return failed("invalid", `failproofaid returned an unexpected ${JSON.stringify(message.type)} response`);
  }
  // The daemon always serializes all three (crates/fpai-ipc/src/envelope.rs);
  // a frame missing one is not a hookResult, and must not read as an empty
  // stdout — that is the allow.
  if (
    !Number.isInteger(message.exitCode) ||
    typeof message.stdout !== "string" ||
    typeof message.stderr !== "string"
  ) {
    return failed("invalid", "failproofaid returned an incomplete hookResult");
  }
  if (message.exitCode !== 0) {
    return failed("evaluation", `failproofai exited ${String(message.exitCode)} without a verdict`);
  }
  const stdout = message.stdout.trim();
  if (!stdout) return { ok: true, verdict: { permission: "allow" } };
  let verdict;
  try {
    verdict = JSON.parse(stdout);
  } catch {
    return failed("invalid", "failproofai returned a verdict that is not JSON");
  }
  return isVerdict(verdict)
    ? { ok: true, verdict }
    : failed("invalid", "failproofai returned a malformed verdict");
}

const PERMISSIONS = new Set(["allow", "deny", "instruct"]);

/** The flat shape policy-evaluator.ts prints for `--cli openclaw`; unknown keys are ignored. */
function isVerdict(verdict) {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) return false;
  if (!PERMISSIONS.has(verdict.permission)) return false;
  if (verdict.reason !== undefined && typeof verdict.reason !== "string") return false;
  if (verdict.policyName !== undefined && typeof verdict.policyName !== "string") return false;
  if (
    verdict.policyNames !== undefined &&
    !(Array.isArray(verdict.policyNames) && verdict.policyNames.every((name) => typeof name === "string"))
  ) {
    return false;
  }
  return true;
}

/**
 * One request, one connection, one frame each way. Never rejects: resolves to
 * `{ok: true, verdict}` (plus `oversized: true`, see below) or
 * `{ok: false, failure, message}`.
 *
 * A payload over MAX_PAYLOAD_BYTES is sent as an empty stdin, exactly as the
 * CLI discards an oversized stdin and evaluates an empty payload;
 * `oversized: true` lets the caller say so instead of discarding it silently.
 */
export async function requestHookVerdict(request) {
  // One deadline for the whole call, shared by every attempt below (#1029).
  const startedAt = performance.now();
  const budgetMs = request.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const clock = { startedAt, budgetMs, deadline: startedAt + budgetMs };

  const first = await requestWithRetry(PROTOCOL_VERSION, request, clock);
  // An older daemon still inside the supported range: ask again in its version
  // rather than block every call until it is replaced.
  const older = first.ok ? undefined : first.daemonVersion;
  if (!Number.isInteger(older) || older < MIN_PROTOCOL_VERSION || older >= PROTOCOL_VERSION) {
    if (!first.ok) delete first.daemonVersion;
    return first;
  }
  const retried = await requestWithRetry(older, request, clock);
  if (!retried.ok) delete retried.daemonVersion;
  return retried;
}

/**
 * One request, asked a second time if the first never reached the daemon.
 * Only `unreachable` is retried: nothing was sent, so asking again cannot
 * evaluate a call twice. Every other failure came from a daemon that saw the
 * request, and is returned as it is.
 *
 * Every attempt shares ONE deadline of `responseTimeoutMs`, set before the
 * first and passed to each attempt as an absolute time: an attempt arms its
 * timer with what is left of it just before connecting (so encoding time
 * counts too), and the retry is skipped when the pause before it would use the
 * rest. A fresh budget per attempt let a call wait twice as long, past the
 * gateway's own hook timeout. Time is read from `performance.now()`, a
 * monotonic clock, so a wall-clock change cannot stretch or shrink the budget.
 *
 * A failed retry keeps its own failure and agent-facing message; its `detail`
 * (gateway log only) names both attempts, so the first attempt's cause is
 * never lost behind the second's.
 */
async function requestWithRetry(protocolVersion, request, { startedAt, budgetMs, deadline }) {
  const noTimeToRetry = (first) =>
    ({ ...first, detail: `${first.detail}; no time left in the ${budgetMs} ms budget to retry` });

  const first = await requestOnce(protocolVersion, { ...request, deadline, budgetMs });
  if (first.ok || first.failure !== "unreachable") return first;

  const delayMs = request.retryDelayMs ?? UNREACHABLE_RETRY_DELAY_MS;
  if (deadline - performance.now() - delayMs <= 0) return noTimeToRetry(first);
  await new Promise((resume) => setTimeout(resume, delayMs));
  if (deadline - performance.now() <= 0) return noTimeToRetry(first);

  const second = await requestOnce(protocolVersion, { ...request, deadline, budgetMs });
  if (second.ok) return second;
  return {
    ...second,
    detail:
      `attempt 1: ${first.detail}; attempt 2: ${second.detail ?? second.message}; ` +
      `2 attempts, ${Math.round(performance.now() - startedAt)} ms total`,
  };
}

function requestOnce(protocolVersion, {
  event,
  payload,
  cwd = "",
  agentSettingsPath = "",
  socketPath = daemonSocketPath(),
  // The whole request's budget (for messages) and its absolute end on the
  // performance.now() clock, shared with any retry.
  budgetMs = RESPONSE_TIMEOUT_MS,
  deadline = performance.now() + budgetMs,
}) {
  return new Promise((done) => {
    // Started before encoding, so the elapsed time in `detail` includes it.
    const startedAt = performance.now();
    let body;
    let oversized = false;
    try {
      let stdin = JSON.stringify(payload ?? {});
      if (Buffer.byteLength(stdin, "utf8") > MAX_PAYLOAD_BYTES) {
        stdin = "";
        oversized = true;
      }
      body = Buffer.from(
        JSON.stringify({
          type: "hook",
          protocolVersion,
          hookEvent: event,
          cli: "openclaw",
          stdin,
          ...(typeof cwd === "string" && cwd ? { cwd } : {}),
          ...(protocolVersion >= AGENT_SETTINGS_PATH_SINCE ? { agentSettingsPath: agentSettingsPath || "" } : {}),
        }),
        "utf8",
      );
    } catch (err) {
      done(failed("invalid", `could not encode the hook request: ${err?.message ?? String(err)}`));
      return;
    }
    // Unreachable for a payload within MAX_PAYLOAD_BYTES (escaping at most
    // sextuples it); kept so nothing over the daemon's limit is ever sent.
    if (body.length > MAX_FRAME_BYTES) {
      done(failed("invalid", "hook request exceeds the daemon's 16 MiB frame limit"));
      return;
    }

    let settled = false;
    let connected = false;
    let received = Buffer.alloc(0);
    let timer;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      done(result);
    };
    // The agent-facing message stays the same; `detail` says what actually
    // happened, for the gateway log (hooks.js), so the next field report can
    // tell a missing socket from a refused one from a timeout.
    const unreachable = (cause) =>
      finish({ ...failed("unreachable", UNREACHABLE_MESSAGE), detail: `${cause} after ${Math.round(performance.now() - startedAt)} ms` });

    // Measured after encoding, so a large payload's encoding time is charged
    // to the same budget.
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      unreachable("no time left in the request budget");
      return;
    }
    try {
      socket = createConnection(socketPath);
    } catch (err) {
      unreachable(err?.code ?? err?.message ?? String(err));
      return;
    }
    timer = setTimeout(() => {
      if (connected) finish(failed("timeout", `failproofaid did not answer within ${budgetMs} ms`));
      else unreachable("no connection within the request budget");
    }, remainingMs);

    socket.on("connect", () => {
      connected = true;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        finish(failed("invalid", "failproofaid response exceeds the 16 MiB limit"));
        return;
      }
      if (received.length < 4 + length) return;
      let message;
      try {
        message = JSON.parse(received.subarray(4, 4 + length).toString("utf8"));
      } catch {
        finish(failed("invalid", "failproofaid returned a response that is not JSON"));
        return;
      }
      const result = readHookResult(message, protocolVersion);
      finish(result.ok && oversized ? { ...result, oversized: true } : result);
    });
    socket.on("error", (err) => {
      if (connected) finish(failed("evaluation", `failproofaid connection failed: ${err?.message ?? String(err)}`));
      else unreachable(err?.code ?? err?.message ?? String(err));
    });
    socket.on("close", () => {
      if (connected) finish(failed("evaluation", "failproofaid closed the connection before returning a verdict"));
      else unreachable("closed before connecting");
    });
  });
}
