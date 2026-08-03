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
  HermesHookEventType,
  OpenClawHookEventType,
  AntigravityHookEventType,
} from "./types";
import {
  CODEX_EVENT_MAP,
  CURSOR_EVENT_MAP,
  PI_EVENT_MAP,
  HERMES_EVENT_MAP,
  OPENCLAW_EVENT_MAP,
  ANTIGRAVITY_EVENT_MAP,
} from "./types";
import { canonicalizeToolName, canonicalizeToolInput } from "./tool-name-canonicalize";
import { normalizeCliPayload } from "./normalize-cli-payload";
import type { PolicyFunction, PolicyResult, HooksConfig } from "./policy-types";
import { readMergedHooksConfig } from "./hooks-config";
import { registerBuiltinPolicies } from "./builtin-policies";
import { evaluatePolicies } from "./policy-evaluator";
import { clearPolicies, registerPolicy, getPoliciesForEvent } from "./policy-registry";
import { loadAllCustomHooks } from "./custom-hooks-loader";
import type { CustomHook } from "./policy-types";
import { persistHookActivity } from "./hook-activity-store";
import { trackHookEvent, flushHookTelemetry } from "./hook-telemetry";
import { resolveCwd } from "./resolve-cwd";
import { resolvePermissionMode } from "./resolve-permission-mode";
import { resolveTranscriptPath } from "./resolve-transcript-path";
import { getInstanceId } from "../../lib/telemetry-id";
import { hookLogInfo, hookLogWarn } from "./hook-logger";
import { readStdinPayload } from "./read-stdin";
import { readActiveCloudManagedPolicies, type CloudManagedPolicyArtifact } from "./cloud-managed-policies";
import { readActivePause, type ActivePause } from "./session-pause";

/**
 * Canonicalize an event name to PascalCase. Codex sends snake_case event names
 * on stdin and as the --hook arg; Cursor sends camelCase (`preToolUse`,
 * `beforeSubmitPrompt`); Pi sends underscore_lower_snake_case (`tool_call`,
 * `session_start`); Claude Code sends PascalCase. Copilot CLI is installed
 * in "VS Code compatible" PascalCase mode (see integrations.ts), so its event
 * NAMES arrive PascalCase already (note: tool names are a separate matter and
 * are canonicalized in canonicalizeToolName below). The internal
 * registry, builtin policies, and policy.match.events all key on PascalCase.
 *
 * Exported so fail-closed.ts can produce the same canonical event type
 * without duplicating this per-CLI mapping.
 */
export function canonicalizeEventType(raw: string, cli: IntegrationType): HookEventType {
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
  if (cli === "hermes") {
    // Hermes sends snake_case event names (pre_tool_call, on_session_start, …);
    // map to PascalCase. Has no turn-end Stop event, so no Stop mapping exists.
    const mapped = HERMES_EVENT_MAP[raw as HermesHookEventType];
    if (mapped) return mapped;
  }
  if (cli === "openclaw") {
    // The openclaw-plugin shim forwards raw snake_case plugin-hook names
    // (before_tool_call, before_agent_finalize, …); map to PascalCase.
    // before_agent_finalize is the real turn-end gate → Stop.
    const mapped = OPENCLAW_EVENT_MAP[raw as OpenClawHookEventType];
    if (mapped) return mapped;
  }
  if (cli === "antigravity") {
    // Antigravity's --hook args are PreToolUse|PostToolUse|PreInvocation|Stop.
    // PreInvocation (before-model) → UserPromptSubmit. Verified agy v1.1.2.
    const mapped = ANTIGRAVITY_EVENT_MAP[raw as AntigravityHookEventType];
    if (mapped) return mapped;
  }
  // claude / copilot / unknown — already PascalCase, pass through.
  // HOOK_EVENT_TYPES type-checks downstream.
  return raw as HookEventType;
}

export interface HookEventOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EvaluateHookEventOptions {
  /**
   * Await pending telemetry POSTs before returning. Defaults to `true`,
   * matching the one-shot CLI process's need to flush before `process.exit()`
   * drops anything in flight. The warm worker (which never exits between
   * calls) passes `false` — telemetry simply resolves on its own schedule,
   * a real latency win unlocked by the process staying alive.
   */
  awaitTelemetryFlush?: boolean;
  /**
   * When set, skips loading policies-config.json / builtins / custom hooks
   * entirely and registers ONLY a single synthetic policy that always
   * returns this decision — then runs the real, unmodified
   * `evaluatePolicies()` so the response still gets this event/CLI's exact
   * per-CLI shaping (Cursor's flat `continue:false`, Factory's exit-2, …).
   * This is the fail-closed path: reusing the real evaluator for shaping
   * instead of hand-rolling a generic denial avoids a decision that *looks*
   * like protection but is silently inert for at least one CLI.
   */
  forceDecision?: { decision: "deny"; reason: string };
  /**
   * Used only when the stdin payload itself carries no `cwd` (and, for
   * Cursor, no `workspace_roots`) — see `resolveCwd`. Callers running
   * inside a long-lived process (the warm worker) MUST pass the
   * *originating* CLI process's cwd here rather than leaving this unset:
   * `readMergedHooksConfig`/`loadAllCustomHooks` fall back to
   * `process.cwd()` internally when `session.cwd` is undefined, and inside
   * a warm worker `process.cwd()` is fixed at wherever the worker itself
   * was spawned — not wherever this particular request's session actually
   * is. The one-shot CLI process doesn't need this: its own `process.cwd()`
   * already IS the right value, which is exactly what that fallback was
   * written for.
   */
  fallbackCwd?: string;
}

/**
 * The core hook-evaluation logic, decoupled from process stdin/stdout so it
 * can be called repeatedly inside a long-lived process (the daemon's warm
 * worker) as well as from the one-shot `handleHookEvent` wrapper below.
 * Never reads `process.stdin` or writes `process.stdout`/`process.stderr`
 * itself — every caller gets the full `{exitCode, stdout, stderr}` back and
 * decides what to do with it.
 */
export async function evaluateHookEvent(
  eventType: string,
  cli: IntegrationType = "claude",
  stdinPayload: string,
  opts?: EvaluateHookEventOptions,
): Promise<HookEventOutcome> {
  const startTime = performance.now();
  try {
    let parsed: Record<string, unknown> = {};
    if (stdinPayload) {
      try {
        parsed = JSON.parse(stdinPayload) as Record<string, unknown>;
      } catch {
        hookLogWarn(`payload parse failed for ${eventType} (${stdinPayload.length} bytes)`);
        void trackHookEvent(getInstanceId(), "hook_payload_parse_error", {
          event_type: eventType,
          cli,
          payload_size: stdinPayload.length,
        });
      }
    }

    normalizeCliPayload(cli, parsed);

    // Canonicalize event name (Codex sends snake_case; internals expect PascalCase)
    const canonicalEventType = canonicalizeEventType(eventType, cli);

    // Canonicalize tool name in place so both the policy-registry tool-name
    // filter and policy bodies (`ctx.toolName === "Bash"`) see the canonical
    // form. Mutating `parsed.tool_name` keeps the activity store + telemetry
    // tagging consistent (they read from `parsed.tool_name`).
    const rawToolName = parsed.tool_name as string | undefined;
    const canonicalToolName = canonicalizeToolName(rawToolName, cli);
    if (canonicalToolName !== rawToolName) {
      parsed.tool_name = canonicalToolName;
    }

    // Canonicalize tool-input keys for OpenCode + Pi (no-op for other CLIs).
    // Defense-in-depth against stale shims that still pass camelCase /
    // Pi-shape keys to the binary. The per-CLI shim ALSO canonicalizes; both
    // passes are idempotent because the camelCase keys won't match a
    // snake_case input.
    const rawInput = parsed.tool_input;
    const canonicalInput = canonicalizeToolInput(canonicalToolName, rawInput, cli);
    if (canonicalInput !== rawInput) {
      parsed.tool_input = canonicalInput;
    }

    // Extract session metadata from payload
    const sessionId = parsed.session_id as string | undefined;
    const session: SessionMetadata = {
      sessionId,
      transcriptPath: resolveTranscriptPath(cli, parsed, sessionId),
      cwd: resolveCwd(cli, parsed) ?? opts?.fallbackCwd,
      permissionMode: resolvePermissionMode(cli, parsed, sessionId),
      hookEventName: parsed.hook_event_name as string | undefined,
      // Preserve the raw CLI-side event name (eventType arg) before
      // canonicalization. Response shapes that round-trip the agent-emitted
      // event name prefer this over the canonicalized form when stdin omits
      // hook_event_name.
      rawHookEventName: eventType,
      cli,
    };

    let config: HooksConfig;
    let customHooksList: CustomHook[] = [];
    let conventionHookNames = new Set<string>();
    let activePause: ActivePause | null = null;

    if (opts?.forceDecision) {
      // Fail-closed: no config/custom-hook loading at all — a daemon that
      // can't be reached can't have run any of a project's custom policies
      // either, so there is nothing to load. One synthetic policy stands in
      // for the entire enabled set.
      config = { enabledPolicies: [] };
      clearPolicies();
      const decision = opts.forceDecision;
      registerPolicy(
        "failproofai/daemon-unreachable",
        "Fail-closed: the failproofaid daemon could not be reached for this daemon-configured scope.",
        async (): Promise<PolicyResult> => ({ decision: decision.decision, reason: decision.reason }),
        {},
      );
    } else {
      // Load enabled policies (merge across project/local/global scopes)
      config = readMergedHooksConfig(session.cwd);
      clearPolicies();

      // A session pause suspends LOCAL policy only, for a bounded time. Cloud
      // assignments are exempt below for the same reason `disabledCustomPolicies`
      // already exempts them: a locally-issued command that could switch off a
      // centrally assigned policy would make cloud enforcement decorative.
      activePause = readActivePause(session.sessionId);
      registerBuiltinPolicies(activePause ? [] : config.enabledPolicies);

      // Cloud-managed policies are daemon-reconciled artifacts, but they use
      // the same public JS policy API as local custom policies. Verify and add
      // only the paths referenced by the atomically active generation.
      const cloudManagedPolicies = readActiveCloudManagedPolicies();
      const configuredCustomPaths = config.customPoliciesPaths ?? config.customPoliciesPath;
      const allExplicitPaths =
        cloudManagedPolicies.length === 0
          ? configuredCustomPaths
          : [
              ...(typeof configuredCustomPaths === "string" ? [configuredCustomPaths] : configuredCustomPaths ?? []),
              ...cloudManagedPolicies.map((policy) => policy.path),
            ];

      // Load and register custom hooks (layer 2, after builtins)
      const loadResult = await loadAllCustomHooks(allExplicitPaths, {
        sessionCwd: session.cwd,
        customPoliciesEnabled: config.customPoliciesEnabled,
        ...(cloudManagedPolicies.length > 0 ? { cloudManagedPolicies } : {}),
      });
      customHooksList = loadResult.hooks;
      const disabledCustomPolicies = new Set(config.disabledCustomPolicies ?? []);
      conventionHookNames = new Set(loadResult.conventionSources.flatMap((s) => s.hookNames));

      for (const hook of customHooksList) {
        const taggedHook = hook as CustomHook & {
          __policyId?: string;
          __cloudManaged?: CloudManagedPolicyArtifact;
        };
        const policyId = taggedHook.__policyId;
        const cloudManaged = taggedHook.__cloudManaged;
        // Local config cannot disable a centrally assigned policy merely by
        // copying its generated ID into disabledCustomPolicies.
        if (!cloudManaged && policyId && disabledCustomPolicies.has(policyId)) continue;
        // Same rule for a session pause — it suspends local policy, never cloud.
        if (!cloudManaged && activePause) continue;
        const hookName = hook.name;
        const conventionScope = (hook as CustomHook & { __conventionScope?: string }).__conventionScope;
        const isConvention = !!conventionScope;
        const prefix = cloudManaged
          ? `cloud/${cloudManaged.id}@${cloudManaged.revision}`
          : isConvention
            ? `.failproofai-${conventionScope}`
            : "custom";
        const fn: PolicyFunction = async (ctx): Promise<PolicyResult> => {
          try {
            const result = await Promise.race([
              hook.fn(ctx),
              new Promise<PolicyResult>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
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

      hookLogInfo(
        `event=${canonicalEventType} cli=${cli} policies=${config.enabledPolicies.length} custom=${customHooksList.length} convention=${conventionHookNames.size}`,
      );
    }

    // Evaluate policies (use canonical PascalCase event type)
    const result = await evaluatePolicies(canonicalEventType, parsed, session, config);
    const durationMs = Math.round(performance.now() - startTime);
    hookLogInfo(`result=${result.decision} policy=${result.policyName ?? "none"} duration=${durationMs}ms`);

    // Which policies actually ran for this event, regardless of how they
    // decided. `result.policyName` names only the decider — null on a plain
    // allow — so without this a row cannot tell "your policy ran and allowed"
    // from "no policy covers this event". The lookup is the same cached call
    // the evaluator already made, so it costs nothing.
    const matchedPolicies = getPoliciesForEvent(canonicalEventType, parsed.tool_name as string | undefined).map(
      (p) => p.name,
    );

    // Persist activity to disk (visible in /policies activity tab)
    const activityEntry = {
      timestamp: Date.now(),
      eventType: canonicalEventType,
      integration: cli,
      toolName: (parsed.tool_name as string) ?? null,
      policyName: result.policyName,
      policyNames: result.policyNames,
      matchedPolicies,
      decision: result.decision,
      reason: result.reason,
      durationMs,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      hookEventName: session.hookEventName,
      // Without these, a row logged during a pause is indistinguishable from
      // one where every policy ran and allowed — the log would assert a clean
      // window over exactly the window that was not enforced.
      ...(activePause
        ? { pausedBy: activePause.setBy, pauseExpiresAt: activePause.expiresAt }
        : {}),
    };
    try {
      persistHookActivity(activityEntry);
    } catch {
      hookLogWarn("activity persistence failed");
    }

    // Fire PostHog telemetry for decisions that affect Claude's behavior
    if (result.decision === "deny" || result.decision === "instruct") {
      try {
        const isCustomHook = result.policyName?.startsWith("custom/") ?? false;
        const isConventionPolicy = result.policyName?.startsWith(".failproofai-") ?? false;
        const conventionScope = isConventionPolicy
          ? (result.policyName!.match(/^\.failproofai-(project|user)\//)?.[1] ?? null)
          : null;
        const hasCustomParams =
          !isCustomHook &&
          !isConventionPolicy &&
          !!(result.policyName && config.policyParams?.[result.policyName]);
        const paramKeysOverridden = hasCustomParams ? Object.keys(config.policyParams![result.policyName!]) : [];
        const distinctId = getInstanceId();
        const trackPromise = trackHookEvent(distinctId, "hook_policy_triggered", {
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
        // Deny/instruct is exactly the response the daemon's warm worker
        // needs to return fast — a live network POST to PostHog on this path
        // (previously always awaited here, regardless of opts.awaitTelemetryFlush)
        // made every deny/instruct decision pay a real network round-trip
        // (hundreds of ms, up to sendEvent's 5s abort timeout when PostHog is
        // unreachable) before the result could return. Caught by a real
        // Docker daemon test: a `sudo` deny took ~700ms even against an
        // already-warm worker and blew through the client's 150ms
        // fail-closed budget every time. Same opt-out this file already
        // grants `flushHookTelemetry()` below — the worker passes
        // awaitTelemetryFlush:false and never calls that flush either, so
        // this becomes true fire-and-forget for it.
        if (opts?.awaitTelemetryFlush ?? true) {
          await trackPromise;
        }
      } catch {
        // Telemetry is best-effort — never block the hook
      }
    }

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (opts?.awaitTelemetryFlush ?? true) {
      // Await any un-awaited (`void trackHookEvent(...)`) events fired during
      // this invocation. The one-shot CLI process calls process.exit() the
      // moment it gets its result back, which would otherwise drop in-flight
      // POSTs — notably on the allow path (no trailing awaited event) and on
      // any early throw (custom-hook load / policy eval) before the happy
      // path is reached. The warm worker passes awaitTelemetryFlush:false —
      // it never exits between calls, so there's nothing to drop.
      await flushHookTelemetry();
    }
  }
}

/**
 * One-shot CLI entrypoint — reads `process.stdin`, evaluates the hook, writes
 * `process.stdout`/`process.stderr`, and returns just the exit code. This is
 * the exact contract `bin/failproofai.mjs`'s `--hook` path has always had;
 * kept unchanged so nothing about the one-shot (non-daemon) path regresses.
 * Internally now just a thin wrapper around `evaluateHookEvent`.
 */
export async function handleHookEvent(eventType: string, cli: IntegrationType = "claude"): Promise<number> {
  const MAX_STDIN_BYTES = 1_048_576; // 1 MB
  const stdinRead = await readStdinPayload(MAX_STDIN_BYTES);
  if (stdinRead.readError) {
    hookLogWarn(`stdin read failed for ${eventType}`);
    void trackHookEvent(getInstanceId(), "hook_stdin_error", {
      event_type: eventType,
      cli,
      error_type: "unknown",
    });
  }
  if (stdinRead.oversized) {
    hookLogWarn(`stdin payload exceeds 1 MB for ${eventType}, discarding`);
    void trackHookEvent(getInstanceId(), "hook_stdin_error", {
      event_type: eventType,
      cli,
      error_type: "oversized",
    });
  }

  const result = await evaluateHookEvent(eventType, cli, stdinRead.payload);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}
