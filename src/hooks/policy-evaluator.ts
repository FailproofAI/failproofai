/**
 * Evaluates enabled policies against a hook event payload.
 * Returns exit code, stdout, and stderr for the hook handler.
 */
import type { HookEventType, SessionMetadata } from "./types";
import type { PolicyContext, HooksConfig, RegisteredPolicy } from "./policy-types";
// Read from the layer that owns it rather than restated here — restating a
// pack id is exactly how `failproofai/builtins` and `failproofai/core` both
// outlived their rename. This is on the hook path, so the cost was measured
// rather than assumed: bundling policy-evaluator with this import is 38,627
// bytes against 37,491 without it, because only the constant survives
// tree-shaking. 1.1 KB is not worth a second copy of a name that has already
// drifted twice.
import { CORE_SOURCE } from "./pack-store";
import { packPolicyParamKey, parsePackPolicyName } from "./pack-param-key";
export { packPolicyParamKey } from "./pack-param-key";
import { DEFAULT_POLICY_NAMESPACE, getPoliciesForEvent } from "./policy-registry";
// Type-only apart from the two pure functions: the semantic evaluator itself is
// loaded by handler.ts, lazily, and only when a Jev config exists.
import { combineTwoTier, regexOnly, type FinalVerdict, type JevActivityFields, type JevReview, type RegexVerdict, type TwoTierReview } from "./semantic/combine";
import { hookLogInfo, hookLogWarn } from "./hook-logger";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

function appendHint(baseReason: string, hint: unknown): string {
  const base = baseReason.trim();
  const normalizedHint = typeof hint === "string" ? hint.trim() : "";
  if (!normalizedHint) return base;
  if (!base) return normalizedHint;
  return `${base}. ${normalizedHint}`;
}

export interface EvaluationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  policyName: string | null;
  policyNames?: string[];
  reason: string | null;
  decision: "allow" | "deny" | "instruct";
  /**
   * Present only when the two-tier (Jev) path ran — never on the regex-only
   * path, so an unconfigured machine's results carry no extra key.
   */
  twoTier?: {
    /** The hook-activity fields to persist for this call. */
    activity: JevActivityFields;
    /** True when Jev's own verdict is what `policyName` names. */
    decidedByJev: boolean;
  };
}


/**
 * The config key a PACK policy's parameters are stored under.
 *
 * Version-less on purpose. A pack policy registers as
 * `pack/<id>@<version>/<name>`, so a key carrying the version would be orphaned
 * by every republish — the parameters would read as unset the moment the pack
 * was upgraded, which is the same failure `enabled` avoids by outliving the
 * version it was chosen against.
 *
 * Exported because the DASHBOARD writes this key and the evaluator reads it.
 * They disagreed before — the dashboard wrote the bare policy name while the
 * evaluator looked up the fully qualified one and fell back to bare only inside
 * the `failproofai/` namespace — so a parameter saved through the UI was
 * displayed as saved and ignored at runtime, on every pack including our own.
 * One function so the two cannot drift again.
 */

/**
 * The parameters a PACK policy actually runs with, resolved out of a config's
 * `policyParams` map: the stable qualified key first, then the BARE name for
 * our own pack alone.
 *
 * The bare read is the migration. Every `policyParams["block-sudo"]` already on
 * disk — written by a build that predates packs, or by the dashboard before it
 * qualified its keys — means the builtin under the name it always had.
 *
 * It is scoped to our pack because a policy name is unique only WITHIN a pack:
 * two installed packs may each declare a `block-sudo`, and a bare key cannot
 * say which was meant. Handing a stranger's pack our pack's configuration runs
 * a third party's code on parameters chosen for ours.
 *
 * Exported because the DASHBOARD's read side resolves the same lookup, and it
 * resolved it differently — an UNSCOPED bare fallback — so a stranger's pack
 * declaring `block-sudo` was SHOWN our saved parameters while this function
 * handed that policy the schema defaults. The config modal seeds its inputs
 * from what was shown and Save writes them back under the stranger's own key,
 * which is the point a display lie turns into configuration that really runs.
 * One function so the two cannot diverge again.
 */
export function readPackPolicyParams(
  policyParams: Record<string, Record<string, unknown>> | undefined,
  packId: string,
  policyName: string,
): Record<string, unknown> | undefined {
  if (!policyParams) return undefined;
  const qualified = policyParams[packPolicyParamKey(packId, policyName)];
  if (qualified) return qualified;
  // Case-insensitively: the id reaches here from a manifest and from a source
  // somebody typed, and GitHub treats `failproofai/policies` and
  // `FailproofAI/policies` as one repository.
  if (packId.toLowerCase() === CORE_SOURCE.toLowerCase()) return policyParams[policyName];
  return undefined;
}


/**
 * Look up policy params for a canonical policy name in the user config,
 * tolerating either flat ("block-force-push") or qualified
 * ("failproofai/block-force-push") config keys for built-in policies.
 *
 * The flat-key fallback is intentionally limited to the default namespace
 * so namespace isolation is preserved: `policyParams.foo` only matches
 * `failproofai/foo`, never `myorg/foo` or `custom/foo`. A `pack/...` name gets
 * the same isolation from `readPackPolicyParams` and returns before reaching
 * that branch, so the two fallbacks never both apply to one name.
 */
function getConfigParamsFor(
  config: HooksConfig | undefined,
  canonicalName: string,
): Record<string, unknown> | undefined {
  if (!config?.policyParams) return undefined;
  const canonicalParams = config.policyParams[canonicalName];
  if (canonicalParams) return canonicalParams;

  // A pack policy: qualified key, then the bare name for our pack only. Shared
  // with the dashboard's read side rather than restated, so what is displayed
  // stays what runs.
  const packPolicy = parsePackPolicyName(canonicalName);
  if (packPolicy) {
    return readPackPolicyParams(config.policyParams, packPolicy.packId, packPolicy.name);
  }

  const defaultPrefix = `${DEFAULT_POLICY_NAMESPACE}/`;
  if (!canonicalName.startsWith(defaultPrefix)) return undefined;
  return config.policyParams[canonicalName.slice(defaultPrefix.length)];
}

const HARD: { authority: "hard"; reviewedBy: string[] } = { authority: "hard", reviewedBy: [] };

/**
 * Evaluate every policy registered for this event and turn the outcome into
 * the calling CLI's response.
 *
 * Three stages, so the two engines can meet in the middle:
 *
 * 1. **collect** runs the regex policies in priority order and records each
 *    verdict. A HARD deny short-circuits exactly as the evaluator always has.
 *    Without `twoTier` every deny is hard, so this is the old loop.
 * 2. **combine** decides. Without `twoTier` that is `regexOnly` — first deny,
 *    else every instruct, else every note — which is the old evaluator's
 *    answer. With it, `combineTwoTier` applies the §4 rules against Jev's
 *    review (see `semantic/combine.ts`).
 * 3. **format** turns the verdict into the per-CLI response shape. It is the
 *    single source of truth for those shapes and does not know which engine
 *    decided.
 *
 * `twoTier` is passed by the handler only when a Jev config (BYOK) exists and
 * the event is a gate; the Jev request is already in flight by then.
 */
export async function evaluatePolicies(
  eventType: HookEventType,
  payload: Record<string, unknown>,
  session?: SessionMetadata,
  config?: HooksConfig,
  twoTier?: TwoTierReview,
): Promise<EvaluationResult> {
  const toolName = payload.tool_name as string | undefined;

  const policies = getPoliciesForEvent(eventType, toolName);

  hookLogInfo(`evaluating ${policies.length} policies for ${eventType}`);

  if (!twoTier) {
    if (policies.length === 0) {
      return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
    }
    const { verdicts } = await collectVerdicts(eventType, payload, session, config, policies);
    return formatVerdict(eventType, session, toolName, regexOnly(verdicts));
  }

  let collected: Awaited<ReturnType<typeof collectVerdicts>>;
  try {
    collected = await collectVerdicts(eventType, payload, session, config, policies, twoTier);
  } catch (err) {
    twoTier.abort();
    throw err;
  }
  let review: JevReview;
  if (collected.hardDenied) {
    // Final whatever Jev says, so stop paying for the answer.
    twoTier.abort();
    review = { kind: "not-consulted" };
  } else {
    // Nothing from here on reads the policy registry (the verdicts, their
    // authority and every policy name are already captured), so the warm
    // worker may start the next queued hook while this one waits on Jev.
    twoTier.releaseRegistry?.();
    review = await twoTier.review;
  }
  const combined = combineTwoTier(collected.verdicts, review, twoTier.mode);
  if (combined.cleared.length > 0) {
    hookLogInfo(`jev ${twoTier.mode === "shadow" ? "would clear" : "cleared"}: ${combined.cleared.join(", ")}`);
  }
  if (combined.activity.evaluator === "jev-fallback") {
    // Info, not warn: during an outage this is every gated call, and warn-level
    // lines reach the hook's stderr — which is the deny text itself on some
    // CLIs. The activity row (`evaluator: "jev-fallback"` + reason) and
    // `failproofai jev status` are where a fallback is made visible.
    //
    // `truncated` and `request-cut` are the reasons that are not an outage:
    // Jev answered, and its answer still counted toward the most-severe rule.
    // `truncated` withdrew its clears; `request-cut` additionally refused to
    // let a call nobody could read in full come out as an allow (see
    // `semantic/combine.ts`). Saying "unavailable" there would send someone
    // looking for a provider problem that is not there.
    hookLogInfo(
      combined.activity.jevFallbackReason === "request-cut"
        ? "jev could not be shown the whole call; it cleared nothing, and the call was not allowed on a partial read"
        : combined.activity.jevFallbackReason === "truncated"
          ? "jev judged a truncated call; it cleared nothing, and only the most severe verdict applied"
          : `jev unavailable (${combined.activity.jevFallbackReason}); the regex result decided this call`,
    );
  }
  return {
    ...formatVerdict(eventType, session, toolName, combined.final),
    twoTier: { activity: combined.activity, decidedByJev: combined.decidedByJev },
  };
}

/**
 * Run the policies in order and record each verdict. Stops at the first HARD
 * deny; a reviewable deny (two-tier only) is recorded and evaluation goes on,
 * because Jev may yet clear it and a later hard deny must still be found.
 */
async function collectVerdicts(
  eventType: HookEventType,
  payload: Record<string, unknown>,
  session: SessionMetadata | undefined,
  config: HooksConfig | undefined,
  policies: RegisteredPolicy[],
  twoTier?: TwoTierReview,
): Promise<{ verdicts: RegexVerdict[]; hardDenied: boolean }> {
  const toolName = payload.tool_name as string | undefined;
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;

  const baseCtx: PolicyContext = {
    eventType,
    payload,
    toolName,
    toolInput,
    session,
    cli: session?.cli,
  };

  const verdicts: RegexVerdict[] = [];

  for (const policy of policies) {
    // Inject params: merge policyParams[policy.name] over schema defaults.
    // policy.name is canonical (e.g. "failproofai/block-force-push"); user
    // config keys may be flat or canonical — getConfigParamsFor accepts both.
    // The schema comes off the REGISTERED policy, so a pack's or a cloud
    // assignment's declared params work exactly like a builtin's. It used to be
    // looked up in a map built from the builtin catalog, which could only ever
    // describe policies compiled into this build.
    const schema = policy.params;
    const userParams = getConfigParamsFor(config, policy.name) ?? {};
    let ctx: PolicyContext;
    if (schema) {
      const resolvedParams: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(schema)) {
        resolvedParams[key] = key in userParams ? userParams[key] : spec.default;
      }
      ctx = { ...baseCtx, params: resolvedParams };
    } else {
      // No schema means no defaults to merge — but the user may still have
      // configured params for it, and silently dropping what they wrote is how
      // a policy ends up ignoring its own configuration. Absent config still
      // yields `{}`, which is what every schema-less policy saw before.
      ctx = { ...baseCtx, params: userParams };
    }

    let result: Awaited<ReturnType<typeof policy.fn>>;
    try {
      result = await policy.fn(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hookLogWarn(`policy "${policy.name}" threw: ${msg}`);
      // `policy_evaluation_error` exists to surface regressions in the policies
      // WE compile in, so it must fire only for those.
      //
      // Tested positively — a builtin is exactly a policy in the `failproofai/`
      // namespace — rather than by listing the prefixes that are not builtins.
      // The list version enumerated `custom/` and `.failproofai-` only, so
      // `cloud/…` and `pack/…` both failed it and reported a third party's
      // crash as ours, under a publisher-controlled policy name. Reproduced
      // exactly that way by an observe-mode pack on this branch. A positive test
      // also means the NEXT source kind cannot re-open this by omission.
      const isBuiltin = policy.name.startsWith(`${DEFAULT_POLICY_NAMESPACE}/`);
      if (isBuiltin) {
        void trackHookEvent(getInstanceId(), "policy_evaluation_error", {
          policy_name: policy.name,
          event_type: eventType,
          cli: session?.cli ?? null,
          error_type: err instanceof Error ? err.name : "unknown",
        });
      }
      continue;
    }

    if (result.decision === "deny") {
      const reason = appendHint(
        result.reason ?? `Blocked by policy: ${policy.name}`,
        getConfigParamsFor(config, policy.name)?.hint,
      );
      hookLogInfo(`deny by "${policy.name}": ${reason}`);
      const { authority, reviewedBy } = twoTier ? twoTier.authorityOf(policy) : HARD;
      verdicts.push({ policyName: policy.name, decision: "deny", reason, authority, reviewedBy });
      if (authority === "hard") return { verdicts, hardDenied: true };
      continue;
    }

    // Accumulate all instruct results (does not short-circuit — later policies can still deny)
    if (result.decision === "instruct") {
      const reason = appendHint(
        result.reason ?? `Instruction from policy: ${policy.name}`,
        getConfigParamsFor(config, policy.name)?.hint,
      );
      const { authority, reviewedBy } = twoTier ? twoTier.authorityOf(policy) : HARD;
      verdicts.push({ policyName: policy.name, decision: "instruct", reason, authority, reviewedBy });
      hookLogInfo(`instruct by "${policy.name}": ${reason}`);
    }

    // Accumulate informational messages from allow decisions
    if (result.decision === "allow" && result.reason) {
      verdicts.push({ policyName: policy.name, decision: "allow", reason: result.reason, ...HARD });
    }
  }

  return { verdicts, hardDenied: false };
}

/** A verdict → the calling CLI's response. Which engine decided is irrelevant here. */
function formatVerdict(
  eventType: HookEventType,
  session: SessionMetadata | undefined,
  toolName: string | undefined,
  final: FinalVerdict,
): EvaluationResult {
  if (final.decision === "deny") {
    const [decider] = final.entries;
    return formatDeny(eventType, session, toolName, decider.policyName, decider.reason);
  }
  if (final.decision === "instruct") return formatInstruct(eventType, session, final.entries);
  if (final.entries.length > 0) return formatAllow(eventType, session, final.entries);
  return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
}

function formatDeny(
  eventType: HookEventType,
  session: SessionMetadata | undefined,
  toolName: string | undefined,
  policyName: string,
  reason: string,
): EvaluationResult {
  // Pick a noun for the deny message that fits the event type. Tool events
  // get the tool name; non-tool events (UserPromptSubmit, SessionStart,
  // SessionEnd, Stop, …) use an event-appropriate label so we don't emit
  // the misleading "Blocked unknown tool by failproofai because: ...".
  let displayTool: string;
  if (toolName) {
    displayTool = toolName;
  } else if (eventType === "UserPromptSubmit") {
    displayTool = "prompt";
  } else if (eventType === "SessionStart") {
    displayTool = "session start";
  } else if (eventType === "SessionEnd") {
    displayTool = "session end";
  } else if (eventType === "Stop") {
    displayTool = "stop";
  } else {
    displayTool = "operation";
  }
  const blockedMessage = `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`;

  // Cursor's hook protocol expects a flat `{permission, user_message,
  // agent_message}` shape for any blocking decision, regardless of which
  // event triggered it. Branch ahead of the per-event handlers below so
  // PreToolUse / PostToolUse / PermissionRequest all flow through the
  // Cursor-shaped response.
  // Ref: https://cursor.com/docs/hooks (Stdout Response Format).
  if (session?.cli === "cursor") {
    // Cursor's `stop` / `subagentStop` hooks ignore `{permission: "deny"}`
    // — that shape is only honored on tool events. The only force-retry
    // channel for Stop/SubagentStop is `{followup_message}` on stdout
    // (exit 0); Cursor auto-submits the text as the next user message
    // (capped at `loop_limit`, default 5). Mirrors the Copilot Stop branch.
    // Without this branch, the 5 `require-*-before-stop` builtins were
    // observation-only on Cursor — the deny was logged but the agent
    // stopped cleanly. Ref: https://cursor.com/docs/hooks
    if (eventType === "Stop" || eventType === "SubagentStop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ followup_message: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    // `beforeSubmitPrompt` does NOT read `permission`. Its only block key
    // is `continue: false` (+ an optional `user_message` shown to the
    // user); an object carrying unknown keys validates and is dropped, so
    // the flat deny below was inert and every prompt went through. Verified
    // against cursor-agent 2026.07.16-899851b, 1931.index.js char 887883.
    if (eventType === "UserPromptSubmit") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ continue: false, user_message: blockedMessage }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    const response = {
      permission: "deny",
      user_message: blockedMessage,
      agent_message: blockedMessage,
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Pi's shim parses a flat `{permission, reason}` JSON shape from stdout
  // and translates `permission === "deny"` into a `{block: true, reason}`
  // return value from its `pi.on("tool_call", ...)` handler. Pi has no
  // event-specific decision wrappers, so all events flow through the
  // same flat shape — except Stop, where we emit the MANDATORY ACTION
  // wording so the shim can re-inject it as a system-prompt suffix on
  // the next before_agent_start (Pi cannot veto agent_end directly).
  // Mirrors the Cursor/Copilot/OpenCode Stop branches above.
  if (session?.cli === "pi") {
    if (eventType === "Stop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    const response = {
      permission: "deny",
      reason: blockedMessage,
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Hermes: the block contract is `{"decision":"block","reason"}` on stdout;
  // Hermes IGNORES exit codes, so the JSON is the only channel. A block on
  // PreToolUse stops the tool before it runs, regardless of the originating
  // platform (slack/telegram/cli/cron) or subagent.
  //
  // Only `pre_tool_call` and `pre_verify` are gated in upstream's
  // `_parse_response` (agent/shell_hooks.py:567-621); the shape is still
  // emitted for the other installed events, where it is read by nothing.
  // We do not install `pre_verify` (see the note in types.ts), so Hermes
  // has no canonical Stop event and no Stop branch is needed here.
  if (session?.cli === "hermes") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // OpenClaw: the shipped openclaw-plugin parses a flat {permission, reason}
  // verdict and maps it per plugin-hook — before_tool_call → {block:true,
  // blockReason}; before_agent_run → {outcome:"block", reason};
  // before_agent_finalize (Stop) → {action:"revise", reason}. For Stop we
  // emit the MANDATORY ACTION wording so the revise loop carries the
  // directive. Observation hooks (after_tool_call / session_* /
  // subagent_ended / before_compaction) ignore stdout, so the flat deny is
  // logged but cannot veto — a documented limitation. Mirrors the Pi branch.
  if (session?.cli === "openclaw") {
    if (eventType === "Stop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ permission: "deny", reason: blockedMessage }),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // OpenCode: `session.idle` is a notification-only bus event — by the
  // time the plugin handler fires, OpenCode has already gone idle and
  // throwing from the handler does not force-retry. The only working
  // channel is the shim's `client.session.prompt(...)` SDK call, which
  // submits a new user message that re-triggers the agent loop. The
  // shim already routes `hookSpecificOutput.additionalContext` through
  // that path (see buildOpenCodePluginShim's applyDecision), so we emit
  // the deny reason as additionalContext instead of exit-2. Mirrors the
  // Cursor `followup_message` and Copilot `{decision:"block"}` Stop
  // branches. SubagentStop is widened in for forward
  // compat — OpenCode doesn't yet expose subagent boundaries to plugins.
  if (session?.cli === "opencode") {
    if (eventType === "Stop" || eventType === "SubagentStop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: reasonText } }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    // Non-Stop opencode events keep the generic Claude shape — the
    // shim's applyDecision already handles permissionDecision: "deny"
    // for tool events.
  }

  // Factory droid: droid drives tool blocking off EXIT CODE 2 (it ignores a
  // JSON `{decision:…}` on tool events — verified live against droid
  // v0.171.0: `Hook returned exit code 2, throwing ToolExecutionControlError`).
  // The one exception is `Stop`, where droid does NOT honor exit-2
  // force-retry; there it reads `{decision:"block", reason}` on stdout at
  // exit 0 ("if decision is block, Droid does not stop"). So: Stop → JSON
  // block; every other event (PreToolUse / PostToolUse / UserPromptSubmit /
  // SubagentStop / …) → exit 2 + the blocked message on stderr.
  if (session?.cli === "factory") {
    if (eventType === "Stop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: blockedMessage + "\n",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Devin CLI: a pure Claude-clone that honors `{decision:"block", reason}`
  // on stdout at exit 0 for EVERY event (verified live against devin
  // v3000.1.27 — the block overrode `--permission-mode dangerous`). On Stop
  // the reason carries the MANDATORY-ACTION force-retry wording; on other
  // events it's the plain blocked message. One branch covers all events.
  if (session?.cli === "devin") {
    const reasonText =
      eventType === "Stop"
        ? `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`
        : blockedMessage;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: reasonText }),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Antigravity CLI: its OWN response shapes (NOT Claude's) — verified live
  // against agy v1.1.2. Tool/prompt events honor `{decision:"deny", reason}`
  // on stdout at exit 0 (hard block). The Stop event has no exit-2 retry;
  // instead `{decision:"continue", reason}` re-enters the loop and injects
  // the reason as a system message — that is how the 5 require-*-before-stop
  // builtins enforce on Antigravity.
  if (session?.cli === "antigravity") {
    if (eventType === "Stop") {
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "continue", reason: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "deny", reason: blockedMessage }),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Goose: the deny contract is `{"decision":"block","reason"}` on stdout at
  // exit 0, honored on PreToolUse ONLY (shipped goose ≥ v1.37.0, PR
  // block/goose#9304; exit 2 also blocks but JSON carries the reason
  // cleanly). Goose has NO Stop event (the 5 require-*-before-stop builtins
  // never fire for it — see CLAUDE.md) and does NOT honor deny on
  // UserPromptSubmit/PostToolUse (observation) — a block emitted on those
  // events is ignored (fail-open), a documented limitation. PreToolUse fires
  // for the shell tool AND inside delegated subagents, so this one branch
  // covers the entire enforceable surface. Mirrors the Hermes branch (no
  // turn-end event to special-case). Verified live against goose v1.43.0.
  if (session?.cli === "goose") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  if (eventType === "PreToolUse") {
    const response = {
      hookSpecificOutput: {
        hookEventName: eventType,
        permissionDecision: "deny",
        permissionDecisionReason: blockedMessage,
      },
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Copilot reads two shapes we were not sending, so a deny on either of
  // these events was emitted, logged, counted as enforcement — and ignored.
  // Both verified against the shipped @github/copilot-linux-x64 bundle.
  // Note exit 2 is NEVER a deny channel on copilot for any event; it is
  // logged as `Hook command exited with code 2 (warning)`.
  if (session?.cli === "copilot") {
    // `userPromptSubmit` gates the turn, but only on {decision:"block"} at
    // exit 0 (consumer app.js@2823018). We were emitting exit 2 + stderr,
    // which copilot warns about and then submits the prompt anyway.
    if (eventType === "UserPromptSubmit") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    // Copilot consumes a FLAT {behavior, message} here (normalizer
    // CMn@179042 -> mapper h4t@2686538). The Codex-shaped nested
    // hookSpecificOutput.decision below normalizes to `{}` on copilot, so
    // the permission prompt proceeded as if no policy existed.
    if (eventType === "PermissionRequest") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ behavior: "deny", message: blockedMessage }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
  }

  if (eventType === "PermissionRequest") {
    // Codex-only: hookSpecificOutput.decision.behavior = "allow" | "deny"
    // (per https://developers.openai.com/codex/hooks#permissionrequest).
    const response = {
      hookSpecificOutput: {
        hookEventName: eventType,
        decision: {
          behavior: "deny",
          message: `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`,
        },
      },
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  if (eventType === "PostToolUse") {
    // codex and copilot both gate PostToolUse on a TOP-LEVEL
    // {decision:"block", reason:<string>}. Neither reads the
    // hookSpecificOutput shape below, so every PostToolUse deny on them was
    // emitted, logged, counted as enforcement — and dropped on the floor.
    //
    // codex 0.147.0, live A/B probe (same prompt, same hook, only the shape
    // differs): with {decision:"block"} the run prints `hook: PostToolUse
    // Blocked`, routes the reason through codex_core::tools::router, and the
    // reason REPLACES the tool result — the model never sees the real
    // output. With hookSpecificOutput it prints `hook: PostToolUse
    // Completed` and the model reads the output verbatim. NOTE the codex
    // rows elsewhere cite output_parser.rs / hook_runtime.rs / tools
    // registry.rs line numbers that no longer exist in 0.147.0 (its hook
    // sources are hooks/src/{engine,events}/…); this row is re-grounded on
    // the live probe rather than those paths.
    //
    // copilot 1.0.78: BOTH postToolUse call sites in the shipped
    // @github/copilot-linux-x64 app.js gate on
    //   vK = t => t?.decision === "block" && typeof t.reason === "string"
    // -> "Tool result blocked". vK fails closed on a missing or non-string
    // reason, so the reason must always be a non-empty string — do not
    // "simplify" this to {decision:"block"} alone.
    //
    // The tool has already RUN in both cases. This replaces the result the
    // model reads; it does not undo the side effect. That is the only
    // semantic available at PostToolUse, and it is precisely what an
    // output-scrubbing policy needs to keep a secret out of the context.
    if (session?.cli === "codex" || session?.cli === "copilot") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    const response = {
      hookSpecificOutput: {
        hookEventName: eventType,
        additionalContext: `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`,
      },
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  if (eventType === "Stop" || eventType === "SubagentStop") {
    const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
    // Copilot CLI: `agentStop` and `subagentStop` both honor
    // `{decision: "block", reason}` JSON on stdout — the reason becomes the
    // next-turn prompt and the agent (or subagent) retries. Exit-2 is logged
    // as `[WARNING] Hook warning: ...` (verified empirically against Copilot
    // CLI 1.0.41 events.jsonl) but does NOT trigger retry. We branch on both
    // event types so that custom policies matching SubagentStop also enforce
    // on Copilot subagent boundaries; the 5 builtin require-*-before-stop
    // policies still match Stop only by design — they are session-completion
    // gates (commit/push/PR/conflicts/CI), not subagent-return gates.
    // Ref: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
    if (session?.cli === "copilot") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: reasonText }),
        stderr: "",
        policyName: policyName,
        reason,
        decision: "deny",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: reasonText,
      policyName: policyName,
      reason,
      decision: "deny",
    };
  }

  // Other event types (Cursor case already handled above): exit 2
  return {
    exitCode: 2,
    stdout: "",
    stderr: reason,
    policyName: policyName,
    reason,
    decision: "deny",
  };
}

function formatInstruct(
  eventType: HookEventType,
  session: SessionMetadata | undefined,
  instructEntries: ReadonlyArray<{ policyName: string; reason: string }>,
): EvaluationResult {
  const combined = instructEntries.map((e) => e.reason).join("\n");
  const policyNames = instructEntries.map((e) => e.policyName);

  // Cursor's hook protocol uses a flat `{permission, additional_context}`
  // shape for non-Stop and `{followup_message}` for Stop/SubagentStop.
  // Branch first so the rest of the function only handles Claude-shaped
  // responses. We match both Stop and SubagentStop so custom policies
  // subscribing to SubagentStop on Cursor get the same force-retry
  // semantics — mirrors the cli==="copilot" Stop|SubagentStop widening.
  // Ref: https://cursor.com/docs/hooks (Stdout Response Format).
  if (session?.cli === "cursor") {
    if (eventType === "Stop" || eventType === "SubagentStop") {
      const response = {
        followup_message: `Instruction from failproofai: ${combined}`,
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(response),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    const response = {
      permission: "allow",
      additional_context: `Instruction from failproofai: ${combined}`,
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // Pi: instruct emits `{permission: "allow", reason}`. The shim won't
  // block (no `"deny"`); it surfaces `reason` to the user where possible
  // (Pi has no first-class `additional_context` channel in its tool-call
  // return shape, so we log it). Stop is the exception — we emit a
  // `permission: "deny"` with the MANDATORY ACTION wording so the shim
  // captures it for next-turn before_agent_start injection. Same handoff
  // contract as the deny branch above.
  if (session?.cli === "pi") {
    if (eventType === "Stop") {
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    const response = {
      permission: "allow",
      reason: `Instruction from failproofai: ${combined}`,
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // Hermes: no additional-context channel on any event (the only actionable
  // response is `{"decision":"block"}`). So instruct degrades to allow +
  // log — we emit a non-blocking `{decision:"allow", reason}` (Hermes lets
  // the tool run) and surface the note on stderr for the operator's logs.
  // Documented limitation; there is no Stop event to force-retry into.
  if (session?.cli === "hermes") {
    const stderrMsg = instructEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        decision: "allow",
        reason: `Instruction from failproofai: ${combined}`,
      }),
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // OpenClaw: Stop (before_agent_finalize) can force a revise, so we emit the
  // MANDATORY ACTION wording as a flat deny — the shim maps it to
  // {action:"revise", reason}. PreToolUse has no non-blocking context channel,
  // but a rejected tool's blockReason is model-visible. Preserve `instruct`
  // in the wire verdict so the shim can interrupt the first matching attempt,
  // deliver the instruction through blockReason, and allow a retry. Other
  // events still degrade to allow + stderr because their return channels
  // cannot carry an instruction to the model.
  if (session?.cli === "openclaw") {
    if (eventType === "Stop") {
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    if (eventType === "PreToolUse") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          permission: "instruct",
          reason: `Instruction from failproofai: ${combined}`,
          policyName: policyNames[0],
          policyNames,
        }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    const stderrMsg = instructEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        permission: "allow",
        reason: `Instruction from failproofai: ${combined}`,
      }),
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // OpenCode: same rationale as the deny branch above — emit
  // additionalContext so the shim submits a follow-up via
  // client.session.prompt instead of throwing into a dead handler.
  if (session?.cli === "opencode") {
    if (eventType === "Stop" || eventType === "SubagentStop") {
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: reasonText } }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
  }

  // Factory droid: on Stop, emit the MANDATORY ACTION wording as a
  // `{decision:"block", reason}` on stdout (exit 0) — droid's only turn-end
  // force-retry channel. Every other event lacks an additional-context
  // channel (droid honors JSON only for the Stop block), so instruct degrades
  // to allow + stderr note, like Hermes.
  if (session?.cli === "factory") {
    if (eventType === "Stop") {
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: reasonText }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    const stderrMsg = instructEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: "",
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // Devin CLI: a pure Claude-clone. On Stop, emit the MANDATORY ACTION
  // wording as `{decision:"block", reason}` on stdout (exit 0) — Devin's
  // turn-end force-retry channel (its exit-2 is not a force-retry). Every
  // other event falls through to the generic Claude additionalContext path
  // below (Devin honors `hookSpecificOutput.additionalContext`).
  if (session?.cli === "devin" && eventType === "Stop") {
    const policyAttribution = policyNames.length === 1
      ? `policy: ${policyNames[0]}`
      : `policies: ${policyNames.join(", ")}`;
    const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: reasonText }),
      stderr: "",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // Antigravity CLI: its OWN instruct shapes (verified live agy v1.1.2).
  //   • UserPromptSubmit (canonical for PreInvocation) → `{injectSteps:[{
  //     ephemeralMessage}]}` injects the instruction as a transient system
  //     message before the model runs.
  //   • Stop → `{decision:"continue", reason}` re-enters the loop with the
  //     MANDATORY-ACTION directive (Antigravity's only turn-end channel).
  //   • Every other event lacks an additional-context channel → degrade to
  //     allow + stderr note, like Hermes.
  if (session?.cli === "antigravity") {
    if (eventType === "UserPromptSubmit") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          injectSteps: [{ ephemeralMessage: `Instruction from failproofai: ${combined}` }],
        }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    if (eventType === "Stop") {
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "continue", reason: reasonText }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    const stderrMsg = instructEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: "",
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  // Goose: a non-block PreToolUse decision injects nothing (verified live — no
  // additional-context channel), and Goose has no Stop event, so instruct
  // degrades to allow + stderr note, like Hermes / Factory non-Stop events.
  if (session?.cli === "goose") {
    const stderrMsg = instructEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: "",
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  if (eventType === "Stop" || eventType === "SubagentStop") {
    // Stop/SubagentStop instruct: exitCode 2 + stderr forces Claude to retry
    // the agent (or subagent) loop with the reason as context. Same widening
    // as the deny branch above — custom policies subscribing to
    // SubagentStop need the same retry semantics; the 5 builtin
    // require-*-before-stop policies still match Stop only by design.
    const policyAttribution = policyNames.length === 1
      ? `policy: ${policyNames[0]}`
      : `policies: ${policyNames.join(", ")}`;
    const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
    // Copilot CLI: exit-2 from agentStop / subagentStop is logged as
    // `[WARNING] Hook warning: ...` but does NOT trigger retry. The
    // documented retry shape is `{decision: "block", reason}` JSON on
    // stdout (exit 0). Mirrors the cli==="copilot" branch in the deny
    // path so custom instruct policies enforce on Copilot.
    if (session?.cli === "copilot") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: reasonText }),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: reasonText,
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "instruct",
    };
  }

  const response = {
    hookSpecificOutput: {
      hookEventName: eventType,
      additionalContext: `Instruction from failproofai: ${combined}`,
    },
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(response),
    stderr: "",
    policyName: policyNames[0],
    policyNames,
    reason: combined,
    decision: "instruct",
  };
}

function formatAllow(
  eventType: HookEventType,
  session: SessionMetadata | undefined,
  allowEntries: ReadonlyArray<{ policyName: string; reason: string }>,
): EvaluationResult {
  const combined = allowEntries.map((e) => e.reason).join("\n");
  const policyNames = allowEntries.map((e) => e.policyName);

  // Cursor: emit the flat shape; allow-with-info maps to
  // `{permission: "allow", additional_context}`.
  if (session?.cli === "cursor") {
    const response = {
      permission: "allow",
      additional_context: `Note from failproofai: ${combined}`,
    };
    const stderrMsg = allowEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "allow",
    };
  }

  // Pi: same shape as Cursor — flat `{permission: "allow", reason}`.
  if (session?.cli === "pi") {
    const response = {
      permission: "allow",
      reason: `Note from failproofai: ${combined}`,
    };
    const stderrMsg = allowEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify(response),
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "allow",
    };
  }

  // OpenClaw: same flat shape as Pi — {permission:"allow", reason}. The shim
  // returns undefined (no block) for an allow verdict regardless, so the note
  // surfaces via stderr; keeping the flat stdout shape keeps the shim's parse
  // path uniform across every verdict.
  if (session?.cli === "openclaw") {
    const stderrMsg = allowEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        permission: "allow",
        reason: `Note from failproofai: ${combined}`,
      }),
      stderr: stderrMsg + "\n",
      policyName: policyNames[0],
      policyNames,
      reason: combined,
      decision: "allow",
    };
  }

  const supportsHookSpecificOutput =
    eventType === "PreToolUse" ||
    eventType === "PostToolUse" ||
    eventType === "UserPromptSubmit" ||
    eventType === "PermissionRequest";
  const stderrMsg = allowEntries
    .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
    .join("\n");
  // Only events with a real additional-context channel carry the allow-note
  // to the agent. Everything else (Stop, SubagentStop, Session*, PreCompact, …)
  // has NO channel, so we keep informational allow-notes OUT of stdout — a
  // bare `{reason}` there is rendered as noise (e.g. droid printing a Stop's
  // "…skipping commit check…skipping PR check…" wall on a perfectly fine turn).
  // The note is still logged to stderr + the activity store for diagnostics.
  if (supportsHookSpecificOutput) {
    const response = { hookSpecificOutput: { hookEventName: eventType, additionalContext: `Note from failproofai: ${combined}` } };
    return { exitCode: 0, stdout: JSON.stringify(response), stderr: stderrMsg + "\n", policyName: policyNames[0], policyNames, reason: combined, decision: "allow" };
  }
  return { exitCode: 0, stdout: "", stderr: stderrMsg + "\n", policyName: policyNames[0], policyNames, reason: combined, decision: "allow" };
}
