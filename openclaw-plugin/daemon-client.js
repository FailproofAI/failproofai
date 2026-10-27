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
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PROTOCOL_VERSION = 2;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

// The CLI's daemon client budgets these separately for the reason it gives:
// connecting is the "is anything listening" probe, the response covers the
// whole evaluation. 250 ms matches the Hermes plugin; 30 s matches the
// daemon's own read timeout on its worker (worker.rs).
export const CONNECT_TIMEOUT_MS = 250;
export const RESPONSE_TIMEOUT_MS = 30_000;

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
function readHookResult(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return failed("invalid", "failproofaid returned a non-object response");
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    return failed("protocol-mismatch", PROTOCOL_MISMATCH_MESSAGE);
  }
  if (message.type === "error") {
    const detail = typeof message.message === "string" && message.message ? message.message : "no detail";
    return failed("evaluation", `failproofaid could not evaluate this call: ${detail}`);
  }
  if (message.type !== "hookResult") {
    return failed("invalid", `failproofaid returned an unexpected ${JSON.stringify(message.type)} response`);
  }
  if (message.exitCode !== 0) {
    return failed("evaluation", `failproofai exited ${String(message.exitCode)} without a verdict`);
  }
  const stdout = typeof message.stdout === "string" ? message.stdout.trim() : "";
  if (!stdout) return { ok: true, verdict: { permission: "allow" } };
  let verdict;
  try {
    verdict = JSON.parse(stdout);
  } catch {
    return failed("invalid", "failproofai returned a verdict that is not JSON");
  }
  if (verdict === null || typeof verdict !== "object" || typeof verdict.permission !== "string") {
    return failed("invalid", "failproofai returned a verdict without a permission");
  }
  return { ok: true, verdict };
}

/**
 * One request, one connection, one frame each way. Never rejects: resolves to
 * `{ok: true, verdict}` or `{ok: false, failure, message}`.
 */
export function requestHookVerdict({
  event,
  payload,
  cwd = "",
  agentSettingsPath = "",
  socketPath = daemonSocketPath(),
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS,
}) {
  return new Promise((done) => {
    let body;
    try {
      body = Buffer.from(
        JSON.stringify({
          type: "hook",
          protocolVersion: PROTOCOL_VERSION,
          hookEvent: event,
          cli: "openclaw",
          stdin: JSON.stringify(payload ?? {}),
          ...(typeof cwd === "string" && cwd ? { cwd } : {}),
          agentSettingsPath: agentSettingsPath || "",
        }),
        "utf8",
      );
    } catch (err) {
      done(failed("invalid", `could not encode the hook request: ${err?.message ?? String(err)}`));
      return;
    }
    if (body.length > MAX_REQUEST_BYTES) {
      done(failed("invalid", "hook request exceeds the 1 MiB limit"));
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

    try {
      socket = createConnection(socketPath);
    } catch {
      finish(failed("unreachable", UNREACHABLE_MESSAGE));
      return;
    }
    timer = setTimeout(() => finish(failed("unreachable", UNREACHABLE_MESSAGE)), connectTimeoutMs);

    socket.on("connect", () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(failed("timeout", `failproofaid did not answer within ${responseTimeoutMs} ms`)),
        responseTimeoutMs,
      );
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
      finish(readHookResult(message));
    });
    socket.on("error", (err) => {
      finish(
        connected
          ? failed("evaluation", `failproofaid connection failed: ${err?.message ?? String(err)}`)
          : failed("unreachable", UNREACHABLE_MESSAGE),
      );
    });
    socket.on("close", () => {
      finish(
        connected
          ? failed("evaluation", "failproofaid closed the connection before returning a verdict")
          : failed("unreachable", UNREACHABLE_MESSAGE),
      );
    });
  });
}
