/**
 * Interactive searchable multi-select prompt for choosing hook policies.
 * Uses raw mode stdin with node:readline for keypress handling.
 * No external dependencies.
 *
 * Rendering strategy: track line count, use cursor-up + clear-to-end-of-screen
 * (\x1B[NA\x1B[J) to avoid flickering. Lines are truncated to terminal width to
 * ensure lastLineCount stays accurate when the terminal is narrow.
 *
 * Keybindings: ↑↓ navigate · Space toggle · Ctrl+A all · Ctrl+S save · Esc clear search
 */
import * as readline from "node:readline";
// Brand palette, ANSI-aware truncation, and glyphs shared with the configure
// wizard (tui.ts) so every failproofai menu reads as one system.
import {
  paint,
  truncate as truncateLine,
  BAR,
  STEP_ACTIVE as STEP,
  STEP_DONE as DONE,
  CHECK_ON as BOX_ON,
  CHECK_OFF as BOX_OFF,
} from "./tui";
import { BUILTIN_POLICIES } from "./builtin-policies";
import { detectInstalledClis, getIntegration, listInstallableIds } from "./integrations";
import { type IntegrationType } from "./types";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

interface SelectItem {
  name: string;
  description: string;
  category: string;
  selected: boolean;
  beta: boolean;
}

type DisplayRow =
  | { kind: "header"; category: string; enabledCount: number; totalCount: number }
  | { kind: "item"; item: SelectItem; filteredIndex: number };

export interface PromptOptions {
  includeBeta?: boolean;
}

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
        "\x1B[33mWarning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent, opencode, pi)." +
          "Defaulting to Claude Code; nothing will be removed if no settings file exists.\x1B[0m",
      );
      fireDetectionEvent(["claude"], "defaulted_to_claude");
      return ["claude"];
    }
    console.log(
      "\x1B[33mWarning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent, opencode, pi)." +
        "Defaulting to Claude Code; hooks will activate when an agent is installed.\x1B[0m",
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
    const verb = action === "uninstall" ? "Remove from" : "Install for";
    options.push({
      label: `${verb} all ${detected.length} detected`,
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
 * Interactive arrow-key single-select for "install/remove for which CLI?" when
 * multiple agent CLIs are detected.
 *
 * Layout:
 *   • DETECTED section: an "Install for all detected" option (only when >1
 *     detected) followed by each detected CLI individually.
 *   • NOT INSTALLED section (install action only): each undetected CLI as a
 *     forward-install option, so users can prep hooks before adding the CLI.
 *
 * Cursor skips section headers — it only lands on selectable item rows.
 */
async function promptCliTargetSelection(
  detected: IntegrationType[],
  action: CliPromptAction = "install",
): Promise<IntegrationType[]> {
  const { options, undetected } = buildCliMenuOptions(detected, action);

  type DisplayRow =
    | { kind: "header"; title: string; hint?: string }
    | { kind: "blank" }
    | { kind: "item"; option: CliMenuOption; itemIndex: number };

  function buildDisplayRows(): DisplayRow[] {
    const rows: DisplayRow[] = [];
    let itemIndex = 0;

    rows.push({
      kind: "header",
      title: `Detected (${detected.length})`,
    });
    for (const opt of options) {
      if (opt.detected) {
        rows.push({ kind: "item", option: opt, itemIndex: itemIndex++ });
      }
    }

    if (undetected.length > 0) {
      rows.push({ kind: "blank" });
      rows.push({
        kind: "header",
        title: `Not installed (${undetected.length})`,
        hint: "install hooks ahead of time",
      });
      for (const opt of options) {
        if (!opt.detected) {
          rows.push({ kind: "item", option: opt, itemIndex: itemIndex++ });
        }
      }
    }

    return rows;
  }

  let cursor = 0;
  let lastLineCount = 0;
  let cursorHidden = false;

  function hideCursor(): void {
    if (!cursorHidden) {
      process.stdout.write("\x1B[?25l");
      cursorHidden = true;
    }
  }
  function showCursor(): void {
    if (cursorHidden) {
      process.stdout.write("\x1B[?25h");
      cursorHidden = false;
    }
  }

  // Shared brand painter from tui.ts (NO_COLOR-gated like the rest of this file).
  const { dim, bold, guide: teal, pink, pinkBold } = paint(!process.env.NO_COLOR);

  const heading =
    action === "uninstall" ? "Remove failproofai hooks" : "Install failproofai hooks";

  function render(): void {
    const cols = process.stdout.columns || 100;
    hideCursor();

    const g = dim(BAR);
    const lines: string[] = [g, `${teal(STEP)}  ${bold(heading)}`];

    for (const row of buildDisplayRows()) {
      if (row.kind === "blank") {
        lines.push(g);
        continue;
      }
      if (row.kind === "header") {
        const hint = row.hint ? `  ${dim("· " + row.hint)}` : "";
        lines.push(`${g}  ${dim(row.title)}${hint}`);
        continue;
      }

      const opt = row.option;
      const isActive = row.itemIndex === cursor;
      const caret = isActive ? pink("❯") : " ";
      const marker = opt.isAll ? teal("★") : opt.detected ? pink("●") : dim("○");
      const label = isActive
        ? pinkBold(opt.label)
        : opt.detected
          ? opt.label
          : dim(opt.label);
      lines.push(`${g}  ${caret} ${marker}  ${label}`);
    }

    lines.push(g);
    lines.push(`${g}  ${dim("↑/↓ move · ↵ select · esc cancel")}`);

    if (lastLineCount > 0) {
      process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    }
    process.stdout.write(lines.map((l) => truncateLine(l, cols)).join("\n") + "\n");
    lastLineCount = lines.length;
  }

  const itemCount = options.length;

  return new Promise<IntegrationType[]>((resolve) => {
    render();
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup(): void {
      showCursor();
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    }

    function onKey(_str: string | undefined, key: readline.Key): void {
      if (!key) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130); // SIGINT-equivalent
      }
      if (key.name === "up") {
        cursor = cursor > 0 ? cursor - 1 : itemCount - 1;
        render();
      } else if (key.name === "down") {
        cursor = cursor < itemCount - 1 ? cursor + 1 : 0;
        render();
      } else if (key.name === "return" || key.name === "space") {
        cleanup();
        process.stdout.write("\n");
        resolve(options[cursor].value);
      }
    }

    process.stdin.on("keypress", onKey);
  });
}

/**
 * Show interactive searchable policy selector.
 * @param preSelected — policy names to pre-check (e.g. from existing config).
 *                      When omitted, uses each policy's defaultEnabled flag.
 * @param options     — prompt options (e.g. includeBeta)
 */
export async function promptPolicySelection(
  preSelected?: string[],
  options: PromptOptions = {},
): Promise<string[]> {
  const { includeBeta = false } = options;

  // If stdin is not a TTY (piped/CI), return defaults
  if (!process.stdin.isTTY) {
    const available = BUILTIN_POLICIES.filter((p) => includeBeta || !p.beta);
    if (preSelected) return preSelected.filter((name) => available.some((p) => p.name === name));
    return available.filter((p) => p.defaultEnabled).map((p) => p.name);
  }

  const preSelectedSet = preSelected ? new Set(preSelected) : null;

  const items: SelectItem[] = BUILTIN_POLICIES
    .filter((p) => includeBeta || !p.beta)
    .map((p) => ({
      name: p.name,
      description: p.description,
      category: p.category,
      selected: preSelectedSet ? preSelectedSet.has(p.name) : p.defaultEnabled,
      beta: !!p.beta,
    }));

  const total = items.length;
  const WINDOW_SIZE = 10;

  // Shared brand painter from tui.ts, bound to role names so a reader never has
  // to decode which hue a role happens to use today (glyphs imported above).
  const useColor = !process.env.NO_COLOR;
  const c = paint(useColor);
  const { dim, bold } = c;
  const stepMark = c.guide; // ◆ step marker + live selected-count
  const activeName = c.pinkBold; // row under the cursor
  const selectedMark = c.pink; // checked boxes / selected names
  const betaTag = c.softPink; // "beta" pill
  // Fixed name column so descriptions align into a clean, scannable second column.
  const NAME_COL = Math.min(34, Math.max(10, ...items.map((i) => i.name.length)));

  let cursor = 0;
  let search = "";
  let lastLineCount = 0;
  let cursorHidden = false;

  function hideCursor(): void {
    if (!cursorHidden) {
      process.stdout.write("\x1B[?25l");
      cursorHidden = true;
    }
  }

  function showCursor(): void {
    if (cursorHidden) {
      process.stdout.write("\x1B[?25h");
      cursorHidden = false;
    }
  }

  function getFiltered(): SelectItem[] {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    );
  }

  // Build display rows: category header rows interspersed with item rows.
  // Categories appear in the order they first appear in BUILTIN_POLICIES.
  function buildDisplayRows(filtered: SelectItem[]): DisplayRow[] {
    // Single pass: compute category order, enabled counts, and total counts together.
    const categoryOrder: string[] = [];
    const categoryEnabledCount = new Map<string, number>();
    const categoryTotalCount = new Map<string, number>();
    for (const p of items) {
      if (!categoryEnabledCount.has(p.category)) {
        categoryOrder.push(p.category);
        categoryEnabledCount.set(p.category, 0);
        categoryTotalCount.set(p.category, 0);
      }
      categoryTotalCount.set(p.category, categoryTotalCount.get(p.category)! + 1);
      if (p.selected) categoryEnabledCount.set(p.category, categoryEnabledCount.get(p.category)! + 1);
    }

    const filteredByCategory = new Map<string, SelectItem[]>();
    for (const item of filtered) {
      const bucket = filteredByCategory.get(item.category) ?? [];
      bucket.push(item);
      filteredByCategory.set(item.category, bucket);
    }

    const rows: DisplayRow[] = [];
    let idx = 0;
    for (const cat of categoryOrder) {
      const catFiltered = filteredByCategory.get(cat);
      if (!catFiltered || catFiltered.length === 0) continue;
      rows.push({ kind: "header", category: cat, enabledCount: categoryEnabledCount.get(cat)!, totalCount: categoryTotalCount.get(cat)! });
      for (const item of catFiltered) {
        rows.push({ kind: "item", item, filteredIndex: idx++ });
      }
    }
    return rows;
  }

  function render(): void {
    const cols = process.stdout.columns || 100;
    hideCursor();

    const filtered = getFiltered();
    const shown = filtered.length;
    if (shown > 0 && cursor >= shown) cursor = shown - 1;
    const selectedCount = items.filter((i) => i.selected).length;

    const g = dim(BAR);
    const lines: string[] = [];

    // header
    lines.push(g);
    lines.push(
      `${stepMark(STEP)}  ${bold("Choose the policies to enable")}   ${dim("·")}   ` +
        `${stepMark(String(selectedCount))} ${dim("selected")}`,
    );

    // search
    const blockCursor = useColor ? "\x1B[7m \x1B[0m" : "_";
    const countLabel = search ? dim(`${shown}/${total} shown`) : dim(`${total} policies`);
    lines.push(`${g}  ${dim("filter ›")} ${search}${blockCursor}   ${countLabel}`);
    lines.push(g);

    if (shown === 0) {
      lines.push(`${g}  ${dim(`no policies match “${search}”`)}`);
      for (let i = 0; i < WINDOW_SIZE + 1; i++) lines.push(g);
    } else {
      const displayRows = buildDisplayRows(filtered);

      let cursorDisplayRow = 0;
      for (let i = 0; i < displayRows.length; i++) {
        const row = displayRows[i];
        if (row.kind === "item" && row.filteredIndex === cursor) {
          cursorDisplayRow = i;
          break;
        }
      }
      let windowStart = cursorDisplayRow - Math.floor(WINDOW_SIZE / 2);
      windowStart = Math.max(0, windowStart);
      windowStart = Math.min(windowStart, Math.max(0, displayRows.length - WINDOW_SIZE));
      const windowEnd = Math.min(displayRows.length, windowStart + WINDOW_SIZE);

      const aboveItems = displayRows.slice(0, windowStart).filter((r) => r.kind === "item").length;
      lines.push(aboveItems > 0 ? `${g}  ${dim(`↑ ${aboveItems} more`)}` : g);

      for (let i = windowStart; i < windowEnd; i++) {
        const row = displayRows[i];
        if (row.kind === "header") {
          lines.push(`${g}  ${dim(row.category.toUpperCase())}  ${dim(`${row.enabledCount}/${row.totalCount}`)}`);
        } else {
          const item = row.item;
          const active = row.filteredIndex === cursor;
          const box = item.selected ? selectedMark(BOX_ON) : dim(BOX_OFF);
          const rawName = item.name.padEnd(NAME_COL);
          const name = active ? activeName(rawName) : item.selected ? rawName : dim(rawName);
          const beta = item.beta ? ` ${betaTag("beta")}` : "";
          const descWidth = Math.max(8, cols - NAME_COL - 8 - (item.beta ? 5 : 0));
          const desc = dim(truncateLine(item.description, descWidth));
          lines.push(`${g}  ${box} ${name}${beta}  ${desc}`);
        }
      }
      for (let i = windowEnd - windowStart; i < WINDOW_SIZE; i++) lines.push(g);

      const belowItems = displayRows.slice(windowEnd).filter((r) => r.kind === "item").length;
      lines.push(belowItems > 0 ? `${g}  ${dim(`↓ ${belowItems} more`)}` : g);
    }

    // footer
    lines.push(g);
    lines.push(`${g}  ${dim("↑/↓ move · space select · ctrl+a all · ↵ save · type to filter · esc clear")}`);

    if (lastLineCount > 0) process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    process.stdout.write(lines.map((l) => truncateLine(l, cols)).join("\n") + "\n");
    lastLineCount = lines.length;
  }

  return new Promise<string[]>((resolve) => {
    render();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Use a single data→keypress pipeline with no readline.Interface.
    // readline.createInterface would register its own competing data listener
    // and its close() call would unexpectedly pause stdin, breaking arrow keys.
    readline.emitKeypressEvents(process.stdin);

    function keypressHandler(_str: string | undefined, key: readline.Key): void {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(0);
      }

      const filtered = getFiltered();

      if (key.name === "up") {
        if (filtered.length > 0) {
          cursor = cursor > 0 ? cursor - 1 : filtered.length - 1;
        }
        render();
      } else if (key.name === "down") {
        if (filtered.length > 0) {
          cursor = cursor < filtered.length - 1 ? cursor + 1 : 0;
        }
        render();
      } else if (key.name === "space") {
        const item = filtered[cursor];
        if (item) item.selected = !item.selected;
        render();
      } else if (key.name === "return" || (key.ctrl && key.name === "s")) {
        // Save — collapse the picker to a one-line summary, then resolve.
        cleanup();
        const selected = items.filter((i) => i.selected).map((i) => i.name);
        if (lastLineCount > 0) process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
        process.stdout.write(
          `${dim(BAR)}\n${dim(DONE)}  Policies\n${dim(BAR)}  ${dim(`${selected.length} selected`)}\n`,
        );
        resolve(selected);
      } else if (key.name === "escape") {
        // Clear search filter
        search = "";
        cursor = 0;
        render();
      } else if (key.ctrl && key.name === "a") {
        // Toggle all visible items
        const allSelected = filtered.length > 0 && filtered.every((i) => i.selected);
        for (const item of filtered) item.selected = !allSelected;
        render();
      } else if (key.name === "backspace" || key.name === "delete") {
        if (search.length > 0) {
          search = search.slice(0, -1);
          cursor = 0;
          render();
        }
      } else if (_str && _str.length === 1 && !key.ctrl && !key.meta) {
        // All printable characters (including 'a', 's') go to search
        search += _str;
        cursor = 0;
        render();
      }
    }

    function cleanup(): void {
      showCursor();
      process.stdin.removeListener("keypress", keypressHandler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on("keypress", keypressHandler);
  });
}
