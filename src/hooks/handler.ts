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
// Types only: the semantic (Jev) modules are loaded with a dynamic import, and
// only once a Jev config exists, so an unconfigured machine never loads them.
import type { TwoTierReview } from "./semantic/combine";
import type { JevActivityFields } from "./semantic/combine";
import type { JevConfig } from "./semantic/jev-config";
import { clearPolicies, registerPolicy, getPoliciesForEvent } from "./policy-registry";
import { loadAllCustomHooks } from "./custom-hooks-loader";
import type { CustomHook } from "./policy-types";
import { persistHookActivity } from "./hook-activity-store";
import { deliveryHealth, deliveryHealthLine } from "./delivery-health";
import { trackHookEvent, flushHookTelemetry } from "./hook-telemetry";
import * as hookTelemetry from "./hook-telemetry";
import { resolveCwd } from "./resolve-cwd";
import { resolvePermissionMode } from "./resolve-permission-mode";
import { resolveTranscriptPath } from "./resolve-transcript-path";
import { getInstanceId } from "../../lib/telemetry-id";
import { hookLogInfo, hookLogWarn } from "./hook-logger";
import { readStdinPayload } from "./read-stdin";
import { readActiveCloudManagedPolicies, type CloudManagedPolicyArtifact } from "./cloud-managed-policies";
import { hasInstalledPacks, readInstalledPacks, type PackError, type ResolvedPack } from "./pack-manifest";
import { missingGuards, packFailureReason, combinedGuardMatch, guardsCover } from "./pack-failclosed";
import { readActivePause, type ActivePause } from "./session-pause";
import { layoutWarningForHook } from "./fp-reset";

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
  /**
   * Structured policy metadata for in-process adapters. Existing shell-hook
   * callers intentionally ignore this and keep consuming stdout/stderr.
   */
  evaluation?: HookEvaluationSummary;
}

export interface HookEvaluationSummary {
  decision: "allow" | "deny" | "instruct";
  policyName: string | null;
  policyNames: string[];
  reason: string | null;
  matchedPolicies: string[];
  durationMs: number;
  toolName: string | null;
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
  /**
   * The warm worker's hook into its request queue. Called at most once, and
   * only on the two-tier path, at the point this evaluation stops reading the
   * process-global policy registry and starts waiting on Jev's network answer
   * — so the next queued hook can run instead of every hook on the machine
   * queueing behind that round trip. After it is called nothing in this
   * evaluation reads the registry again. The one-shot path has no queue and
   * leaves it unset.
   */
  releaseRegistry?: () => void;
}

/**
 * Runs an observe-mode policy under the same timeout and error handling as an
 * enforcing one, so what gets measured is what would actually have happened —
 * including a policy that times out, which in enforce mode is an allow and must
 * be recorded as one rather than as a would-deny.
 */
async function runObserved(
  hook: CustomHook,
  ctx: Parameters<CustomHook["fn"]>[0],
  hookName: string,
  eventType: string,
  cli: IntegrationType,
): Promise<PolicyResult> {
  try {
    return await Promise.race([
      hook.fn(ctx),
      new Promise<PolicyResult>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void trackHookEvent(getInstanceId(), "custom_hook_error", {
      hook_name: hookName,
      error_type: msg === "timeout" ? "timeout" : "exception",
      event_type: eventType,
      cli,
      is_observe_mode: true,
    });
    return { decision: "allow" };
  }
}

// ── Two-tier (Jev) opt-in ────────────────────────────────────────────────────
//
// Jev reviews a call only when ALL of these hold, and the regex engine runs
// alone — exactly as it did before two tiers existed — otherwise:
//
// - a valid BYOK config exists (`~/.failproofai/jev.json`, global only);
// - `FAILPROOFAI_EVALUATOR` is not `legacy` (the escape hatch). On a daemon
//   machine this must be set in the daemon's environment: the daemon forwards
//   a hook's stdin and cwd to the warm worker, never the shell's environment;
// - this is not the fail-closed `forceDecision` path and no session pause is
//   active — a pause suspends local policy, and Jev must not become a way to
//   evaluate what the pause switched off;
// - the event is a gate (`PreToolUse` / `PermissionRequest`) for a named tool.
//
// There is no cloud-deployment exclusion: cloud policies default to `hard`, so
// Jev can only make a centrally managed machine stricter, never weaker.

/** The two gate events Jev reviews. Everything else is regex-only. */
const JEV_GATE_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PermissionRequest"]);

function jevForcedOff(opts: EvaluateHookEventOptions | undefined): boolean {
  return process.env.FAILPROOFAI_EVALUATOR === "legacy" || !!opts?.forceDecision;
}

/**
 * The BYOK config (with the build's default mode, D2), or null (Jev off). A
 * config that cannot be read is off, never a failure.
 */
async function readJevConfig(): Promise<{ config: JevConfig; defaultMode: TwoTierReview["mode"] } | null> {
  try {
    const { loadJevConfig, DEFAULT_JEV_MODE } = await import("./semantic/jev-config");
    const config = loadJevConfig();
    return config ? { config, defaultMode: DEFAULT_JEV_MODE } : null;
  } catch (err) {
    hookLogWarn(
      `Jev config could not be read (${err instanceof Error ? err.message : String(err)}); the regex engine decides alone`,
    );
    return null;
  }
}

/**
 * Start Jev's review of this call — before the regex policies run, so the two
 * proceed in parallel — or return null for the regex-only path.
 */
async function startTwoTier(
  canonicalEventType: string,
  parsed: Record<string, unknown>,
  session: SessionMetadata,
  cli: IntegrationType,
  opts: EvaluateHookEventOptions | undefined,
  activePause: ActivePause | null,
): Promise<TwoTierReview | null> {
  if (!JEV_GATE_EVENTS.has(canonicalEventType)) return null;
  if (typeof parsed.tool_name !== "string" || parsed.tool_name.length === 0) return null;
  if (jevForcedOff(opts) || activePause) return null;
  const loaded = await readJevConfig();
  if (!loaded) return null;
  const cfg = loaded.config;
  try {
    const { startJevReview } = await import("./semantic/jev-review");
    return startJevReview(cfg, {
      eventType: canonicalEventType,
      toolName: parsed.tool_name,
      toolInput: parsed.tool_input,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      sessionId: session.sessionId,
      cli,
    });
  } catch (err) {
    // Configured but unable to start: that is a fallback, and it is recorded
    // as one — every regex verdict hard, the regex result final. Recorded as
    // `error`, one of the reason codes the activity store and the collector
    // know (T8's closed list); an unknown code would ship as `other`.
    hookLogWarn(`Jev review could not start (${err instanceof Error ? err.message : String(err)})`);
    return {
      mode: cfg.mode === "shadow" || cfg.mode === "enforce" ? cfg.mode : loaded.defaultMode,
      review: Promise.resolve({ kind: "fallback", reason: "error", latencyMs: null, model: null, decision: null }),
      abort: () => {},
      authorityOf: () => ({ authority: "hard", reviewedBy: [] }),
    };
  }
}

/**
 * The Jev properties for `hook_policy_triggered`, from T8's
 * `jevTelemetryProperties` (decisions, reason codes, policy and model names,
 * a latency — never command or prompt text). `{}` when the two-tier path did
 * not run, so an unconfigured machine's event is unchanged, and `{}` when the
 * helper is not in this build (it is T8's, not a §7 contract) or throws:
 * telemetry never costs a hook its answer.
 */
function jevTelemetry(activity: JevActivityFields | undefined): Record<string, unknown> {
  if (!activity) return {};
  try {
    const build = (hookTelemetry as unknown as { jevTelemetryProperties?: (entry: JevActivityFields) => unknown })
      .jevTelemetryProperties;
    const props = typeof build === "function" ? build(activity) : null;
    return props && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Record what the human just typed, for Jev to judge later calls against.
 * Only when Jev is configured, and never for a prompt a policy blocked — the
 * agent never receives that one, so it cannot be what the agent is working
 * on. Which CLIs' prompt events count as human is decided inside
 * `captureIntent` (T4). Never throws.
 *
 * `captureIntent` gets the whole normalized payload (`payload`): the prompt
 * text is in a different field on some harnesses (Goose: `message`), and the
 * marks that tell a human's prompt from a subagent's or an extension's are
 * elsewhere in it. `prompt` is §7's original field, still read by the
 * contract stub; T4's implementation reads `payload` and ignores it.
 */
async function captureJevIntent(
  canonicalEventType: string,
  decision: "allow" | "deny" | "instruct",
  parsed: Record<string, unknown>,
  session: SessionMetadata,
  cli: IntegrationType,
  opts: EvaluateHookEventOptions | undefined,
): Promise<void> {
  if (canonicalEventType !== "UserPromptSubmit" || decision === "deny" || jevForcedOff(opts)) return;
  try {
    if (!(await readJevConfig())) return;
    const { captureIntent } = await import("./semantic/intent");
    // Built first, then passed: the one object satisfies §7's shape and T4's.
    const event = {
      eventType: canonicalEventType,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      cli,
      payload: parsed,
      prompt: parsed.prompt,
    };
    captureIntent(event);
  } catch (err) {
    hookLogWarn(`Jev intent capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // A home from another layout resolves to no global config, so every builtin
  // silently stops firing — the machine looks protected and is not. Say so on
  // every call rather than deleting anything (a hook is unattended) or denying
  // (a blanket deny takes UserPromptSubmit with it and locks the user out of
  // their agent entirely — demonstrated on a real machine during this work).
  const layoutWarning = layoutWarningForHook();
  if (layoutWarning) hookLogWarn(layoutWarning);
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
    /** Registered policy name → where it came from. See the set() below. */
    const policyAttribution = new Map<
      string,
      {
        source: "custom" | "convention" | "cloud" | "pack";
        cloudPolicyId?: string;
        cloudVersion?: number;
        packId?: string;
        packVersion?: string;
      }
    >();
    let cloudDeployment: number | undefined;
    /** Policy names each pack actually got registered, for the fail-closed check. */
    const registeredByPack = new Map<string, Set<string>>();
    let packErrors: PackError[] = [];
    /** What observe-mode policies WOULD have done, had they been enforcing. */
    const observedResults: Array<{
      policyId: string;
      /** A cloud deployment counts; a pack carries a version STRING. */
      version: string | number;
      decision: "deny" | "instruct";
      reason: string | null;
    }> = [];

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
      // Enforcement comes from PACKS now. What still registers from this build is
      // the always-on self-protection guard, and nothing else: a pack may not
      // declare `alwaysOn` — a downloaded file that no local command can switch
      // off is the thing that guard exists to prevent — so it cannot travel the
      // pack lane and has to ship compiled in.
      //
      // The second argument is the migration shim, not a feature. A machine that
      // upgraded into this build has `enabledPolicies` and no pack installed
      // yet, and it must not lose enforcement in the gap before `failproofai
      // update` runs. It disappears for that machine the moment a pack is
      // installed, and never fires for a machine set up by this version.
      const packsInstalledHere = hasInstalledPacks();
      const legacyNames =
        activePause || packsInstalledHere ? [] : config.enabledPolicies;
      // `alwaysOn` policies bypass the enabled set inside `registerBuiltinPolicies`,
      // so an empty list still registers the guard — which is exactly what this
      // build should contribute once packs carry everything else.
      registerBuiltinPolicies(activePause ? [] : legacyNames);
      if (legacyNames.length > 0) {
        hookLogWarn(
          `enforcing ${legacyNames.length} policies from this build because no pack is installed — ` +
            `run \`failproofai policies add FailproofAI/policies\` to move them into a real pack`,
        );
      }
      // What actually registered, for the pack-duplicate check below. A paused
      // session registers none, and then a pack twin is not a duplicate of
      // anything — but a pause already skips every local policy, pack included.
      const enabledBuiltinNames = new Set(legacyNames);

      // Cloud-managed policies are daemon-reconciled artifacts, but they use
      // the same public JS policy API as local custom policies. Verify and add
      // only the paths referenced by the atomically active deployment.
      //
      // Wrapped, like `readConfigAt` and `readActivePause` above it. This call
      // has fourteen throw sites — a malformed manifest, an unsafe id, an
      // integrity mismatch, an unknown effect — and it sat bare inside a `try`
      // whose only handler is a `finally`, so any of them aborted the entire
      // evaluation. What that cost depended on where the hook ran, and none of
      // the outcomes were the intended one: on a daemon machine the client
      // fail-closed denies every tool call, and off the daemon path the throw
      // reaches `bin/failproofai.mjs`'s outer catch, which exits 2 with nothing
      // on stdout — a deny on Claude and Factory, but a logged warning followed
      // by an ALLOW on Copilot, Cursor, Goose, Pi and Hermes, which read a
      // decision off stdout and ignore the exit code. One corrupt byte was
      // either a permanent machine-wide lockout or silent non-enforcement,
      // depending on the CLI.
      //
      // Failing open here degrades ONE layer: builtins and local custom
      // policies were already registered above and keep enforcing. That is the
      // same trade `2ad735e5` made on the Rust side, and it is strictly better
      // than the status quo, which already failed open on five of the twelve —
      // just accidentally, and without saying so.
      let cloudManagedPolicies: CloudManagedPolicyArtifact[] = [];
      try {
        cloudManagedPolicies = readActiveCloudManagedPolicies();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hookLogWarn(
          `[failproofai] cloud-managed policies could NOT be loaded and are not being enforced: ${msg}. ` +
            `Local policies are unaffected. Run \`failproofai config --status\` to check this machine's enrolment.`,
        );
        void trackHookEvent(getInstanceId(), "cloud_managed_load_error", {
          event_type: eventType,
          cli,
        });
      }
      // Recorded on every row once a machine is managed, whether or not a cloud
      // policy decided this event: "what was deployed here at the time" is a
      // separate question from "what decided", and only the former can tell a
      // rollout that changed nothing from one that never reached the machine.
      cloudDeployment = cloudManagedPolicies[0]?.deployment;
      // Installed packs. `readInstalledPacks` never throws: a bad manifest or a
      // tampered artifact yields zero packs and a recorded reason, which is
      // sound ONLY because the builtins still ship compiled in and keep
      // enforcing underneath. See the fail-open note in pack-manifest.ts — the
      // day builtins become a fetched pack this posture has to change with them.
      let installedPacks: ResolvedPack[] = [];
      try {
        const packResult = readInstalledPacks();
        installedPacks = packResult.packs;
        packErrors = packResult.errors;
        for (const err of packResult.errors) {
          hookLogWarn(`pack ${err.id ?? "(unnamed)"} not loaded: ${err.reason}`);
        }
      } catch (err) {
        hookLogWarn(`pack manifest unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }

      const configuredCustomPaths = config.customPoliciesPaths ?? config.customPoliciesPath;
      const allExplicitPaths =
        cloudManagedPolicies.length === 0 && installedPacks.length === 0
          ? configuredCustomPaths
          : [
              ...(typeof configuredCustomPaths === "string" ? [configuredCustomPaths] : configuredCustomPaths ?? []),
              ...cloudManagedPolicies.map((policy) => policy.path),
              ...installedPacks.map((pack) => pack.path),
            ];

      // Load and register custom hooks (layer 2, after builtins)
      const loadResult = await loadAllCustomHooks(allExplicitPaths, {
        sessionCwd: session.cwd,
        customPoliciesEnabled: config.customPoliciesEnabled,
        ...(cloudManagedPolicies.length > 0 ? { cloudManagedPolicies } : {}),
        ...(installedPacks.length > 0 ? { packs: installedPacks } : {}),
      });
      customHooksList = loadResult.hooks;
      const disabledCustomPolicies = new Set(config.disabledCustomPolicies ?? []);
      conventionHookNames = new Set(loadResult.conventionSources.flatMap((s) => s.hookNames));

      for (const hook of customHooksList) {
        const taggedHook = hook as CustomHook & {
          __policyId?: string;
          __cloudManaged?: CloudManagedPolicyArtifact;
          __pack?: ResolvedPack;
        };
        const policyId = taggedHook.__policyId;
        const cloudManaged = taggedHook.__cloudManaged;
        const pack = taggedHook.__pack;
        // Local config cannot disable a centrally assigned policy merely by
        // copying its generated ID into disabledCustomPolicies.
        if (!cloudManaged && policyId && disabledCustomPolicies.has(policyId)) continue;
        // Same rule for a session pause — it suspends local policy, never cloud.
        if (!cloudManaged && activePause) continue;
        // A pack narrowed to particular agents does not fire on the others.
        // Setup wires hooks into every supported CLI — hooks alone enforce
        // nothing — so the choice of which agents a pack guards is made when the
        // pack is installed, and this is where it takes effect. `clis: null`
        // means every agent, which is what an install with no narrowing writes
        // and what every pack installed before this field existed reads as.
        if (pack?.clis && !pack.clis.includes(cli)) continue;
        // A pack's artifact registers everything it contains; the user may have
        // taken only some of it. `enabled: null` means the whole pack, which is
        // what `policies add` writes when no selection was made.
        if (pack?.enabled && !pack.enabled.includes(hook.name)) continue;
        // A pack policy whose name is an ENABLED BUILTIN is the same guard
        // twice. The two register under different keys — `failproofai/block-sudo`
        // and `pack/<id>@<version>/block-sudo` — so nothing deduped them, and
        // the core pack carries the builtins under exactly these names.
        //
        // A deny hides it (the first verdict short-circuits) but an INSTRUCT does
        // not: instructions accumulate and are joined, so the agent received the
        // identical paragraph twice. Every duplicate also ran its policy function
        // a second time, inside its own 10s timeout race, against a 150ms daemon
        // budget.
        //
        // The builtin wins, because a bare name means the builtin everywhere else
        // — `policies --uninstall block-sudo` disables the compiled one, and a
        // machine that wants the pack's copy instead turns the builtin off.
        // A pack policy whose name matches one the MIGRATION SHIM registered.
        // Only reachable on a machine that has not migrated yet and somehow has
        // a pack too; once the shim stops, nothing else registers by name.
        if (pack && enabledBuiltinNames.has(hook.name)) continue;
        if (pack) {
          // Recorded against EVERY pack behind these bytes, not just the id the
          // collapse kept. A shared artifact loads once and every hook carries
          // the surviving record's id, so registering under it alone left the
          // other pack in neither map — and `missingGuards` skips a pack in
          // neither map, so an artifact that imported fine while omitting a
          // policy only that pack had selected produced no guard: not
          // registered, and not denied either.
          for (const id of loadResult.packAliases?.get(pack.id) ?? [pack.id]) {
            const seen = registeredByPack.get(id) ?? new Set<string>();
            seen.add(hook.name);
            registeredByPack.set(id, seen);
          }
        }
        const hookName = hook.name;
        const conventionScope = (hook as CustomHook & { __conventionScope?: string }).__conventionScope;
        const isConvention = !!conventionScope;
        // A pack's prefix carries its id and version, and it always contains a
        // `/` — which is what keeps a pack policy structurally unable to
        // normalize into the `failproofai/` namespace and REPLACE a builtin.
        // pack-manifest.ts refuses a `/` in the declared name for the same
        // reason; this is the second half of that guard.
        const prefix = cloudManaged
          ? `cloud/${cloudManaged.id}@${cloudManaged.version}`
          : pack
            ? `pack/${pack.id}@${pack.version}`
            : isConvention
              ? `.failproofai-${conventionScope}`
              : "custom";
        // Observe mode: run it for real, record what it decided, then hand back
        // an allow. Evaluating and discarding is the whole point — a rollout is
        // measured against real traffic before it can break anyone's work, and
        // a policy that did not actually run would measure nothing.
        const observeOnly = cloudManaged?.effect === "observe" || pack?.effect === "observe";
        const fn: PolicyFunction = async (ctx): Promise<PolicyResult> => {
          if (observeOnly) {
            const shadow = await runObserved(hook, ctx, hookName, eventType, cli);
            if (shadow.decision !== "allow") {
              // Sourced from whichever layer asked to observe. This read
              // `cloudManaged!.id` — a non-null assertion that is simply false
              // for a pack, so an observe-mode PACK threw on its first non-allow
              // verdict. The throw escapes before the wrapper's own try below,
              // so policy-evaluator swallowed it and `continue`d: nothing was
              // recorded, the row read as a clean allow, and the rollout being
              // trialled measured nothing while reporting healthy.
              const observer = cloudManaged ?? pack;
              observedResults.push({
                policyId: observer!.id,
                version: observer!.version,
                decision: shadow.decision,
                reason: shadow.reason ?? null,
              });
            }
            return { decision: "allow" };
          }
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
        const registeredName = `${prefix}/${hookName}`;
        // Record where this policy came from as structured data, keyed by the
        // exact name the evaluator will report back. The display name already
        // encodes it ("cloud/org-guard@7/…"), but only as a string — so the one
        // question cloud attribution has to answer, "which rollout produced
        // this decision", could only be answered by re-parsing our own label.
        policyAttribution.set(registeredName, {
          // `pack` was in scope here and simply not consulted, so every pack
          // decision was filed as "custom" — which is also what a user's own
          // local .mjs gets, making the two indistinguishable without
          // re-parsing the `pack/` prefix off the display name. That re-parsing
          // is exactly the practice these fields exist to replace.
          source: cloudManaged ? "cloud" : pack ? "pack" : isConvention ? "convention" : "custom",
          ...(cloudManaged ? { cloudPolicyId: cloudManaged.id, cloudVersion: cloudManaged.version } : {}),
          ...(pack ? { packId: pack.id, packVersion: pack.version } : {}),
        });
        registerPolicy(
          registeredName,
          hook.description ?? "",
          fn,
          hook.match ?? {},
          -1, // Custom hooks run after builtins (priority 0)
          // A pack declares its policies' params in its manifest, so they work
          // exactly like a builtin's — defaults merged under whatever the user
          // configured. Matched by the pack's own name for the policy, which is
          // the name before the `pack/<id>@<version>/` prefix is applied.
          pack?.policies.find((p) => p.name === hook.name)?.params,
        );
      }

      // Fail closed on enforcement this machine was told it had and does not.
      //
      // Additive, and deliberately NOT a clearPolicies() the way the
      // daemon-unreachable branch is: `registerBuiltinPolicies` registers the
      // alwaysOn self-protection guard unconditionally, and clearing here would
      // let a corrupt third-party download switch off the one policy nothing may
      // disable.
      //
      // Skipped entirely under a session pause. A pause suspends local policy for
      // a bounded, deliberate window; a check derived from registrations would
      // fire for every pack on every paused event and convert that into a
      // machine-wide deny — the exact inversion of what a pause is for.
      if (!activePause) {
        const guards = missingGuards({
          errors: packErrors,
          packs: installedPacks,
          registered: registeredByPack,
          failed: loadResult.packFailures,
          disabled: disabledCustomPolicies,
          cli,
        });
        if (guards.length > 0) {
          const reason = packFailureReason(guards);
          const match = combinedGuardMatch(guards);
          const name = "pack/failproofai-pack-unavailable";
          policyAttribution.set(name, {
            source: "pack",
            packId: guards[0].packId,
            ...(guards[0].packVersion ? { packVersion: guards[0].packVersion } : {}),
          });
          registerPolicy(
            name,
            "A policy pack this machine enforces could not be loaded",
            async (ctx): Promise<PolicyResult> => {
              // The matcher is a union of both axes and the registry ANDs them,
              // so being CALLED is not proof any guard covered this pair. Two
              // packs scoped to (PreToolUse, Bash) and (PostToolUse, Write)
              // produce a matcher that also catches (PreToolUse, Write) —
              // neither pack's business. The pairing is decided here, where the
              // real event and tool are known.
              if (!guardsCover(guards, canonicalEventType, ctx.toolName)) return { decision: "allow" };
              // UserPromptSubmit instructs rather than denies, whatever the
              // missing policies declared: a deny there locks the user out of
              // their own agent, which is the one thing that stops them fixing it.
              return canonicalEventType === "UserPromptSubmit"
                ? { decision: "instruct", reason }
                : { decision: "deny", reason };
            },
            match,
            // Above builtins (0) and custom (-1), so the short-circuit attributes
            // the deny to the missing pack rather than to whichever surviving
            // policy happened to fire first.
            1,
          );
          hookLogWarn(reason);
        }
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

    // Two-tier: when a Jev config exists and this is a gate, Jev's request
    // starts HERE, before any regex policy runs, and evaluatePolicies combines
    // the two (see semantic/combine.ts). Otherwise this is null and the call
    // below is exactly the regex-only evaluation it always was.
    const twoTier = await startTwoTier(canonicalEventType, parsed, session, cli, opts, activePause);
    // On the two-tier path the registry is read for the activity row BEFORE
    // evaluating, because evaluatePolicies may hand the registry back to the
    // warm worker's queue (`releaseRegistry`) while it waits on Jev, and the
    // next request's clearPolicies() could then run under this one. Same
    // cached lookup, same answer: nothing between here and there registers.
    const matchedBeforeRelease = twoTier
      ? getPoliciesForEvent(canonicalEventType, parsed.tool_name as string | undefined).map((p) => p.name)
      : null;

    // Evaluate policies (use canonical PascalCase event type)
    const result = twoTier
      ? await evaluatePolicies(canonicalEventType, parsed, session, config, {
          ...twoTier,
          releaseRegistry: opts?.releaseRegistry,
        })
      : await evaluatePolicies(canonicalEventType, parsed, session, config);
    const durationMs = Math.round(performance.now() - startTime);
    hookLogInfo(`result=${result.decision} policy=${result.policyName ?? "none"} duration=${durationMs}ms`);

    await captureJevIntent(canonicalEventType, result.decision, parsed, session, cli, opts);

    // Which policies actually ran for this event, regardless of how they
    // decided. `result.policyName` names only the decider — null on a plain
    // allow — so without this a row cannot tell "your policy ran and allowed"
    // from "no policy covers this event". The lookup is the same cached call
    // the evaluator already made, so it costs nothing.
    const matchedPolicies =
      matchedBeforeRelease ??
      getPoliciesForEvent(canonicalEventType, parsed.tool_name as string | undefined).map((p) => p.name);

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
      // How Jev took part (§7 fields). Absent unless the two-tier path ran.
      ...(result.twoTier ? result.twoTier.activity : {}),
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      hookEventName: session.hookEventName,
      // Attribution. A builtin is anything registered that is not in the map,
      // so its absence is meaningful rather than missing — but only when a
      // policy actually decided; a plain allow names nobody. When Jev's own
      // verdict decided, no registered policy did: `evaluator` + `jevDecision`
      // say so, and claiming "builtin" here would be false.
      ...(result.policyName && !result.twoTier?.decidedByJev
        ? (() => {
            const attribution = policyAttribution.get(result.policyName);
            return {
              policySource: attribution?.source ?? ("builtin" as const),
              ...(attribution?.cloudPolicyId ? { cloudPolicyId: attribution.cloudPolicyId } : {}),
              ...(attribution?.cloudVersion !== undefined
                ? { cloudVersion: attribution.cloudVersion }
                : {}),
              ...(attribution?.packId ? { packId: attribution.packId } : {}),
              ...(attribution?.packVersion ? { packVersion: attribution.packVersion } : {}),
            };
          })()
        : {}),
      ...(cloudDeployment !== undefined ? { cloudDeployment } : {}),
      // The point of observe mode is this record. Without it the rollout is
      // unmeasurable and the row is indistinguishable from one where the policy
      // never matched at all.
      ...(observedResults.length > 0 ? { observed: observedResults } : {}),
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
          ...jevTelemetry(result.twoTier?.activity),
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

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      evaluation: {
        decision: result.decision,
        policyName: result.policyName,
        policyNames: result.policyNames ?? (result.policyName ? [result.policyName] : []),
        reason: result.reason,
        matchedPolicies,
        durationMs,
        toolName: (parsed.tool_name as string) ?? null,
      },
    };
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
  if (stdinRead.timedOut) {
    // Reported distinctly from a read error because the remedy is different and
    // the cause is upstream: the agent spawned the hook and did not close its
    // stdin. Before this was bounded it was not reported at all — the process
    // simply never returned, and the tool call it was gating never resolved.
    hookLogWarn(`stdin never closed for ${eventType}; evaluated nothing`);
    void trackHookEvent(getInstanceId(), "hook_stdin_error", {
      event_type: eventType,
      cli,
      error_type: "timeout",
    });
  }

  const result = await evaluateHookEvent(eventType, cli, stdinRead.payload);

  // Say it out loud, once a session, when the collector is holding batches the
  // server definitively refused.
  //
  // Everything `--status` prints about the connection comes from the credential
  // file, which records what was true at `--connect` time and is never
  // revisited — so a revoked or expired key, or an org that was disabled,
  // leaves that file correct while nothing arrives. `--status` also only speaks
  // when someone runs it, and the whole failure mode here is that nobody knows
  // there is anything to ask about. SessionStart is the one place failproofai
  // is already invoked, on every CLI, exactly once per session, with a person
  // watching — so this costs one directory read per session and needs no flag,
  // no daemon channel and no user action.
  //
  // Never allowed to affect the outcome: the read swallows its own errors, the
  // verdict goes to stderr (SessionStart is `observe` everywhere — a stderr
  // write there cannot block a session), and `result.exitCode` is untouched.
  try {
    if (canonicalizeEventType(eventType, cli) === "SessionStart") {
      const rejection = deliveryHealthLine(deliveryHealth());
      if (rejection) hookLogWarn(rejection);
    }
  } catch {
    // A status notice must never be the reason a hook misbehaves.
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}
