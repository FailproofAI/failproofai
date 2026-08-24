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
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { EvaluationResult } from "../hooks/policy-evaluator";
import { evaluatePolicies } from "../hooks/policy-evaluator";
import { BUILTIN_POLICIES, registerBuiltinPolicies } from "../hooks/builtin-policies";
import { PACK_ENTRY_ASSET, bundledPackDir } from "../hooks/pack-store";
import { loadCustomHooks } from "../hooks/custom-hooks-loader";
import { clearCustomHooks } from "../hooks/custom-hooks-registry";
import {
  clearPolicies,
  getAllPolicies,
  normalizePolicyName,
  registerPolicy,
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

/** Register every builtin policy (regardless of user config) so the replay
 *  shows what *could* be caught, not just what's currently enabled. Called
 *  once per `runAudit` invocation. Snapshots the existing registry so it can
 *  be restored by `restoreReplay()` once the audit is done. */
export async function initReplay(): Promise<void> {
  if (initialized) return;
  savedSnapshot = getAllPolicies();
  clearPolicies();
  const enabled = BUILTIN_POLICIES
    .map((p) => p.name)
    .filter((n) => !SKIP_POLICIES.has(normalizePolicyName(n)));
  if (!(await registerFromVendoredPack(enabled))) registerBuiltinPolicies(enabled);
  initialized = true;
}

/**
 * Register the audit's policies from the pack that ships inside the package,
 * rather than from implementations compiled into this build.
 *
 * The audit scores by RUNNING the policies — three of its four penalty buckets
 * are replay hits — so the day the builtins stop being compiled in, this is
 * what keeps `failproofai audit` reporting the same findings and the same score
 * for the same transcripts. The pack carries the identical functions:
 * `builtin-pack-conformance.test.ts` replays a corpus through both and asserts
 * the verdicts do not diverge.
 *
 * Two things it must get right, or the audit quietly changes:
 *
 * - The pack cannot carry `block-failproofai-commands`, because `alwaysOn` is
 *   refused by the pack loader by design — a downloaded file that no local
 *   command can switch off. It is registered from the compiled side, so the
 *   replayed set is the same 39 either way.
 * - The skip list still applies. `warn-repeated-tool-calls` writes a per-session
 *   sidecar into the user's real transcript directory on every evaluation.
 *
 * Returns false when there is no vendored pack to read — a source checkout that
 * has not run `build:pack`, or a tarball packed without it — and the caller
 * falls back to the compiled implementations. An audit that silently scored on
 * fewer policies would be worse than either.
 */
async function registerFromVendoredPack(enabled: string[]): Promise<boolean> {
  const dir = bundledPackDir();
  if (!dir) return false;
  const entry = resolve(dir, PACK_ENTRY_ASSET);
  if (!existsSync(entry)) return false;

  const wanted = new Set(enabled);
  let hooks;
  try {
    clearCustomHooks();
    hooks = await loadCustomHooks(entry, { strict: true });
  } catch {
    return false;
  } finally {
    clearCustomHooks();
  }
  if (hooks.length === 0) return false;
  const fromPack = new Map(hooks.map((hook) => [hook.name, hook]));

  // Registered in CATALOG ORDER, taking the pack's function where it has one and
  // the compiled one for the guard the pack may not carry.
  //
  // Order is not cosmetic here. `getPoliciesForEvent` sorts by priority only and
  // V8's sort is stable, so registration order decides EVALUATION order, and
  // `evaluatePolicies` stops at the first deny — which means the order decides
  // which policy is CREDITED for a hit. Appending the always-on guard after the
  // pack instead of at its catalog position moved it from index 11 to last, and
  // re-attributed 3 events in a 23,477-event corpus: 456 -> 453 for the guard,
  // with the denies it used to shadow surfacing as block-force-push and
  // block-gh-pipeline. The audit's per-policy counts are what a user reads, so
  // that is a changed audit, not a changed internal.
  let registered = 0;
  for (const policy of BUILTIN_POLICIES) {
    if (!wanted.has(policy.name)) continue;
    const packHook = fromPack.get(policy.name);
    if (policy.alwaysOn || !packHook) {
      registerPolicy(policy.name, policy.description, policy.fn, policy.match, 0, policy.params);
      continue;
    }
    registerPolicy(
      packHook.name,
      packHook.description ?? policy.description,
      packHook.fn,
      packHook.match ?? policy.match,
      0,
      policy.params,
    );
    registered += 1;
  }
  // Nothing came from the pack: it loaded but carried none of the names the
  // audit replays. Falling back is more honest than scoring on the compiled set
  // while claiming the pack lane ran.
  return registered > 0;
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
