/**
 * Minimal clack-style TUI primitives for the `failproofai config` launcher,
 * dressed in the befailproof.ai identity: the pixel logomark opens the flow, and
 * the palette is pink-forward like the site — pink drives selection/enabled,
 * teal stays the flower on the mark and the step spine.
 *
 * A single continuous flow with a left gutter (│) threading through step nodes:
 * the active step shows as ◆, answered steps collapse to a persistent ◇ log
 * line, and the run ends on a └ outro. Two interactive prompts — `selectOne`
 * (radio) and `multiSelect` (checklist, windowed with a caret) — plus
 * `intro` / `outro`.
 *
 * Each prompt owns only its own render region (cursor-up + clear-to-end
 * repaint) and, on resolve, collapses that region to a one-line summary that
 * stays on screen — so the next prompt simply appends below, building the log.
 * No external dependencies. Honors NO_COLOR and non-TTY (returns the default
 * without drawing), and uses 24-bit color where COLORTERM advertises it,
 * falling back to the nearest basic ANSI hue otherwise.
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
  /** Noun used when collapsing many selections to a count (e.g. "assistants"). */
  summaryNoun?: string;
  stdin?: TTYIn;
  stdout?: TTYOut;
}

const ESC = "\x1B";

// ── glyphs ────────────────────────────────────────────────────────────────
// Exported so the other branded prompts (install-prompt.ts) share the exact
// same set instead of hand-syncing copies.
export const BAR = "│";
const BAR_END = "└";
export const STEP_ACTIVE = "◆";
export const STEP_DONE = "◇";
const RADIO_ON = "●";
const RADIO_OFF = "○";
export const CHECK_ON = "◼";
export const CHECK_OFF = "◻";
export const CARET = "❯";
const FLOWER = "❋";

// ── color ─────────────────────────────────────────────────────────────────
// The single source of truth for the brand palette — exported (via `paint`)
// so the other branded prompts (install-prompt.ts) reuse it instead of
// re-deriving their own copies.
interface Hue {
  rgb: [number, number, number];
  basic: string;
}
const HUES = {
  guide: { rgb: [102, 209, 181], basic: "36" }, // teal — the policy flower / step spine
  pink: { rgb: [255, 46, 136], basic: "95" }, // hot pink — selection, enabled, the brand
  logoPink: { rgb: [228, 88, 124], basic: "95" }, // the softer artwork pink of the logomark
  warn: { rgb: [227, 179, 65], basic: "33" },
  dim: { rgb: [107, 118, 132], basic: "2" },
} satisfies Record<string, Hue>;

export function colorsEnabled(out: TTYOut): boolean {
  return !!out.isTTY && !process.env.NO_COLOR;
}
function truecolorEnabled(): boolean {
  return /truecolor|24bit/i.test(process.env.COLORTERM || "");
}

/** Brand painter: role-named color functions, truecolor where advertised,
 * basic-ANSI fallback otherwise, identity when `on` is false. */
export function paint(on: boolean) {
  const tc = on && truecolorEnabled();
  const mk =
    (h: Hue, bold = false) =>
    (s: string): string => {
      if (!on) return s;
      const code = tc ? `38;2;${h.rgb[0]};${h.rgb[1]};${h.rgb[2]}` : h.basic;
      return `${ESC}[${bold ? "1;" : ""}${code}m${s}${ESC}[0m`;
    };
  return {
    bold: (s: string) => (on ? `${ESC}[1m${s}${ESC}[0m` : s),
    dim: mk(HUES.dim),
    guide: mk(HUES.guide),
    pink: mk(HUES.pink),
    pinkBold: mk(HUES.pink, true),
    softPink: mk(HUES.logoPink),
    warn: mk(HUES.warn),
  };
}

// ── brand logo (befailproof.ai logomark) ────────────────────────────────────
// Half-block rendition of the real site mark — the teal flower, the pink cross,
// and the tall bar joined at the base — downscaled from the actual artwork so it
// stays faithful at terminal size. Each character cell packs two vertical pixels
// (▀ top, ▄ bottom); `t` = teal, `p` = pink, `.` = transparent. Shown when
// there's room, else a compact one-liner.
const LOGO_MIN_COLS = 22;
const TAGLINE = "end-to-end failure layer for ai agents";

const LOGO_GRID = [
  "...tt...........",
  "..tttt..........",
  ".tttttt.........",
  ".tttttt.....ppp.",
  "..tttt......ppp.",
  "...tt.......ppp.",
  "............ppp.",
  "............ppp.",
  "..pppp......ppp.",
  "..pppp......ppp.",
  "..pppp......ppp.",
  ".pppppp.....ppp.",
  ".pppppp.....ppp.",
  ".pppppp.....ppp.",
  ".pppppp.....ppp.",
  "..pppp......ppp.",
  "..pppp......ppp.",
  "..pppp......ppp.",
  "..ppppppppppppp.",
  "..ppppppppppppp.",
  "..ppppppppppppp.",
  "..ppppppppppppp.",
];
// Derived from the shared HUES table so a palette tweak needs one edit.
const LOGO_TEAL: [number, number, number] = HUES.guide.rgb;
const LOGO_PINK: [number, number, number] = HUES.logoPink.rgb;

/** Render the logomark as half-block art. When `colorize` is false (no truecolor
 * / NO_COLOR) the shape still prints, just monochrome. */
function renderLogo(colorize: boolean): string[] {
  const pad = ".".repeat(LOGO_GRID[0]?.length ?? 0);
  const rgb = (ch: string): [number, number, number] | null =>
    ch === "t" ? LOGO_TEAL : ch === "p" ? LOGO_PINK : null;
  const lines: string[] = [];
  for (let r = 0; r < LOGO_GRID.length; r += 2) {
    const top = LOGO_GRID[r];
    const bot = LOGO_GRID[r + 1] ?? pad;
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = rgb(top[x]);
      const b = rgb(bot[x]);
      if (!t && !b) {
        line += " ";
      } else if (!colorize) {
        line += t && b ? "█" : t ? "▀" : "▄";
      } else if (t && b) {
        line +=
          t === b
            ? `${ESC}[38;2;${t.join(";")}m█${ESC}[0m`
            : `${ESC}[38;2;${t.join(";")};48;2;${b.join(";")}m▀${ESC}[0m`;
      } else if (t) {
        line += `${ESC}[38;2;${t.join(";")}m▀${ESC}[0m`;
      } else {
        line += `${ESC}[38;2;${b!.join(";")}m▄${ESC}[0m`;
      }
    }
    lines.push(line);
  }
  return lines;
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** Truncate a line to `width` visual columns, skipping ANSI CSI sequences.
 * Exported so install-prompt.ts shares it instead of keeping local copies. */
export function truncate(line: string, width: number): string {
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

/** Truncate PLAIN text to `width`, ending on a single ellipsis rather than a
 * mid-word hard cut. Assumes no ANSI inside `text` (hints/labels are plain). */
export function ellipsize(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return text.slice(0, width - 1).trimEnd() + "…";
}

/** Collapse many labels to a readable summary: a full join for a few, a
 * `N noun · a, b, c +K` count for many. */
export function summarize(labels: string[], noun = "selected"): string {
  if (labels.length === 0) return "none";
  if (labels.length <= 3) return labels.join(", ");
  const head = labels.slice(0, 3).join(", ");
  return `${labels.length} ${noun} · ${head} +${labels.length - 3}`;
}

function writeLines(out: TTYOut, lines: string[]): void {
  const cols = out.columns || 80;
  out.write(lines.map((l) => (l === "" ? l : truncate(l, cols))).join("\n") + "\n");
}

// ── framing ─────────────────────────────────────────────────────────────────

/** The logomark + wordmark + tagline block (with a 2-space margin), color-aware.
 *  Shared by the wizard intro and the dashboard launch banner. On a too-narrow
 *  target it collapses to a single compact line. */
export function renderBrandLogo(stdout: TTYOut = process.stdout): string[] {
  const c = paint(colorsEnabled(stdout));
  const cols = stdout.columns || 80;
  if (cols < LOGO_MIN_COLS) {
    return [`${c.guide(FLOWER)} fa${c.pink("il")}proof ai  ${c.dim("· " + TAGLINE)}`];
  }
  const tc = colorsEnabled(stdout) && truecolorEnabled();
  const lines = renderLogo(tc).map((l) => `  ${l}`);
  lines.push("");
  lines.push(`  fa${c.pink("il")}proof ai`);
  lines.push(`  ${c.dim(TAGLINE)}`);
  return lines;
}

/** Print the flow header — the brand logo, tagline, and the opening step. */
export function intro(message: string, stdout: TTYOut = process.stdout): void {
  if (!stdout.isTTY) return;
  const c = paint(colorsEnabled(stdout));
  const lines: string[] = ["", ...renderBrandLogo(stdout)];
  lines.push(c.dim(BAR));
  lines.push(`${c.guide(STEP_ACTIVE)}  ${c.bold(message)}`);
  writeLines(stdout, lines);
}

/** The branded splash the dashboard prints on launch — logomark, wordmark, and a
 *  tidy version/links column. Returned as ready-to-print lines (caller writes
 *  them). Degrades to plain text off a TTY so it stays clean in piped logs. */
export function renderLaunchBanner(version: string, stdout: TTYOut = process.stdout): string[] {
  // paint() is identity when colors are off, so the link rows are built once
  // and only the header block differs between TTY and piped output.
  const c = paint(colorsEnabled(stdout));
  const row = (label: string, value: string) => `  ${c.guide(label.padEnd(9))}${value}`;
  const header = stdout.isTTY
    ? renderBrandLogo(stdout)
    : ["  failproof ai", `  ${TAGLINE}`];
  return [
    "",
    ...header,
    "",
    row("version", c.pink(version)),
    row("star", c.dim("https://github.com/failproofai/failproofai")),
    row("docs", c.dim("https://docs.befailproof.ai/introduction")),
    row("discord", c.dim("https://discord.gg/2zjBZP7yQJ")),
    "",
  ];
}

/** Close the flow with a terminating └ line — pink on success, dim on cancel. */
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
  const end = ok ? c.pink(BAR_END) : c.dim(BAR_END);
  const text = ok ? c.pink(message) : c.dim(message);
  writeLines(stdout, [c.dim(BAR), `${end}  ${text}`]);
}

// ── shared render engine ─────────────────────────────────────────────────────

type Region = { lastCount: number };

const WINDOW = 8; // visible rows before the checklist scrolls

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

/** Shared width for the label column so hints align into a second column. */
function nameWidth(labels: string[]): number {
  return Math.min(24, Math.max(6, ...labels.map((l) => l.length)));
}

type DisplayRow = { kind: "header"; text: string } | { kind: "item"; index: number };

/** Flatten choices into section-header + item display rows. */
function displayRows(choices: Array<{ section?: string }>): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let lastSection: string | undefined;
  choices.forEach((choice, index) => {
    if (choice.section && choice.section !== lastSection) {
      lastSection = choice.section;
      rows.push({ kind: "header", text: choice.section });
    }
    rows.push({ kind: "item", index });
  });
  return rows;
}

/** Compute a viewport window over display rows, centred on the cursor row. */
function viewport(rows: DisplayRow[], cursorRow: number, window: number) {
  if (rows.length <= window) return { start: 0, end: rows.length };
  let start = cursorRow - Math.floor(window / 2);
  start = Math.max(0, Math.min(start, rows.length - window));
  return { start, end: start + window };
}

// ── shared prompt engine ──────────────────────────────────────────────────────
// One copy of the raw-mode keypress loop, viewport frame, and ◇ collapse shared
// by selectOne and multiSelect — the two prompts differ only in row glyphs and
// non-navigation key handling.

interface PromptSpec<R> {
  stdin: TTYIn;
  stdout: TTYOut;
  message: string;
  c: ReturnType<typeof paint>;
  /** Static info lines rendered under the question. */
  body?: string[];
  choices: Array<{ label: string; section?: string }>;
  /** Row content after the gutter, e.g. "● Label  hint". */
  renderRow: (index: number, active: boolean, budget: number) => string;
  /** Extra line(s) above the footer (e.g. a min-selected warning). */
  warnLine?: () => string | null;
  footer: string;
  /** Handle non-navigation keys. `{done}` finishes, `"redraw"` repaints. */
  onKey: (key: readline.Key, cursor: number) => { done: R } | "redraw" | undefined;
  /** One-line ◇ summary for the collapsed log entry. */
  summaryFor: (result: R | null) => string;
}

function runPrompt<R>(p: PromptSpec<R>): Promise<R | null> {
  const { stdin, stdout, c, choices } = p;
  const region: Region = { lastCount: 0 };
  const nameCol = nameWidth(choices.map((ch) => ch.label));
  let cursor = 0;

  const build = (): string[] => {
    const cols = stdout.columns || 80;
    const lines: string[] = [c.dim(BAR), `${c.guide(STEP_ACTIVE)}  ${c.bold(p.message)}`];
    for (const b of p.body ?? []) lines.push(`${c.dim(BAR)}  ${c.dim(b)}`);

    const rows = displayRows(choices);
    let cursorRow = 0;
    rows.forEach((r, ri) => {
      if (r.kind === "item" && r.index === cursor) cursorRow = ri;
    });
    const { start, end } = viewport(rows, cursorRow, WINDOW);
    const above = rows.slice(0, start).filter((r) => r.kind === "item").length;
    const below = rows.slice(end).filter((r) => r.kind === "item").length;
    if (above > 0) lines.push(`${c.dim(BAR)}    ${c.dim(`↑ ${above} more`)}`);

    const budget = Math.max(6, cols - nameCol - 10);
    for (let ri = start; ri < end; ri++) {
      const row = rows[ri];
      if (row.kind === "header") {
        lines.push(`${c.dim(BAR)}  ${c.dim(row.text)}`);
      } else {
        lines.push(`${c.dim(BAR)}  ${p.renderRow(row.index, row.index === cursor, budget)}`);
      }
    }
    if (below > 0) lines.push(`${c.dim(BAR)}    ${c.dim(`↓ ${below} more`)}`);

    const warn = p.warnLine?.();
    if (warn) lines.push(`${c.dim(BAR)}  ${warn}`);
    lines.push(`${c.dim(BAR)}  ${c.dim(p.footer)}`);
    return lines;
  };

  const collapse = (result: R | null): void => {
    repaint(stdout, region, [
      c.dim(BAR),
      `${c.dim(STEP_DONE)}  ${p.message}`,
      `${c.dim(BAR)}  ${c.dim(p.summaryFor(result))}`,
    ]);
  };

  return new Promise<R | null>((resolve) => {
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
    const finish = (result: R | null) => {
      cleanup();
      collapse(result);
      resolve(result);
    };

    function onKey(_s: string | undefined, key: readline.Key): void {
      if (!key) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
        finish(null);
      } else if (key.name === "up") {
        cursor = cursor > 0 ? cursor - 1 : choices.length - 1;
        repaint(stdout, region, build());
      } else if (key.name === "down") {
        cursor = cursor < choices.length - 1 ? cursor + 1 : 0;
        repaint(stdout, region, build());
      } else {
        const outcome = p.onKey(key, cursor);
        if (outcome === "redraw") repaint(stdout, region, build());
        else if (outcome) finish(outcome.done);
      }
    }

    stdin.on("keypress", onKey);
  });
}

// ── selectOne (radio) ─────────────────────────────────────────────────────────

export function selectOne<T>(opts: SelectOneOptions<T>): Promise<T | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const choices = opts.choices;

  // Guard empty choices before the TTY branch too — otherwise the Enter handler
  // dereferences choices[0].value on a TTY. Matches the non-TTY null behavior.
  if (!choices.length) return Promise.resolve(null);

  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(choices[0].value);
  }

  const c = paint(colorsEnabled(stdout));
  const nameCol = nameWidth(choices.map((ch) => ch.label));

  return runPrompt<T>({
    stdin,
    stdout,
    message: opts.message,
    c,
    body: opts.body,
    choices,
    renderRow: (index, active, budget) => {
      const choice = choices[index];
      const dot = active ? c.pink(RADIO_ON) : c.dim(RADIO_OFF);
      const rawLabel = choice.label.padEnd(nameCol);
      const label = active ? c.pinkBold(rawLabel) : rawLabel;
      const hint = choice.hint ? `  ${c.dim(ellipsize(choice.hint, budget))}` : "";
      return `${dot} ${label}${hint}`;
    },
    footer: "↑/↓ navigate · enter to select · esc to cancel",
    onKey: (key, cursor) =>
      key.name === "return" ? { done: choices[cursor].value } : undefined,
    summaryFor: (value) =>
      value === null
        ? "cancelled"
        : (choices.find((ch) => ch.value === value)?.label ?? String(value)),
  });
}

// ── multiSelect (checklist) ────────────────────────────────────────────────────

export function multiSelect<T>(opts: MultiSelectOptions<T>): Promise<T[] | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const choices = opts.choices;
  const minSelected = opts.minSelected ?? 0;
  const noun = opts.summaryNoun ?? "selected";
  const checked = choices.map((ch) => !!ch.checked);

  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(choices.filter((_, i) => checked[i]).map((ch) => ch.value));
  }

  const c = paint(colorsEnabled(stdout));
  const nameCol = nameWidth(choices.map((ch) => ch.label));
  let warn = false;

  return runPrompt<T[]>({
    stdin,
    stdout,
    message: opts.message,
    c,
    choices,
    renderRow: (index, active, budget) => {
      const choice = choices[index];
      const caret = active ? c.pink(CARET) : " ";
      const box = checked[index] ? c.pink(CHECK_ON) : c.dim(CHECK_OFF);
      const rawLabel = choice.label.padEnd(nameCol);
      const label = active ? c.pinkBold(rawLabel) : checked[index] ? rawLabel : c.dim(rawLabel);
      const hint = choice.hint ? `  ${c.dim(ellipsize(choice.hint, budget))}` : "";
      return `${caret} ${box} ${label}${hint}`;
    },
    warnLine: () => (warn ? c.warn(`Select at least ${minSelected}.`) : null),
    footer: opts.hint ?? "↑/↓ move · space select · ctrl+a all · enter confirm",
    onKey: (key, cursor) => {
      if (key.name === "space") {
        checked[cursor] = !checked[cursor];
        warn = false;
        return "redraw";
      }
      if (key.ctrl && key.name === "a") {
        const allOn = checked.every(Boolean);
        for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
        return "redraw";
      }
      if (key.name === "return") {
        const selected = choices.filter((_, i) => checked[i]).map((ch) => ch.value);
        if (selected.length < minSelected) {
          warn = true;
          return "redraw";
        }
        return { done: selected };
      }
      return undefined;
    },
    summaryFor: (values) =>
      values === null
        ? "cancelled"
        : summarize(
            choices.filter((ch) => values.includes(ch.value)).map((ch) => ch.label),
            noun,
          ),
  });
}
