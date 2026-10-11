/**
 * `failproofai config` — the interactive setup launcher.
 *
 * Four steps, in the order the machine needs them:
 *
 *   1. Daemon  — REQUIRED. Asks for sudo first, on a clean terminal.
 *   2. Connect — one masked API-key field; Tab for open source.
 *   3. Agents  — which agents failproofai traces: hooks, collection and
 *                backfill all follow this one saved list.
 *   4. Done    — applied straight after the agents step; there is no separate
 *                review. Esc at any step before that changes nothing.
 *
 * ## Two ordering rules that are not cosmetic
 *
 * **The daemon comes first because it is the only step that needs a password.**
 * `sudo -v` must prompt on a clean terminal, before any TUI frame is drawn —
 * fired from underneath a rendered screen the prompt is invisible and the typed
 * password lands in a redrawn frame.
 *
 * **Everything is written at apply, the daemon before anything else.** Setup
 * requires the daemon, so a failure has to leave the machine exactly as it was
 * found rather than half-configured. Writing hooks first and discovering the
 * service will not start afterwards is the one ordering that cannot be undone
 * cleanly.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

import { CORE_SOURCE } from "./pack-store";

import {
  collapseAfter,
  colorsEnabled,
  multiSelect,
  OPEN_SOURCE,
  optsFor,
  paint,
  promptCloudKey,
  screenKit,
  type CloudKeyAnswer,
  type MultiChoice,
  type OpenSource,
  type TTYIn,
  type TTYOut,
} from "./tui";
import {
  DEFAULT_INGEST_URL,
  readIngestCredential,
  validateIngestKey,
} from "./collector-config";
import {
  detectInstalledClis,
  getIntegration,
  hermesProfileHealth,
  settingsPathsFor,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { enforcingPolicyCount, installHooks, notEnforcingReason } from "./manager";
import { getConfigPathForScope, readScopedHooksConfig } from "./hooks-config";
import { discoverPolicyFiles, findSkippedPolicyFiles } from "./custom-hooks-loader";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import {
  canElevate,
  isDaemonSupportedPlatform,
  installDaemonService,
  daemonServiceStatus,
  daemonServiceNeedsUpgrade,
  daemonStatusCommand,
  ensureDaemonServiceCurrent,
  daemonVersionSkew,
  primeElevation,
  setDaemonConfigured,
  probeDaemon,
  probeDaemonEndToEnd,
  uninstallDaemonService,
} from "./daemon-service";
import { hookLogWarn } from "./hook-logger";
import {
  maskToken,
  readCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
} from "./cloud-enrollment";
import {
  cloudBaseFor,
  ingestUrlFor,
  connectToCloud,
  jevLines,
} from "./cloud-connection";
import { hasPermission, introspectKey, PERMISSION_EVENTS, PERMISSION_POLICIES } from "./cloud-introspect";
import { readConfig, readCredentials, updateConfig } from "./fp-config";
import { writeBackfillRequest } from "./backfill-request";
import {
  detectSetupState,
  isConfigured,
  type SetupTarget,
} from "./setup-state";
import { customPoliciesDir, launcherMarker } from "./fp-home";
import { pruneOldDaemonBinaries } from "./daemon-download";
import { version as cliVersion } from "../../package.json";
import {
  attemptHintLines,
  blockerCleared,
  clearOnboardingAttempt,
  readOnboardingAttempt,
  recordOnboardingAttempt,
  type RetryProbe,
} from "./onboarding-attempt";
import { acquireOnboardingLock } from "./onboarding-lock";

export interface WizardIO {
  stdin?: TTYIn;
  stdout?: TTYOut;
}

/**
 * Answers supplied up front, so the run needs nobody at the keyboard.
 *
 * This is the whole of headless setup, and it is small for a reason nobody
 * planned: the wizard stopped DECIDING most of what it used to. Scope, agents,
 * policies and the custom-policy toggle are all hardcoded now (see the
 * constants further down), so there is no decision surface left to expose —
 * only the three questions that remain, and each has one sensible unattended
 * answer.
 *
 * None of this skips sudo. Installing a system service needs root and nothing
 * here changes that: elevation goes through `sudo -n`, which never prompts, and
 * a machine that cannot elevate is told exactly what to run as root.
 */
export interface WizardAnswers {
  /** Cloud API key. Its presence IS the request to connect. */
  token?: string;
  /** Where to connect. Defaults to the same URL the wizard infers. */
  url?: string;
  machineId?: string;
  machineLabel?: string;
  /** Record decisions only, no session transcripts. */
  noTranscripts?: boolean;
  /** `--oss`: skip the connect step. A connection already here is left as it is. */
  oss?: boolean;
  /** `--agents`: the agents to trace, already validated. Skips the agents step. */
  agents?: IntegrationType[];
}

/**
 * Why a wizard run ended without applying. Distinguished so the caller can
 * pick an exit code — a user who pressed Esc did nothing wrong (exit 0), a
 * machine that could not install the required daemon did not get set up
 * (exit 1), and a fleet script needs to tell those apart.
 */
export type WizardAbort =
  | "cancelled"
  | "needs_root"
  | "daemon_failed"
  | "unsupported_platform"
  | "running_as_sudo"
  /** A cloud key was supplied and the server refused it. Unattended only. */
  | "cloud_unverified";

export interface WizardResult {
  applied: boolean;
  /** Present only when `applied` is false. */
  abort?: WizardAbort;
  target?: SetupTarget;
  scopes?: HookScope[];
  clis?: IntegrationType[];
  policies?: string[];
  daemonInstalled?: boolean;
  /** A connection was written by this run. */
  connected?: boolean;
  /** Whether the machine is connected once the run ends. */
  mode?: "cloud" | "oss";
  agents?: { selected: IntegrationType[]; added: IntegrationType[]; removed: IntegrationType[] };
}

async function emit(event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await trackHookEvent(getInstanceId(), event, props);
  } catch {
    // best-effort — never break the wizard
  }
}

/** Replace ~ prefix with the literal home dir path for readable review output. */
function homeify(p: string): string {
  const home = homedir();
  // Require a path boundary so `/home/alice-work` isn't collapsed to `~-work`
  // for a home of `/home/alice`.
  if (p === home) return "~";
  if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
  return p;
}

// ── Pure builders (exported for tests) ───────────────────────────────────────

/** The CLIs that can actually be configured at `scope`. Hermes and OpenClaw
 *  are gateways with no project-level config, so they are user-scope only. */
export function clisSupportingScope(scope: HookScope): IntegrationType[] {
  return INTEGRATION_TYPES.filter((id) => getIntegration(id).scopes.includes(scope));
}

/**
 * Which agents a run starts with ticked, and what it compares the answer to.
 *
 * Three cases, told apart by what is on disk:
 *  - **rerun**: a saved selection exists. It is restored exactly, plus any
 *    agent detected now that no earlier setup saw — ticked, and tagged new.
 *  - **upgrade**: no saved selection, but hooks are installed (a machine set
 *    up before the selection existed). What is protected today is ticked, so
 *    finishing setup neither widens nor narrows it.
 *  - **first**: neither. The detected agents are ticked.
 *
 * Every agent is listed, detected or not (decision D1): an agent installed
 * next week can be ticked today, and an empty machine is not stuck.
 */
export type AgentPlanMode = "first" | "rerun" | "upgrade";

export interface AgentPlan {
  mode: AgentPlanMode;
  /** Every agent: the detected ones first, then the rest. */
  order: IntegrationType[];
  detected: Set<IntegrationType>;
  /** What the answer is compared to: the saved selection, or what is hooked today. */
  baseline: Set<IntegrationType>;
  /** Detected now and seen at no earlier setup. Re-runs only. */
  fresh: Set<IntegrationType>;
  /** Ticked when the step opens. */
  initial: IntegrationType[];
  /** The `seen` list to save: every agent detected at any setup so far. */
  seen: IntegrationType[];
}

export function planAgents(input: {
  detected: IntegrationType[];
  saved?: { selected: string[]; seen: string[] };
  hooked: IntegrationType[];
}): AgentPlan {
  const known = (ids: string[]): IntegrationType[] =>
    INTEGRATION_TYPES.filter((id) => ids.includes(id));
  const detected = new Set(known(input.detected));
  const order = [
    ...INTEGRATION_TYPES.filter((id) => detected.has(id)),
    ...INTEGRATION_TYPES.filter((id) => !detected.has(id)),
  ];
  const ordered = (ids: Iterable<IntegrationType>): IntegrationType[] => {
    const set = new Set(ids);
    return order.filter((id) => set.has(id));
  };
  // Seen accumulates. Rebuilding it from this run's detection would let a PATH
  // glitch forget an agent, and the next run would call it new — ticked — after
  // somebody had deliberately unticked it.
  const seen = ordered([...known(input.saved?.seen ?? []), ...detected]);

  if (input.saved) {
    const baseline = new Set(known(input.saved.selected));
    const previouslySeen = new Set(known(input.saved.seen));
    const fresh = new Set([...detected].filter((id) => !previouslySeen.has(id) && !baseline.has(id)));
    return { mode: "rerun", order, detected, baseline, fresh, initial: ordered([...baseline, ...fresh]), seen };
  }
  const hooked = known(input.hooked);
  if (hooked.length > 0) {
    return { mode: "upgrade", order, detected, baseline: new Set(hooked), fresh: new Set(), initial: ordered(hooked), seen };
  }
  return { mode: "first", order, detected, baseline: new Set(), fresh: new Set(), initial: ordered(detected), seen };
}

/**
 * The selection a run takes without asking: no terminal, or a `--token` run.
 * The plan's starting ticks — and every agent when those are empty, which only
 * happens on a machine where nothing is detected, hooked or saved. Hooking
 * nothing there would leave setup finished and nothing guarded.
 */
export function defaultSelection(plan: AgentPlan): IntegrationType[] {
  // A saved answer stands even when it is empty: removing every agent's hooks
  // saves an empty selection, and an unattended re-run must not put them back.
  if (plan.mode === "rerun") return plan.initial;
  return plan.initial.length > 0 ? plan.initial : [...plan.order];
}

/** What a chosen selection changes, against the plan's baseline. */
export function agentChanges(
  plan: AgentPlan,
  selected: IntegrationType[],
): { added: IntegrationType[]; removed: IntegrationType[] } {
  const chosen = new Set(selected);
  return {
    // On a first run nothing was traced before, so nothing is "added" back.
    added: plan.mode === "first" ? [] : plan.order.filter((id) => chosen.has(id) && !plan.baseline.has(id)),
    removed: plan.order.filter((id) => !chosen.has(id) && plan.baseline.has(id)),
  };
}

/** The picker's rows: one per agent, in the plan's order. */
export function agentChoices(plan: AgentPlan): MultiChoice<IntegrationType>[] {
  return plan.order.map((id) => ({
    label: getIntegration(id).displayName,
    value: id,
    checked: plan.initial.includes(id),
  }));
}

/**
 * The tag after a row, recomputed on every toggle: `new on this machine`,
 * then what the toggle changes against the baseline, then `not installed`.
 * No change tags on a first run — every tick would read "will be added".
 */
export function agentTag(
  plan: AgentPlan,
  c: ReturnType<typeof paint>,
): (id: IntegrationType, checked: boolean) => string | undefined {
  return (id, checked) => {
    if (plan.fresh.has(id)) return c.guide("new on this machine");
    if (plan.mode !== "first") {
      const before = plan.baseline.has(id);
      if (checked && !before) return c.guide("will be added");
      if (!checked && before) return c.warn("will be removed");
    }
    if (!plan.detected.has(id)) return c.ink3("not installed");
    return undefined;
  };
}

/** "A", "A and B", "A, B and C". */
function namesList(ids: IntegrationType[]): string {
  const names = ids.map((id) => getIntegration(id).displayName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Wrap `text` after a 2-column glyph, continuing under it, within `width`. */
function wrapAfterGlyph(glyph: string, text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && 2 + line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? `${glyph} ${l}` : `  ${l}`));
}

/**
 * The AGENTS step, collapsed. Names are listed when nothing changed against
 * the baseline; otherwise the count, then what was added and removed. What a
 * removal promises is only what the code does: no more hooks, and on a
 * connected machine no more collection. Nothing already collected is deleted.
 */
export function agentsCollapsedLines(
  kit: ReturnType<typeof screenKit>,
  plan: AgentPlan,
  selected: IntegrationType[],
  collecting: boolean,
  c: ReturnType<typeof paint>,
): string[] {
  const { added, removed } = agentChanges(plan, selected);
  const n = selected.length;
  const tracing = `Tracing ${n} ${n === 1 ? "agent" : "agents"}`;
  const lines = [kit.head("Agents")];
  if (n === 0) {
    lines.push(kit.caution("Tracing no agents.", "failproofai config"));
    return lines;
  }
  if (added.length === 0 && removed.length === 0) {
    const list = selected.map((id) => getIntegration(id).displayName).join(", ");
    lines.push(...wrapAfterGlyph(c.guide("✓"), `${tracing}: ${list}`, kit.cols));
    return lines;
  }
  lines.push(kit.ok(tracing));
  if (added.length > 0) lines.push(`  Added ${namesList(added)}.`);
  if (removed.length > 0) {
    lines.push(
      collecting
        ? `  Removed ${namesList(removed)}: no longer hooked or collected. Sessions already collected are kept.`
        : `  Removed ${namesList(removed)}: no longer hooked.`,
    );
  }
  return lines;
}

/**
 * Whether an agent has failproofai hooks in its USER settings — the seed for an
 * upgrade. User scope only: project hooks depend on the directory `config`
 * happens to run from. A gateway with several profiles counts when ANY profile
 * is hooked; requiring all of them would drop a partly hooked Hermes from the
 * seed, and setup would then unhook every profile it has.
 */
export function hookedAtUserScope(id: IntegrationType, cwd: string): boolean {
  const integration = getIntegration(id);
  try {
    if (integration.hooksInstalledInSettings("user", cwd)) return true;
    if (id === "hermes") return hermesProfileHealth().some((p) => existsSync(p.home) && p.healthy);
    const paths = settingsPathsFor(integration, "user", cwd);
    if (paths.length < 2) return false;
    return paths.some((one) =>
      integration.hooksInstalledInSettings.call({ ...integration, getSettingsPaths: () => [one] }, "user", cwd),
    );
  } catch {
    return false;
  }
}

/**
 * Take failproofai's hooks out of these agents' USER settings, and nothing
 * else. Not `removeHooks`: that is the full uninstall, which also strips
 * project and local hooks under the working directory and resets the policy
 * configuration of every scope. Unticking an agent in setup must leave every
 * `policies-config.json` exactly as it was.
 */
export function removeUserScopeHooks(clis: IntegrationType[], cwd: string): number {
  let removed = 0;
  for (const id of clis) {
    const integration = getIntegration(id);
    if (!integration.scopes.includes("user")) continue;
    for (const settingsPath of settingsPathsFor(integration, "user", cwd)) {
      // Hermes is asked even without a config file, so it can clear a plugin
      // directory left behind by an interrupted install.
      if (id !== "hermes" && !existsSync(settingsPath)) continue;
      try {
        removed += integration.removeHooksFromFile(settingsPath);
      } catch (err) {
        hookLogWarn(
          `could not remove failproofai hooks from ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return removed;
}

/**
 * Persist the Custom checkbox into the scope's config, after installHooks has
 * written it (installHooks copies the previous config forward, so writing
 * first would be overwritten).
 *
 * Writes the key only to turn discovery OFF, and removes it when turning back
 * on, so the common case leaves no `customPoliciesEnabled: true` noise in the
 * file and "absent means enabled" stays the single default. `undefined` means
 * there was nothing to toggle — leave whatever is there alone.
 */
export function setCustomPoliciesEnabled(
  scope: HookScope,
  cwd: string,
  enabled: boolean | undefined,
): void {
  if (enabled === undefined) return;
  const path = getConfigPathForScope(scope, cwd);
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(path)) config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return; // a malformed config is the install path's problem, not ours
  }
  if (enabled) delete config.customPoliciesEnabled;
  else config.customPoliciesEnabled = false;
  try {
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {
    /* best-effort: never fail a completed setup over this flag */
  }
}

/**
 * Maps a daemon-install failure to one of a fixed set of codes, safe to
 * send off the machine.
 *
 * `installDaemonService`'s `reason` is a diagnostic for the local log, not a
 * telemetry field: on most failure paths it is an errno message naming an
 * absolute path under `homedir()`, which carries the OS username. Only the
 * classification travels.
 */
export function classifyDaemonInstallFailure(reason: string | undefined): string {
  if (!reason) return "unknown";
  if (/not supported on/.test(reason)) return "unsupported_platform";
  if (/no prebuilt binary for/.test(reason)) return "unsupported_platform";
  if (/binary not found/.test(reason)) return "binary_not_found";
  // The download path is where a machine acquires the daemon at all, so its
  // failures need to be distinguishable: a checksum mismatch is a supply-chain
  // signal, "disabled" is a deliberate air-gapped opt-out, and a plain fetch
  // failure is usually a proxy or an offline box — three very different
  // stories that would otherwise all land in `service_manager_error`.
  // The service is installed system-wide now, so "couldn't become root" is a
  // first-class outcome with a specific remedy (re-run under sudo) rather
  // than an opaque service_manager_error.
  if (/root privileges are required/.test(reason)) return "needs_root";
  if (/checksum mismatch|has no entry for/.test(reason)) return "checksum_mismatch";
  if (/downloads are disabled/.test(reason)) return "downloads_disabled";
  if (/failed to download/.test(reason)) return "download_failed";
  if (/did not reach a running state/.test(reason)) return "did_not_start";
  return "service_manager_error";
}

/**
 * Summarise the custom policy files on disk, for the review screen.
 *
 * Only lists files — it deliberately does NOT load them. Loading executes
 * user code, which is fine on the hook path but wrong in an interactive
 * wizard the user hasn't confirmed yet.
 *
 * `warnings` covers the silent-skip trap: a file in the right directory whose
 * name doesn't end in `policies.{js,mjs,ts}` is ignored entirely, with nothing
 * on screen to say so. Surfacing it here is the difference between "my rule
 * isn't working and I don't know why" and a one-line rename.
 */
export function describeCustomPolicies(cwd: string): {
  active: string[];
  warnings: string[];
  fileCount: number;
  scopes: string[];
} {
  const active: string[] = [];
  const warnings: string[] = [];
  const scopes: string[] = [];
  let fileCount = 0;
  const dirs: Array<{ dir: string; label: string }> = [
    { dir: resolve(cwd, ".failproofai", "policies"), label: "project" },
    // `customPoliciesDir()`, not layout 1's `~/.failproofai/policies`. This
    // scanned the old location while `custom-hooks-loader.ts` loads from the
    // new one, so the wizard reported "no personal policies" to users whose
    // policies were being enforced, and would have reported the opposite after
    // the layout reset moved them.
    { dir: customPoliciesDir(), label: "global" },
  ];
  for (const { dir, label } of dirs) {
    const found = discoverPolicyFiles(dir);
    if (found.length > 0) {
      active.push(`${found.length} file${found.length === 1 ? "" : "s"} (${label})`);
      scopes.push(label);
      fileCount += found.length;
    }
    for (const name of findSkippedPolicyFiles(dir)) {
      warnings.push(
        `! ${homeify(resolve(dir, name))} is NOT loaded — rename to ` +
          `${name.replace(/\.(js|mjs|ts)$/, "-policies.$1")}`,
      );
    }
  }
  return { active, warnings, fileCount, scopes };
}

// ── First-run redirect ───────────────────────────────────────────────────────

function firstRunMarkerPath(): string {
  return launcherMarker();
}

export function hasSeenLauncher(): boolean {
  return existsSync(firstRunMarkerPath());
}

export function markLauncherSeen(): void {
  try {
    // Layout 2 puts this under state/ with the rest of the daemon-adjacent
    // markers, so the parent is a directory deeper than the home and has to be
    // created rather than assumed.
    mkdirSync(dirname(firstRunMarkerPath()), { recursive: true });
    writeFileSync(firstRunMarkerPath(), "1", "utf8");
  } catch {
    // best-effort
  }
}

/**
 * On the FIRST bare `failproofai` invocation, redirect the user into the
 * configure wizard instead of the dashboard. Returns true when it handled the
 * turn (caller should exit rather than launch the dashboard).
 *
 *   • FAILPROOFAI_NO_FIRST_RUN=1 → never redirect
 *   • already seen the launcher   → never redirect again
 *   • hooks already installed     → mark seen, go to dashboard (already set up)
 *   • non-TTY (CI/pipe)           → print a one-line hint, go to dashboard
 *   • fresh + TTY                 → mark seen, run the wizard, done
 */
export interface FirstRunOptions {
  /**
   * Run the post-setup audit after a completed apply. The caller sets this to
   * false when the command it is about to run is `audit` itself, which would
   * otherwise scan the entire history twice back to back.
   */
  postSetupAudit?: boolean;
  /**
   * Run setup even though the machine reads as already configured.
   *
   * Set by the caller after a layout reset. `isConfigured()` is a union that
   * counts live user-scope hooks in any agent CLI, and the reset deliberately
   * leaves those settings files alone — so a machine whose policy config was
   * just deleted still answers "configured", the wizard is skipped, and
   * `markLauncherSeen()` below back-fills the marker so every later run skips
   * it too. The result is hooks firing on every tool call against no policies,
   * with nothing to say so.
   */
  force?: boolean;
}

/**
 * The live values `blockerCleared` compares an earlier attempt against.
 *
 * Built here rather than imported into `onboarding-attempt.ts` so that module
 * stays pure and unit-testable without a service manager or a sudo binary.
 */
function retryProbe(): RetryProbe {
  return {
    canElevate: () => {
      try {
        return canElevate();
      } catch {
        // No sudo binary at all is a blocker that has not cleared.
        return false;
      }
    },
    daemonStatus: () => {
      try {
        return daemonServiceStatus();
      } catch {
        return "";
      }
    },
    cliVersion,
  };
}

export async function maybeFirstRunConfigure(
  io: WizardIO = {},
  opts: FirstRunOptions = {},
): Promise<boolean> {
  if (process.env.FAILPROOFAI_NO_FIRST_RUN === "1") return false;

  const stdin: TTYIn = io.stdin ?? process.stdin;
  const stdout: TTYOut = io.stdout ?? process.stdout;

  // One state read covering all three "already set up" signals — a config
  // file, live user-scope hooks, or the legacy marker. See `isConfigured`.
  const state = detectSetupState();
  if (isConfigured(state) && !opts.force) {
    // Back-fill the marker for a machine that is demonstrably configured but
    // predates it, so later runs settle this with a single stat instead of
    // walking every integration's settings file on every invocation.
    if (!state.hasLegacyMarker) markLauncherSeen();
    return false;
  }

  // A previous attempt that ABORTED. Setup writes nothing on those paths, by
  // design, so without this record the machine is indistinguishable from one
  // that has never been offered setup — and the wizard relaunches on every
  // command forever. `--force` (an explicit `failproofai config`) never reaches
  // here, so asking for setup by name always gets it.
  const attempt = opts.force ? null : readOnboardingAttempt();
  if (attempt && !blockerCleared(attempt, retryProbe())) {
    for (const line of attemptHintLines(attempt)) stdout.write(`${line}\n`);
    return false;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    // Never launch a wizard nobody can answer. This is the CI / piped path,
    // and it must stay a hint rather than a failure: the command the user
    // actually typed still runs.
    stdout.write(
      `\n${screenKit(optsFor(stdout)).caution("failproofai is not set up yet.", "failproofai config")}\n\n`,
    );
    return false;
  }

  // Onboarding now fires on ANY command, so two terminals on a fresh machine
  // is a real shape: both would draw a wizard, race on the same settings
  // files, and both try to install the one system service. Only one gets to.
  const lock = acquireOnboardingLock();
  if (!lock) {
    stdout.write(
      `\n${screenKit(optsFor(stdout)).caution("Setup is already running in another terminal, so this one leaves it to finish.")}\n\n`,
    );
    return false;
  }

  try {
    // Fire-and-forget: never block the wizard's first paint on telemetry.
    void emit("first_run_configure_shown", {});
    // runConfigureWizard marks the launcher as seen only if the user completes
    // an apply — so cancelling keeps offering setup on the next run rather
    // than silently never mentioning it again.
    const result = await runConfigureWizard(io);
    // Remember WHY, so the next command can hint instead of relaunching. Only
    // on an abort: a completed apply clears the record below.
    if (!result.applied && result.abort) {
      recordOnboardingAttempt(result.abort, cliVersion, daemonServiceStatus());
    }

  // Onboarding-only: after a completed first-run setup, run the audit pipeline
  // (scan + cache warm) before the caller boots the dashboard. The explicit
  // `failproofai config` command does NOT do this — only this first-run path.
  // Lazy-imported + best-effort; opt out with FAILPROOFAI_NO_AUTO_AUDIT=1.
    if (result.applied && opts.postSetupAudit !== false) {
      try {
        const { runPostSetupAudit } = await import("../audit/cli");
        await runPostSetupAudit();
      } catch {
        // the audit is a bonus — never let it break onboarding or the dashboard.
      }
    }
    return true;
  } finally {
    // Released on every path, including a throw from the wizard itself —
    // otherwise a crash mid-setup would leave a lock behind, and although the
    // liveness check reclaims it, doing so needs the next run to reach that
    // check rather than relying on it.
    lock.release();
  }
}

// ── The wizard ───────────────────────────────────────────────────────────────

export async function runConfigureWizard(
  io: WizardIO = {},
  answers: WizardAnswers = {},
): Promise<WizardResult> {
  const stdin: TTYIn = io.stdin ?? process.stdin;
  const stdout: TTYOut = io.stdout ?? process.stdout;
  const cwd = process.cwd();
  const started = Date.now();
  // No terminal means no questions — not a refusal.
  //
  // `failproofai config` IS the authorisation: somebody typed the command whose
  // entire job is to configure this machine. Safe because the IMPLICIT path is
  // guarded separately: `maybeFirstRunConfigure` has its own TTY check and
  // returns before ever reaching this function, so setup never runs off the back
  // of some other command on a headless box.
  const unattended = !stdin.isTTY || !stdout.isTTY;
  // A key on the command line settles the whole run, not just the question it
  // literally answers: set this machine up, connect it, send its data. The only
  // thing still worth stopping for is the sudo password, which is a CREDENTIAL
  // rather than a question, and no flag can supply it.
  const preAnswered = Boolean(answers.token);

  // Running the wizard itself under sudo configures the WRONG ACCOUNT, and
  // does it silently: homedir() becomes /root, so the hooks land in root's
  // settings, `daemonConfigured` is set for root, the daemon binary downloads
  // to /root/.failproofai/bin, and the unit is generated with User=root —
  // exactly the elevation the design exists to avoid. SUDO_USER is set only
  // when a real user sudo'd here, which distinguishes this mistake from a
  // legitimately root-only environment (a container that has no other user).
  if (typeof process.getuid === "function" && process.getuid() === 0 && process.env.SUDO_USER) {
    stdout.write(
      `Run failproofai config as ${process.env.SUDO_USER}, not under sudo.\n` +
        "Everything it configures is per-user — hooks, policies and the daemon's own\n" +
        "account — so under sudo it would set all of that up for root instead of you.\n" +
        "The one step that needs root (installing the service) asks for your password\n" +
        "on its own.\n",
    );
    return { applied: false, abort: "running_as_sudo" };
  }

  // Fire-and-forget: never block the wizard's first paint on telemetry.
  void emit("configure_started", {});

  // failproofaid — the only evaluator on a configured machine — only runs on
  // Linux and macOS. Checked before a single prompt is asked: completing setup
  // anyway used to leave e.g. a Windows machine reading as configured while
  // enforcing in-process with no fail-closed guarantee, which is worse than not
  // being set up at all.
  if (!isDaemonSupportedPlatform()) {
    stdout.write(
      `failproofai requires failproofaid, its background policy daemon, which runs on\n` +
        `Linux and macOS only — not ${process.platform}. Setup cannot continue here: an\n` +
        "installation with no daemon behind it would read as configured while enforcing\n" +
        "nothing, which is worse than not being set up at all.\n\n" +
        "Nothing was changed. This platform will be supported once failproofaid gains a\n" +
        `${process.platform} service target.\n\n`,
    );
    void emit("configure_aborted", { reason: "unsupported_platform" });
    return { applied: false, abort: "unsupported_platform" };
  }

  const c = paint(colorsEnabled(stdout));
  const kit = screenKit({ ...optsFor(stdout), fit: Boolean(stdout.isTTY), version: cliVersion });
  const write = (lines: string[]): void => {
    stdout.write(lines.map((line) => `${line}\n`).join(""));
  };
  // A grey line saying what apply is doing right now, removed once it is done.
  // Without a terminal it stays, as a log line.
  const transient = async <T,>(text: string, run: () => Promise<T>): Promise<T> => {
    if (!stdout.isTTY) {
      write([text]);
      return run();
    }
    write([c.ink3(text)]);
    try {
      return await run();
    } finally {
      stdout.write("\x1b[1A\x1b[2K");
    }
  };

  // The logomark opens a config run on a terminal — one of the two places it
  // appears at all.
  if (stdout.isTTY) write(["", ...kit.logo()]);
  write(["", kit.header("Set up this machine"), ""]);

  const cancel = (): WizardResult => {
    write(["", c.ink3("Cancelled. Nothing was changed.")]);
    // Distinguished from the abort reasons: pressing Esc is not a failure, and
    // a caller picking an exit code must not treat it as one.
    return { applied: false, abort: "cancelled" };
  };

  // ── DAEMON ──────────────────────────────────────────────────────────────────
  //
  // First because it is the only step that needs a password: asking here means
  // sudo prompts on a clean terminal, before any question has drawn a screen.
  // `sudo -v` caches the credential for the rest of the run, so the install at
  // apply time stays non-interactive. Machine-level: one daemon serves every
  // project on this machine.
  //
  // An already-healthy daemon needs no install and no password — but healthy
  // means running, the version this CLI ships, AND able to answer. Running
  // alone skipped the stale version during an upgrade; the right version alone
  // waved through a unit whose worker dies on every spawn (`ExecStart` bakes in
  // `process.execPath`, so an `nvm uninstall` breaks it). A real hook
  // evaluation is the only check that tells those apart. `unknown` is macOS's
  // "the state could not be READ" (launchd's system domain needs root), so it is
  // probed rather than assumed down: reinstalling a healthy service opens a
  // fail-closed window to fix nothing.
  const daemonSkew = daemonVersionSkew();
  const daemonState = daemonServiceStatus();
  const daemonMaybeUp = (daemonState === "running" || daemonState === "unknown") && daemonSkew === null;
  const daemonAnswers = daemonMaybeUp ? await probeDaemonEndToEnd() : false;
  const daemonAlreadyRunning = daemonMaybeUp && daemonAnswers;
  // Installed and running, but its worker cannot evaluate anything. Keyed on a
  // DEFINITE `running`: this is the branch that tears the service down before
  // rebuilding, justified only by knowing a live process holds the flock.
  const daemonBroken = daemonState === "running" && daemonSkew === null && !daemonAnswers;
  const daemonWanted = !daemonAlreadyRunning;
  // A healthy daemon can still run a service definition written before
  // FAILPROOFAI_CLI_CMD existed, and nothing else ever rewrites it: upgrading
  // the npm package does not touch /etc/systemd/system.
  let daemonUnitStale = daemonAlreadyRunning && daemonServiceNeedsUpgrade();

  // `primeElevation` runs `sudo -v`, which PROMPTS. An unattended run has
  // nobody to type a password, so it goes straight to the `sudo -n` the install
  // uses anyway, and a machine that cannot elevate gets the commands instead of
  // a hung terminal.
  const elevate = (ask: string | null): boolean => {
    if (unattended) {
      if (ask) write([ask]);
      return canElevate();
    }
    // The prompt is erased afterwards, with the line asking for it, so the step
    // collapses to the one line that says how it went.
    const rooted = collapseAfter(stdout, 10, () => {
      if (ask) stdout.write(`${ask}\n`);
      return primeElevation();
    });
    // Erased on failure too, so it is said again where the failure is.
    if (!rooted && ask) write([ask]);
    return rooted;
  };

  write([kit.head("Daemon")]);
  if (daemonWanted) {
    // The broken case keeps its consequence on screen: "every tool call is
    // denied" is the difference between a thirty-second fix and a support
    // thread, so it is printed outside the region the sudo prompt is erased
    // from.
    if (daemonBroken) write(["failproofaid can't evaluate — every tool call is denied. Rebuilding needs sudo."]);
    const ask = daemonBroken
      ? null
      : daemonSkew
        ? `Updating failproofaid from ${daemonSkew.installed} to ${daemonSkew.expected} needs root once.`
        : "Installing failproofaid needs root once.";
    if (!elevate(ask)) {
      // Required means required: write nothing at all, so a machine that could
      // not be set up is left exactly as it was found.
      write([
        kit.fail("Couldn't get root, so setup stopped before changing anything."),
        `  Re-run once you can use sudo:  ${kit.cmd("failproofai config")}`,
        `  Check what it needs:           ${kit.cmd(daemonStatusCommand() ?? "n/a")}`,
      ]);
      void emit("configure_aborted", { reason: "needs_root" });
      return { applied: false, abort: "needs_root" };
    }
    write([
      kit.ok(
        daemonBroken
          ? "Root granted to rebuild failproofaid"
          : daemonSkew
            ? `Root granted to update failproofaid to ${daemonSkew.expected}`
            : "Root granted to install failproofaid",
      ),
    ]);
  } else {
    write([kit.ok(`failproofaid ${cliVersion} is already running`)]);
    if (daemonUnitStale) {
      if (elevate("Its service definition is from an older version. Refreshing it needs root once.")) {
        write([kit.ok("Root granted to refresh its service definition")]);
      } else {
        // NOT an abort: hooks are enforcing through a working daemon; only the
        // scheduled audit is out of reach. Stopping setup over that would make
        // an upgrade the thing that locked someone out of `failproofai config`.
        write([kit.caution("No root, so its service definition stays as it is. Scheduled audits stay off until it is refreshed.")]);
        daemonUnitStale = false;
      }
    }
  }
  write([""]);

  // ── CONNECT TO CLOUD ────────────────────────────────────────────────────────
  //
  // One masked field, with Tab as the way out. The key is checked here and
  // written at apply, after the last question, so Esc anywhere before that
  // still changes nothing (decision D3).
  //
  // Tab never disconnects (decision D4): on a connected machine it leaves the
  // connection as it is, and `failproofai config --disconnect` is the one way to
  // remove it. Enter on an empty field keeps the saved key exactly as it is too
  // — no `connectToCloud`, which would reset collector settings — after
  // checking that it still works.
  const saved = savedConnection();
  const urlChoice = resolveCloudUrl(answers.url, saved?.url);
  if (!urlChoice.ok) {
    // Loud, not a silent fall-back to the hosted service: whoever set it wants
    // THAT endpoint, and reporting the machine elsewhere is what they did not ask.
    write([kit.fail(urlChoice.message)]);
    return cancel();
  }
  const url = urlChoice.url;
  const host = hostOf(url);
  const machineId = resolveMachineId(answers.machineId);
  const machineLabel = answers.machineLabel ?? saved?.machineLabel ?? resolveMachineLabel();

  let typedOrg: string | undefined;
  const planFor = (answer: CloudKeyAnswer | OpenSource): CloudPlan =>
    answer === OPEN_SOURCE
      ? saved
        ? { kind: "kept", how: "skip", verified: false }
        : { kind: "oss" }
      : answer.kind === "saved"
        ? { kind: "kept", how: "saved", verified: answer.verified }
        : { kind: "connect", token: answer.key, org: typedOrg, note: answer.note };
  const cloudLines = (plan: CloudPlan): string[] =>
    cloudCollapsedLines(kit, plan, {
      host,
      savedHost: saved ? hostOf(saved.url) : host,
      savedOrg: saved?.org,
      source: urlChoice.source,
    });

  const askCloud = (): Promise<CloudKeyAnswer | OpenSource | null> =>
    promptCloudKey({
      message: "Connect to cloud",
      // Where the key goes, in the heading: the one place somebody can notice
      // they are about to send a key somewhere they did not mean to.
      meta: urlChoice.source ? `${host}  ·  from ${urlChoice.source}` : host,
      tabHint: saved ? "skip" : "use open source instead",
      emptyError: saved ? "Paste a key, or press tab to skip." : "Paste a key, or press tab to use open source.",
      saved: saved
        ? {
            masked: maskToken(saved.token),
            check: async () => {
              const r = await checkCloudKey(saved.url, saved.token);
              if (r.ok) {
                const org = r.org ?? saved.org;
                return { ok: true, line: `Your saved key works: ${maskToken(saved.token)}${org ? `, ${org}` : ""}` };
              }
              return r.refused
                ? { ok: false, line: `Your saved key no longer works: ${r.reason}` }
                : { ok: false, usable: true, line: `Couldn't check your saved key: ${r.reason}` };
            },
          }
        : undefined,
      check: async (key) => {
        const r = await checkCloudKey(url, key);
        if (r.ok) {
          typedOrg = r.org;
          return { ok: true, line: r.note };
        }
        return { ok: false, line: r.refused ? `That key was refused: ${r.reason}.` : `Couldn't check the key: ${r.reason}.` };
      },
      collapsed: (answer) => [...cloudLines(planFor(answer)), ""],
      stdin,
      stdout,
    });

  let cloud: CloudPlan;
  if (answers.oss) {
    cloud = saved ? { kind: "kept", how: "skip", verified: false } : { kind: "oss" };
    write([...cloudLines(cloud), ""]);
  } else if (answers.token) {
    const r = await checkCloudKey(url, answers.token);
    if (r.ok) {
      cloud = { kind: "connect", token: answers.token, org: r.org, note: r.note };
      write([...cloudLines(cloud), ""]);
    } else if (unattended) {
      // A key that does not work is a FAILED setup, not a prompt: a script that
      // exited 0 here would leave a fleet believing it was reporting.
      write([
        kit.head("Connect to cloud", host),
        kit.fail(r.refused ? `That key was refused: ${r.reason}.` : `Couldn't check the key: ${r.reason}.`),
      ]);
      void emit("configure_aborted", { reason: "cloud_unverified" });
      return { applied: false, abort: "cloud_unverified" };
    } else {
      // Somebody is at the keyboard, so a refused --token is a question again
      // rather than the end of setup.
      write([kit.fail(r.refused ? `The --token key was refused: ${r.reason}.` : `Couldn't check the --token key: ${r.reason}.`)]);
      const answer = await askCloud();
      if (answer === null) return cancel();
      cloud = planFor(answer);
    }
  } else if (unattended) {
    // No key and nobody to ask: nothing about the connection changes.
    cloud = saved ? { kind: "kept", how: "skip", verified: false } : { kind: "oss" };
    write([...cloudLines(cloud), ""]);
  } else {
    const answer = await askCloud();
    if (answer === null) return cancel();
    cloud = planFor(answer);
  }

  // ── AGENTS ──────────────────────────────────────────────────────────────────
  //
  // One saved list drives hooks, collection and backfill. See `planAgents` for
  // which ticks a run starts with.
  const fp = readConfig();
  const hookedNow = INTEGRATION_TYPES.filter((id) => hookedAtUserScope(id, cwd));
  const plan = planAgents({ detected: detectInstalledClis(), saved: fp.agents, hooked: hookedNow });
  // Whether the daemon will be collecting once this run ends: a key is already
  // on disk, or this run writes one. Removal copy and the backfill request both
  // depend on it.
  const collectingAfter = cloud.kind === "connect" || readIngestCredential() !== null;
  const sessionsOn = cloud.kind === "connect" ? answers.noTranscripts !== true : fp.collector.sessions === true;

  let selected: IntegrationType[];
  if (answers.agents && answers.agents.length > 0) {
    const named = new Set(answers.agents);
    selected = plan.order.filter((id) => named.has(id));
    write([...agentsCollapsedLines(kit, plan, selected, collectingAfter, c), ""]);
  } else if (unattended || preAnswered) {
    selected = defaultSelection(plan);
    write([...agentsCollapsedLines(kit, plan, selected, collectingAfter, c), ""]);
  } else {
    // "from last setup", not the reference's "from your last setup": with all
    // twelve agents listed, the longer meta runs the heading to 81 columns and
    // the end of it is cut off.
    const suffix =
      plan.mode === "rerun" ? "  ·  from last setup" : plan.mode === "upgrade" ? "  ·  as protected today" : "";
    const picked = await multiSelect<IntegrationType>({
      message: "Which agents should failproofai trace?",
      choices: agentChoices(plan),
      minSelected: 1,
      minMessage: "Pick at least one agent.",
      meta: (checked) => `${checked.length} of ${plan.order.length} selected${suffix}`,
      tag: agentTag(plan, c),
      collapsed: (values) => [
        ...agentsCollapsedLines(kit, plan, plan.order.filter((id) => values.includes(id)), collectingAfter, c),
        "",
      ],
      stdin,
      stdout,
    });
    if (picked === null) return cancel();
    selected = plan.order.filter((id) => picked.includes(id));
  }
  const { added, removed } = agentChanges(plan, selected);

  // ── Apply ─────────────────────────────────────────────────────────────────
  //
  // Enter on the agents step was the last decision. ORDER MATTERS here:
  //
  //  1. The daemon first, because setup requires it: if it cannot be installed
  //     this run must leave the machine exactly as it found it. Writing hooks
  //     first and discovering the service will not start is the one ordering
  //     whose failure cannot be undone cleanly.
  //  2. Hooks for the chosen agents, and off for the rest.
  //  3. The backfill request for agents added back, BEFORE the selection that
  //     ticks them: the daemon handles a pending request ahead of its config
  //     compare, so one landing a tick later would let an added agent resume
  //     stale cursors first.
  //  4. The selection, BEFORE any new ingest key, or the first collection runs
  //     every agent.
  //  5. The connection last.
  const done: string[] = [];
  let daemonInstalled = daemonAlreadyRunning;
  if (daemonWanted) {
    // A unit that is running but cannot answer is torn down before it is
    // rebuilt: it holds the singleton flock the replacement needs, so
    // installing over it starts a unit that loses the lock race.
    if (daemonBroken) {
      await transient("Removing the failproofaid service that can't start…", async () => {
        try {
          await uninstallDaemonService();
        } catch (err) {
          // Non-fatal: the install below reports the outcome that decides.
          hookLogWarn(
            `could not remove the broken failproofaid service: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
    const daemonResult = await transient(daemonBroken ? "Reinstalling failproofaid…" : "Installing failproofaid…", () =>
      installDaemonService(),
    );
    void emit("configure_daemon_install", {
      installed: daemonResult.installed,
      // A bounded classification, never the raw reason: that string routinely
      // carries the OS username. The full text stays local via hookLogWarn.
      reason: daemonResult.installed ? null : classifyDaemonInstallFailure(daemonResult.reason),
      platform: process.platform,
    });
    if (!daemonResult.installed) {
      hookLogWarn(`failproofaid was not installed as a service: ${daemonResult.reason}`);
      // Nothing user-facing has been written yet, so there is nothing to roll
      // back — which is the entire reason this runs first.
      write([
        kit.fail("failproofaid could not be installed, so setup stopped before changing anything."),
        `  ${daemonResult.reason ?? "unknown error"}`,
        `  Once that is fixed, re-run:  ${kit.cmd("failproofai config")}`,
      ]);
      void emit("configure_aborted", { reason: "daemon_failed" });
      return { applied: false, abort: "daemon_failed" };
    }
    // Installed and running is the service manager's opinion. Setting
    // `daemonConfigured` against a daemon whose worker cannot run denies every
    // tool call across all twelve CLIs, `UserPromptSubmit` included, so a real
    // evaluation is asked for before anything else is written.
    const probe = await transient("Checking that failproofai answers…", () => probeDaemon());
    if (!probe.ok) {
      hookLogWarn(
        `failproofaid was installed and running but did not answer a policy evaluation (${probe.reason})`,
      );
      write([
        kit.fail(
          probe.reason === "worker"
            ? "failproofaid started but can't evaluate policies: its worker process could not be run."
            : "failproofaid started but could not be reached on its socket.",
        ),
        "  Setup stopped before changing anything: a machine that requires a daemon",
        "  that cannot answer denies every tool call.",
        `  Check it with:  ${kit.cmd(daemonStatusCommand() ?? "systemctl status failproofaid")}`,
        `  Then re-run:    ${kit.cmd("failproofai config")}`,
      ]);
      void emit("configure_aborted", { reason: `daemon_not_answering_${probe.reason}` });
      return { applied: false, abort: "daemon_failed" };
    }
    daemonInstalled = true;
    done.push(
      kit.ok(
        daemonBroken
          ? "failproofaid rebuilt and running"
          : daemonSkew
            ? `failproofaid updated to ${cliVersion} and running`
            : "failproofaid installed and running",
      ),
    );
  } else if (daemonUnitStale) {
    // Never instead of the install, and never able to abort a setup that is
    // otherwise fine: a failure here costs the scheduled audit, nothing else.
    const upgrade = await transient("Refreshing failproofaid's service definition…", () => ensureDaemonServiceCurrent());
    void emit("configure_daemon_unit_refresh", {
      outcome: upgrade.outcome,
      daemon_running: upgrade.daemonRunning ?? true,
      platform: process.platform,
    });
    if (upgrade.outcome === "failed") {
      hookLogWarn(`failproofaid service definition could not be refreshed: ${upgrade.reason}`);
      done.push(kit.caution(`failproofaid's service definition could not be refreshed: ${upgrade.reason ?? "unknown error"}`));
      if (upgrade.daemonRunning === false) {
        // The refresh stopped a daemon it could not start again. Leaving
        // `daemonConfigured` set would deny every tool call against a socket
        // nothing listens on, so the machine goes back to in-process evaluation.
        daemonInstalled = false;
        setDaemonConfigured(false);
        done.push(
          "  It is no longer running, so this machine is back on in-process evaluation, and",
          `  hooks keep enforcing. Reinstall it with  ${kit.cmd("failproofai config")}`,
        );
      } else {
        done.push("  Hooks keep enforcing; scheduled audits stay off until it is refreshed.");
      }
    } else {
      done.push(kit.ok("failproofaid's service definition is up to date"));
    }
  }

  // The flag that makes hooks route through the daemon — and fail closed when
  // it is unreachable. Only ever set after a verified-running service.
  if (daemonInstalled) {
    setDaemonConfigured(true, cliVersion);
    // The unit points at the new binary now, so older ones are unreferenced.
    pruneOldDaemonBinaries();
  }

  const connectedAfterPlan = cloud.kind === "connect" || cloud.kind === "kept";
  // Telemetry runs concurrently with the rest of apply (never rejects,
  // 5s-bounded) and is awaited before returning. Counts only: no agent names.
  const applied = emit("configure_applied", {
    target: "user",
    scopes: ["user"],
    cli: selected,
    cli_count: selected.length,
    policy_count: (readScopedHooksConfig("user", cwd).enabledPolicies ?? []).length,
    connected: cloud.kind === "connect",
    mode: connectedAfterPlan ? "cloud" : "oss",
    agents_selected: selected.length,
    agents_detected: plan.detected.size,
    agents_changed: added.length + removed.length > 0,
  });

  // Hooks, at user scope, for the chosen agents. Whatever policies are enabled
  // there are carried through untouched: `replace: true` would otherwise switch
  // off policies the user had turned on, and setup must never reduce
  // protection. Setup chooses no policies of its own any more.
  const policies = readScopedHooksConfig("user", cwd).enabledPolicies ?? [];
  // Nothing to hook is a real answer (a saved empty selection), and handing
  // installHooks an empty list is not a way to say it.
  if (selected.length > 0) await transient("Installing hooks…", () =>
    installHooks(
      policies,
      "user",
      cwd,
      /* includeBeta */ false,
      "configure-wizard",
      /* customPoliciesPath */ undefined,
      /* removeCustomHooks */ false,
      selected,
      { replace: true, quiet: true },
    ),
  );
  // And off for every agent not chosen that has them: the ones unticked now,
  // and any hooked since the last setup without being part of it.
  removeUserScopeHooks(
    INTEGRATION_TYPES.filter((id) => !selected.includes(id) && (plan.baseline.has(id) || hookedNow.includes(id))),
    cwd,
  );

  // Agents traced again start fresh: their old cursors are forgotten and the
  // collector reads the default window, exactly as for an agent never traced.
  // Only when something will be collecting afterwards — on an open-source
  // machine the request would wait for a connection that may never come, and
  // the daemon drops one that old anyway.
  if (added.length > 0 && collectingAfter && sessionsOn) {
    try {
      writeBackfillRequest({ kind: "added", agents: added, requestedAtMs: Date.now() });
    } catch (err) {
      hookLogWarn(
        `could not write the backfill request for re-added agents: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  updateConfig({ agents: { selected, seen: plan.seen } });

  // The connection, written after the daemon exists — the daemon runs the
  // collector, so a credential written for a service that is not there would be
  // a key on disk doing nothing. `connectToCloud` re-verifies each capability
  // and writes only what works.
  let connected = false;
  if (cloud.kind === "connect") {
    const token = cloud.token;
    try {
      const outcome = await transient("Connecting…", () =>
        connectToCloud({
          url,
          token,
          machineId,
          machineLabel,
          // Both streams unless the run said `--no-transcripts`.
          sessions: answers.noTranscripts !== true,
        }),
      );
      connected = outcome.anyConfigured;
      done.push(...connectDoneLines(kit, outcome, host, cloud.org));
      if (outcome.ingest.ok && answers.noTranscripts === true) {
        done.push("  Decisions only: session transcripts are not sent (--no-transcripts).");
      }
      void emit("configure_connect", { policy_ok: outcome.policy.ok, ingest_ok: outcome.ingest.ok });
    } catch (err) {
      // Non-fatal, unlike the daemon: enforcement does not depend on the cloud.
      hookLogWarn(`cloud connection was not written: ${err instanceof Error ? err.message : String(err)}`);
      done.push(kit.caution("Couldn't connect; everything else was applied.", "failproofai config"));
    }
  } else if (cloud.kind === "kept" && cloud.how === "saved" && fp.mode !== "cloud") {
    // A home migrated from layout 1 carries keys but no mode, and would read
    // as open source everywhere that asks.
    updateConfig({ mode: "cloud" });
  }

  await applied;
  // Only now — a completed apply — is the launcher considered "seen", so
  // first-run onboarding stops offering itself on every command.
  markLauncherSeen();
  // And any record of an earlier failure is now false: this machine got set up.
  clearOnboardingAttempt();

  write(doneLines(kit, { elapsedMs: Date.now() - started, done, cwd, agents: selected.length, connected: connected || cloud.kind === "kept" }));

  return {
    applied: true,
    target: "user",
    scopes: ["user"],
    clis: selected,
    policies,
    daemonInstalled,
    connected,
    mode: connected || cloud.kind === "kept" ? "cloud" : "oss",
    agents: { selected, added, removed },
  };
}

// ── Cloud helpers ────────────────────────────────────────────────────────────

/** What the CONNECT step decided. Nothing is written until apply. */
type CloudPlan =
  | { kind: "oss" }
  | { kind: "kept"; how: "skip" | "saved"; verified: boolean }
  | { kind: "connect"; token: string; org?: string; note?: string };

/**
 * The connection already on this machine, from either credential: the policy
 * one and the collector's ingest key. Reading only the first, as setup used to,
 * showed a collector-only machine as unconnected.
 */
function savedConnection(): {
  url: string;
  token: string;
  org?: string;
  machineLabel?: string;
} | null {
  const cloud = readCloudCredentials();
  const ingest = readIngestCredential();
  const token = cloud?.token ?? ingest?.key;
  if (!token) return null;
  const url = cloud?.url ?? cloudBaseFor(ingest?.url ?? DEFAULT_INGEST_URL);
  let org: string | undefined;
  try {
    const stored = readCredentials().org;
    org = stored?.name ?? stored?.slug;
  } catch {
    org = undefined;
  }
  return { url, token, org, machineLabel: cloud?.machineLabel };
}

/**
 * Where a key is sent: `--url`, else FAILPROOFAI_CLOUD_URL, else this machine's
 * existing connection, else the hosted service.
 *
 * Never asked for interactively: everybody on the hosted product has one right
 * answer, and asking made it look like a decision — which is how keys ended up
 * pasted into the URL field. The env value goes through the SAME validation a
 * typed one did, so http stays loopback-only. The source is named on screen,
 * because an env var is invisible at exactly the moment it matters.
 */
export function resolveCloudUrl(
  flag: string | undefined,
  existing: string | undefined,
): { ok: true; url: string; source?: string } | { ok: false; message: string } {
  const env = process.env.FAILPROOFAI_CLOUD_URL?.trim();
  const fromFlag = flag?.trim();
  const override = fromFlag || env;
  if (!override) return { ok: true, url: existing ?? cloudBaseFor(DEFAULT_INGEST_URL) };
  const source = fromFlag && fromFlag !== env ? "--url" : "FAILPROOFAI_CLOUD_URL";
  const validated = validateCloudUrl(cloudBaseFor(override));
  if (!validated.ok) {
    return {
      ok: false,
      message: `${source === "--url" ? "--url is" : "FAILPROOFAI_CLOUD_URL is set to"} "${override}", which cannot be used: ${validated.reason}`,
    };
  }
  return { ok: true, url: validated.url, source };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Check a key without writing anything or registering anything server-side.
 *
 * Introspect first: it says which organisation the key belongs to and what it
 * may do, with no side effect. A key that can neither send events nor pull
 * policies is refused; one that can do one of them is accepted with a note
 * saying which half is missing. A server too old for introspect is probed the
 * way setup always did, with an empty batch to the ingest endpoint.
 *
 * `refused: false` is "could not ask" (offline, a timeout, a 5xx) — a saved key
 * that fails that way may still be fine, so it is not treated as broken.
 */
export async function checkCloudKey(
  url: string,
  key: string,
): Promise<{ ok: true; org?: string; note?: string } | { ok: false; refused: boolean; reason: string }> {
  const identity = await introspectKey(url, key);
  if (identity.kind === "rejected") return { ok: false, refused: true, reason: "the server did not accept it" };
  if (identity.kind === "unreachable") return { ok: false, refused: false, reason: identity.reason };
  if (identity.kind === "ok") {
    const events = hasPermission(identity.identity, PERMISSION_EVENTS);
    const policies = hasPermission(identity.identity, PERMISSION_POLICIES);
    const org = identity.identity.orgName ?? identity.identity.orgSlug;
    if (!events && !policies) {
      return { ok: false, refused: true, reason: `it is missing the ${PERMISSION_EVENTS} permission` };
    }
    const note = !events
      ? `This key can't send events (${PERMISSION_EVENTS}), so nothing will be collected.`
      : !policies
        ? `This key can't pull policies (${PERMISSION_POLICIES}), so cloud-managed policies won't arrive.`
        : undefined;
    return { ok: true, org, note };
  }
  const probe = await validateIngestKey({ url: ingestUrlFor(url), key });
  if (probe.ok) return { ok: true };
  const offline = /^could not reach|answered 5\d\d/.test(probe.reason);
  return { ok: false, refused: !offline, reason: probe.reason };
}

/** The CONNECT step, collapsed: what was checked, never yet what was written. */
export function cloudCollapsedLines(
  kit: ReturnType<typeof screenKit>,
  plan: CloudPlan,
  at: { host: string; savedHost: string; savedOrg?: string; source?: string },
): string[] {
  // An override is named where the key went: an env var is invisible at the
  // moment it matters, and a machine reporting somewhere unexpected is exactly
  // what nobody notices until they look for data that is not there.
  const head = kit.head("Connect to cloud", at.source ? `${at.host}  ·  from ${at.source}` : undefined);
  switch (plan.kind) {
    case "oss":
      return [head, kit.ok("Using open source.")];
    case "kept":
      if (plan.how === "skip") return [head, kit.ok(`Not connecting. The connection to ${at.savedHost} is unchanged.`)];
      return plan.verified
        ? [head, kit.ok(at.savedOrg ? `Connected as ${at.savedOrg} to ${at.savedHost}` : `Connected to ${at.savedHost}`)]
        : [head, kit.caution(`Keeping the connection to ${at.savedHost}. Its key couldn't be checked just now.`)];
    case "connect":
      return [
        head,
        kit.ok(plan.org ? `Key accepted for ${plan.org} on ${at.host}` : `Key accepted by ${at.host}`),
        ...(plan.note ? [kit.caution(plan.note)] : []),
      ];
  }
}

/** What connecting wrote, for the DONE section. */
function connectDoneLines(
  kit: ReturnType<typeof screenKit>,
  outcome: Awaited<ReturnType<typeof connectToCloud>>,
  host: string,
  org: string | undefined,
): string[] {
  const name = outcome.org?.name ?? outcome.org?.slug ?? org;
  const as = name ? `Connected as ${name} to ${host}` : `Connected to ${host}`;
  // Jev's state rides along on every branch that connected: whether it is on,
  // available but off, or was cleared is decided by this connect and said
  // nowhere else.
  if (outcome.policy.ok && outcome.ingest.ok) return [kit.ok(as), ...jevLines(outcome)];
  if (outcome.ingest.ok) {
    return [kit.ok(as), kit.caution(`Cloud-managed policies won't arrive: ${outcome.policy.reason}`), ...jevLines(outcome)];
  }
  if (outcome.policy.ok) return [kit.ok(as), kit.caution(`Nothing is collected: ${outcome.ingest.reason}`), ...jevLines(outcome)];
  return [kit.caution(`Not connected: ${outcome.ingest.reason ?? outcome.policy.reason ?? "unknown error"}`, "failproofai config")];
}

/**
 * The DONE section: what apply wrote, then whether anything is enforcing — the
 * one generic warning when it is not (decision D18) — and the custom-policy
 * files that will not load, which the removed review step used to show.
 */
export function doneLines(
  kit: ReturnType<typeof screenKit>,
  state: { elapsedMs: number; done: string[]; cwd: string; agents: number; connected: boolean },
): string[] {
  const lines = [kit.head("Done", `in ${(state.elapsedMs / 1000).toFixed(1)}s`), ...state.done];
  const on = `${state.agents} ${state.agents === 1 ? "agent" : "agents"}`;
  if (notEnforcingReason(state.cwd)) {
    lines.push(
      kit.caution("Policies are not enforcing yet."),
      `  Turn on ours:  ${kit.cmd(`failproofai policies add ${CORE_SOURCE}`)}`,
    );
  } else {
    const { count, custom } = enforcingPolicyCount(state.cwd);
    lines.push(
      kit.ok(
        count === 0
          ? `Your custom policies are enforcing on ${on}.`
          : custom
            ? `${count} ${count === 1 ? "policy" : "policies"} and your custom policies are enforcing on ${on}.`
            : `${count} ${count === 1 ? "policy is" : "policies are"} enforcing on ${on}.`,
      ),
    );
  }
  if (!state.connected) lines.push(`  Connect to cloud any time:  ${kit.cmd("failproofai config")}`);
  for (const warning of describeCustomPolicies(state.cwd).warnings) {
    lines.push(kit.caution(warning.replace(/^! /, "")));
  }
  lines.push("");
  return lines;
}
