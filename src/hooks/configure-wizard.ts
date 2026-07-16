/**
 * `failproofai config` — the interactive setup launcher.
 *
 * A single guided flow that sets up the whole failproofai ecosystem, hiding the
 * scope / cli / two-layer machinery behind three plain questions:
 *   1. Where?      global (user) vs this project
 *   2. Assistants? multi-select of agent CLIs (detected + install-ahead)
 *   3. Policies?   multi-select of themed presets (combine any) or Everything
 * …then a Review screen that shows exactly which files change, and Apply.
 *
 * Selections REPLACE the enabled set at the chosen scope (the picker pre-checks
 * whatever is already enabled, so unticking removes). Reuses the tested
 * install/uninstall manager and the existing searchable policy picker.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import { selectOne, multiSelect, intro, outro, summarize, type TTYIn, type TTYOut } from "./tui";
import {
  detectInstalledClis,
  getIntegration,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { installHooks } from "./manager";
import { getConfigPathForScope } from "./hooks-config";
import { POLICY_PRESETS, resolvePreset, resolveEverything } from "./policy-presets";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

export interface WizardIO {
  stdin?: TTYIn;
  stdout?: TTYOut;
}

export interface WizardResult {
  applied: boolean;
  scope?: HookScope;
  clis?: IntegrationType[];
  policies?: string[];
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

export function buildScopeChoices(cwd: string) {
  return [
    {
      label: "Everywhere I code",
      value: "user" as HookScope,
      hint: "global · applies in every project on this machine",
    },
    {
      label: "Just this project",
      value: "project" as HookScope,
      hint: homeify(cwd),
    },
  ];
}

export function buildAgentChoices(scope: HookScope, cwd: string) {
  const detected = new Set(detectInstalledClis());
  // Detected first, then the rest as "install ahead of time".
  const ordered = [
    ...INTEGRATION_TYPES.filter((id) => detected.has(id)),
    ...INTEGRATION_TYPES.filter((id) => !detected.has(id)),
  ];
  return ordered.map((id) => {
    const integration = getIntegration(id);
    const isDetected = detected.has(id);
    let installedHere = false;
    try {
      installedHere = integration.hooksInstalledInSettings(scope, cwd);
    } catch {
      installedHere = false;
    }
    return {
      label: integration.displayName,
      value: id,
      checked: isDetected || installedHere,
      section: isDetected ? "Detected" : "Not installed · set up ahead of time",
      hint: installedHere ? "already configured" : isDetected ? undefined : "not on PATH",
    };
  });
}

const EVERYTHING = "__everything__";
const ALL_CLIS = "__all_clis__";

/** The themed preset bundles for the wizard's multi-select, plus an "Everything"
 *  option that enables the full builtin policy set. */
export function buildPresetChoices() {
  const choices: Array<{ label: string; value: string; hint: string }> = POLICY_PRESETS.map(
    (p) => ({ label: p.label, value: p.id, hint: p.description }),
  );
  choices.push({
    label: "Everything",
    value: EVERYTHING,
    hint: `all ${resolveEverything().length} policies`,
  });
  return choices;
}

/**
 * Resolve the ticked options to a concrete policy set. Presets are additive —
 * the deduped union of every selected preset's policies — while "Everything"
 * enables the full policy set and wins over any presets.
 */
export function resolvePresetSelection(values: string[]): string[] {
  if (values.includes(EVERYTHING)) return resolveEverything();
  return [...new Set(values.flatMap((id) => resolvePreset(id)))];
}

export function reviewLines(
  state: { scope: HookScope; clis: IntegrationType[]; policies: string[]; cwd: string },
): string[] {
  const { scope, clis, policies, cwd } = state;
  const where =
    scope === "project" ? `This project (${homeify(cwd)})` : "Everywhere (global)";
  const lines: string[] = [];
  const assistantNames = clis.map((c) => getIntegration(c).displayName);
  lines.push(`  Where      : ${where}`);
  lines.push(`  Assistants : ${assistantNames.length ? summarize(assistantNames, "assistants") : "(none)"}`);
  lines.push(`  Policies   : ${policies.length} enabled`);
  lines.push("");
  lines.push("  This will update:");
  for (const cli of clis) {
    const integration = getIntegration(cli);
    lines.push(`    ${homeify(integration.getSettingsPath(scope, cwd))}   ${integration.displayName} hooks`);
  }
  lines.push(`    ${homeify(getConfigPathForScope(scope, cwd))}   ${policies.length} policies`);
  return lines;
}

// ── First-run redirect ───────────────────────────────────────────────────────

function firstRunMarkerPath(): string {
  return resolve(homedir(), ".failproofai", ".launcher-configured");
}

export function hasSeenLauncher(): boolean {
  return existsSync(firstRunMarkerPath());
}

export function markLauncherSeen(): void {
  try {
    mkdirSync(resolve(homedir(), ".failproofai"), { recursive: true });
    writeFileSync(firstRunMarkerPath(), "1", "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Whether failproofai is already set up GLOBALLY (user scope) for any agent.
 * Deliberately ignores project scope: project-scoped hooks in whatever repo the
 * user happens to be in shouldn't suppress the one-time global welcome. The
 * marker file is the primary "seen" gate; this is the "already set up" shortcut.
 */
function anyHooksInstalledGlobally(): boolean {
  for (const id of INTEGRATION_TYPES) {
    try {
      if (getIntegration(id).hooksInstalledInSettings("user")) return true;
    } catch {
      // ignore broken settings files
    }
  }
  return false;
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
export async function maybeFirstRunConfigure(io: WizardIO = {}): Promise<boolean> {
  if (process.env.FAILPROOFAI_NO_FIRST_RUN === "1") return false;
  if (hasSeenLauncher()) return false;

  const stdin: TTYIn = io.stdin ?? process.stdin;
  const stdout: TTYOut = io.stdout ?? process.stdout;

  if (anyHooksInstalledGlobally()) {
    markLauncherSeen();
    return false;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(
      `\n[failproofai] Not set up yet — run \`failproofai config\` to get started.\n\n`,
    );
    return false;
  }

  // Fire-and-forget: never block the wizard's first paint on telemetry.
  void emit("first_run_configure_shown", {});
  // runConfigureWizard marks the launcher as seen only if the user completes an
  // apply — so cancelling keeps redirecting here on the next bare run, and only
  // a finished setup sends the user to the dashboard afterwards.
  const result = await runConfigureWizard(io);

  // Onboarding-only: after a completed first-run setup, run the audit pipeline
  // (scan + cache warm) before the caller boots the dashboard. The explicit
  // `failproofai config` command does NOT do this — only this first-run path.
  // Lazy-imported + best-effort; opt out with FAILPROOFAI_NO_AUTO_AUDIT=1.
  if (result.applied) {
    try {
      const { runPostSetupAudit } = await import("../audit/cli");
      await runPostSetupAudit();
    } catch {
      // the audit is a bonus — never let it break onboarding or the dashboard.
    }
  }
  return true;
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

  // Fire-and-forget: never block the wizard's first paint on telemetry.
  void emit("configure_started", {});
  intro("let's set up your safety net", stdout);

  const cancel = (): WizardResult => {
    outro("Cancelled — nothing was changed.", { ok: false }, stdout);
    return { applied: false };
  };

  // 1 — Where?
  const scope = await selectOne<HookScope>({
    message: "Where should this apply?",
    choices: buildScopeChoices(cwd),
    stdin,
    stdout,
  });
  if (scope === null) return cancel();

  // 2 — Which assistants? An "Everything available" row protects every supported
  // CLI (detected + set-up-ahead); when ticked it wins over the individual boxes.
  const clisSel = await multiSelect<string>({
    message: "Which AI assistants should it protect?",
    choices: [
      {
        label: "Everything available",
        value: ALL_CLIS,
        hint: `protect all ${INTEGRATION_TYPES.length} supported CLIs`,
      },
      ...buildAgentChoices(scope, cwd),
    ],
    minSelected: 1,
    summaryNoun: "assistants",
    hint: "detected CLIs are pre-selected · space toggles · ctrl+a all · ↵ confirm",
    stdin,
    stdout,
  });
  if (clisSel === null) return cancel();
  const clis: IntegrationType[] = clisSel.includes(ALL_CLIS)
    ? [...INTEGRATION_TYPES]
    : (clisSel.filter((v) => v !== ALL_CLIS) as IntegrationType[]);

  // 3 — Which policies? Multi-select of themed presets — additive, so the
  // enabled set is the union of every ticked bundle.
  const presets = await multiSelect<string>({
    message: "What should we guard against?",
    choices: buildPresetChoices(),
    minSelected: 1,
    summaryNoun: "bundles",
    hint: "space toggles · combine presets · ↵ confirm",
    stdin,
    stdout,
  });
  if (presets === null) return cancel();
  const policies = resolvePresetSelection(presets);

  // 4 — Review & apply
  const decision = await selectOne<"apply" | "cancel">({
    message: "Ready to apply?",
    body: reviewLines({ scope, clis, policies, cwd }),
    choices: [
      { label: "Yes, apply now", value: "apply", hint: "write the config" },
      { label: "Cancel", value: "cancel", hint: "quit, no changes" },
    ],
    stdin,
    stdout,
  });
  if (decision !== "apply") return cancel();

  // Apply — REPLACE the enabled set at this scope.
  // Telemetry runs concurrently with the install (never rejects, 5s-bounded) so
  // it doesn't add dead time between "apply" and the config actually writing,
  // while still being awaited before the process can exit.
  const applied = emit("configure_applied", {
    scope,
    cli: clis,
    cli_count: clis.length,
    policy_count: policies.length,
    source: presets.join("+"),
  });
  // quiet: the wizard renders its own outro; replace: the chosen set becomes
  // the full enabled set at this scope (unticking removes).
  await installHooks(
    policies,
    scope,
    cwd,
    /* includeBeta */ false,
    "configure-wizard",
    /* customPoliciesPath */ undefined,
    /* removeCustomHooks */ false,
    clis,
    { replace: true, quiet: true },
  );
  await applied;
  // Only now — a completed apply — is the launcher considered "seen", so the
  // first-run bare invocation stops redirecting here and opens the dashboard.
  markLauncherSeen();

  const agentNames = clis.map((c) => getIntegration(c).displayName).join(", ");
  outro(`Setup complete — ${policies.length} policies guarding ${agentNames}.`, { ok: true }, stdout);
  return { applied: true, scope, clis, policies };
}
