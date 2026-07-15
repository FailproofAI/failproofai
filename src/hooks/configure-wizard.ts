/**
 * `failproofai configure` — the interactive setup launcher.
 *
 * A single guided flow that sets up the whole failproofai ecosystem, hiding the
 * scope / cli / two-layer machinery behind three plain questions:
 *   1. Where?      global (user) vs this project
 *   2. Assistants? multi-select of agent CLIs (detected + install-ahead)
 *   3. Policies?   a themed preset, Everything, or a Custom picker
 * …then a Review screen that shows exactly which files change, and Apply.
 *
 * Selections REPLACE the enabled set at the chosen scope (the picker pre-checks
 * whatever is already enabled, so unticking removes). Reuses the tested
 * install/uninstall manager and the existing searchable policy picker.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { selectOne, multiSelect, intro, outro, type TTYIn, type TTYOut } from "./tui";
import {
  detectInstalledClis,
  getIntegration,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { installHooks } from "./manager";
import { promptPolicySelection } from "./install-prompt";
import { readScopedHooksConfig, getConfigPathForScope } from "./hooks-config";
import { POLICY_PRESETS, resolvePreset, resolveEverything } from "./policy-presets";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

const EVERYTHING = "__everything__";
const CUSTOM = "__custom__";

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
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
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
  const choices: Array<{
    label: string;
    value: IntegrationType;
    checked: boolean;
    section: string;
    hint?: string;
  }> = [];
  // Detected first, then the rest as "install ahead of time".
  const detectedIds = INTEGRATION_TYPES.filter((id) => detected.has(id));
  const undetectedIds = INTEGRATION_TYPES.filter((id) => !detected.has(id));
  for (const id of detectedIds) {
    const integration = getIntegration(id);
    let installedHere = false;
    try {
      installedHere = integration.hooksInstalledInSettings(scope, cwd);
    } catch {
      installedHere = false;
    }
    choices.push({
      label: integration.displayName,
      value: id,
      checked: true,
      section: "Detected",
      hint: installedHere ? "already configured" : undefined,
    });
  }
  for (const id of undetectedIds) {
    const integration = getIntegration(id);
    let installedHere = false;
    try {
      installedHere = integration.hooksInstalledInSettings(scope, cwd);
    } catch {
      installedHere = false;
    }
    choices.push({
      label: integration.displayName,
      value: id,
      checked: installedHere,
      section: "Not installed · set up ahead of time",
      hint: installedHere ? "already configured" : "not on PATH",
    });
  }
  return choices;
}

export function buildPolicySourceChoices(includeBeta = false) {
  const everythingCount = resolveEverything(includeBeta).length;
  const choices = POLICY_PRESETS.map((p) => ({
    label: p.label,
    value: p.id,
    hint: p.description,
    section: "Presets",
  }));
  choices.push({
    label: "Everything",
    value: EVERYTHING,
    hint: `all ${everythingCount} policies`,
    section: "Full control",
  });
  choices.push({
    label: "Custom…",
    value: CUSTOM,
    hint: "pick policies individually",
    section: "Full control",
  });
  return choices;
}

/**
 * Resolve a chosen policy-source id to a concrete policy set. Returns
 * `{ custom: true }` when the caller should open the full searchable picker.
 */
export function resolvePolicySource(
  value: string,
  includeBeta = false,
): { custom: true } | { custom: false; policies: string[] } {
  if (value === CUSTOM) return { custom: true };
  if (value === EVERYTHING) return { custom: false, policies: resolveEverything(includeBeta) };
  return { custom: false, policies: resolvePreset(value, includeBeta) };
}

export function reviewLines(
  state: { scope: HookScope; clis: IntegrationType[]; policies: string[]; cwd: string },
): string[] {
  const { scope, clis, policies, cwd } = state;
  const where =
    scope === "project" ? `This project (${homeify(cwd)})` : "Everywhere (global)";
  const lines: string[] = [];
  lines.push(`  Where      : ${where}`);
  lines.push(`  Assistants : ${clis.map((c) => getIntegration(c).displayName).join(", ") || "(none)"}`);
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
      `\n[failproofai] Not set up yet — run \`failproofai configure\` to get started.\n\n`,
    );
    return false;
  }

  await emit("first_run_configure_shown", {});
  // runConfigureWizard marks the launcher as seen only if the user completes an
  // apply — so cancelling keeps redirecting here on the next bare run, and only
  // a finished setup sends the user to the dashboard afterwards.
  await runConfigureWizard(io);
  return true;
}

// ── The wizard ───────────────────────────────────────────────────────────────

export async function runConfigureWizard(io: WizardIO = {}): Promise<WizardResult> {
  const stdin: TTYIn = io.stdin ?? process.stdin;
  const stdout: TTYOut = io.stdout ?? process.stdout;
  const cwd = process.cwd();

  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(
      "failproofai configure needs an interactive terminal.\n" +
        "Use the flag form instead, e.g.:\n" +
        "  failproofai policies --install --scope user --cli claude\n",
    );
    return { applied: false };
  }

  await emit("configure_started", {});
  intro("Failproof AI · let's set up your safety policies", stdout);

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

  // 2 — Which assistants?
  const clis = await multiSelect<IntegrationType>({
    message: "Which AI assistants should it protect?",
    choices: buildAgentChoices(scope, cwd),
    minSelected: 1,
    stdin,
    stdout,
  });
  if (clis === null) return cancel();

  // 3 — Which policies?
  const source = await selectOne<string>({
    message: "What should we guard against?",
    choices: buildPolicySourceChoices(),
    stdin,
    stdout,
  });
  if (source === null) return cancel();

  let policies: string[];
  const resolved = resolvePolicySource(source);
  if (resolved.custom) {
    const preSelected = readScopedHooksConfig(scope, cwd).enabledPolicies;
    policies = await promptPolicySelection(preSelected.length > 0 ? preSelected : undefined, {});
  } else {
    policies = resolved.policies;
  }

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
  await emit("configure_applied", {
    scope,
    cli: clis,
    cli_count: clis.length,
    policy_count: policies.length,
    source,
  });
  // installHooks logs verbosely; silence it so the clack flow stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await installHooks(
      policies,
      scope,
      cwd,
      /* includeBeta */ false,
      "configure-wizard",
      /* customPoliciesPath */ undefined,
      /* removeCustomHooks */ false,
      clis,
      /* replace */ true,
    );
  } finally {
    console.log = origLog;
  }
  // Only now — a completed apply — is the launcher considered "seen", so the
  // first-run bare invocation stops redirecting here and opens the dashboard.
  markLauncherSeen();

  const agentNames = clis.map((c) => getIntegration(c).displayName).join(", ");
  outro(`Setup complete — ${policies.length} policies guarding ${agentNames}.`, { ok: true }, stdout);
  return { applied: true, scope, clis, policies };
}
