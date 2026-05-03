/**
 * Hook event handler — invoked when Claude Code triggers a hook.
 *
 * Reads the JSON payload from stdin, loads enabled policies from
 * ~/.failproofai/policies-config.json, evaluates matching policies, persists
 * activity to disk, and returns the appropriate exit code + stdout response.
 */
import type {
  HookEventType,
  IntegrationType,
  SessionMetadata,
  CodexHookEventType,
  CursorHookEventType,
  PiHookEventType,
} from "./types";
import { CODEX_EVENT_MAP, CURSOR_EVENT_MAP, PI_EVENT_MAP } from "./types";
import type { PolicyFunction, PolicyResult } from "./policy-types";
import { readMergedHooksConfig } from "./hooks-config";
import { registerBuiltinPolicies } from "./builtin-policies";
import { evaluatePolicies } from "./policy-evaluator";
import { clearPolicies, registerPolicy } from "./policy-registry";
import { loadAllCustomHooks } from "./custom-hooks-loader";
import type { CustomHook } from "./policy-types";
import { persistHookActivity } from "./hook-activity-store";
import { trackHookEvent } from "./hook-telemetry";
import { resolvePermissionMode } from "./resolve-permission-mode";
import { getInstanceId } from "../../lib/telemetry-id";
import { hookLogInfo, hookLogWarn } from "./hook-logger";

/**
 * Canonicalize an event name to PascalCase. Codex sends snake_case event names
 * on stdin and as the --hook arg; Cursor sends camelCase (`preToolUse`,
 * `beforeSubmitPrompt`); Pi sends underscore_lower_snake_case (`tool_call`,
 * `session_start`); Claude Code sends PascalCase. Copilot CLI is installed
 * in "VS Code compatible" PascalCase mode (see integrations.ts), so its events
 * arrive PascalCase already. The internal registry, builtin policies, and
 * policy.match.events all key on PascalCase.
 */
function canonicalizeEventType(raw: string, cli: IntegrationType): HookEventType {
  if (cli === "codex") {
    const mapped = CODEX_EVENT_MAP[raw as CodexHookEventType];
    if (mapped) return mapped;
  }
  if (cli === "cursor") {
    const mapped = CURSOR_EVENT_MAP[raw as CursorHookEventType];
    if (mapped) return mapped;
  }
  if (cli === "pi") {
    const mapped = PI_EVENT_MAP[raw as PiHookEventType];
    if (mapped) return mapped;
  }
  // claude / copilot / unknown — already PascalCase, pass through.
  // HOOK_EVENT_TYPES type-checks downstream.
  return raw as HookEventType;
}

export async function handleHookEvent(
  eventType: string,
  cli: IntegrationType = "claude",
): Promise<number> {
  const startTime = performance.now();

  // Read stdin payload (Claude passes JSON)
  const MAX_STDIN_BYTES = 1_048_576; // 1 MB
  let payload = "";
  try {
    payload = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let totalBytes = 0;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > MAX_STDIN_BYTES) {
          hookLogWarn(`stdin payload exceeds 1 MB for ${eventType}, discarding`);
          process.stdin.destroy();
          resolve("");
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on("end", () => resolve(chunks.join("")));
      process.stdin.on("error", reject);
      // If stdin is already closed or not piped, resolve immediately
      if (process.stdin.readableEnded) resolve("");
    });
  } catch {
    hookLogWarn(`stdin read failed for ${eventType}`);
  }

  let parsed: Record<string, unknown> = {};
  if (payload) {
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      hookLogWarn(`payload parse failed for ${eventType} (${payload.length} bytes)`);
    }
  }

  // Canonicalize event name (Codex sends snake_case; internals expect PascalCase)
  const canonicalEventType = canonicalizeEventType(eventType, cli);

  // Extract session metadata from payload
  const sessionId = parsed.session_id as string | undefined;
  const session: SessionMetadata = {
    sessionId,
    transcriptPath: parsed.transcript_path as string | undefined,
    cwd: parsed.cwd as string | undefined,
    permissionMode: resolvePermissionMode(cli, parsed, sessionId),
    hookEventName: parsed.hook_event_name as string | undefined,
    cli,
  };

  // Load enabled policies (merge across project/local/global scopes)
  const config = readMergedHooksConfig(session.cwd);
  clearPolicies();
  registerBuiltinPolicies(config.enabledPolicies);

  // Load and register custom hooks (layer 2, after builtins)
  const loadResult = await loadAllCustomHooks(config.customPoliciesPath, { sessionCwd: session.cwd });
  const customHooksList = loadResult.hooks;
  const conventionHookNames = new Set(loadResult.conventionSources.flatMap((s) => s.hookNames));

  for (const hook of customHooksList) {
    const hookName = hook.name;
    const conventionScope = (hook as CustomHook & { __conventionScope?: string }).__conventionScope;
    const isConvention = !!conventionScope;
    const prefix = isConvention ? `.failproofai-${conventionScope}` : "custom";
    const fn: PolicyFunction = async (ctx): Promise<PolicyResult> => {
      try {
        const result = await Promise.race([
          hook.fn(ctx),
          new Promise<PolicyResult>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 10_000),
          ),
        ]);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg === "timeout";
        hookLogWarn(`${prefix} hook "${hookName}" failed: ${msg}`);
        void trackHookEvent(getInstanceId(), "custom_hook_error", {
          hook_name: hookName,
          error_type: isTimeout ? "timeout" : "exception",
          event_type: eventType,
          cli,
          is_convention_policy: isConvention,
          convention_scope: conventionScope ?? null,
        });
        return { decision: "allow" };
      }
    };
    registerPolicy(
      `${prefix}/${hookName}`,
      hook.description ?? "",
      fn,
      hook.match ?? {},
      -1, // Custom hooks run after builtins (priority 0)
    );
  }

  // Fire telemetry once per invocation for custom hook loads
  if (customHooksList.length > 0) {
    void trackHookEvent(getInstanceId(), "custom_hooks_loaded", {
      cli,
      custom_hooks_count: customHooksList.length,
      custom_hook_names: customHooksList.map((h) => h.name),
      event_types_covered: [...new Set(customHooksList.flatMap((h) => h.match?.events ?? []))],
    });
  }

  // Fire telemetry for convention-based policy discovery
  if (loadResult.conventionSources.length > 0) {
    void trackHookEvent(getInstanceId(), "convention_policies_loaded", {
      event_type: canonicalEventType,
      cli,
      project_file_count: loadResult.conventionSources.filter((s) => s.scope === "project").length,
      user_file_count: loadResult.conventionSources.filter((s) => s.scope === "user").length,
      convention_hook_count: conventionHookNames.size,
      convention_hook_names: [...conventionHookNames],
    });
  }

  hookLogInfo(`event=${canonicalEventType} cli=${cli} policies=${config.enabledPolicies.length} custom=${customHooksList.length} convention=${conventionHookNames.size}`);

  // Evaluate policies (use canonical PascalCase event type)
  const result = await evaluatePolicies(canonicalEventType, parsed, session, config);
  const durationMs = Math.round(performance.now() - startTime);
  hookLogInfo(`result=${result.decision} policy=${result.policyName ?? "none"} duration=${durationMs}ms`);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  // Persist activity to disk (visible in /policies activity tab)
  const activityEntry = {
    timestamp: Date.now(),
    eventType: canonicalEventType,
    integration: cli,
    toolName: (parsed.tool_name as string) ?? null,
    policyName: result.policyName,
    policyNames: result.policyNames,
    decision: result.decision,
    reason: result.reason,
    durationMs,
    sessionId: session.sessionId,
    transcriptPath: session.transcriptPath,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    hookEventName: session.hookEventName,
  };
  try {
    persistHookActivity(activityEntry);
  } catch {
    hookLogWarn("activity persistence failed");
  }

  // Enqueue for server relay — fire-and-forget, never blocks hook.
  // queue.ts is a no-op if the user is not logged in (no auth.json), and
  // sanitizes the entry before persisting (drops toolInput/transcriptPath,
  // hashes cwd, redacts known secret patterns in `reason`).
  try {
    const { appendToServerQueue } = await import("../relay/queue");
    appendToServerQueue(activityEntry);
  } catch {
    // Server queue is best-effort; fail-open
  }

  // Lazy-start relay daemon if user is logged in — ~1ms when already running
  try {
    const { ensureRelayRunning } = await import("../relay/daemon");
    ensureRelayRunning();
  } catch {
    // Relay is best-effort; hook must succeed regardless
  }

  // Fire PostHog telemetry for decisions that affect Claude's behavior
  if (result.decision === "deny" || result.decision === "instruct") {
    try {
      const isCustomHook = result.policyName?.startsWith("custom/") ?? false;
      const isConventionPolicy = result.policyName?.startsWith(".failproofai-") ?? false;
      const conventionScope = isConventionPolicy
        ? result.policyName!.match(/^\.failproofai-(project|user)\//)?.[1] ?? null
        : null;
      const hasCustomParams =
        !isCustomHook && !isConventionPolicy && !!(result.policyName && config.policyParams?.[result.policyName]);
      const paramKeysOverridden = hasCustomParams
        ? Object.keys(config.policyParams![result.policyName!])
        : [];
      const distinctId = getInstanceId();
      await trackHookEvent(distinctId, "hook_policy_triggered", {
        event_type: canonicalEventType,
        cli,
        tool_name: (parsed.tool_name as string) ?? null,
        policy_name: result.policyName,
        decision: result.decision,
        is_custom_hook: isCustomHook,
        is_convention_policy: isConventionPolicy,
        convention_scope: conventionScope,
        has_custom_params: hasCustomParams,
        param_keys_overridden: paramKeysOverridden,
      });
    } catch {
      // Telemetry is best-effort — never block the hook
    }
  }

  return result.exitCode;
}
