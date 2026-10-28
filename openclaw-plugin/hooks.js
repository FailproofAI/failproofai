/**
 * OpenClaw typed plugin hooks → failproofai verdicts.
 *
 * Kept apart from index.js (whose only job is `definePluginEntry`) so the
 * hook wiring is importable without the `openclaw/plugin-sdk` package, which
 * only resolves inside the gateway.
 *
 * Each hook sends a Claude-shaped payload (params→tool_input, toolName→
 * tool_name, transcriptPath→transcript_path, stopHookActive→stop_hook_active,
 * sessionKey→session_id) with the RAW event and tool names; the daemon's
 * worker canonicalizes them via the OPENCLAW_* maps in src/hooks/types.ts
 * (single source of truth — no inline maps here, unlike the OpenCode/Pi shims).
 *
 * When failproofaid cannot return a verdict the gates fail closed, as every
 * other CLI does on a daemon-configured machine (bin/failproofai.mjs): a tool
 * call or prompt is blocked with the reason, and the reason is logged. The
 * turn-end gate is the exception — a revise cannot bring the daemon back, so
 * forcing one would loop the turn instead of protecting anything.
 */
import { createInstructRetryGate, mapBeforeToolVerdict } from "./instruct-retry-gate.js";
import { createWorkspaceContext } from "./workspace-context.js";
import { openclawAgentSettingsPath, requestHookVerdict } from "./daemon-client.js";

const sharedRetryGate = createInstructRetryGate();
const sharedWorkspace = createWorkspaceContext();

const OBSERVATION_EVENTS = [
  "after_tool_call",
  "session_start",
  "session_end",
  "subagent_ended",
  "before_compaction",
];

const HOOK_OPTIONS = { priority: 100, timeoutMs: 60_000 };

/** Claude-shaped stdin base. Extra keys are ignored by the evaluator's payload
 *  parser; they're forwarded for activity attribution. */
function baseMeta(payload, ctx, config, workspace) {
  const p = payload || {};
  const c = ctx || {};
  return {
    session_id: c.sessionId ?? p.sessionId ?? c.sessionKey ?? p.sessionKey,
    cwd: workspace.resolveWorkspace(p, c, config) ?? process.cwd(),
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

function defaultEvaluate(event, payload) {
  return requestHookVerdict({
    event,
    payload,
    cwd: payload.cwd,
    agentSettingsPath: openclawAgentSettingsPath(),
  });
}

function logFailure(api, event, message) {
  const line = `[failproofai] ${event}: ${message}`;
  try {
    if (typeof api?.logger?.error === "function") {
      api.logger.error(line);
      return;
    }
  } catch { /* fall through to stderr */ }
  process.stderr.write(`${line}\n`);
}

const blockedReason = (message) => `FailproofAI could not check this call, so it was blocked: ${message}`;

/**
 * Register every hook on `api`. `evaluate(event, payload)` resolves to
 * `{ok: true, verdict}` or `{ok: false, message}`; tests inject their own.
 */
export function registerFailproofaiHooks(api, {
  evaluate = defaultEvaluate,
  retryGate = sharedRetryGate,
  workspace = sharedWorkspace,
} = {}) {
  const ask = async (event, payload) => {
    let result;
    try {
      result = await evaluate(event, payload);
    } catch (err) {
      result = { ok: false, message: `the failproofai plugin failed: ${err?.message ?? String(err)}` };
    }
    if (!result?.ok) logFailure(api, event, result?.message ?? "no verdict");
    // Same outcome as the CLI's oversized stdin (warn, evaluate an empty
    // payload), and said out loud for the same reason it is there.
    else if (result.oversized) {
      logFailure(api, event, "payload exceeds 1 MiB, so it was evaluated as an empty payload");
    }
    return result ?? { ok: false, message: "no verdict" };
  };

  // before_tool_call → PreToolUse. Deny always blocks. Instruct blocks the
  // first matching attempt only, using blockReason to give the model the
  // instruction, then permits retries from that session/policy for 5 minutes.
  api.on(
    "before_tool_call",
    async (payload, ctx) => {
      const p = payload || {};
      const result = await ask("before_tool_call", {
        ...baseMeta(payload, ctx, api.config, workspace),
        tool_name: p.toolName,
        tool_input: p.params,
        hook_event_name: "before_tool_call",
      });
      if (!result.ok) return { block: true, blockReason: blockedReason(result.message) };
      return mapBeforeToolVerdict(result.verdict, payload, ctx, retryGate);
    },
    HOOK_OPTIONS,
  );

  // before_agent_run → UserPromptSubmit. Deny: return {outcome:"block", reason}.
  api.on(
    "before_agent_run",
    async (payload, ctx) => {
      const p = payload || {};
      workspace.remember(payload, ctx);
      const result = await ask("before_agent_run", {
        ...baseMeta(payload, ctx, api.config, workspace),
        prompt: p.prompt,
        hook_event_name: "before_agent_run",
      });
      if (!result.ok) return { outcome: "block", reason: blockedReason(result.message) };
      if (result.verdict.permission === "deny") {
        return { outcome: "block", reason: result.verdict.reason || "Blocked by failproofai" };
      }
      return undefined;
    },
    HOOK_OPTIONS,
  );

  // before_agent_finalize → Stop. The real turn-end gate: a deny becomes a
  // revise so the agent runs another pass. The evaluator supplies the
  // MANDATORY ACTION wording; the payload's stop_hook_active guards the
  // require-*-before-stop builtins against infinite loops.
  api.on(
    "before_agent_finalize",
    async (payload, ctx) => {
      const result = await ask("before_agent_finalize", {
        ...baseMeta(payload, ctx, api.config, workspace),
        hook_event_name: "before_agent_finalize",
      });
      if (result.ok && result.verdict.permission === "deny") {
        return { action: "revise", reason: result.verdict.reason || "Action required by failproofai" };
      }
      return undefined;
    },
    HOOK_OPTIONS,
  );

  // Observation hooks — await so activity ordering is stable, ignore verdict.
  // after_tool_call → PostToolUse; session_start/end → SessionStart/End;
  // subagent_ended → SubagentStop (obs only); before_compaction → PreCompact.
  for (const event of OBSERVATION_EVENTS) {
    api.on(
      event,
      async (payload, ctx) => {
        const p = payload || {};
        await ask(event, {
          ...baseMeta(payload, ctx, api.config, workspace),
          tool_name: p.toolName,
          tool_input: p.params,
          tool_response: p.result,
          reason: p.reason,
          hook_event_name: event,
        });
        if (event === "session_end") {
          retryGate.clear(payload, ctx);
          workspace.clear(payload, ctx);
        }
        return undefined;
      },
      HOOK_OPTIONS,
    );
  }
}
