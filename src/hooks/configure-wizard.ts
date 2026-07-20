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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import {
  selectOne,
  multiSelect,
  intro,
  outro,
  summarize,
  type MultiChoice,
  type TTYIn,
  type TTYOut,
} from "./tui";
import {
  detectInstalledClis,
  getIntegration,
} from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType, type HookScope } from "./types";
import { installHooks } from "./manager";
import { getConfigPathForScope, readHooksConfig } from "./hooks-config";
import { POLICY_PRESETS, resolvePreset, resolveEverything } from "./policy-presets";
import { discoverPolicyFiles, findSkippedPolicyFiles } from "./custom-hooks-loader";
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
    { dir: resolve(homedir(), ".failproofai", "policies"), label: "global" },
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
  scope: HookScope;
  clis: IntegrationType[];
  policies: string[];
  cwd: string;
  /** The Custom checkbox. `undefined` = nothing to toggle, leave as-is. */
  customEnabled?: boolean;
}): string[] {
  const { scope, clis, policies, cwd, customEnabled } = state;
  const where =
    scope === "project" ? `This project (${homeify(cwd)})` : "Everywhere (global)";
  const lines: string[] = [];
  const assistantNames = clis.map((c) => getIntegration(c).displayName);
  lines.push(`  Where      : ${where}`);
  lines.push(`  Assistants : ${assistantNames.length ? summarize(assistantNames, "assistants") : "(none)"}`);
  lines.push(`  Policies   : ${policies.length} enabled`);

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
        // Counts only what this scope can actually take — expanding to all 12
        // under project scope is what crashed the apply on Hermes.
        hint: `protect all ${clisSupportingScope(scope).length} CLIs configurable here`,
        // A selector, not an assistant. Counting it gave "13 assistants" for
        // the 12 supported CLIs, and listed "Everything available" among them.
        summaryExclude: true,
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
  // Filter to what this scope supports in BOTH branches: "Everything
  // available" must not expand to CLIs that cannot take this scope, and a
  // locked row can't be ticked but belt-and-braces keeps the invariant local
  // to the one place `clis` is built.
  const supported = new Set(clisSupportingScope(scope));
  const clis: IntegrationType[] = (
    clisSel.includes(ALL_CLIS)
      ? [...INTEGRATION_TYPES]
      : (clisSel.filter((v) => v !== ALL_CLIS) as IntegrationType[])
  ).filter((id) => supported.has(id));

  // 3 — Which policies? Multi-select of themed presets — additive, so the
  // enabled set is the union of every ticked bundle.
  // Seed the Custom checkbox from whatever the config already says, so the
  // wizard shows the current state rather than resetting it every run.
  const customEnabledBefore = readHooksConfig().customPoliciesEnabled !== false;
  const presetChoices = buildPresetChoices(cwd, customEnabledBefore);
  const hasCustomFiles = describeCustomPolicies(cwd).fileCount > 0;

  const presets = await multiSelect<string>({
    message: "What should we guard against?",
    choices: presetChoices,
    minSelected: 1,
    summaryNoun: "bundles",
    hint: "space toggles · combine presets · ↵ confirm",
    stdin,
    stdout,
  });
  if (presets === null) return cancel();
  const policies = resolvePresetSelection(presets);
  // Only meaningful when there are files to switch off; with none, the row is
  // locked-unchecked and must not write a disabling flag.
  const customEnabled = hasCustomFiles ? presets.includes(CUSTOM) : undefined;

  // 4 — Review & apply
  const decision = await selectOne<"apply" | "cancel">({
    message: "Ready to apply?",
    body: reviewLines({ scope, clis, policies, cwd, customEnabled }),
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
  setCustomPoliciesEnabled(scope, cwd, customEnabled);
  await applied;
  // Only now — a completed apply — is the launcher considered "seen", so the
  // first-run bare invocation stops redirecting here and opens the dashboard.
  markLauncherSeen();

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
  const assistants = `${clis.length} assistant${clis.length === 1 ? "" : "s"}`;
  outro(
    `Setup complete — ${policies.length} policies${customNote} · ${assistants}`,
    { ok: true },
    stdout,
  );
  return { applied: true, scope, clis, policies };
}
