/**
 * failproofai policy bridge for OpenClaw (openclaw gateway).
 *
 * Loaded in-process by the gateway (registered via `plugins.load.paths` +
 * `plugins.entries.failproofai` in ~/.openclaw/openclaw.json). It subscribes to
 * OpenClaw's typed PLUGIN hooks — the only surface that can block; OpenClaw's
 * file-based "internal hooks" are observation-only — and forwards each to the
 * failproofai binary as `failproofai --hook <event> --cli openclaw`. failproofai
 * prints a flat `{permission, reason}` verdict on stdout; this shim maps it to
 * each hook's native return shape.
 *
 * Marker comment for failproofai's installer detection (do not remove):
 *   __failproofai_hook__: true
 *
 * Design notes (verified live against openclaw v2026.7.1):
 *  • ASYNC spawn, never spawnSync — the gateway is a long-running multi-channel
 *    process; a synchronous spawn on every hook would stall every channel.
 *    30s guard timer; fail-open on any error (never block on infra failure).
 *  • Raw forwarding — we send the raw tool name / params and a Claude-shaped
 *    stdin (params→tool_input, toolName→tool_name, transcriptPath→
 *    transcript_path, stopHookActive→stop_hook_active, sessionKey→session_id).
 *    The binary canonicalizes via OPENCLAW_* maps (single source of truth); the
 *    shim ships NO inline maps (unlike the OpenCode/Pi shims).
 *  • No top-level `await` — OpenClaw's plugin loader rejects it; all async work
 *    happens inside register()'s handlers.
 *
 * Binary resolution mirrors pi-extension/index.ts: prefer the bundled
 * dist/cli.mjs (node-compatible), fall back to bin/failproofai.mjs with bun for
 * dev; honor FAILPROOFAI_BINARY_OVERRIDE. Paths resolve relative to this file
 * via import.meta.url (the gateway spawns plugins with an undefined cwd).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_BIN = resolve(HERE, "..", "dist", "cli.mjs");
const SRC_BIN = resolve(HERE, "..", "bin", "failproofai.mjs");

function resolveSpawn() {
  if (process.env.FAILPROOFAI_BINARY_OVERRIDE) {
    return { cmd: "node", args: [process.env.FAILPROOFAI_BINARY_OVERRIDE] };
  }
  if (existsSync(DIST_BIN)) {
    return { cmd: "node", args: [DIST_BIN] };
  }
  return { cmd: "bun", args: [SRC_BIN] };
}

function debug(msg) {
  if (process.env.FAILPROOFAI_OPENCLAW_DEBUG === "1") {
    process.stderr.write(`[failproofai-openclaw-shim] ${msg}\n`);
  }
}

/**
 * Spawn `failproofai --hook <rawEvent> --cli openclaw`, write the JSON payload
 * to stdin, and resolve the parsed flat `{permission, reason}` verdict. Async +
 * fail-open: any spawn/parse error or timeout resolves to `{permission:"allow"}`
 * so a failproofai fault never blocks the gateway.
 */
function callPolicy(rawEvent, payload) {
  return new Promise((done) => {
    const { cmd, args } = resolveSpawn();
    let child;
    try {
      child = spawn(cmd, [...args, "--hook", rawEvent, "--cli", "openclaw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      debug(`spawn threw: ${err && err.message ? err.message : String(err)}`);
      done({ permission: "allow" });
      return;
    }
    let out = "";
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(verdict);
    };
    const timer = setTimeout(() => {
      debug(`timeout on ${rawEvent}; killing child`);
      try { child.kill(); } catch { /* ignore */ }
      finish({ permission: "allow" });
    }, 30_000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (err) => {
      debug(`child error: ${err && err.message ? err.message : String(err)}`);
      finish({ permission: "allow" });
    });
    child.on("close", () => {
      const stdout = out.trim();
      if (!stdout) { finish({ permission: "allow" }); return; }
      try {
        finish(JSON.parse(stdout));
      } catch (err) {
        debug(`parse error: ${err && err.message ? err.message : String(err)}`);
        finish({ permission: "allow" });
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (err) {
      debug(`stdin write failed: ${err && err.message ? err.message : String(err)}`);
      finish({ permission: "allow" });
    }
  });
}

/** Claude-shaped stdin base. Extra keys are ignored by the binary's payload
 *  parser; they're forwarded for future use / activity attribution. */
function baseMeta(payload, ctx) {
  const p = payload || {};
  const c = ctx || {};
  return {
    session_id: c.sessionId ?? p.sessionId ?? c.sessionKey ?? p.sessionKey,
    cwd: p.cwd ?? c.workspaceDir ?? process.cwd(),
    transcript_path: p.transcriptPath,
    stop_hook_active: p.stopHookActive === true,
    openclaw: {
      agentId: c.agentId,
      sessionKey: c.sessionKey ?? p.sessionKey,
      runId: c.runId ?? p.runId,
      provider: p.provider,
      model: p.model,
    },
  };
}

export default definePluginEntry({
  id: "failproofai",
  name: "failproofai",
  description: "Real-time policy enforcement for OpenClaw by failproofai",
  register(api) {
    // before_tool_call → PreToolUse. Full deny: return {block:true, blockReason}.
    api.on(
      "before_tool_call",
      async (payload, ctx) => {
        const p = payload || {};
        const verdict = await callPolicy("before_tool_call", {
          ...baseMeta(payload, ctx),
          tool_name: p.toolName,
          tool_input: p.params,
          hook_event_name: "before_tool_call",
        });
        if (verdict.permission === "deny") {
          return { block: true, blockReason: verdict.reason || "Blocked by failproofai" };
        }
        return undefined;
      },
      { priority: 100, timeoutMs: 60_000 },
    );

    // before_agent_run → UserPromptSubmit. Deny: return {outcome:"block", reason}.
    api.on(
      "before_agent_run",
      async (payload, ctx) => {
        const p = payload || {};
        const verdict = await callPolicy("before_agent_run", {
          ...baseMeta(payload, ctx),
          prompt: p.prompt,
          hook_event_name: "before_agent_run",
        });
        if (verdict.permission === "deny") {
          return { outcome: "block", reason: verdict.reason || "Blocked by failproofai" };
        }
        return undefined;
      },
      { priority: 100, timeoutMs: 60_000 },
    );

    // before_agent_finalize → Stop. The real turn-end gate: a deny becomes a
    // revise so the agent runs another pass. The evaluator supplies the
    // MANDATORY ACTION wording; the payload's stop_hook_active guards the
    // require-*-before-stop builtins against infinite loops.
    api.on(
      "before_agent_finalize",
      async (payload, ctx) => {
        const verdict = await callPolicy("before_agent_finalize", {
          ...baseMeta(payload, ctx),
          hook_event_name: "before_agent_finalize",
        });
        if (verdict.permission === "deny") {
          return { action: "revise", reason: verdict.reason || "Action required by failproofai" };
        }
        return undefined;
      },
      { priority: 100, timeoutMs: 60_000 },
    );

    // Observation hooks — await so activity ordering is stable, ignore verdict.
    // after_tool_call → PostToolUse; session_start/end → SessionStart/End;
    // subagent_ended → SubagentStop (obs only); before_compaction → PreCompact.
    for (const ev of [
      "after_tool_call",
      "session_start",
      "session_end",
      "subagent_ended",
      "before_compaction",
    ]) {
      api.on(
        ev,
        async (payload, ctx) => {
          const p = payload || {};
          await callPolicy(ev, {
            ...baseMeta(payload, ctx),
            tool_name: p.toolName,
            tool_input: p.params,
            tool_response: p.result,
            reason: p.reason,
            hook_event_name: ev,
          });
          return undefined;
        },
        { priority: 100, timeoutMs: 60_000 },
      );
    }
  },
});
