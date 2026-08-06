/**
 * `failproofai config` — the interactive setup launcher.
 *
 * A single guided flow that sets up the whole failproofai ecosystem:
 *
 *   0. Daemon    — REQUIRED. Asks for sudo first, on a clean terminal.
 *   1. Where     — inferred from cwd, then confirmed (global / project / both)
 *   2. Policies  — multi-select of themed presets (combine any) or Everything
 *   3. Assistants— multi-select of agent CLIs (detected + install-ahead)
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

import {
  selectOne,
  multiSelect,
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
  writeIngestCredential,
  writeCollectorSettings,
} from "./collector-config";
import {
  detectInstalledClis,
  getIntegration,
  settingsPathsFor,
  unhookedHermesProfiles,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { installHooks } from "./manager";
import { getConfigPathForScope, readHooksConfig } from "./hooks-config";
import { POLICY_PRESETS, resolvePreset, resolveEverything } from "./policy-presets";
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
  reloadDaemonAfterConfigChange,
} from "./daemon-service";
import { hookLogWarn } from "./hook-logger";
import {
  readCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
  verifyCloudCredentials,
  writeCloudCredentials,
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
  buildTargetChoices,
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
 * Why a wizard run ended without applying. Distinguished so the caller can
 * pick an exit code — a user who pressed Esc did nothing wrong (exit 0), a
 * machine that could not install the required daemon did not get set up
 * (exit 1), and a fleet script needs to tell those apart.
 */
export type WizardAbort =
  | "cancelled"
  | "needs_root"
  | "daemon_failed"
  | "not_a_tty"
  | "running_as_sudo";

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

const EVERYTHING = "__everything__";
const ALL_CLIS = "__all_clis__";
/** Sentinel for the locked "Custom" row — informational, never resolves to
 *  builtin policy names (custom policies load by convention, not by config). */
const CUSTOM = "__custom__";

/** The themed preset bundles for the wizard's multi-select, plus an "Everything"
 *  option that enables the full builtin policy set. */
export function buildPresetChoices(cwd: string = process.cwd(), enabled = true) {
  const choices: MultiChoice<string>[] = POLICY_PRESETS.map((p) => ({
    label: p.label,
    value: p.id,
    hint: p.description,
  }));
  choices.push({
    label: "Everything",
    value: EVERYTHING,
    hint: `all ${resolveEverything().length} policies`,
  });

  // The Custom row is ALWAYS present, because it is the only place the feature
  // is discoverable: a user who has never written a policy cannot learn the
  // capability exists, and one who wrote a badly-named file cannot learn why
  // nothing happened.
  //
  // When there are loadable files it is a REAL checkbox — unticking writes
  // `customPoliciesEnabled: false`, which switches convention discovery off
  // without renaming or deleting anything. With nothing to toggle (no files,
  // or only skipped ones) it falls back to a locked status row.
  const custom = describeCustomPolicies(cwd);
  const skipped = custom.warnings.length;
  const plural = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const skippedNote = skipped > 0 ? ` · ${skipped} skipped, see next screen` : "";

  if (custom.fileCount > 0) {
    choices.push({
      label: "Custom",
      value: CUSTOM,
      checked: enabled,
      // Deliberately NOT summaryExclude'd: this one is a real choice, and the
      // step summary is the only place the user sees what they picked. Hiding
      // it meant unticking Custom and every bundle showed "none", giving no
      // way to tell the toggle had registered.
      hint: `${plural(custom.fileCount)} in ${custom.scopes.join(" + ")}${skippedNote}`,
    });
  } else {
    choices.push({
      label: "Custom",
      value: CUSTOM,
      locked: true,
      checked: false,
      summaryExclude: true,
      hint:
        skipped > 0
          ? `${plural(skipped)} found but NOT loaded — see next screen`
          : "none yet · drop *-policies.mjs in .failproofai/policies/",
    });
  }
  return choices;
}

/**
 * Resolve the ticked options to a concrete policy set. Presets are additive —
 * the deduped union of every selected preset's policies — while "Everything"
 * enables the full policy set and wins over any presets.
 */
export function resolvePresetSelection(values: string[]): string[] {
  // The Custom row is informational — custom policies are discovered from disk
  // by the loader, never named in the enabled-policies config — so it must not
  // reach resolvePreset(), which only knows builtin bundle ids.
  const selected = values.filter((v) => v !== CUSTOM);
  if (selected.includes(EVERYTHING)) return resolveEverything();
  return [...new Set(selected.flatMap((id) => resolvePreset(id)))];
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
  const assistantNames = clis.map((c) => getIntegration(c).displayName);
  lines.push(`  Where      : ${where}`);
  lines.push(`  Assistants : ${assistantNames.length ? summarize(assistantNames, "assistants") : "(none)"}`);
  // Zero is a deliberate answer, not a failed step — say so, and say where to
  // change it, so the review screen doesn't read like the wizard lost the
  // selection. Hooks still install; only the builtin set is empty.
  lines.push(
    policies.length === 0
      ? "  Policies   : none enabled (add later: failproofai policies --install)"
      : `  Policies   : ${policies.length} enabled`,
  );
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

export async function runConfigureWizard(io: WizardIO = {}): Promise<WizardResult> {
  const stdin: TTYIn = io.stdin ?? process.stdin;
  const stdout: TTYOut = io.stdout ?? process.stdout;
  const cwd = process.cwd();

  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(
      "failproofai config needs an interactive terminal.\n" +
        "Use the flag form instead, e.g.:\n" +
        "  failproofai policies --install --scope user --cli claude\n",
    );
    return { applied: false };
  }

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
    return { applied: false };
  }

  // Fire-and-forget: never block the wizard's first paint on telemetry.
  void emit("configure_started", {});
  intro("let's set up your safety net", stdout);

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
  // On a platform with no service manager there is nothing to install, so the
  // requirement does not apply — requiring an impossible step would lock those
  // users out of setup entirely rather than protecting anything.
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
  // every tool call with no route back but hand-editing `config.toml`. A real
  // hook evaluation is the only check that distinguishes the two.
  const daemonSkew = daemonSupported ? daemonVersionSkew() : null;
  const daemonUpToDate =
    daemonSupported && daemonServiceStatus() === "running" && daemonSkew === null;
  const daemonAnswers = daemonUpToDate ? await probeDaemonEndToEnd() : false;
  const daemonAlreadyRunning = daemonUpToDate && daemonAnswers;
  /** Installed and running, but its worker cannot evaluate anything. */
  const daemonBroken = daemonUpToDate && !daemonAnswers;
  let daemonWanted = daemonSupported && !daemonAlreadyRunning;
  // A healthy daemon can still be running a service definition written before
  // FAILPROOFAI_CLI_CMD existed, and nothing else on the machine will ever
  // rewrite it: upgrading the npm package does not touch /etc/systemd/system.
  // Re-running setup is the one moment a user asks for their configuration to
  // be brought up to date, so it is the moment to do it.
  let daemonUnitStale = daemonAlreadyRunning && daemonServiceNeedsUpgrade();

  if (daemonWanted) {
    stdout.write(
      daemonBroken
        ? "failproofaid is installed and running but cannot evaluate policies — its worker\n" +
            "process will not start, which on this machine denies every tool call. Rebuilding\n" +
            "the service needs root once. Your password goes to sudo, never to us.\n\n"
        : "failproofai runs a small background service (failproofaid) so policy checks\n" +
            "stay warm — without it every tool call pays a fresh startup, about 15x slower.\n" +
            "Installing it needs root once. Your password goes to sudo, never to us.\n\n",
    );
    if (!primeElevation()) {
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
    if (!primeElevation()) {
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

  // 1 — Where? Inferred from cwd, then confirmed.
  //
  // Running from inside a project and running from a home directory are two
  // different intents, and asking a context-free "global or project?" made the
  // user restate something they had already expressed by choosing where to run
  // the command. So the choices are built from what actually exists here — and
  // labelled Update vs Set up accordingly — with the likelier target first.
  const setupState = detectSetupState(cwd);
  const targetChoices = buildTargetChoices(setupState);

  let target: SetupTarget;
  if (targetChoices.length === 1) {
    // From a home directory there is no project to configure, so there is no
    // question to ask. Say what is about to happen rather than silently
    // deciding it.
    target = targetChoices[0].value;
    stdout.write(`Configuring ${targetChoices[0].label.toLowerCase()} — ${targetChoices[0].hint}.\n\n`);
  } else {
    const chosen = await selectOne<SetupTarget>({
      message: "What are we configuring?",
      choices: targetChoices.map((c) => ({
        label: c.label,
        value: c.value,
        hint: c.hint,
      })),
      stdin,
      stdout,
    });
    if (chosen === null) return cancel();
    target = chosen;
  }
  const scopes = scopesFor(target);
  // The scope whose CURRENT state seeds the pickers below. With "Both" the
  // project is the more specific of the two and the one the user is standing
  // in, so it wins; anything it does not define still falls back to global at
  // merge time, which is exactly the layering the policy loader already does.
  const primaryScope: HookScope = scopes.includes("project") ? "project" : "user";

  // 2 — Which policies? Multi-select of themed presets — additive, so the
  // enabled set is the union of every ticked bundle.
  //
  // Before the assistants step, because "what do you want guarded" is the
  // question the user came here to answer; which CLIs to wire it into is
  // plumbing that follows from it.
  //
  // Seed the Custom checkbox from whatever the config already says, so the
  // wizard shows the current state rather than resetting it every run.
  const customEnabledBefore = readHooksConfig().customPoliciesEnabled !== false;
  const presetChoices = buildPresetChoices(cwd, customEnabledBefore);
  const hasCustomFiles = describeCustomPolicies(cwd).fileCount > 0;

  // No minimum. Ticking nothing is a real answer — someone who only wants their
  // own custom policies, or who intends to pick bundles later from the
  // dashboard, was previously stuck on this step with no way forward and no
  // explanation beyond "Select at least 1". An empty set is already supported
  // end to end: `installHooksImpl` documents its explicit-array path as "may be
  // empty", `replace: true` makes it the full enabled set, and `summarize([])`
  // renders "none". Hooks still install, so enforcement can be switched on
  // later without re-running setup.
  //
  // The assistants step below keeps its minimum deliberately: an empty CLI list
  // does NOT mean "no assistants" there — `installHooksImpl` falls back to
  // ["claude"], so letting it through would silently install for Claude.
  const presets = await multiSelect<string>({
    message: "What should we guard against?",
    choices: presetChoices,
    summaryNoun: "bundles",
    hint: "space toggles · combine presets · ↵ confirm · none is fine",
    stdin,
    stdout,
  });
  if (presets === null) return cancel();
  const policies = resolvePresetSelection(presets);
  // Only meaningful when there are files to switch off; with none, the row is
  // locked-unchecked and must not write a disabling flag.
  const customEnabled = hasCustomFiles ? presets.includes(CUSTOM) : undefined;

  // 3 — Which assistants? An "Everything available" row protects every supported
  // CLI (detected + set-up-ahead); when ticked it wins over the individual boxes.
  const clisSel = await multiSelect<string>({
    message: "Which AI assistants should it protect?",
    choices: [
      {
        label: "Everything available",
        value: ALL_CLIS,
        // Counts only what this scope can actually take — expanding to all 12
        // under project scope is what crashed the apply on Hermes.
        hint: `protect all ${clisSupportingScope(primaryScope).length} CLIs configurable here`,
        // A selector, not an assistant. Counting it gave "13 assistants" for
        // the 12 supported CLIs, and listed "Everything available" among them.
        summaryExclude: true,
      },
      ...buildAgentChoices(primaryScope, cwd),
    ],
    minSelected: 1,
    summaryNoun: "assistants",
    hint: "detected CLIs are pre-selected · space toggles · ctrl+a all · ↵ confirm",
    stdin,
    stdout,
  });
  if (clisSel === null) return cancel();
  // Filter to what the chosen scopes support in BOTH branches: "Everything
  // available" must not expand to CLIs that cannot take any selected scope,
  // and a locked row can't be ticked but belt-and-braces keeps the invariant
  // local to the one place `clis` is built.
  //
  // The union across scopes, not the intersection: under "Both", a user-scope-
  // only gateway like Hermes is still installable via the user half, and
  // dropping it because project scope cannot take it would silently protect
  // less than the user asked for. `installHooks` is called per scope below and
  // skips what a given scope cannot take.
  const supported = new Set(scopes.flatMap((s) => clisSupportingScope(s)));
  const clis: IntegrationType[] = (
    clisSel.includes(ALL_CLIS)
      ? [...INTEGRATION_TYPES]
      : (clisSel.filter((v) => v !== ALL_CLIS) as IntegrationType[])
  ).filter((id) => supported.has(id));

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
    const choice = await selectOne<"key" | "local">({
      message: "Connect this machine to Failproof Cloud?",
      body: [
        "  Connecting reports this machine's policy decisions AND full session",
        "  transcripts — prompts, file contents and command output — to your",
        "  dashboard. Staying local sends nothing, anywhere, ever.",
      ],
      choices: [
        {
          label: "Not now — stay local",
          value: "local",
          hint: "policies still enforce · connect later with failproofai config --connect",
        },
        {
          label: "Paste an API key",
          value: "key",
          hint: "reports decisions and transcripts to your dashboard",
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

      if (existing) {
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
        // making it can be expected to avoid: "Failproof Cloud URL" has no
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
  const decision = await selectOne<"apply" | "cancel">({
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
    source: presets.join("+"),
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

  // Make the RUNNING daemon match what was just written.
  //
  // The collector reads its credential once, at start, and caches the bearer
  // key — config is re-read on a 5s tick but the credential is not. So a wizard
  // run that rotates a key leaves the file correct and the process posting the
  // old one: every batch 401s and parks, while the wizard has just verified the
  // NEW key itself and reported success. Nothing a person can see says
  // otherwise; the only symptom is data that never arrives.
  //
  // Only when something the daemon reads actually changed. A run that only
  // touched policy selection has nothing to reload, and a restart costs a short
  // window in which a fail-closed machine denies tool calls — not a price to
  // pay for nothing.
  if (connected) {
    const reload = await reloadDaemonAfterConfigChange();
    if (reload.reloaded) {
      stdout.write("Restarted failproofaid so it uses this connection now.\n");
    } else if (reload.reason !== "no-service" && reload.reason !== "not-running") {
      stdout.write(
        `failproofaid could not be restarted, so it is STILL USING ITS PREVIOUS\n` +
          `credential and will reject what it queues. Run:\n  ${reload.command}\n`,
      );
    }
  }

  // Only now — a completed apply — is the launcher considered "seen", so
  // first-run onboarding stops offering itself on every command.
  markLauncherSeen();
  // And any record of an earlier failure is now false: this machine got set up.
  clearOnboardingAttempt();

  // Keep this inside a standard 80-column terminal. `writeLines` truncates with
  // a hard cut and no ellipsis, so an over-long line doesn't just lose its tail
  // — it reads as broken output. Naming all ten CLIs took it to 182 characters;
  // the count alone carries the same information, and the user picked them two
  // screens ago.
  const customNote =
    customEnabled === true
      ? " + your custom policies"
      : customEnabled === false
        ? " · custom policies DISABLED"
        : "";
  const daemonNote = daemonInstalled ? " · daemon on" : "";
  const cloudNote = connected ? " · reporting on" : "";
  const assistants = `${clis.length} assistant${clis.length === 1 ? "" : "s"}`;
  outro(
    `Setup complete — ${policies.length} policies${customNote} · ${assistants}${daemonNote}${cloudNote}`,
    { ok: true },
    stdout,
  );
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
