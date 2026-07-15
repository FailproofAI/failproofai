/**
 * Minimal clack-style TUI primitives for the `failproofai configure` launcher.
 *
 * A single continuous flow with a left gutter (│) threading through step nodes:
 * the active step shows as ◆, answered steps collapse to a persistent ◇ log
 * line, and the run ends on a └ outro. Two interactive prompts — `selectOne`
 * (radio) and `multiSelect` (checklist) — plus `intro` / `outro` framing.
 *
 * Each prompt owns only its own render region (cursor-up + clear-to-end
 * repaint) and, on resolve, collapses that region to a one-line summary that
 * stays on screen — so the next prompt simply appends below, building the log.
 * No external dependencies. Honors NO_COLOR and non-TTY (returns the default
 * without drawing).
 */
import * as readline from "node:readline";

export type TTYIn = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  isRaw?: boolean;
};
export type TTYOut = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

export interface SelectChoice<T> {
  label: string;
  value: T;
  hint?: string;
  section?: string;
}

export interface SelectOneOptions<T> {
  message: string;
  choices: SelectChoice<T>[];
  /** Static info lines rendered under the question (e.g. a review summary). */
  body?: string[];
  hint?: string;
  initialIndex?: number;
  stdin?: TTYIn;
  stdout?: TTYOut;
}

export interface MultiChoice<T> {
  label: string;
  value: T;
  hint?: string;
  checked?: boolean;
  section?: string;
}

export interface MultiSelectOptions<T> {
  message: string;
  choices: MultiChoice<T>[];
  minSelected?: number;
  hint?: string;
  stdin?: TTYIn;
  stdout?: TTYOut;
}

const ESC = "\x1B";

// ── glyphs ────────────────────────────────────────────────────────────────
const BAR = "│";
const BAR_END = "└";
const STEP_ACTIVE = "◆";
const STEP_DONE = "◇";
const RADIO_ON = "●";
const RADIO_OFF = "○";
const CHECK_ON = "◼";
const CHECK_OFF = "◻";

function colorsEnabled(out: TTYOut): boolean {
  return !!out.isTTY && !process.env.NO_COLOR;
}

function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `${ESC}[${code}m${s}${ESC}[0m` : s);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    cyanBold: wrap("1;36"),
    green: wrap("32"),
    greenBold: wrap("1;32"),
    yellow: wrap("33"),
    red: wrap("31"),
  };
}

/** Truncate a line to `width` visual columns, skipping ANSI CSI sequences. */
function truncate(line: string, width: number): string {
  let visual = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
      j++;
      out += line.slice(i, j);
      i = j;
    } else {
      if (visual >= width) break;
      out += line[i];
      visual++;
      i++;
    }
  }
  return out;
}

function writeLines(out: TTYOut, lines: string[]): void {
  const cols = out.columns || 80;
  out.write(lines.map((l) => (l === "" ? l : truncate(l, cols))).join("\n") + "\n");
}

// ── framing ─────────────────────────────────────────────────────────────────

/** Print the flow header. Call once at the start of a wizard run. */
export function intro(message: string, stdout: TTYOut = process.stdout): void {
  if (!stdout.isTTY) return;
  const c = paint(colorsEnabled(stdout));
  writeLines(stdout, ["", `${c.cyan(STEP_ACTIVE)}  ${c.bold(message)}`]);
}

/** Close the flow with a terminating └ line. */
export function outro(
  message: string,
  opts: { ok?: boolean } = {},
  stdout: TTYOut = process.stdout,
): void {
  const c = paint(colorsEnabled(stdout));
  const ok = opts.ok !== false;
  if (!stdout.isTTY) {
    stdout.write(message + "\n");
    return;
  }
  const end = ok ? c.green(BAR_END) : c.dim(BAR_END);
  const text = ok ? c.green(message) : c.dim(message);
  writeLines(stdout, [c.dim(BAR), `${end}  ${text}`]);
}

// ── shared render engine ─────────────────────────────────────────────────────

type Region = { lastCount: number };

function repaint(out: TTYOut, region: Region, lines: string[]): void {
  if (region.lastCount > 0) out.write(`${ESC}[${region.lastCount}A${ESC}[J`);
  writeLines(out, lines);
  region.lastCount = lines.length;
}

function hideCursor(out: TTYOut): void {
  out.write(`${ESC}[?25l`);
}
function showCursor(out: TTYOut): void {
  out.write(`${ESC}[?25h`);
}

function sectionRows<T extends { section?: string }>(
  choices: T[],
  renderRow: (choice: T, idx: number) => string,
  c: ReturnType<typeof paint>,
): string[] {
  const lines: string[] = [];
  let lastSection: string | undefined;
  choices.forEach((choice, idx) => {
    if (choice.section && choice.section !== lastSection) {
      lastSection = choice.section;
      lines.push(`${c.dim(BAR)}  ${c.dim(choice.section)}`);
    }
    lines.push(renderRow(choice, idx));
  });
  return lines;
}

// ── selectOne (radio) ─────────────────────────────────────────────────────────

export function selectOne<T>(opts: SelectOneOptions<T>): Promise<T | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const choices = opts.choices;
  const initial = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, choices.length - 1));

  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(choices.length ? choices[initial].value : null);
  }

  const c = paint(colorsEnabled(stdout));
  const region: Region = { lastCount: 0 };
  let cursor = initial;

  const build = (): string[] => {
    const lines: string[] = [c.dim(BAR), `${c.cyan(STEP_ACTIVE)}  ${c.bold(opts.message)}`];
    for (const b of opts.body ?? []) lines.push(`${c.dim(BAR)}  ${c.dim(b)}`);
    lines.push(
      ...sectionRows(
        choices,
        (choice, idx) => {
          const active = idx === cursor;
          const dot = active ? c.cyan(RADIO_ON) : c.dim(RADIO_OFF);
          const label = active ? c.cyanBold(choice.label) : choice.label;
          const hint = choice.hint ? `  ${c.dim(choice.hint)}` : "";
          return `${c.dim(BAR)}  ${dot} ${label}${hint}`;
        },
        c,
      ),
    );
    lines.push(`${c.dim(BAR)}  ${c.dim(opts.hint ?? "↑/↓ navigate · enter to select · esc to cancel")}`);
    return lines;
  };

  const collapse = (value: T | null): void => {
    const chosen = choices.find((ch) => ch.value === value);
    const summary = value === null ? c.dim("cancelled") : c.dim(chosen?.label ?? String(value));
    const lines = [c.dim(BAR), `${c.dim(STEP_DONE)}  ${opts.message}`, `${c.dim(BAR)}  ${summary}`];
    if (region.lastCount > 0) stdout.write(`${ESC}[${region.lastCount}A${ESC}[J`);
    writeLines(stdout, lines);
  };

  return new Promise<T | null>((resolve) => {
    hideCursor(stdout);
    repaint(stdout, region, build());
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      showCursor(stdout);
    };

    function onKey(_s: string | undefined, key: readline.Key): void {
      if (!key) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
        cleanup();
        collapse(null);
        resolve(null);
        return;
      }
      if (key.name === "up") {
        cursor = cursor > 0 ? cursor - 1 : choices.length - 1;
        repaint(stdout, region, build());
      } else if (key.name === "down") {
        cursor = cursor < choices.length - 1 ? cursor + 1 : 0;
        repaint(stdout, region, build());
      } else if (key.name === "return") {
        cleanup();
        collapse(choices[cursor].value);
        resolve(choices[cursor].value);
      }
    }

    stdin.on("keypress", onKey);
  });
}

// ── multiSelect (checklist) ────────────────────────────────────────────────────

export function multiSelect<T>(opts: MultiSelectOptions<T>): Promise<T[] | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const choices = opts.choices;
  const minSelected = opts.minSelected ?? 0;
  const checked = choices.map((ch) => !!ch.checked);

  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(choices.filter((_, i) => checked[i]).map((ch) => ch.value));
  }

  const c = paint(colorsEnabled(stdout));
  const region: Region = { lastCount: 0 };
  let cursor = 0;
  let warn = false;

  const build = (): string[] => {
    const lines: string[] = [c.dim(BAR), `${c.cyan(STEP_ACTIVE)}  ${c.bold(opts.message)}`];
    lines.push(
      ...sectionRows(
        choices,
        (choice, idx) => {
          const active = idx === cursor;
          const box = checked[idx] ? c.green(CHECK_ON) : c.dim(CHECK_OFF);
          const label = active ? c.cyanBold(choice.label) : checked[idx] ? choice.label : c.dim(choice.label);
          const hint = choice.hint ? `  ${c.dim(choice.hint)}` : "";
          return `${c.dim(BAR)}  ${box} ${label}${hint}`;
        },
        c,
      ),
    );
    if (warn) lines.push(`${c.dim(BAR)}  ${c.yellow(`Select at least ${minSelected}.`)}`);
    lines.push(`${c.dim(BAR)}  ${c.dim(opts.hint ?? "↑/↓ navigate · space to select · enter to confirm")}`);
    return lines;
  };

  const collapse = (values: T[] | null): void => {
    const summary =
      values === null
        ? c.dim("cancelled")
        : c.dim(
            choices
              .filter((ch) => values.includes(ch.value))
              .map((ch) => ch.label)
              .join(", ") || "none",
          );
    const lines = [c.dim(BAR), `${c.dim(STEP_DONE)}  ${opts.message}`, `${c.dim(BAR)}  ${summary}`];
    if (region.lastCount > 0) stdout.write(`${ESC}[${region.lastCount}A${ESC}[J`);
    writeLines(stdout, lines);
  };

  return new Promise<T[] | null>((resolve) => {
    hideCursor(stdout);
    repaint(stdout, region, build());
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      showCursor(stdout);
    };

    function onKey(_s: string | undefined, key: readline.Key): void {
      if (!key) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
        cleanup();
        collapse(null);
        resolve(null);
        return;
      }
      if (key.name === "up") {
        cursor = cursor > 0 ? cursor - 1 : choices.length - 1;
        repaint(stdout, region, build());
      } else if (key.name === "down") {
        cursor = cursor < choices.length - 1 ? cursor + 1 : 0;
        repaint(stdout, region, build());
      } else if (key.name === "space") {
        checked[cursor] = !checked[cursor];
        warn = false;
        repaint(stdout, region, build());
      } else if (key.ctrl && key.name === "a") {
        const allOn = checked.every(Boolean);
        for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
        repaint(stdout, region, build());
      } else if (key.name === "return") {
        const selected = choices.filter((_, i) => checked[i]).map((ch) => ch.value);
        if (selected.length < minSelected) {
          warn = true;
          repaint(stdout, region, build());
          return;
        }
        cleanup();
        collapse(selected);
        resolve(selected);
      }
    }

    stdin.on("keypress", onKey);
  });
}
