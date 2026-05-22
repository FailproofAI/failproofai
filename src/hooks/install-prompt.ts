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
import { BUILTIN_POLICIES } from "./builtin-policies";
import { detectInstalledClis, getIntegration } from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";
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
        "\x1B[33mWarning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent, opencode, pi, gemini). " +
          "Defaulting to Claude Code; nothing will be removed if no settings file exists.\x1B[0m",
      );
      fireDetectionEvent(["claude"], "defaulted_to_claude");
      return ["claude"];
    }
    console.log(
      "\x1B[33mWarning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent, opencode, pi, gemini). " +
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
      ? INTEGRATION_TYPES.filter((id) => !detected.includes(id))
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

  function truncateLine(line: string, width: number): string {
    let visual = 0;
    let result = "";
    let i = 0;
    while (i < line.length) {
      if (line[i] === "\x1B" && line[i + 1] === "[") {
        let j = i + 2;
        while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
        j++;
        result += line.slice(i, j);
        i = j;
      } else {
        if (visual >= width) break;
        result += line[i];
        visual++;
        i++;
      }
    }
    return result;
  }

  const heading = action === "uninstall" ? "Remove Hooks" : "Install Hooks";

  function render(): void {
    const cols = process.stdout.columns || 120;
    hideCursor();

    const lines: string[] = [];
    lines.push(`  \x1B[1mFailproof AI\x1B[0m \x1B[2m—\x1B[0m ${heading}`);
    lines.push("");

    for (const row of buildDisplayRows()) {
      if (row.kind === "blank") {
        lines.push("");
        continue;
      }
      if (row.kind === "header") {
        const hintVisible = row.hint ? ` · ${row.hint}` : "";
        // Line shape: "  " + "── " + title + hintVisible + " " + dashes  → cols
        const dashLen = Math.max(2, cols - 2 - 3 - row.title.length - hintVisible.length - 1);
        const suffix = row.hint ? ` \x1B[2m· ${row.hint}\x1B[0m` : "";
        lines.push(
          `  \x1B[2m── \x1B[0m\x1B[1m${row.title}\x1B[0m${suffix} \x1B[2m${"─".repeat(dashLen)}\x1B[0m`,
        );
        continue;
      }

      const opt = row.option;
      const isActive = row.itemIndex === cursor;
      const pointer = isActive ? "\x1B[36m❯\x1B[0m" : " ";
      const marker = opt.isAll
        ? "\x1B[33m★\x1B[0m"
        : opt.detected
          ? "\x1B[32m●\x1B[0m"
          : "\x1B[2m○\x1B[0m";
      const label = isActive
        ? `\x1B[1;36m${opt.label}\x1B[0m`
        : opt.detected
          ? opt.label
          : `\x1B[2m${opt.label}\x1B[0m`;
      lines.push(`  ${pointer} ${marker}  ${label}`);
    }

    lines.push("");
    lines.push("  \x1B[2m" + "─".repeat(Math.max(2, cols - 2)) + "\x1B[0m");
    lines.push("  [↑↓] Move  [Enter] Select  [^C] Quit");

    if (lastLineCount > 0) {
      process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    }
    const output =
      lines.map((l) => (l === "" ? l : truncateLine(l, cols))).join("\n") + "\n";
    process.stdout.write(output);
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
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
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
  const WINDOW_SIZE = 8;

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

  // Truncate a line to `width` visual columns, skipping ANSI CSI sequences.
  function truncateLine(line: string, width: number): string {
    let visual = 0;
    let result = "";
    let i = 0;
    while (i < line.length) {
      if (line[i] === "\x1B" && line[i + 1] === "[") {
        let j = i + 2;
        while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
        j++;
        result += line.slice(i, j);
        i = j;
      } else {
        if (visual >= width) break;
        result += line[i];
        visual++;
        i++;
      }
    }
    return result;
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
    const cols = process.stdout.columns || 120;
    hideCursor();

    const filtered = getFiltered();
    const shown = filtered.length;

    // Clamp cursor to filtered list bounds
    if (shown > 0 && cursor >= shown) cursor = shown - 1;

    const lines: string[] = [];

    // ── Title ────────────────────────────────────────────────────
    lines.push("  Failproof AI \u2014 Policy Manager");
    lines.push("");

    // ── Bordered search box ──────────────────────────────────────
    const innerWidth = Math.max(20, cols - 6);
    const topBorder = "  \u250c" + "\u2500".repeat(innerWidth + 2) + "\u2510";
    const botBorder = "  \u2514" + "\u2500".repeat(innerWidth + 2) + "\u2518";
    const cursorChar = "\x1B[7m \x1B[0m"; // reverse-video block cursor
    const countPart = search
      ? ` \x1B[2m(${shown}/${total})\x1B[0m`
      : ` \x1B[2m(${total} policies)\x1B[0m`;
    const searchContent = `\x1B[1mSearch:\x1B[0m ${search}${cursorChar}${countPart}`;
    lines.push(topBorder);
    lines.push(`  \u2502 ${searchContent}`);
    lines.push(botBorder);
    lines.push("");

    // ── Content area ─────────────────────────────────────────────
    if (shown === 0) {
      lines.push("  \x1B[2mNo policies match \u201c" + search + "\u201d\x1B[0m");
      // Pad to stable height: 1 (scroll-up) + WINDOW_SIZE (rows) + 1 (scroll-down)
      for (let i = 0; i < WINDOW_SIZE + 1; i++) lines.push("");
    } else {
      const displayRows = buildDisplayRows(filtered);

      // Find the display row index that corresponds to the current cursor
      let cursorDisplayRow = 0;
      for (let i = 0; i < displayRows.length; i++) {
        const row = displayRows[i];
        if (row.kind === "item" && row.filteredIndex === cursor) {
          cursorDisplayRow = i;
          break;
        }
      }

      // Viewport: keep cursor row roughly centred
      let windowStart = cursorDisplayRow - Math.floor(WINDOW_SIZE / 2);
      windowStart = Math.max(0, windowStart);
      windowStart = Math.min(windowStart, Math.max(0, displayRows.length - WINDOW_SIZE));
      const windowEnd = Math.min(displayRows.length, windowStart + WINDOW_SIZE);

      // Scroll-up indicator (always reserve this line for stable height)
      const aboveItems = displayRows
        .slice(0, windowStart)
        .filter((r) => r.kind === "item").length;
      if (aboveItems > 0) {
        lines.push(`  \x1B[2m  \u2191 ${aboveItems} more above\x1B[0m`);
      } else {
        lines.push("");
      }

      // Visible display rows
      for (let i = windowStart; i < windowEnd; i++) {
        const row = displayRows[i];
        if (row.kind === "header") {
          // ── CATEGORY NAME (enabled/total) ─────
          const label = ` ${row.category.toUpperCase()} (${row.enabledCount}/${row.totalCount}) `;
          const prefix = "\u2500\u2500 ";
          const prefixLen = 3 + label.length;
          const dashLen = Math.max(2, cols - 2 - prefixLen);
          lines.push(
            `  \x1B[2m${prefix}${label}${"\u2500".repeat(dashLen)}\x1B[0m`,
          );
        } else {
          const item = row.item;
          const isActive = row.filteredIndex === cursor;
          const pointer = isActive ? "\x1B[36m\u276f\x1B[0m" : " ";
          const check = item.selected ? "\x1B[32m[\u2713]\x1B[0m" : "[ ]";
          const namePart = isActive
            ? `\x1B[1;36m${item.name}\x1B[0m`
            : item.name;
          const betaPart = item.beta ? " \x1B[35m[beta]\x1B[0m" : "";
          const pad = " ".repeat(Math.max(1, 28 - item.name.length));
          const desc = `\x1B[2m${item.description}\x1B[0m`;
          lines.push(`  ${pointer} ${check} ${namePart}${betaPart}${pad}${desc}`);
        }
      }

      // Pad window to fixed WINDOW_SIZE rows for stable height
      for (let i = windowEnd - windowStart; i < WINDOW_SIZE; i++) {
        lines.push("");
      }

      // Scroll-down indicator (always reserve this line for stable height)
      const belowItems = displayRows
        .slice(windowEnd)
        .filter((r) => r.kind === "item").length;
      if (belowItems > 0) {
        lines.push(`  \x1B[2m  \u2193 ${belowItems} more below\x1B[0m`);
      } else {
        lines.push("");
      }
    }

    // ── Footer ───────────────────────────────────────────────────
    lines.push("");
    lines.push("  \x1B[2m" + "\u2500".repeat(cols - 2) + "\x1B[0m");
    lines.push(
      "  [\u2191\u2193] Move  [Space] Toggle  [Ctrl+A] All  [Ctrl+S] Save  [Esc] Clear  [^C] Quit",
    );
    lines.push("");
    lines.push(
      "  \x1B[2mTip: `policies` for a flat list \u00b7 `policies --install <name\u2026>` to skip prompt\x1B[0m",
    );
    if (!includeBeta) {
      lines.push(
        "  \x1B[2mTip: `policies --install --beta` to include beta policies\x1B[0m",
      );
    }

    // ── Repaint: cursor-up by previous line count, clear to end, redraw ──
    if (lastLineCount > 0) {
      process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    }
    const output =
      lines.map((l) => (l === "" ? l : truncateLine(l, cols))).join("\n") + "\n";
    process.stdout.write(output);
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
      } else if (key.name === "return" || key.name === "space") {
        const item = filtered[cursor];
        if (item) item.selected = !item.selected;
        render();
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
      } else if (key.ctrl && key.name === "s") {
        // Submit
        cleanup();
        const selected = items.filter((i) => i.selected).map((i) => i.name);
        process.stdout.write("\n");
        resolve(selected);
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
