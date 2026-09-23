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
import {
  clearPolicies,
  getAllPolicies,
  normalizePolicyName,
  setAllPolicies,
} from "../hooks/policy-registry";
import type { RegisteredPolicy } from "../hooks/policy-types";
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
/** Snapshot of the registry taken at `initReplay()`. Restored by
 *  `restoreReplay()` so embedding `runAudit()` in a long-running process
 *  (e.g. the Next.js dashboard) doesn't wipe any prior policy registrations. */
let savedSnapshot: RegisteredPolicy[] | null = null;

/**
 * Register every builtin policy (regardless of user config) so the replay shows
 * what *could* be caught, not just what is currently enabled. Called once per
 * `runAudit` invocation. Snapshots the existing registry so `restoreReplay()`
 * can put it back.
 *
 * The implementations compiled into this build, and ONLY those. The audit used
 * to prefer a vendored `policy-pack/` copy where one existed, which was
 * meaningful while the package shipped that directory; it no longer ships it, so
 * that branch could not fire in any published build and existed only to be
 * misread as "the audit scores against installed packs". It does not, and must
 * not: an audit is a fixed yardstick, and one that changed shape with whatever
 * pack a machine happened to have could not be compared against its own history.
 */
export async function initReplay(): Promise<void> {
  if (initialized) return;
  savedSnapshot = getAllPolicies();
  clearPolicies();
  const enabled = BUILTIN_POLICIES
    .map((p) => p.name)
    .filter((n) => !SKIP_POLICIES.has(normalizePolicyName(n)));
  registerBuiltinPolicies(enabled);
  initialized = true;
}

/** Restore the registry to whatever was there before `initReplay()`. Safe to
 *  call when not initialized (no-op). Always paired with `initReplay()` in a
 *  try/finally inside `runAudit()`. */
export function restoreReplay(): void {
  if (!initialized) return;
  if (savedSnapshot !== null) {
    setAllPolicies(savedSnapshot);
    savedSnapshot = null;
  }
  initialized = false;
}

/** Reset for tests / repeated audits in the same process. Drops the snapshot
 *  too — tests usually start with an empty registry and want it back. */
export function resetReplay(): void {
  initialized = false;
  savedSnapshot = null;
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
  if (!initialized) await initReplay();

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
