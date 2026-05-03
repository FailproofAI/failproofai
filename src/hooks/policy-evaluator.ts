/**
 * Evaluates enabled policies against a hook event payload.
 * Returns exit code, stdout, and stderr for the hook handler.
 */
import type { HookEventType, SessionMetadata } from "./types";
import type { PolicyContext, HooksConfig } from "./policy-types";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { DEFAULT_POLICY_NAMESPACE, getPoliciesForEvent, normalizePolicyName } from "./policy-registry";
import { hookLogInfo, hookLogWarn } from "./hook-logger";

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
}

// Build a map from canonical policy name to its params schema (for injecting defaults).
// Keyed by canonical name because registered policies always carry the canonical form.
const POLICY_PARAMS_MAP = new Map(
  BUILTIN_POLICIES.filter((p) => p.params).map((p) => [normalizePolicyName(p.name), p.params!]),
);

/**
 * Look up policy params for a canonical policy name in the user config,
 * tolerating either flat ("block-force-push") or qualified
 * ("exospherehost/block-force-push") config keys for built-in policies.
 *
 * The flat-key fallback is intentionally limited to the default namespace
 * so namespace isolation is preserved: `policyParams.foo` only matches
 * `exospherehost/foo`, never `myorg/foo` or `custom/foo`.
 */
function getConfigParamsFor(
  config: HooksConfig | undefined,
  canonicalName: string,
): Record<string, unknown> | undefined {
  if (!config?.policyParams) return undefined;
  const canonicalParams = config.policyParams[canonicalName];
  if (canonicalParams) return canonicalParams;
  const defaultPrefix = `${DEFAULT_POLICY_NAMESPACE}/`;
  if (!canonicalName.startsWith(defaultPrefix)) return undefined;
  return config.policyParams[canonicalName.slice(defaultPrefix.length)];
}

export async function evaluatePolicies(
  eventType: HookEventType,
  payload: Record<string, unknown>,
  session?: SessionMetadata,
  config?: HooksConfig,
): Promise<EvaluationResult> {
  const toolName = payload.tool_name as string | undefined;
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;

  const policies = getPoliciesForEvent(eventType, toolName);

  hookLogInfo(`evaluating ${policies.length} policies for ${eventType}`);

  if (policies.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
  }

  const baseCtx: PolicyContext = {
    eventType,
    payload,
    toolName,
    toolInput,
    session,
    cli: session?.cli,
  };

  // Track all instruct results (accumulated, does not short-circuit)
  const instructEntries: Array<{ policyName: string; reason: string }> = [];

  // Track informational messages from allow decisions (with policy attribution)
  const allowEntries: Array<{ policyName: string; reason: string }> = [];

  for (const policy of policies) {
    // Inject params: merge policyParams[policy.name] over schema defaults.
    // policy.name is canonical (e.g. "exospherehost/block-force-push"); user
    // config keys may be flat or canonical — getConfigParamsFor accepts both.
    const schema = POLICY_PARAMS_MAP.get(policy.name);
    let ctx: PolicyContext;
    if (schema) {
      const userParams = getConfigParamsFor(config, policy.name) ?? {};
      const resolvedParams: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(schema)) {
        resolvedParams[key] = key in userParams ? userParams[key] : spec.default;
      }
      ctx = { ...baseCtx, params: resolvedParams };
    } else {
      // Custom hooks and policies without schema get empty params
      ctx = { ...baseCtx, params: {} };
    }

    let result: Awaited<ReturnType<typeof policy.fn>>;
    try {
      result = await policy.fn(ctx);
    } catch (err) {
      hookLogWarn(`policy "${policy.name}" threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (result.decision === "deny") {
      const reason = appendHint(
        result.reason ?? `Blocked by policy: ${policy.name}`,
        getConfigParamsFor(config, policy.name)?.hint,
      );
      hookLogInfo(`deny by "${policy.name}": ${reason}`);

      const displayTool = ctx.toolName ?? "unknown tool";
      const blockedMessage = `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`;

      // Cursor's hook protocol expects a flat `{permission, user_message,
      // agent_message}` shape for any blocking decision, regardless of which
      // event triggered it. Branch ahead of the per-event handlers below so
      // PreToolUse / PostToolUse / PermissionRequest all flow through the
      // Cursor-shaped response.
      // Ref: https://cursor.com/docs/hooks (Stdout Response Format).
      if (session?.cli === "cursor") {
        const response = {
          permission: "deny",
          user_message: blockedMessage,
          agent_message: blockedMessage,
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName: policy.name,
          reason,
          decision: "deny",
        };
      }

      // Pi's shim parses a flat `{permission, reason}` JSON shape from stdout
      // and translates `permission === "deny"` into a `{block: true, reason}`
      // return value from its `pi.on("tool_call", ...)` handler. Pi has no
      // event-specific decision wrappers, so all events flow through the
      // same flat shape.
      if (session?.cli === "pi") {
        const response = {
          permission: "deny",
          reason: blockedMessage,
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName: policy.name,
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
          policyName: policy.name,
          reason,
          decision: "deny",
        };
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
          policyName: policy.name,
          reason,
          decision: "deny",
        };
      }

      if (eventType === "PostToolUse") {
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
          policyName: policy.name,
          reason,
          decision: "deny",
        };
      }

      if (eventType === "Stop") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`,
          policyName: policy.name,
          reason,
          decision: "deny",
        };
      }

      // Other event types (Cursor case already handled above): exit 2
      return {
        exitCode: 2,
        stdout: "",
        stderr: reason,
        policyName: policy.name,
        reason,
        decision: "deny",
      };
    }

    // Accumulate all instruct results (does not short-circuit — later policies can still deny)
    if (result.decision === "instruct") {
      const reason = appendHint(
        result.reason ?? `Instruction from policy: ${policy.name}`,
        getConfigParamsFor(config, policy.name)?.hint,
      );
      instructEntries.push({ policyName: policy.name, reason });
      hookLogInfo(`instruct by "${policy.name}": ${reason}`);
    }

    // Accumulate informational messages from allow decisions
    if (result.decision === "allow" && result.reason) {
      allowEntries.push({ policyName: policy.name, reason: result.reason });
    }
  }

  // No deny — check if we accumulated any instructs
  if (instructEntries.length > 0) {
    const combined = instructEntries.map((e) => e.reason).join("\n");
    const policyNames = instructEntries.map((e) => e.policyName);

    // Cursor's hook protocol uses a flat `{permission, additional_context}`
    // shape for non-Stop and `{followup_message}` for Stop/SubagentStop.
    // Branch first so the rest of the function only handles Claude-shaped
    // responses. Ref: https://cursor.com/docs/hooks (Stdout Response Format).
    if (session?.cli === "cursor") {
      if (eventType === "Stop") {
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
    // return shape, so we log it).
    if (session?.cli === "pi") {
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

    if (eventType === "Stop") {
      // Stop hook: exitCode 2 blocks Claude from stopping.
      // Reason goes to stderr so Claude Code receives it as context.
      const policyAttribution = policyNames.length === 1
        ? `policy: ${policyNames[0]}`
        : `policies: ${policyNames.join(", ")}`;
      return {
        exitCode: 2,
        stdout: "",
        stderr: `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}\n\nYou MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`,
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

  // All policies allowed — pass along any informational messages
  if (allowEntries.length > 0) {
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

    const supportsHookSpecificOutput =
      eventType === "PreToolUse" ||
      eventType === "PostToolUse" ||
      eventType === "UserPromptSubmit" ||
      eventType === "PermissionRequest";
    const response = supportsHookSpecificOutput
      ? { hookSpecificOutput: { hookEventName: eventType, additionalContext: `Note from failproofai: ${combined}` } }
      : { reason: combined };
    const stderrMsg = allowEntries
      .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
      .join("\n");
    return { exitCode: 0, stdout: JSON.stringify(response), stderr: stderrMsg + "\n", policyName: policyNames[0], policyNames, reason: combined, decision: "allow" };
  }
  return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
}
