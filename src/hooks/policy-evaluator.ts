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

      // Pick a noun for the deny message that fits the event type. Tool events
      // get the tool name; non-tool events (UserPromptSubmit, SessionStart,
      // SessionEnd, Stop, …) use an event-appropriate label so we don't emit
      // the misleading "Blocked unknown tool by failproofai because: ...".
      let displayTool: string;
      if (ctx.toolName) {
        displayTool = ctx.toolName;
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
        // (capped at `loop_limit`, default 5). Mirrors the Copilot Stop
        // branch at line ~279 and the Gemini AfterAgent branch at line ~188.
        // Without this branch, the 5 `require-*-before-stop` builtins were
        // observation-only on Cursor — the deny was logged but the agent
        // stopped cleanly. Ref: https://cursor.com/docs/hooks
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ followup_message: reasonText }),
            stderr: "",
            policyName: policy.name,
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
          policyName: policy.name,
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
      // Mirrors the Cursor/Gemini/Copilot/OpenCode Stop branches above.
      if (session?.cli === "pi") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
            stderr: "",
            policyName: policy.name,
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
          policyName: policy.name,
          reason,
          decision: "deny",
        };
      }

      // Gemini CLI: flat `{decision: "deny", reason}` for non-Stop events
      // (preferred per Gemini's "Golden Rule" — exit 0 with structured JSON).
      // For Stop (AfterAgent), use `{decision: "block", reason}` to force-retry,
      // mirroring Claude's exit-2-from-Stop "do this before stopping" semantics.
      // Ref: https://geminicli.com/docs/hooks/
      if (session?.cli === "gemini") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: reasonText }),
            stderr: "",
            policyName: policy.name,
            reason,
            decision: "deny",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "deny", reason: blockedMessage }),
          stderr: "",
          policyName: policy.name,
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
      // Cursor `followup_message` (line ~157) and Copilot `{decision:"block"}`
      // (line ~299) Stop branches. SubagentStop is widened in for forward
      // compat — OpenCode doesn't yet expose subagent boundaries to plugins.
      if (session?.cli === "opencode") {
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: reasonText } }),
            stderr: "",
            policyName: policy.name,
            reason,
            decision: "deny",
          };
        }
        // Non-Stop opencode events keep the generic Claude shape — the
        // shim's applyDecision already handles permissionDecision: "deny"
        // for tool events.
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

      if (eventType === "Stop" || eventType === "SubagentStop") {
        const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
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
            policyName: policy.name,
            reason,
            decision: "deny",
          };
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: reasonText,
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
    // responses. We match both Stop and SubagentStop so custom policies
    // subscribing to SubagentStop on Cursor get the same force-retry
    // semantics — mirrors the cli==="copilot" Stop|SubagentStop widening
    // at line ~472. Ref: https://cursor.com/docs/hooks (Stdout Response Format).
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

    // Gemini CLI:
    //   • Stop (AfterAgent) → {decision: "block", reason: "MANDATORY ACTION..."}
    //     mirrors Claude's exit-2-from-Stop "force retry" semantics.
    //   • UserPromptSubmit/PostToolUse/SessionStart/PreToolUse → context
    //     injection via {hookSpecificOutput: {hookEventName, additionalContext}}
    //     where hookEventName is the GEMINI event name (BeforeAgent/AfterTool/
    //     SessionStart/BeforeTool), not the canonical PascalCase form.
    //   • Other events → stderr only (no stdout JSON shape supported).
    if (session?.cli === "gemini") {
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
      // Map back from canonical → Gemini event name. Prefer the raw event name
      // off the session (handler.ts populates it from parsed.hook_event_name)
      // so we don't have to maintain a reverse lookup table.
      const supportsContext =
        eventType === "UserPromptSubmit" ||
        eventType === "PreToolUse" ||
        eventType === "PostToolUse" ||
        eventType === "SessionStart";
      if (supportsContext) {
        // Round-trip the agent-emitted event name so Gemini sees `BeforeTool`,
        // `BeforeAgent`, etc. (NOT the canonical Claude form). Prefer the
        // stdin payload's `hook_event_name` when present; fall back to the raw
        // CLI `--hook` arg captured by handler.ts; only use the canonical
        // event as a last resort (would never round-trip correctly, but better
        // than emitting nothing).
        const hookEventName = session?.hookEventName ?? session?.rawHookEventName ?? eventType;
        const response = {
          hookSpecificOutput: {
            hookEventName,
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
      // No context-injection channel for SessionEnd/PreCompress/Notification/
      // BeforeModel/AfterModel/BeforeToolSelection — surface via stderr only.
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
      // path at line ~279 so custom instruct policies enforce on Copilot.
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

    // Gemini: mirror the instruct context-injection shape for events that
    // support it; stderr-only for everything else.
    if (session?.cli === "gemini") {
      const supportsContext =
        eventType === "UserPromptSubmit" ||
        eventType === "PreToolUse" ||
        eventType === "PostToolUse" ||
        eventType === "SessionStart";
      const stderrMsg = allowEntries
        .map((e) => `[failproofai] ${e.policyName}: ${e.reason}`)
        .join("\n");
      if (supportsContext) {
        // Same fallback chain as the instruct path above — see comment there.
        const hookEventName = session?.hookEventName ?? session?.rawHookEventName ?? eventType;
        const response = {
          hookSpecificOutput: {
            hookEventName,
            additionalContext: `Note from failproofai: ${combined}`,
          },
        };
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
      return {
        exitCode: 0,
        stdout: "",
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
