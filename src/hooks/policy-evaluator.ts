/**
 * Evaluates enabled policies against a hook event payload.
 * Returns exit code, stdout, and stderr for the hook handler.
 */
import type { HookEventType, SessionMetadata } from "./types";
import type { PolicyContext, HooksConfig } from "./policy-types";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { DEFAULT_POLICY_NAMESPACE, getPoliciesForEvent, normalizePolicyName } from "./policy-registry";
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
}

// Build a map from canonical policy name to its params schema (for injecting defaults).
// Keyed by canonical name because registered policies always carry the canonical form.
const POLICY_PARAMS_MAP = new Map(
  BUILTIN_POLICIES.filter((p) => p.params).map((p) => [normalizePolicyName(p.name), p.params!]),
);

/**
 * Look up policy params for a canonical policy name in the user config,
 * tolerating either flat ("block-force-push") or qualified
 * ("failproofai/block-force-push") config keys for built-in policies.
 *
 * The flat-key fallback is intentionally limited to the default namespace
 * so namespace isolation is preserved: `policyParams.foo` only matches
 * `failproofai/foo`, never `myorg/foo` or `custom/foo`.
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
    // policy.name is canonical (e.g. "failproofai/block-force-push"); user
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
      const msg = err instanceof Error ? err.message : String(err);
      hookLogWarn(`policy "${policy.name}" threw: ${msg}`);
      // Custom hooks are wrapped in handler.ts with their own try/catch that
      // emits custom_hook_error. Anything reaching here is a builtin policy
      // crash — track separately so we can surface regressions in builtins.
      const isCustom = policy.name.startsWith("custom/") || policy.name.startsWith(".failproofai-");
      if (!isCustom) {
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
        // (capped at `loop_limit`, default 5). Mirrors the Copilot Stop branch.
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
      // Mirrors the Cursor/Copilot/OpenCode Stop branches above.
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

      // Hermes: the block contract is `{"decision":"block","reason"}` on stdout;
      // Hermes IGNORES exit codes, so the JSON is the only channel. This one
      // return covers every Hermes event we install (PreToolUse / PostToolUse /
      // SubagentStop) — there is no Stop/turn-end event to special-case (Hermes
      // has no turn boundary; the 5 require-*-before-stop builtins never fire for
      // it — see CLAUDE.md / the audit plan). A block on PreToolUse stops the
      // tool before it runs, regardless of the originating platform
      // (slack/telegram/cli/cron) or subagent.
      if (session?.cli === "hermes") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
          stderr: "",
          policyName: policy.name,
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
        return {
          exitCode: 0,
          stdout: JSON.stringify({ permission: "deny", reason: blockedMessage }),
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
      // Cursor `followup_message` and Copilot `{decision:"block"}` Stop
      // branches. SubagentStop is widened in for forward
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
          exitCode: 2,
          stdout: "",
          stderr: blockedMessage + "\n",
          policyName: policy.name,
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
            ? `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`
            : blockedMessage;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: reasonText }),
          stderr: "",
          policyName: policy.name,
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
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policy.name}): ${reason}\n\nYou MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "continue", reason: reasonText }),
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
    // {action:"revise", reason}. Every other event lacks an additional-context
    // channel (before_tool_call's return is {params,block,blockReason} only), so
    // instruct degrades to allow + stderr note, like Hermes.
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
  return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
}
