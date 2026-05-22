/**
 * Replay engine — turns a NormalizedToolEvent into one (or two) synthetic hook
 * payloads, runs them through the existing `evaluatePolicies` function, and
 * returns the policy decisions.
 *
 * Why two events: builtin sanitize-* policies match on PostToolUse and inspect
 * the tool result text. PreToolUse alone misses them. Per event we synthesize:
 *   1. PreToolUse  — { tool_name, tool_input }
 *   2. PostToolUse — { tool_name, tool_input, tool_response } (only when the
 *                     transcript captured a tool_result)
 *
 * Workflow policies (`require-*-before-stop`) match only on `Stop` and
 * execSync against live git, so they never fire on PreToolUse/PostToolUse
 * replay — no explicit skip needed.
 */
import type { EvaluationResult } from "../hooks/policy-evaluator";
import { evaluatePolicies } from "../hooks/policy-evaluator";
import { BUILTIN_POLICIES, registerBuiltinPolicies } from "../hooks/builtin-policies";
import { clearPolicies, normalizePolicyName } from "../hooks/policy-registry";
import type { SessionMetadata } from "../hooks/types";
import type { NormalizedToolEvent } from "./types";

/** Policies the audit skips on purpose. `warn-repeated-tool-calls` mutates a
 *  per-session sidecar file on every evaluation, which would pollute the
 *  user's real transcript directory during a replay (and inflate counts
 *  because the replay always re-traverses the full session). */
const SKIP_POLICIES = new Set(
  ["warn-repeated-tool-calls"].map((n) => normalizePolicyName(n)),
);

let initialized = false;

/** Register every builtin policy (regardless of user config) so the replay
 *  shows what *could* be caught, not just what's currently enabled. Called
 *  once per `runAudit` invocation. */
export function initReplay(): void {
  if (initialized) return;
  clearPolicies();
  const enabled = BUILTIN_POLICIES
    .map((p) => p.name)
    .filter((n) => !SKIP_POLICIES.has(normalizePolicyName(n)));
  registerBuiltinPolicies(enabled);
  initialized = true;
}

/** Reset for tests / repeated audits in the same process. */
export function resetReplay(): void {
  initialized = false;
  clearPolicies();
}

export interface ReplayHit {
  policyName: string;
  decision: "deny" | "instruct" | "allow";
  reason: string | null;
  eventType: "PreToolUse" | "PostToolUse";
}

/** Replay one normalized tool event through every registered policy. Returns
 *  one ReplayHit per non-allow decision (deny + instruct). Allow-with-reason
 *  is reported too, so sanitize policies that emit informational notes still
 *  surface in the audit. */
export async function replayEvent(event: NormalizedToolEvent): Promise<ReplayHit[]> {
  if (!initialized) initReplay();

  const session: SessionMetadata = {
    sessionId: event.sessionId,
    transcriptPath: event.transcriptPath,
    cwd: event.cwd,
    cli: event.cli,
  };

  const baseToolPayload: Record<string, unknown> = {
    tool_name: event.toolName,
    tool_input: event.toolInput,
    session_id: event.sessionId,
    cwd: event.cwd,
    transcript_path: event.transcriptPath,
  };

  const out: ReplayHit[] = [];

  // PreToolUse
  const pre = await evaluatePolicies("PreToolUse", baseToolPayload, session);
  collectHits(pre, "PreToolUse", out);

  // PostToolUse — only if the transcript captured a tool result.
  if (event.toolResultText !== undefined) {
    const postPayload = { ...baseToolPayload, tool_response: event.toolResultText };
    const post = await evaluatePolicies("PostToolUse", postPayload, session);
    collectHits(post, "PostToolUse", out);
  }

  return out;
}

function collectHits(
  result: EvaluationResult,
  eventType: "PreToolUse" | "PostToolUse",
  out: ReplayHit[],
): void {
  // `policyNames` is set when multiple policies fired (sanitize stack);
  // otherwise fall back to `policyName`.
  const names = result.policyNames && result.policyNames.length > 0
    ? result.policyNames
    : result.policyName
      ? [result.policyName]
      : [];
  for (const name of names) {
    // The aggregate `decision` reflects the most severe firing, but the audit
    // wants per-policy counts. We re-tag each name with the aggregate decision
    // for now — accurate enough for the table; a future audit-detail mode can
    // re-evaluate per-policy if precision becomes important.
    out.push({
      policyName: name,
      decision: result.decision,
      reason: result.reason,
      eventType,
    });
  }
}
