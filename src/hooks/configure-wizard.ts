/**
 * `failproofai config` — the interactive setup launcher.
 *
 * A single guided flow that sets up the whole failproofai ecosystem:
 *
 *   0. Daemon    — REQUIRED. Asks for sudo first, on a clean terminal.
 *   1. Where     — inferred from cwd, then confirmed (global / project / both)
 *   2. Policies  — multi-select of themed presets (combine any) or Everything
 *   3. Assistants— multi-select of agent harnesses (detected + install-ahead)
 *   4. Connect   — paste an API key, or stay fully local
 *   5. Review    — shows exactly which files change, then Apply.
 *
 * Selections REPLACE the enabled set at the chosen scope (the picker pre-checks
 * whatever is already enabled, so unticking removes). Reuses the tested
 * install/uninstall manager and the existing searchable policy picker.
 *
 * ## Two ordering rules that are not cosmetic
 *
 * **The daemon comes first because it is the only step that needs a password.**
 * `sudo -v` must prompt on a clean terminal, before any TUI frame is drawn —
 * fired from underneath a rendered screen the prompt is invisible and the typed
 * password lands in a redrawn frame.
 *
 * **The daemon is INSTALLED first, before any user config is written.** Setup
 * requires it, so a failure has to leave the machine exactly as it was found
 * rather than half-configured. Writing hooks first and discovering the service
 * will not start afterwards is the one ordering that cannot be undone cleanly.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

import { CORE_SOURCE } from "./pack-store";

import {
  selectOne,
  promptText,
  intro,
  outro,
  summarize,
  type MultiChoice,
  type TTYIn,
  type TTYOut,
} from "./tui";
import {
  DEFAULT_INGEST_URL,
  validateIngestKey,
} from "./collector-config";
import {
  detectInstalledClis,
  getIntegration,
  settingsPathsFor,
  unhookedHermesProfiles,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { installHooks } from "./manager";
import { getConfigPathForScope, readScopedHooksConfig } from "./hooks-config";
import { discoverPolicyFiles, findSkippedPolicyFiles } from "./custom-hooks-loader";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import {
  canElevate,
  isDaemonSupportedPlatform,
  installDaemonService,
  daemonServiceFilePath,
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
  readCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
} from "./cloud-enrollment";
import {
  cloudBaseFor,
  ingestUrlFor,
  connectToCloud,
  describeOutcome,
} from "./cloud-connection";
import {
  detectSetupState,
  isConfigured,
  scopesFor,
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
  connected?: boolean;
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

export function buildAgentChoices(scope: HookScope, cwd: string): MultiChoice<IntegrationType>[] {
  const detected = new Set(detectInstalledClis());
  // Detected first, then the rest as "install ahead of time".
  const ordered = [
    ...INTEGRATION_TYPES.filter((id) => detected.has(id)),
    ...INTEGRATION_TYPES.filter((id) => !detected.has(id)),
  ];
  return ordered.map((id) => {
    const integration = getIntegration(id);
    const isDetected = detected.has(id);

    // Not every CLI can be configured at every scope — Hermes and OpenClaw
    // have no project config at all. Offering them anyway meant picking "Just
    // this project" and applying died with `Scope "project" is not supported
    // by Hermes`, after the user had answered every question. Show them as
    // locked and unchecked with the reason, so the constraint is visible
    // instead of being discovered as a crash.
    const supported = integration.scopes.includes(scope);
    if (!supported) {
      return {
        label: integration.displayName,
        value: id,
        checked: false,
        locked: true,
        section: "Global only · not configurable per-project",
        hint: `supports ${integration.scopes.join(", ")} scope — rerun with "Everywhere I code"`,
      };
    }

    let installedHere = false;
    try {
      installedHere = integration.hooksInstalledInSettings(scope, cwd);
    } catch {
      installedHere = false;
    }
    // Hermes reports installed only when EVERY profile is hooked, so a profile
    // added after install flips it to false. Say which ones, otherwise a mostly
    // configured gateway just reads as "not configured".
    let partialHint: string | undefined;
    if (id === "hermes" && !installedHere) {
      try {
        const unhooked = unhookedHermesProfiles();
        if (unhooked.length > 0) {
          partialHint = `${unhooked.length} unhooked profile(s): ${unhooked.join(", ")}`;
        }
      } catch {
        // Profile discovery is best-effort — never block the wizard.
      }
    }
    return {
      label: integration.displayName,
      value: id,
      checked: isDetected || installedHere,
      section: isDetected ? "Detected" : "Not installed · set up ahead of time",
      hint: installedHere
        ? "already configured"
        : (partialHint ?? (isDetected ? undefined : "not on PATH")),
    };
  });
}


const DIM_NOTE = "(auto-loaded)";

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

/**
 * The wizard's one-line completion summary. Pure and exported so the widest
 * real combination — every policy, every CLI, custom/daemon/reporting all
 * present — can be pinned by a test without having to drive the whole wizard
 * through a real chdir + on-disk custom-policy fixture.
 *
 * Kept inside a standard 80-column terminal: `writeLines` truncates with a
 * hard cut and no ellipsis, so an over-long line doesn't just lose its tail
 * — it reads as broken output. Naming all ten CLIs once took it to 182
 * characters; the count alone carries the same information, and the user
 * picked them two screens ago. A single grouped "· a, b, c" clause bounds the
 * optional notes to one separator and short tags, rather than three
 * independent " · " clauses stacking up.
 */
export function buildCompletionSummary(
  policiesCount: number,
  harnessesCount: number,
  customEnabled: boolean | undefined,
  daemonInstalled: boolean,
  connected: boolean,
): string {
  const extras: string[] = [];
  if (customEnabled === true) extras.push("custom");
  else if (customEnabled === false) extras.push("custom off");
  if (daemonInstalled) extras.push("daemon");
  if (connected) extras.push("reporting");
  const extrasNote = extras.length > 0 ? ` · ${extras.join(", ")}` : "";
  const harnesses = `${harnessesCount} harness${harnessesCount === 1 ? "" : "es"}`;
  const line = (selection: string) =>
    `Setup complete — ${selection} · ${harnesses}${extrasNote}`;

  // Bound the WHOLE line, not just the names. `writeLines` truncates with a hard
  // cut and no ellipsis, so 81 characters does not lose a tail — it reads as
  // broken output. Naming is preferred and degrades to the count only when the
  // full line will not fit, which is checked rather than guessed at: the extras
  // clause grows too ("custom, daemon, reporting" is 25 characters), so a names
  // budget alone was wrong for exactly the combinations that need it most.
  return line(describeSelection(policiesCount));
}

/**
 * The budget this line has to fit in.
 *
 * 80 columns minus the 3-column gutter the existing summary tests already assert
 * (`message.length + GUTTER <= 80`) — matching that convention rather than
 * inventing a second one, because two different width rules for the same line is
 * how one of them ends up wrong.
 */
const MAX_SUMMARY_COLUMNS = 77;

/** The column this line aligns under, matching `  Policies   : `. */
const POLICY_LIST_INDENT = " ".repeat(15);

/**
 * A taste of the set, not the set: two names and a count of the rest.
 *
 * The same shape `describeSelection` uses for bundles, for the same reason —
 * naming everything turned a four-line review screen into a fifteen-line one,
 * and a screen nobody reads to the bottom is worse at conveying what is about
 * to happen than a short one. Two names say what KIND of thing these are;
 * `failproofai policies list` says the rest, for the person who wants it.
 *
 * The whole review body is rendered dim by the prompt (`tui.ts`), so this
 * reads as a subtitle to the count above it rather than competing with it.
 *
 * Degrades by dropping names rather than by overflowing: `writeLines`
 * truncates with a hard cut and no ellipsis, so a line that runs over ends
 * mid-slug and reads as a policy name that does not exist. Two long names
 * (`sanitize-private-key-content` is 28) plus the prefix is within budget, but
 * the guard is here rather than argued about, because a future rename is
 * exactly the kind of change nobody re-measures.
 */
export function policyNamesLine(names: string[]): string[] {
  if (names.length === 0) return [];
  const budget = MAX_SUMMARY_COLUMNS - POLICY_LIST_INDENT.length;
  for (const take of [2, 1]) {
    const shown = names.slice(0, take);
    const rest = names.length - shown.length;
    const text = rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
    if (text.length <= budget) return [`${POLICY_LIST_INDENT}${text}`];
  }
  return [];
}

/** The Policies line's value. With policies no longer chosen during setup, this
 *  reports what is enabled and nothing about how it got that way. */
function describeSelection(policiesCount: number): string {
  return `${policiesCount} ${policiesCount === 1 ? "policy" : "policies"}`;
}


export function reviewLines(state: {
  /** What the scope step resolved to. Expands to one or two real scopes. */
  target: SetupTarget;
  clis: IntegrationType[];
  policies: string[];
  cwd: string;
  /** The Custom checkbox. `undefined` = nothing to toggle, leave as-is. */
  customEnabled?: boolean;
  /**
   * Whether a daemon will be installed by this run. False when one is already
   * healthy (nothing to do) or the platform has no service manager — showing
   * it any other way would promise work the apply will not perform.
   */
  installDaemon?: boolean;
  /** Whether an API key will be written and reporting turned on. */
  connect?: boolean;
}): string[] {
  const { target, clis, policies, cwd, customEnabled, installDaemon, connect } = state;
  const scopes = scopesFor(target);
  const where =
    target === "both"
      ? `Global, plus this project (${homeify(cwd)})`
      : target === "project"
        ? `This project (${homeify(cwd)})`
        : "Everywhere (global)";
  const lines: string[] = [];
  const harnessNames = clis.map((c) => getIntegration(c).displayName);
  lines.push(`  Where      : ${where}`);
  lines.push(`  Harnesses  : ${harnessNames.length ? summarize(harnessNames, "harnesses") : "(none)"}`);
  // Zero is a deliberate answer, not a failed step — say so, and say where to
  // change it, so the review screen doesn't read like the wizard lost the
  // selection. Hooks still install; only the builtin set is empty.
  lines.push(
    policies.length === 0
      ? "  Policies   : none enabled (add later: failproofai policies --install)"
      : `  Policies   : ${policies.length} enabled`,
  );
  // A taste of what they are, under the count. "15 enabled" alone is a number
  // the user cannot check and, on the recommended path, did not choose; two
  // names say what kind of thing it is without turning the review into a page.
  if (policies.length > 0) {
    lines.push(...policyNamesLine([...policies].sort()));
  }
  if (installDaemon && isDaemonSupportedPlatform()) {
    lines.push(
      `  Daemon     : failproofaid, installed as a system service running as you`,
    );
  }
  lines.push(
    connect
      ? "  Reporting  : on — policy decisions and session transcripts"
      : "  Reporting  : off — nothing leaves this machine",
  );

  // Reflect the Custom decision, not just what is on disk. Reporting
  // "1 file (project) (auto-loaded)" after the user had just unticked the row
  // stated the opposite of what was about to happen.
  const custom = describeCustomPolicies(cwd);
  if (custom.active.length > 0) {
    lines.push(
      `  Custom     : ${custom.active.join(" · ")} ${
        customEnabled === false ? "— DISABLED, will not load" : DIM_NOTE
      }`,
    );
  }
  for (const warning of custom.warnings) lines.push(`  ${warning}`);

  lines.push("");
  lines.push("  This will update:");
  // Deduplicated across scopes: a CLI that supports only user scope resolves to
  // the same settings file under both halves of "Both", and listing it twice
  // reads as two separate writes.
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const cli of clis) {
      const integration = getIntegration(cli);
      if (!integration.scopes.includes(scope)) continue;
      // Usually one path; Hermes lists one per profile so the operator sees
      // every home dir that is about to be written.
      for (const p of settingsPathsFor(integration, scope, cwd)) {
        if (seen.has(p)) continue;
        seen.add(p);
        lines.push(`    ${homeify(p)}   ${integration.displayName} hooks`);
      }
    }
  }
  for (const scope of scopes) {
    const configPath = getConfigPathForScope(scope, cwd);
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    lines.push(`    ${homeify(configPath)}   ${policies.length} policies`);
  }
  if (installDaemon && isDaemonSupportedPlatform()) {
    const servicePath = daemonServiceFilePath();
    if (servicePath) lines.push(`    ${homeify(servicePath)}   failproofaid service (needs root)`);
  }
  return lines;
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
      `\n[failproofai] Not set up yet — run \`failproofai config\` to get started.\n\n`,
    );
    return false;
  }

  // Onboarding now fires on ANY command, so two terminals on a fresh machine
  // is a real shape: both would draw a wizard, race on the same settings
  // files, and both try to install the one system service. Only one gets to.
  const lock = acquireOnboardingLock();
  if (!lock) {
    stdout.write(
      `\n[failproofai] Setup is already running in another terminal — leaving it to finish.\n\n`,
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
  // No terminal means no questions — not a refusal.
  //
  // `failproofai config` IS the authorisation: somebody typed the command whose
  // entire job is to configure this machine. Requiring a flag on top of that to
  // permit what the command already means is asking the same question twice,
  // and this used to refuse outright — so a CI job, a container or an agent
  // could not set a machine up at all, which is the gap this closes.
  //
  // Safe to do here because the IMPLICIT path is guarded separately:
  // `maybeFirstRunConfigure` has its own TTY check and returns before ever
  // reaching this function, so setup never runs off the back of some other
  // command on a headless box.
  const unattended = !stdin.isTTY || !stdout.isTTY;


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
    // Same reason as above: this configured nothing, and it is not a
    // cancellation. `running_as_sudo` has been in `WizardAbort` since it was
    // written and was never once assigned.
    return { applied: false, abort: "running_as_sudo" };
  }

  // Fire-and-forget: never block the wizard's first paint on telemetry.
  void emit("configure_started", {});

  // failproofaid — the only evaluator on a configured machine — only runs on
  // Linux and macOS. Checked before intro() draws anything and before a
  // single prompt is asked: completing setup anyway used to leave e.g. a
  // Windows machine reading as configured while enforcing in-process with no
  // fail-closed guarantee, which is worse than not being set up at all.
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

  intro("let's set up failproofai", stdout);

  const cancel = (): WizardResult => {
    outro("Cancelled — nothing was changed.", { ok: false }, stdout);
    // Distinguished from the abort reasons: pressing Esc is not a failure, and
    // a caller picking an exit code must not treat it as one.
    return { applied: false, abort: "cancelled" };
  };

  // 0 — The background daemon. REQUIRED, and before anything else.
  //
  // First because it is the only step that needs a password: asking here means
  // sudo prompts on a clean terminal, before any question has drawn a screen,
  // instead of firing from underneath a rendered TUI where the prompt is
  // invisible and the typed password lands in a redrawn frame. `sudo -v`
  // caches the credential for the rest of the run, so the actual install at
  // apply time stays non-interactive.
  //
  // Machine-level, so it is deliberately NOT gated on the scope chosen in the
  // next step: one daemon serves every project on this machine.
  //
  // Always true here — the guard near the top of this function already
  // refused setup on anything else. Kept as a real read (not a literal
  // `true`) so this block still fails safe if that guard is ever moved.
  const daemonSupported = isDaemonSupportedPlatform();
  // An already-healthy daemon needs no install and no password. Re-running
  // setup on a configured machine must not demand sudo for work that is
  // already done.
  // "running" only. A unit that exists but is stopped or crash-looping is
  // exactly the machine that needs this run to reinstall it, and treating
  // "installed" as good enough would skip the repair and then set
  // `daemonConfigured` against a service that is not answering — which fails
  // closed on every tool call.
  // Running is not enough — it must also be the version this CLI ships.
  //
  // Skipping on "running" alone was right for the case it was written for
  // (never demand a password for work already done), and exactly backwards
  // during an upgrade: the OLD daemon is perfectly healthy, so setup skipped
  // it and the stale version survived. That made "just re-run config" — the
  // remedy every message points at — silently do nothing.
  //
  // And running the right VERSION is still not enough: it must be able to
  // answer. `ExecStart` bakes in `process.execPath` and an absolute
  // `dist/worker.mjs`, so an `nvm uninstall 20` after setup leaves a unit
  // systemd calls active whose worker dies on every spawn. That machine reads
  // as "already running", so this wizard — the documented remedy, and the only
  // caller that can rebuild the unit — skipped it and left the box denying
  // every tool call with no route back but hand-editing `config.json`. A real
  // hook evaluation is the only check that distinguishes the two.
  const daemonSkew = daemonSupported ? daemonVersionSkew() : null;
  const daemonState = daemonSupported ? daemonServiceStatus() : "unsupported-platform";
  // `unknown` is "the service state could not be READ", which only macOS
  // produces: a LaunchDaemon's state lives in launchd's system domain and needs
  // root to read, so a sudo cache older than five minutes says nothing about
  // whether the daemon is up. Treating that as "stopped" made the wizard demand
  // a password and unload/reload a perfectly healthy service — a real
  // fail-closed window on a `daemonConfigured` machine, opened to fix nothing,
  // and a direct breach of this file's own rule that setup must not demand sudo
  // for work already done. So it is probed rather than assumed: the probe is a
  // real hook evaluation over the socket, needs no privileges, and answers the
  // question the status check was only standing in for.
  const daemonMaybeUp =
    daemonSupported && (daemonState === "running" || daemonState === "unknown") && daemonSkew === null;
  const daemonAnswers = daemonMaybeUp ? await probeDaemonEndToEnd() : false;
  const daemonAlreadyRunning = daemonMaybeUp && daemonAnswers;
  /**
   * Installed and running, but its worker cannot evaluate anything.
   *
   * Keyed on a DEFINITE `running` reading, not on `daemonMaybeUp`: this is the
   * branch that tears the service down before rebuilding, and the justification
   * for that is knowing a live process is holding the singleton flock. An
   * unreadable state is not that knowledge, and the plain install path already
   * unloads before it writes.
   */
  const daemonBroken = daemonState === "running" && daemonSkew === null && !daemonAnswers;
  let daemonWanted = daemonSupported && !daemonAlreadyRunning;
  // A healthy daemon can still be running a service definition written before
  // FAILPROOFAI_CLI_CMD existed, and nothing else on the machine will ever
  // rewrite it: upgrading the npm package does not touch /etc/systemd/system.
  // Re-running setup is the one moment a user asks for their configuration to
  // be brought up to date, so it is the moment to do it.
  let daemonUnitStale = daemonAlreadyRunning && daemonServiceNeedsUpgrade();

  if (daemonWanted) {
    // Say what is about to happen. Nothing else.
    //
    // This block explained the warm-worker architecture to somebody who is
    // about to type a password — three lines of mechanism answering a question
    // nobody had. The install is happening either way; what they need is what
    // it is and that it costs one sudo.
    //
    // The BROKEN case keeps its consequence, and only that: "every tool call is
    // denied" is the difference between a thirty-second fix and a support
    // thread, so it survives any further trim of this block.
    stdout.write(
      daemonBroken
        ? "failproofaid can't evaluate — every tool call is denied. Rebuilding needs sudo.\n\n"
        : "Installing failproofaid — needs sudo once.\n\n",
    );
    // `primeElevation` runs `sudo -v`, which PROMPTS. An unattended run has
    // nobody to type a password, so it goes straight to the `sudo -n` that
    // `runPrivileged` uses anyway — exactly what `failproofai update` already
    // does — and a machine that cannot elevate gets the commands below instead
    // of a hung terminal. This is the same answer for both: sudo cannot be
    // conjured away, only asked for at a moment somebody can answer.
    if (!(unattended ? canElevate() : primeElevation())) {
      // Required means required: write nothing at all, so a machine that could
      // not be set up is left exactly as it was found rather than carrying
      // half a configuration. The commands are printed so an admin can do the
      // privileged half by hand.
      stdout.write(
        "\nCould not get root, so setup stopped before changing anything.\n\n" +
          "  Re-run once you can use sudo:   failproofai config\n" +
          `  Check what it needs:            ${daemonStatusCommand() ?? "n/a"}\n\n`,
      );
      void emit("configure_aborted", { reason: "needs_root" });
      outro("Nothing was changed.", { ok: false }, stdout);
      return { applied: false, abort: "needs_root" };
    }
  } else if (daemonUnitStale) {
    stdout.write(
      "failproofaid is running, but from a service definition written by an older\n" +
        "version — it cannot start a scheduled audit. Refreshing it needs root once.\n\n",
    );
    if (!(unattended ? canElevate() : primeElevation())) {
      // NOT an abort, unlike the install branch above. There is a working
      // daemon here and hooks are enforcing; only the scheduled audit is out
      // of reach. Stopping setup over that would make an upgrade the thing
      // that locked someone out of `failproofai config`.
      stdout.write(
        "\nCould not get root, so the service definition was left as it is.\n" +
          "Everything else is set up as normal; scheduled audits stay off until it is\n" +
          `refreshed. Re-run \`failproofai config\` once you can use sudo.\n\n`,
      );
      daemonUnitStale = false;
    }
  } else if (daemonAlreadyRunning) {
    stdout.write("failproofaid is already installed and running — leaving it alone.\n\n");
  }
  if (daemonSkew) {
    stdout.write(
      `failproofaid is ${daemonSkew.installed} but this CLI ships ${daemonSkew.expected} — ` +
        `reinstalling it.\n\n`,
    );
  }

  // 0 — Recommended, or choose everything yourself?
  //
  // ONE linear flow, and no opening fork.
  //
  // Setup used to ask "Recommended or Customize?" before anything else, which
  // is a question about the wizard rather than about the machine — you cannot
  // answer it until you know what the alternatives are, and you only learn that
  // by picking one. Recommended then silently took global scope, the detected
  // CLIs, and fifteen policies nobody had seen.
  //
  // What is left is three questions, in the order the machine needs them:
  // the daemon (already installed above, because it is the only step that needs
  // a password), then which harnesses, then whether to connect. Scope is not
  // among them: it is GLOBAL, always. A project-scoped install guards the one
  // directory the command happened to be run from and silently leaves every
  // other repo on the machine unguarded — `failproofai policies --install
  // --scope project` is still there for someone who genuinely wants that, and
  // knows they do.
  const target: SetupTarget = "user";
  const scopes = scopesFor(target);
  const primaryScope: HookScope = scopes.includes("project") ? "project" : "user";

  // 2 — Which harnesses?
  //
  // Setup no longer asks which policies to enable, and that is deliberate.
  // failproofai ships no policies of its own any more: they arrive as packs —
  // from inside this package (`policies add FailproofAI/policies`) or from anyone's GitHub release.
  // A wizard that pre-ticks OUR list makes a product decision on behalf of
  // somebody who has not seen the list yet, and not everyone wants the set we
  // would have chosen. So setup wires the hooks, and choosing what they
  // enforce is a separate act, taken later and on purpose.
  //
  // Whatever is already enabled at THIS scope is read and carried through
  // untouched. `installHooks` is called with `replace: true`, so passing
  // anything less would switch OFF policies the user had turned on — running
  // setup a second time must never reduce protection.
  const enabledHere = readScopedHooksConfig(primaryScope, cwd).enabledPolicies ?? [];
  const policies = enabledHere;

  // Left alone, in both modes. This was a checkbox on the policy step, which is
  // gone; with no row to read, the only honest value is "do not touch it".
  // Writing `false` here switched off every convention policy on disk as a side
  // effect of finishing setup.
  const customEnabled: boolean | undefined = undefined;

  // An "Everything available" row protects every supported CLI (detected +
  // set-up-ahead); when ticked it wins over the individual boxes.
  //
  // Every supported agent, detected or not — setup asks nothing about this.
  //
  // It used to be the one question left, on the reasoning that which agents to
  // guard is a real choice. It stopped being one when this package stopped
  // shipping policies: hooks alone enforce nothing, so wiring them everywhere
  // costs a config entry and changes no behaviour until a pack arrives. What it
  // buys is that an agent installed NEXT WEEK is guarded from its first tool
  // call, instead of running unguarded until somebody remembers to re-run setup
  // — and nobody remembers, because nothing tells them to.
  //
  // ALL twelve, not the detected ones, for exactly that reason. The cost is
  // honest and worth naming: hook config appears under `~/.cursor/`,
  // `~/.factory/` and the rest for agents that may never be installed.
  //
  // Which policies run, and on which of these agents, is chosen at
  // `failproofai policies add` — where the user is looking at a real list
  // instead of answering in the abstract.
  const clis: IntegrationType[] = [...clisSupportingScope(primaryScope)];

  // 4 — Connect this machine? Last, because by this point the user has decided
  // what to protect, so "would you like to see it in a dashboard?" follows
  // naturally — asking up front interrupts setup with a question about a
  // product they may not have.
  //
  // A pasted API key rather than an interactive sign-in: it is the only form
  // that works on a headless box, in a container or over SSH, and it is the
  // same credential `failproofai config --connect` takes, so a machine set up
  // by the wizard and one set up by hand end up byte-identical on disk.
  //
  // Connecting turns on BOTH streams — policy decisions and session
  // transcripts. That is a real disclosure, not a footnote, so it is stated in
  // the body of the question itself rather than buried in an option hint.
  let connect: { url: string; token: string; machineId: string; machineLabel: string } | null = null;

  {
    // Supplying a key IS asking to connect — there is no other reason to pass
    // one — so an unattended run with a token skips straight past the question,
    // and one without a token stays local, which is the same "Not now" branch a
    // person picks. Neither needs a separate flag to say so.
    const choice = unattended
      ? (answers.token ? "key" : "local")
      : await selectOne<"key" | "local">({
      message: "Connect this machine to FailproofAI Cloud?",
      // The hint says what you GET; the body says what LEAVES.
      //
      // Both have to be here and they are different jobs. "sends decisions +
      // transcripts" described the plumbing, which reads like a data-collection
      // notice rather than a feature — the reason anyone connects is to see
      // what their agents did, so the option says that.
      //
      // The disclosure stays in the BODY rather than moving into the hint,
      // which was the original design and is right: this screen is the only
      // place it is ever made. `describeOutcome` prints "hook activity" after
      // connecting and never mentions transcripts, so a person who does not
      // read it here does not read it at all. One line, not three, and the
      // specific nouns survive — "sessions" alone would not tell anyone their
      // file contents leave the machine.
      //
      // The get-started page, not the dashboard host.
      //
      // `app.befailproof.ai` is only useful to somebody who already has an
      // account, and this line addresses the person who has none — new to the
      // product, so no org either, not merely missing a key. The get-started
      // route walks them through creating both, so it answers the question
      // actually being asked. Naming the product rather than the artefact is
      // what makes it self-selecting: "No key?" reads as an error state to
      // someone who simply has not signed up yet.
      //
      // A marketing route rather than a dashboard one is also the safer thing
      // to hard-code here — it is the URL the site is expected to keep stable,
      // where an in-app path can be reorganised without anyone thinking to
      // update a string compiled into a CLI.
      //
      // The scope is gone from this screen: it is enforced at paste time, where
      // a wrong key is actually caught.
      body: [
        "  Sessions include prompts, file contents and command output.",
        "  New to FailproofAI? Create a key at https://befailproof.ai/get-started/",
      ],
      // Cloud first, and therefore preselected: connecting is what most people
      // running this wizard came to do, and the local path stays one keystroke
      // away. Reversing these two is the whole change — neither option's copy
      // moved, so "stay local" is still stated as plainly as it was.
      choices: [
        {
          // What the cloud gives that this machine does not ALREADY have.
          //
          // "see what your agents did" was wrong: the local dashboard already
          // shows that, so it described something the user gets either way and
          // made connecting look redundant. The cloud's two jobs are a fleet
          // seen in one place and policies deployed to it from there — which is
          // also exactly what the key's two scopes buy (`events:add`,
          // `policies:pull`).
          label: "Paste an API key",
          value: "key",
          hint: "central monitoring · deploy policies from the dashboard",
        },
        {
          // "re-run config", NOT "--connect". That flag exists for scripted,
          // non-interactive setup; pointing a person who just declined at a
          // flag they would have to look up is worse than naming the command
          // they already ran.
          label: "Not now — stay local",
          value: "local",
          hint: "nothing leaves this machine · re-run config to add",
        },
      ],
      stdin,
      stdout,
    });
    if (choice === null) return cancel();

    if (choice === "key") {
      // An already-enrolled machine has a URL and token that usually work.
      // Asking again is the seam that made connecting feel like two products.
      const existing = readCloudCredentials();
      let url: string | null = null;
      let token: string | null = null;
      // Reuse the enrolled id if there is one, else mint a stable key — never
      // the hostname, so two hosts with the same name do not merge. The hostname
      // becomes the human label instead.
      let machineId = resolveMachineId();
      let machineLabel = existing?.machineLabel ?? resolveMachineLabel();

      if (existing && unattended && !answers.url) {
        // Already enrolled, and this run did not name a different place to
        // enrol. Reusing is what the person picks here too, and re-verifying a
        // working credential is the one thing an unattended re-run must not
        // turn into a failure.
        url = existing.url;
        token = answers.token ?? existing.token;
        machineId = answers.machineId ?? existing.machineId;
        machineLabel = answers.machineLabel ?? existing.machineLabel ?? machineLabel;
      } else if (existing && !unattended) {
        const reuse = await selectOne<"reuse" | "other">({
          message: `Use this machine's existing connection to ${existing.url}?`,
          choices: [
            {
              label: "Yes — reuse it",
              value: "reuse",
              hint: `as ${existing.machineLabel ?? existing.machineId}, same token`,
            },
            { label: "No — different endpoint or key", value: "other", hint: "" },
          ],
          stdin,
          stdout,
        });
        if (reuse === null) return cancel();
        if (reuse === "reuse") {
          url = existing.url;
          token = existing.token;
          machineId = existing.machineId;
          machineLabel = existing.machineLabel ?? machineLabel;
        }
      }

      if (url === null) {
        // NOT asked for. There is exactly one right answer for everybody using
        // the hosted product, and asking made it look like a decision — which
        // is how a key ends up pasted into the URL field, and how someone
        // reasonably types the dashboard's own address and gets a 404 from a
        // web app that is not the ingest endpoint. Both are real, both happened
        // within ten minutes of each other, and neither is a mistake the person
        // making it can be expected to avoid: "FailproofAI Cloud URL" has no
        // knowable answer other than the default it was already showing.
        //
        // The two audiences that genuinely need a different endpoint keep an
        // explicit way to say so, and neither is an interactive prompt:
        //
        //   • local development / self-hosting → FAILPROOFAI_CLOUD_URL, the
        //     same variable the DAEMON already reads for cloud-managed policy
        //     (crates/failproofaid/src/cloud_client.rs), so one export points
        //     the whole machine at one place instead of the wizard and the
        //     daemon disagreeing.
        //   • scripted installs → `failproofai config --connect <url> --token`,
        //     unchanged.
        //
        // The env value goes through the SAME `validateCloudUrl` a typed one
        // did — it is not a trusted back door. http stays loopback-only, so a
        // bearer token still cannot be exported onto the wire in clear by
        // setting a variable.
        const override = process.env.FAILPROOFAI_CLOUD_URL?.trim();
        if (override) {
          const validated = validateCloudUrl(cloudBaseFor(override));
          if (!validated.ok) {
            // Loud, not silent-fallback-to-hosted: someone who exported this
            // wants THAT endpoint, and quietly reporting a machine to the
            // hosted service instead is the one outcome they did not ask for.
            stdout.write(
              `\nFAILPROOFAI_CLOUD_URL is set to "${override}", which cannot be used: ` +
                `${validated.reason}\n`,
            );
            return cancel();
          }
          url = validated.url;
          // Named on screen, because an env var is invisible at the moment it
          // matters and a machine reporting somewhere unexpected is exactly the
          // thing nobody notices until they go looking for data that is not
          // there.
          stdout.write(`\nUsing ${url} (from FAILPROOFAI_CLOUD_URL).\n`);
        } else {
          url = cloudBaseFor(DEFAULT_INGEST_URL);
        }
      }

      if (token === null && unattended) {
        // Supplied on the command line, so nothing is asked and nothing is
        // echoed. Reaching here without one cannot happen — an unattended run
        // only takes the "key" branch BECAUSE a token was given.
        token = answers.token ?? null;
      }
      if (token === null) {
        token = await promptText({
          // The destination is in the question now that it is no longer a
          // question of its own. It is the only remaining place a person can
          // notice they are about to send a key somewhere they did not mean.
          message: `API key for ${new URL(url).host}`,
          hint: "needs events:add · policies:pull enables managed policy too",
          // Masked: setup is routinely run while screen-sharing, and a pasted
          // key would otherwise sit in the scrollback of every recording.
          mask: true,
          validate: (v) => (v.length >= 8 ? null : "that looks too short to be a key"),
          stdin,
          stdout,
        });
        if (token === null) return cancel();
      }

      // Check BEFORE the review screen, so a typo is caught while the user is
      // still thinking about credentials rather than three screens later. The
      // apply step re-verifies and is what actually writes — nothing is
      // persisted here.
      stdout.write("\nChecking the key… ");
      const probe = await validateIngestKey({ url: ingestUrlFor(url), key: token });
      if (!probe.ok && unattended) {
        // A key that does not work is a FAILED setup, not a prompt. The
        // interactive path offers "save it anyway" because a person can weigh
        // an outage against their own impatience; a script cannot, and one that
        // exited 0 here would leave a fleet believing it was reporting.
        stdout.write(`\nThat key did not work: ${probe.reason}\n`);
        return { applied: false, abort: "cloud_unverified" };
      }
      if (!probe.ok) {
        stdout.write(`\nThat did not work: ${probe.reason}\n`);
        const retry = await selectOne<"skip" | "anyway">({
          message: "Carry on without connecting?",
          choices: [
            { label: "Yes, skip it", value: "skip", hint: "everything else still applies" },
            { label: "Save it anyway", value: "anyway", hint: "if you know the server is just down" },
          ],
          stdin,
          stdout,
        });
        if (retry === null) return cancel();
        if (retry === "skip") {
          stdout.write("Staying local. Connect later with `failproofai config --connect`.\n\n");
        } else {
          connect = { url, token, machineId, machineLabel };
        }
      } else {
        stdout.write("looks good.\n\n");
        connect = { url, token, machineId, machineLabel };
      }
    }
  }
  // 5 — Review & apply
  //
  // The last question, and the only one a headless run skips outright rather
  // than answering from a flag. There is nothing to confirm when nobody is
  // watching, and the command itself was the confirmation.
  //
  // NOT the same call as `uninstall`, which does require --yes: that one
  // REMOVES things, so silence there would destroy on a signal as weak as a
  // missing terminal. This one does exactly what its name says.
  const decision = unattended ? "apply" : await selectOne<"apply" | "cancel">({
    message: "Ready to apply?",
    body: reviewLines({
      target,
      clis,
      policies,
      cwd,
      customEnabled,
      // A stale-unit refresh rewrites the service file and restarts the
      // daemon, so it belongs on the list of things this run is about to
      // change. Leaving it off would make the confirmation screen of a
      // security tool quietly incomplete about a root-owned file.
      installDaemon: daemonWanted || daemonUnitStale,
      connect: connect !== null,
    }),
    choices: [
      { label: "Yes, apply now", value: "apply", hint: "write the config" },
      { label: "Cancel", value: "cancel", hint: "quit, no changes" },
    ],
    stdin,
    stdout,
  });
  if (decision !== "apply") return cancel();

  // ── Apply ─────────────────────────────────────────────────────────────────
  //
  // ORDER MATTERS. The daemon goes first, because setup requires it: if it
  // cannot be installed, this run must leave the machine exactly as it found
  // it rather than half-configured. Writing hooks first and discovering the
  // service will not start afterwards is the one ordering whose failure cannot
  // be undone cleanly — hooks would already be live, pointing at a machine
  // whose `daemonConfigured` flag we then could not honestly set.
  let daemonInstalled = daemonAlreadyRunning;
  if (daemonWanted) {
    // A unit that is running but cannot answer is torn down before it is
    // rebuilt, rather than installed over. Its `ExecStart` points at a binary
    // or interpreter that no longer works, and it holds the singleton flock
    // the replacement needs — install over the top and the new unit starts,
    // loses the lock race, and the machine stays exactly as broken. This is
    // the production path for `uninstallDaemonService`, which until now had
    // none: it was defined, tested, documented in CLAUDE.md as called from
    // here, and referenced by nothing.
    if (daemonBroken) {
      stdout.write("Removing the failproofaid service that cannot start…\n");
      try {
        await uninstallDaemonService();
      } catch (err) {
        // Non-fatal: the install below reports its own outcome, and it is that
        // outcome — not this one — that decides whether setup continues.
        hookLogWarn(
          `could not remove the broken failproofaid service: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    stdout.write(daemonBroken ? "Reinstalling the failproofaid service…\n" : "Installing the failproofaid service…\n");
    const daemonResult = await installDaemonService();
    void emit("configure_daemon_install", {
      installed: daemonResult.installed,
      // A bounded classification, never the raw reason: on the failure path
      // that string is an errno message from writeFileSync/execFileSync
      // against a homedir()-derived path, so it routinely carries the OS
      // username and the local filesystem layout. The full text stays local
      // via the hookLogWarn below.
      reason: daemonResult.installed ? null : classifyDaemonInstallFailure(daemonResult.reason),
      platform: process.platform,
    });

    if (!daemonResult.installed) {
      hookLogWarn(`failproofaid was not installed as a service: ${daemonResult.reason}`);
      // Nothing user-facing has been written yet, so there is nothing to roll
      // back — which is the entire reason this runs first.
      stdout.write(
        `\nThe failproofaid service could not be installed:\n  ${daemonResult.reason ?? "unknown error"}\n\n` +
          "Setup stopped before changing anything. Once that is fixed, re-run:\n" +
          "  failproofai config\n\n",
      );
      void emit("configure_aborted", { reason: "daemon_failed" });
      outro("Nothing was changed.", { ok: false }, stdout);
      return { applied: false, abort: "daemon_failed" };
    }

    // Installed and running is the service manager's opinion, and it is not
    // what setup needs to know. `ExecStart` bakes in `process.execPath` and an
    // absolute `dist/worker.mjs`, so a unit can be perfectly active while the
    // worker behind it dies on every spawn — and every other check waves that
    // machine through: `waitForDaemonRunning()` asks systemd, `Ping` is
    // answered in `server.rs` without touching the worker, a null
    // `resolveWorkerCommand()` is best-effort, and `Worker::warm()` swallows
    // its own failure. Setting `daemonConfigured` against it denies every tool
    // call across all twelve CLIs, `UserPromptSubmit` included, so the user
    // cannot even ask their agent why.
    //
    // Checked HERE rather than inside `installDaemonService`, which can only
    // honestly report on the service: keeping them apart is also what lets the
    // install mechanics be tested against a stub binary.
    const probe = await probeDaemon();
    if (!probe.ok) {
      hookLogWarn(
        `failproofaid was installed and running but did not answer a policy evaluation (${probe.reason})`,
      );
      // Two different faults, two different things to go and look at. Saying
      // "your worker will not start" at a machine whose socket simply never
      // came up sends someone to inspect a process that is fine.
      stdout.write(
        (probe.reason === "worker"
          ? "\nfailproofaid started but cannot evaluate policies — it is listening, and\n" +
            "its worker process could not be run.\n"
          : "\nfailproofaid started but could not be reached on its socket.\n") +
          "Setup stopped before changing anything, because a machine configured to\n" +
          "require a daemon that cannot answer denies every tool call.\n\n" +
          `  Check it with:  ${daemonStatusCommand() ?? "systemctl status failproofaid"}\n` +
          "  Then re-run:    failproofai config\n\n",
      );
      void emit("configure_aborted", { reason: `daemon_not_answering_${probe.reason}` });
      outro("Nothing was changed.", { ok: false }, stdout);
      return { applied: false, abort: "daemon_failed" };
    }
    daemonInstalled = true;
  } else if (daemonUnitStale) {
    // Deliberately after the install branch and never instead of it: this only
    // ever runs on a machine whose daemon is already up, and it must not be
    // able to abort a setup that is otherwise fine. A failure here costs the
    // scheduled audit, nothing else.
    stdout.write("Refreshing the failproofaid service definition…\n");
    const upgrade = await ensureDaemonServiceCurrent();
    void emit("configure_daemon_unit_refresh", {
      outcome: upgrade.outcome,
      daemon_running: upgrade.daemonRunning ?? true,
      platform: process.platform,
    });
    if (upgrade.outcome === "failed") {
      hookLogWarn(`failproofaid service definition could not be refreshed: ${upgrade.reason}`);
      if (upgrade.daemonRunning === false) {
        // The refresh stopped a daemon it could not start again, and its own
        // rollback could not either. Explicitly `=== false`: every failure
        // that never touched the service leaves this undefined, and those must
        // not drag a healthy machine down this branch.
        //
        // Leaving `daemonConfigured` set here is not "the audit stays off", it
        // is every tool call across all 12 CLIs denied against a socket
        // nothing is listening on, recoverable only by hand-editing
        // policies-config.json. So the machine goes back to in-process
        // evaluation — the same trade uninstallDaemonService makes, and for
        // the same reason.
        daemonInstalled = false;
        setDaemonConfigured(false);
        stdout.write(
          `\nThe service definition could not be refreshed:\n  ${upgrade.reason ?? "unknown error"}\n` +
            "failproofaid is no longer running, so this machine was switched back to\n" +
            "in-process evaluation rather than left denying every tool call. Hooks keep\n" +
            "enforcing. Re-run `failproofai config` to reinstall the service.\n\n",
        );
      } else {
        stdout.write(
          `\nThe service definition could not be refreshed:\n  ${upgrade.reason ?? "unknown error"}\n` +
            "Hooks keep enforcing; scheduled audits stay off until it is.\n\n",
        );
      }
    }
  }

  // The flag that makes hooks route through the daemon — and, on a machine
  // where the daemon is unreachable, fail closed. Only ever set after a
  // verified-running service, never on intent.
  // The version is recorded HERE, from the CLI that installed it — which is by
  // construction the version that was installed, since the download URL and the
  // binary filename are both derived from it.
  if (daemonInstalled) {
    setDaemonConfigured(true, cliVersion);
    // Only now — the unit points at the new binary, so older ones are no
    // longer referenced by anything. Keeps the previous version for an
    // offline rollback.
    pruneOldDaemonBinaries();
  }

  // Telemetry runs concurrently with the install (never rejects, 5s-bounded) so
  // it doesn't add dead time between "apply" and the config actually writing,
  // while still being awaited before the process can exit.
  const applied = emit("configure_applied", {
    target,
    scopes,
    cli: clis,
    cli_count: clis.length,
    policy_count: policies.length,
    connected: connect !== null,
  });

  // One install per chosen scope, with the CLI list narrowed to what THAT
  // scope can take.
  //
  // The comment here used to claim `installHooks` "already skips CLIs a given
  // scope cannot take". It does not — `installHooksImpl` validates every CLI
  // against the scope up front and THROWS `Scope "project" is not supported by
  // Hermes`. `clis` is the union across scopes (deliberately, so a user-scope-
  // only gateway is still installed via the user half), so under "Both" +
  // "Everything available" the project pass got handed hermes/openclaw and
  // died. Nothing catches it, and by then the daemon is installed,
  // `daemonConfigured` is set and user-scope hooks are written — so the run
  // aborted mid-apply, before any project config or the pasted cloud key.
  // `configure-wizard.test.ts` mocks `installHooks` wholesale, which is why the
  // real validation path was never exercised.
  //
  // quiet: the wizard renders its own outro; replace: the chosen set becomes
  // the full enabled set at that scope (unticking removes).
  for (const scope of scopes) {
    const supportedHere = new Set(clisSupportingScope(scope));
    const clisForScope = clis.filter((id) => supportedHere.has(id));
    if (clisForScope.length > 0) {
      await installHooks(
        policies,
        scope,
        cwd,
        /* includeBeta */ false,
        "configure-wizard",
        /* customPoliciesPath */ undefined,
        /* removeCustomHooks */ false,
        clisForScope,
        { replace: true, quiet: true },
      );
    }
    setCustomPoliciesEnabled(scope, cwd, customEnabled);
  }

  // Cloud connection, written after the daemon exists — the daemon is what
  // runs the collector, so a credential written for a service that is not
  // there would be a key on disk doing nothing.
  //
  // `connectToCloud` re-verifies each capability and writes only what actually
  // works, so a key revoked between the earlier probe and here degrades to a
  // reported partial rather than a connection this machine does not have.
  let connected = false;
  if (connect) {
    try {
      const outcome = await connectToCloud({
        url: connect.url,
        token: connect.token,
        machineId: connect.machineId,
        machineLabel: connect.machineLabel,
        // Both streams, as disclosed at the connect question. This is the one
        // place that decision becomes a written setting.
        sessions: true,
      });
      connected = outcome.anyConfigured;
      // Show the human label with the id in parentheses when they differ.
      const shownAs =
        connect.machineLabel === connect.machineId
          ? connect.machineId
          : `${connect.machineLabel} (${connect.machineId})`;
      for (const line of describeOutcome(outcome, shownAs, connect.url)) {
        stdout.write(`${line}\n`);
      }
      // Never the key, the URL, or the count — only that it happened and which
      // capabilities the server actually granted.
      void emit("configure_connect", {
        policy_ok: outcome.policy.ok,
        ingest_ok: outcome.ingest.ok,
      });
    } catch (err) {
      // Non-fatal, unlike the daemon: enforcement does not depend on the
      // dashboard, and a machine with no connection behaves exactly as every
      // release before this one did.
      hookLogWarn(
        `cloud connection was not written: ${err instanceof Error ? err.message : String(err)}`,
      );
      stdout.write("\nCould not connect — everything else applied. Retry with `failproofai config --connect`.\n");
    }
  }

  await applied;
  // Only now — a completed apply — is the launcher considered "seen", so
  // first-run onboarding stops offering itself on every command.
  markLauncherSeen();
  // And any record of an earlier failure is now false: this machine got set up.
  clearOnboardingAttempt();

  // Every real completed setup is on a supported platform now (an unsupported
  // one aborts before this point), so the optional notes in the summary below
  // are no longer occasional additions — see buildCompletionSummary's own doc
  // comment for why the widest combination still fits in 80 columns.
  outro(
    buildCompletionSummary(
      policies.length,
      clis.length,
      customEnabled,
      daemonInstalled,
      connected,
    ),
    { ok: true },
    stdout,
  );
  // Setup wires the hooks and deliberately chooses NO policies, so a machine
  // that has just finished it enforces almost nothing — and the summary line
  // says "0 policies" without saying what to do about it. Anyone else's pack is
  // typed the same way, which is the point: ours is named in full rather than
  // by a short name only we could use.
  if (policies.length === 0) {
    stdout.write(
      `\n  Nothing is enforcing yet. Take ours, or anyone's:\n` +
        `    failproofai policies add ${CORE_SOURCE}\n` +
        `    failproofai policies show <owner>/<repo>   (look first)\n\n`,
    );
  }
  return {
    applied: true,
    target,
    scopes,
    clis,
    policies,
    daemonInstalled,
    connected,
  };
}
