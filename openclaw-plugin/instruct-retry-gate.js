/**
 * OpenClaw has no non-blocking context channel on before_tool_call. To deliver
 * an instruct verdict to the model, the shim rejects the first matching call
 * with the instruction as blockReason. Calls from the same session and policy
 * are then allowed for a short window so an advisory policy cannot trap the
 * agent in an endless reject/retry loop.
 */

export const DEFAULT_INSTRUCT_RETRY_WINDOW_MS = 5 * 60 * 1000;

function policyKey(verdict) {
  if (Array.isArray(verdict?.policyNames) && verdict.policyNames.length > 0) {
    return [...verdict.policyNames].map(String).sort().join(",");
  }
  if (verdict?.policyName) return String(verdict.policyName);
  return String(verdict?.reason ?? "instruct");
}

function identity(payload, ctx) {
  const p = payload || {};
  const c = ctx || {};
  const session = c.sessionKey ?? p.sessionKey ?? c.sessionId ?? p.sessionId;
  const run = c.runId ?? p.runId;
  if (session !== undefined && session !== null && session !== "") {
    return {
      scope: `session:${String(session)}${run ? `:run:${String(run)}` : ""}`,
      sessionPrefix: `session:${String(session)}`,
    };
  }
  if (run !== undefined && run !== null && run !== "") {
    return { scope: `run:${String(run)}`, sessionPrefix: null };
  }
  return { scope: null, sessionPrefix: null };
}

export function createInstructRetryGate({
  windowMs = DEFAULT_INSTRUCT_RETRY_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const instructedUntil = new Map();

  function prune(at) {
    for (const [key, expiresAt] of instructedUntil) {
      if (expiresAt <= at) instructedUntil.delete(key);
    }
  }

  return {
    /** True means interrupt this attempt and show the instruction to the model. */
    shouldInterrupt(verdict, payload, ctx) {
      const at = now();
      prune(at);
      const { scope } = identity(payload, ctx);
      // Never let one anonymous hook invocation suppress another unrelated
      // session. OpenClaw normally supplies sessionKey/runId; if it does not,
      // fail safe by delivering the instruction on every matching attempt.
      if (!scope) return true;
      const key = `${scope}\0${policyKey(verdict)}`;
      const expiresAt = instructedUntil.get(key);
      if (expiresAt !== undefined && expiresAt > at) return false;
      instructedUntil.set(key, at + windowMs);
      return true;
    },

    clear(payload, ctx) {
      const { sessionPrefix, scope } = identity(payload, ctx);
      const prefix = sessionPrefix ?? scope;
      if (!prefix) return;
      for (const key of instructedUntil.keys()) {
        if (key.startsWith(`${prefix}\0`) || key.startsWith(`${prefix}:run:`)) {
          instructedUntil.delete(key);
        }
      }
    },
  };
}

/** Map failproofai's flat verdict to OpenClaw's before_tool_call result. */
export function mapBeforeToolVerdict(verdict, payload, ctx, retryGate) {
  if (verdict?.permission === "deny") {
    return { block: true, blockReason: verdict.reason || "Blocked by failproofai" };
  }
  if (verdict?.permission !== "instruct") return undefined;
  if (!retryGate.shouldInterrupt(verdict, payload, ctx)) return undefined;
  return {
    block: true,
    blockReason: verdict.reason || "Instruction from failproofai: reconsider this action before retrying",
  };
}
