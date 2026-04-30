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
import type { IntegrationType } from "./types";
import { createCliStyler, createCursorController } from "../cli-color";

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
  const style = createCliStyler(process.stdout);
  if (explicit && explicit.length > 0) return [...new Set(explicit)];

  const detected = detectInstalledClis();

  if (detected.length === 0) {
    if (action === "uninstall") {
      // Uninstall flow: no agent CLIs detected — nothing to remove from. Default to
      // claude so removeHooks operates over Claude's scopes (no-op if no settings file).
      console.log(
        style.yellow(
          "Warning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent). " +
            "Defaulting to Claude Code; nothing will be removed if no settings file exists.",
        ),
      );
      return ["claude"];
    }
    console.log(
      style.yellow(
        "Warning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent). " +
          "Defaulting to Claude Code; hooks will activate when an agent is installed.",
      ),
    );
    return ["claude"];
  }

  if (detected.length === 1) {
    const integration = getIntegration(detected[0]);
    const verb = action === "uninstall" ? "removing hooks from" : "installing hooks for";
    console.log(`Detected ${integration.displayName}; ${verb} it.`);
    return detected;
  }

  // Multiple detected. Prompt or default.
  if (!process.stdin.isTTY || !style.enabled) return detected; // non-interactive/no-color: use all detected

  return promptCliTargetSelection(detected, action);
}

/**
 * Interactive arrow-key single-select for "install/remove for which CLI?" when
 * multiple agent CLIs are detected. Visual style mirrors promptPolicySelection.
 */
async function promptCliTargetSelection(
  detected: IntegrationType[],
  action: CliPromptAction = "install",
): Promise<IntegrationType[]> {
  const style = createCliStyler(process.stdout);
  const labels = detected.map((id) => getIntegration(id).displayName).join(" + ");
  const allLabel = detected.length > 2 ? "All" : "Both";
  const options: Array<{ label: string; description: string; value: IntegrationType[] }> = [
    { label: allLabel, description: labels, value: detected },
    ...detected.map((id) => ({
      label: `${getIntegration(id).displayName} only`,
      description: "",
      value: [id] as IntegrationType[],
    })),
  ];

  let cursor = 0;
  let lastLineCount = 0;
  const cursorCtl = createCursorController(process.stdout);

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
  const verb = action === "uninstall" ? "remove from" : "install";

  function render(): void {
    const cols = process.stdout.columns || 120;
    cursorCtl.hide();

    const lines: string[] = [];
    lines.push(`  Failproof AI — ${heading}`);
    lines.push("");
    lines.push(`  ${style.dim(`Detected ${labels}. Choose where to ${verb}:`)}`);
    lines.push("");

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isActive = i === cursor;
      const pointer = isActive ? style.cyan("❯") : " ";
      const labelPart = isActive ? style.cyan(style.bold(opt.label)) : opt.label;
      const pad = opt.description ? " ".repeat(Math.max(2, 22 - opt.label.length)) : "";
      const desc = opt.description ? style.dim(opt.description) : "";
      lines.push(`  ${pointer} ${labelPart}${pad}${desc}`);
    }

    lines.push("");
    lines.push("  " + style.dim("─".repeat(Math.max(2, cols - 2))));
    lines.push("  [↑↓] Move  [Enter] Select  [^C] Quit");

    if (lastLineCount > 0) {
      process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
    }
    const output =
      lines.map((l) => (l === "" ? l : truncateLine(l, cols))).join("\n") + "\n";
    process.stdout.write(output);
    lastLineCount = lines.length;
  }

  return new Promise<IntegrationType[]>((resolve) => {
    render();
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup(): void {
      cursorCtl.dispose();
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
        cursor = cursor > 0 ? cursor - 1 : options.length - 1;
        render();
      } else if (key.name === "down") {
        cursor = cursor < options.length - 1 ? cursor + 1 : 0;
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
  const style = createCliStyler(process.stdout);

  // If stdin is not a TTY (piped/CI) or colors are explicitly disabled,
  // skip interactive rendering and return defaults.
  if (!process.stdin.isTTY || !style.enabled) {
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
  const cursorCtl = createCursorController(process.stdout);

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
    cursorCtl.hide();

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
      cursorCtl.dispose();
      process.stdin.removeListener("keypress", keypressHandler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on("keypress", keypressHandler);
  });
}
