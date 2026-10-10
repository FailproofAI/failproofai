/**
 * Which agent CLIs a `policies --install / --uninstall` acts on, asked with the
 * shared `selectOne` when more than one is detected.
 *
 * This file used to carry two hand-rolled raw-mode menus of its own: this one,
 * with a two-write (non-atomic) repaint and an escape-gate that ignored pipes,
 * and a searchable policy picker that nothing had called since `--install`
 * stopped choosing policies. The picker is gone and the menu is `selectOne`,
 * so it draws, windows and repaints like every other prompt in the CLI.
 */
import { colorsEnabled, optsFor, screenKit, selectOne, type SelectChoice } from "./tui";
import { detectInstalledClis, getIntegration, listInstallableIds } from "./integrations";
import { type IntegrationType } from "./types";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

/** Whether the prompt is being shown for an install or an uninstall flow.
 *  Drives heading + hint text so `policies --uninstall` no longer says
 *  "Install Hooks". */
export type CliPromptAction = "install" | "uninstall";

/**
 * Resolve which agent CLIs to install/uninstall hooks for.
 *
 * Rules:
 *   • If `explicit` is provided (from `--cli`), use it as-is.
 *   • Else, detect installed CLIs (PATH probe).
 *   • If exactly one detected → use just that one (no prompt).
 *   • If multiple detected and stdin is a TTY → arrow-key single-select.
 *   • Otherwise → default to all detected (or ["claude"] when none).
 *
 * Returns the selected IntegrationType[] (always non-empty).
 */
export async function resolveTargetClis(
  explicit?: IntegrationType[],
  action: CliPromptAction = "install",
): Promise<IntegrationType[]> {
  const detected = explicit && explicit.length > 0 ? [] : detectInstalledClis();
  const stdinIsTty = !!process.stdin.isTTY;
  const explicitList = explicit && explicit.length > 0 ? [...new Set(explicit)] : [];

  const fireDetectionEvent = (
    selected: IntegrationType[],
    resolutionMode: "explicit" | "single_detected" | "all_detected" | "interactive_prompt" | "defaulted_to_claude",
  ): void => {
    void trackHookEvent(getInstanceId(), "cli_detection_summary", {
      action,
      detected_clis: detected,
      explicit_clis: explicitList,
      selected_clis: selected,
      defaulted_to_claude: resolutionMode === "defaulted_to_claude",
      stdin_is_tty: stdinIsTty,
      resolution_mode: resolutionMode,
    });
  };

  if (explicit && explicit.length > 0) {
    fireDetectionEvent(explicitList, "explicit");
    return explicitList;
  }

  if (detected.length === 0) {
    if (action === "uninstall") {
      // Uninstall flow: no agent CLIs detected — nothing to remove from. Default to
      // claude so removeHooks operates over Claude's scopes (no-op if no settings file).
      console.log(
        screenKit({ color: colorsEnabled(process.stdout) }).caution(
          "No agent CLI was found on PATH, so this acts on Claude Code. Nothing is removed if it has no settings file.",
        ),
      );
      fireDetectionEvent(["claude"], "defaulted_to_claude");
      return ["claude"];
    }
    console.log(
      screenKit({ color: colorsEnabled(process.stdout) }).caution(
        "No agent CLI was found on PATH, so hooks go into Claude Code. They take effect once it is installed.",
      ),
    );
    fireDetectionEvent(["claude"], "defaulted_to_claude");
    return ["claude"];
  }

  if (detected.length === 1) {
    const integration = getIntegration(detected[0]);
    const verb = action === "uninstall" ? "removing hooks from" : "installing hooks for";
    console.log(`Detected ${integration.displayName}; ${verb} it.`);
    fireDetectionEvent(detected, "single_detected");
    return detected;
  }

  // Multiple detected. Prompt or default.
  if (!process.stdin.isTTY) {
    fireDetectionEvent(detected, "all_detected");
    return detected;
  }

  const selected = await promptCliTargetSelection(detected, action);
  fireDetectionEvent(selected, "interactive_prompt");
  return selected;
}

/** Selectable row in the CLI target menu. Exported for unit tests. */
export interface CliMenuOption {
  label: string;
  value: IntegrationType[];
  /** True when the underlying CLI was found on PATH. */
  detected: boolean;
  /** True for the aggregated "Install for all detected" row. */
  isAll: boolean;
}

/**
 * Build the option list for the CLI target menu.
 *
 *   • install action  → detected first (with optional aggregate row), then
 *                       every undetected CLI as a forward-install option.
 *   • uninstall action → detected only (you cannot remove from what was never
 *                       installed); aggregate row says "Remove from all N".
 */
export function buildCliMenuOptions(
  detected: IntegrationType[],
  action: CliPromptAction,
): { options: CliMenuOption[]; undetected: IntegrationType[] } {
  const undetected: IntegrationType[] =
    action === "install"
      ? // Only CLIs that support live-hook install — a future audit-only CLI
        // (one with no INTEGRATIONS entry) has no install path and must not
        // appear as a forward-install option. (hermes IS installable, so it
        // correctly appears here.)
        listInstallableIds().filter((id) => !detected.includes(id))
      : [];

  const options: CliMenuOption[] = [];
  if (detected.length > 1) {
    options.push({
      label: `All ${detected.length} agents`,
      value: detected,
      detected: true,
      isAll: true,
    });
  }
  for (const id of detected) {
    options.push({
      label: getIntegration(id).displayName,
      value: [id],
      detected: true,
      isAll: false,
    });
  }
  for (const id of undetected) {
    options.push({
      label: getIntegration(id).displayName,
      value: [id],
      detected: false,
      isAll: false,
    });
  }
  return { options, undetected };
}

/**
 * "Install / remove hooks for which agent?" when more than one is detected.
 *
 * Detected agents first — with an "All N agents" row when there are several —
 * then, for an install, every undetected agent as a forward install, so hooks
 * can be in place before the agent is. Esc exits 130, as it always has: the
 * caller has no "cancelled" path, and an install that quietly picked something
 * would be worse.
 */
async function promptCliTargetSelection(
  detected: IntegrationType[],
  action: CliPromptAction = "install",
): Promise<IntegrationType[]> {
  const { options } = buildCliMenuOptions(detected, action);
  const kit = screenKit(optsFor(process.stdout));
  process.stdout.write(`\n${kit.header(action === "uninstall" ? "Remove hooks" : "Install hooks")}\n\n`);
  const choices: SelectChoice<IntegrationType[]>[] = options.map((option) => ({
    label: option.label,
    value: option.value,
    section: option.detected ? "found on this machine" : "not installed, set up ahead of time",
  }));
  const picked = await selectOne<IntegrationType[]>({
    message: "Choose agents",
    meta: `${detected.length} found on this machine`,
    choices,
    spaceSelects: true,
  });
  if (picked === null) {
    process.stdout.write("\n");
    process.exit(130); // SIGINT-equivalent
  }
  return picked;
}
