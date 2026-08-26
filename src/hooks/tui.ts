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
 * without drawing), and paints at the deepest tier the terminal admits to —
 * 24-bit, the xterm-256 cube, or the 16 basic ANSI hues.
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
  /** Offer ← to go back a step. The caller must handle `BACK`. */
  allowBack?: boolean;
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
  /**
   * Render as un-togglable and ignore space on it. For rows that report a
   * state rather than offer a choice — a checkbox the user can click but that
   * changes nothing is worse than no checkbox. Locked rows default to checked;
   * set `checked: false` for a locked row that reports "nothing here yet".
   */
  locked?: boolean;
  /**
   * Keep this row out of the "N selected · a, b, c" summary line. For selector
   * rows ("Everything available") and status rows ("Custom") that are not
   * themselves one of the things being counted.
   */
  summaryExclude?: boolean;
}

export interface MultiSelectOptions<T> {
  /** Offer ← to go back a step. The caller must handle `BACK`. */
  allowBack?: boolean;
  /**
   * Called with what was ticked at the moment ← was pressed.
   *
   * `BACK` is a symbol, so it cannot carry a value, and the selection lives in a
   * local array here rather than on the caller's choice objects — so a caller had
   * no way to learn what a user had toggled before stepping back. The wizard's
   * harness step needs exactly that: without it, deselecting a CLI and pressing ←
   * discards the deselection, the step is redrawn from the detected defaults, and
   * confirming re-enables hook installation for a CLI the user explicitly turned
   * off.
   *
   * OPTIONAL and additive rather than a change to the return type: `BACK` is
   * shared with `selectOne` and every other caller, and widening that contract to
   * fix one step's state would be a much larger surface than the bug.
   */
  onBack?: (checkedNow: T[]) => void;
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
const MARK = "\u25AE\u25AE"; // ▮▮ — the brand mark, per the design system

// ── color ─────────────────────────────────────────────────────────────────
// The single source of truth for the brand palette — exported (via `paint`)
// so the other branded prompts (install-prompt.ts) reuse it instead of
// re-deriving their own copies.
interface Hue {
  rgb: [number, number, number];
  /**
   * xterm-256 index for the middle tier, verified as the nearest cube entry by
   * Euclidean distance rather than eyeballed.
   *
   * Optional because `dim` has no honest answer: its `basic` is SGR 2, an
   * ATTRIBUTE that steps down whatever foreground the user's theme is already
   * using, and the cube's nearest grey (243, #767676) is a fixed colour that
   * fights every theme that is not ours. So dim keeps the attribute at all
   * three tiers and this stays undefined.
   */
  c256?: number;
  basic: string;
}
/**
 * TWO accent hues and no third — the brand system states that as a rule, and
 * this table used to break it: `pink` was #ff2e88, a hot pink that appears in
 * no brand token, sitting beside `logoPink` #e4587d which was the real one. The
 * mark and the prompts were therefore two different pinks, and neither surface
 * could be recoloured without the other drifting. There is now one pink.
 * Everything past the two accents is a state — amber for warn, an attribute for
 * dim — never identity.
 */
const HUES = {
  guide: { rgb: [102, 209, 181], c256: 79, basic: "36" }, // #66d1b5 mint — the policy flower / step spine
  pink: { rgb: [228, 88, 125], c256: 168, basic: "95" }, // #e4587d — selection, enabled, the mark, the brand
  warn: { rgb: [227, 179, 65], c256: 179, basic: "33" },
  dim: { rgb: [107, 118, 132], basic: "2" },
} satisfies Record<string, Hue>;

export function colorsEnabled(out: TTYOut): boolean {
  return !!out.isTTY && !process.env.NO_COLOR;
}

/**
 * The raw ANSI opening sequence for a brand role, for callers that assemble
 * their own strings instead of using `paint()`'s wrappers (`src/audit/cli.ts`).
 * That file previously hardcoded its own 256-colour palette — a green and a
 * blue that appear nowhere in the brand — so `audit` looked like a different
 * product from `config`. Routing it here
 * keeps HUES the single source of truth: change a hue once and every surface
 * follows. Paints at the deepest tier the terminal admits to; the caller still
 * decides *whether* to colour at all.
 */
export function brandAnsi(role: keyof typeof HUES): string {
  return `${ESC}[${fg(HUES[role], colorTier())}m`;
}

export const ANSI_RESET = `${ESC}[0m`;
export const ANSI_BOLD = `${ESC}[1m`;
export const ANSI_DIM = `${ESC}[2m`;

/** How much colour this terminal will actually render. */
type ColorTier = "truecolor" | "ansi256" | "basic";

/**
 * Three tiers, because the two-way gate skipped the one most terminals are in.
 *
 * COLORTERM-or-nothing sent every terminal that renders 256 colours but does
 * not advertise 24-bit — tmux and screen, ssh into a stock xterm, most CI
 * runners — all the way down to the 16 basic hues, where the brand pink lands
 * on generic bright magenta and the mint on generic cyan. TERM naming its own
 * depth is the signal those terminals do set, and it costs one regex.
 *
 * Deliberately no `FORCE_COLOR` / `-256color`-less allowlist: over-claiming a
 * depth prints raw escape bytes into the user's scrollback, which is worse than
 * an approximate hue. Under-claiming only costs fidelity.
 */
function colorTier(): ColorTier {
  if (/truecolor|24bit/i.test(process.env.COLORTERM || "")) return "truecolor";
  if (/256color/i.test(process.env.TERM || "")) return "ansi256";
  return "basic";
}

/** SGR foreground parameters for a hue at a tier. The ONE place a hue turns
 *  into bytes, so a new tier is added here and nowhere else. */
function fg(h: Hue, tier: ColorTier): string {
  if (tier === "truecolor") return `38;2;${h.rgb[0]};${h.rgb[1]};${h.rgb[2]}`;
  if (tier === "ansi256" && h.c256 !== undefined) return `38;5;${h.c256}`;
  return h.basic;
}

/** The same as a background — only the logomark needs one, for a half-block
 *  cell whose two pixels are different hues. The current grid has no such cell
 *  (the flower and the cross never share a column), so this is here for the
 *  next grid edit, which the rules above LOGO_GRID actively invite. Never
 *  called at the basic tier: the mark draws monochrome there rather than
 *  approximate two brand hues with ANSI 5 and 6. */
function bg(h: Hue, tier: ColorTier): string {
  return tier === "ansi256" && h.c256 !== undefined
    ? `48;5;${h.c256}`
    : `48;2;${h.rgb[0]};${h.rgb[1]};${h.rgb[2]}`;
}

/** Brand painter: role-named color functions at the terminal's best tier,
 * identity when `on` is false. */
export function paint(on: boolean) {
  const tier: ColorTier = on ? colorTier() : "basic";
  const mk =
    (h: Hue, bold = false) =>
    (s: string): string => {
      if (!on) return s;
      return `${ESC}[${bold ? "1;" : ""}${fg(h, tier)}m${s}${ESC}[0m`;
    };
  return {
    bold: (s: string) => (on ? `${ESC}[1m${s}${ESC}[0m` : s),
    dim: mk(HUES.dim),
    guide: mk(HUES.guide),
    pink: mk(HUES.pink),
    pinkBold: mk(HUES.pink, true),
    // An ALIAS of `pink`, not a hue. The logomark's softer artwork tint
    // collapsed into the one brand pink, so this name survives only for its
    // single caller — install-prompt.ts's "beta" pill — and should be renamed
    // to `pink` there, at which point it is deleted.
    softPink: mk(HUES.pink),
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

// Three editing rules, all learned the hard way:
//   1. The two uprights must be the SAME width. In the artwork both are 93px of
//      a 379px canvas; an earlier grid drew the right one a column narrower and
//      it read as a mistake at every terminal size.
//   2. Keep the uprights an EVEN number of columns. They are 4 here, so the
//      flower and cross — which are centred on them — can use even widths and
//      taper 2→4→6. An odd upright forces odd widths (1/3/5), which pinches the
//      flower to a one-column tip and makes it read as a spike, not a bloom.
//   3. A colour boundary on an ODD row renders mid-cell (▀/▄). That is what
//      rounds the cross's corners, so the cross starts on an odd row — but the
//      same thing at the flower's edge leaves it looking detached, so the
//      flower and the base bar stay on even boundaries.
// Shrinking this means choosing a vertical element to spend, and the printed
// height moves in whole lines (2 grid rows) — the cross in particular needs 4
// rows to keep both rounded edges AND its solid middle; at 3 it loses the
// bottom edge and goes lopsided. This grid spends the stem (the short upright
// between cross and base), so the cross meets the base directly. Adding it back
// costs one line and restores the original exactly, 3 columns narrower.
const LOGO_GRID = [
  "...tt........",
  "..tttt.......",
  ".tttttt..pppp",
  ".tttttt..pppp",
  "..tttt...pppp",
  "...tt....pppp",
  ".........pppp",
  ".........pppp",
  "..pppp...pppp",
  "..pppp...pppp",
  "..pppp...pppp",
  ".pppppp..pppp",
  ".pppppp..pppp",
  ".pppppp..pppp",
  ".pppppp..pppp",
  "..pppp...pppp",
  "..ppppppppppp",
  "..ppppppppppp",
  "..ppppppppppp",
  "..ppppppppppp",
];
// Derived from the shared HUES table so a palette tweak needs one edit. The
// mark is painted from the SAME two accents as the prompts — it used to carry
// its own pink, which is how the two drifted apart.
const LOGO_TEAL: Hue = HUES.guide;
const LOGO_PINK: Hue = HUES.pink;

/** Render the logomark as half-block art. At the `basic` tier (16 colours, or
 * NO_COLOR) the shape still prints, just monochrome — approximating two brand
 * hues with generic magenta and cyan reads as a different mark, and the shape
 * alone already carries it. */
function renderLogo(tier: ColorTier): string[] {
  const pad = ".".repeat(LOGO_GRID[0]?.length ?? 0);
  const hue = (ch: string): Hue | null => (ch === "t" ? LOGO_TEAL : ch === "p" ? LOGO_PINK : null);
  const lines: string[] = [];
  for (let r = 0; r < LOGO_GRID.length; r += 2) {
    const top = LOGO_GRID[r];
    const bot = LOGO_GRID[r + 1] ?? pad;
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = hue(top[x]);
      const b = hue(bot[x]);
      if (!t && !b) {
        line += " ";
      } else if (tier === "basic") {
        line += t && b ? "█" : t ? "▀" : "▄";
      } else if (t && b) {
        line +=
          t === b
            ? `${ESC}[${fg(t, tier)}m█${ESC}[0m`
            : `${ESC}[${fg(t, tier)};${bg(b, tier)}m▀${ESC}[0m`;
      } else if (t) {
        line += `${ESC}[${fg(t, tier)}m▀${ESC}[0m`;
      } else {
        line += `${ESC}[${fg(b!, tier)}m▄${ESC}[0m`;
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
    return [`${c.pink(MARK)} fa${c.pink("il")}proof ai  ${c.dim("· " + TAGLINE)}`];
  }
  // NO_COLOR / non-TTY forces `basic`, which renderLogo draws monochrome — so
  // the mark never emits an escape byte on a stream that asked for none.
  const tier: ColorTier = colorsEnabled(stdout) ? colorTier() : "basic";
  const lines = renderLogo(tier).map((l) => `  ${l}`);
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
    row("discord", c.dim("https://discord.befailproof.ai/")),
    row("reddit", c.dim("https://www.reddit.com/r/failproofai/")),
    "",
  ];
}

/**
 * Print a step that is already SETTLED — the `◇ / message / summary` block
 * `selectOne` leaves behind when it resolves.
 *
 * Extracted because a flow assembled out of `promptText` had no way to show its
 * own history: `intro` opens the spine and `outro` closes it, and everything in
 * between was bare lines that made the frame look like it belonged to a
 * different command. `summary` is the answer, dimmed under the question, which
 * is what makes a completed step readable at a glance rather than a heading
 * with nothing under it.
 */
export function step(
  message: string,
  summary?: string | string[],
  stdout: TTYOut = process.stdout,
): void {
  const c = paint(colorsEnabled(stdout));
  const rows = summary === undefined ? [] : Array.isArray(summary) ? summary : [summary];
  if (!stdout.isTTY) {
    if (rows.length) stdout.write(`${message}: ${rows.join(" ")}\n`);
    return;
  }
  // Truncated to the terminal, because a summary that wraps loses the spine on
  // its second row and the block stops reading as one step.
  const cols = stdout.columns || 80;
  const lines = [c.dim(BAR), truncate(`${c.dim(STEP_DONE)}  ${message}`, cols - 1)];
  for (const r of rows) lines.push(truncate(`${c.dim(BAR)}  ${c.dim(r)}`, cols - 1));
  writeLines(stdout, lines);
}

/**
 * Open a step and leave the cursor on it, for a prompt that draws its own line.
 *
 * The counterpart to {@link step}: `◆` in teal with the question in bold, then
 * a spine row the prompt is expected to hang off via `PromptTextOptions.prefix`.
 */
export function stepOpen(message: string, stdout: TTYOut = process.stdout): void {
  const c = paint(colorsEnabled(stdout));
  if (!stdout.isTTY) return;
  writeLines(stdout, [c.dim(BAR), `${c.guide(STEP_ACTIVE)}  ${c.bold(message)}`]);
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

/**
 * Redraw the region as ONE atomic frame.
 *
 * Two things make it atomic, and both are needed. The cursor-up-and-clear used
 * to be its own `write()`, so a terminal could render the CLEARED state before
 * the new lines arrived — a blank flash on every keystroke, invisible locally
 * and obvious over SSH or inside tmux, where the two writes cross a network or
 * a multiplexer between frames. They are one string now.
 *
 * And that string is wrapped in synchronized output (DECSET 2026), which tells
 * the terminal to hold what it has until the reset rather than painting each
 * chunk as it lands. Terminals that do not implement it ignore an unknown
 * private mode, so it costs nothing where it does not help.
 */
function repaint(out: TTYOut, region: Region, lines: string[]): void {
  const cols = out.columns || 80;
  const body = lines.map((l) => (l === "" ? l : truncate(l, cols))).join("\n") + "\n";
  const clear = region.lastCount > 0 ? `${ESC}[${region.lastCount}A${ESC}[J` : "";
  out.write(`${ESC}[?2026h${clear}${body}${ESC}[?2026l`);
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

/**
 * The hint budget for one row, after a label that outgrew its column.
 *
 * `nameWidth` caps the name column at 24 so that one long name cannot squeeze
 * every description on screen — but `padEnd` pads, it does not TRUNCATE, so a
 * longer name renders at its true width while the description was sized against
 * the cap. The row then overruns the terminal by the difference and the
 * description is cut by the terminal instead of by `ellipsize`, with no `…` to
 * show it happened.
 *
 * Names are deliberately not truncated: a policy name is the thing you type
 * next, and half of one is useless. The description gives up the space, because
 * it is prose and shortening prose costs nothing.
 */
function hintBudget(label: string, nameCol: number, budget: number): number {
  return Math.max(6, budget - Math.max(0, label.length - nameCol));
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
  /** When set, ← resolves `BACK` so the caller can step backwards. */
  allowBack?: boolean;
  /** Called just before ← resolves, so a caller can keep in-progress state. */
  onBack?: () => void;
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
    // BACK is handled HERE, not in each `summaryFor`, because it is not a value
    // of `R` at all — it is a sentinel the shared key handler injects, so every
    // prompt would otherwise have to know about a symbol it never declared.
    //
    // Both existing callers got it wrong in different ways, and one of them
    // hung: `multiSelect`'s summary calls `values.includes(...)`, which throws
    // `TypeError` on a symbol — and it throws INSIDE `finish`, before
    // `resolve(result)`, so pressing ← never settled the promise and the wizard
    // stopped responding entirely. `selectOne` fell through to `String(value)`
    // and rendered the literal text `Symbol(failproofai.back)`.
    const summary = (result as unknown) === BACK ? "back" : p.summaryFor(result);
    repaint(stdout, region, [
      c.dim(BAR),
      `${c.dim(STEP_DONE)}  ${p.message}`,
      `${c.dim(BAR)}  ${c.dim(summary)}`,
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
      } else if (key.name === "left" && p.allowBack) {
        // Only when the caller opted in. A prompt with nowhere to go back TO
        // must not appear to offer it.
        //
        // Reported BEFORE finishing, because `finish` collapses the prompt and
        // resolves — after that the selection is gone and the caller is already
        // running.
        p.onBack?.();
        finish(BACK as unknown as never);
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

/**
 * Returned by a prompt when the user asked to go BACK a step, as distinct from
 * cancelling. Both used to be `null`, which made "I picked the wrong scope" and
 * "I want out" the same keystroke — so the only way to change an earlier answer
 * was to abandon setup and start over.
 *
 * A symbol rather than a sentinel string because a caller's value type is its
 * own: `selectOne<string>` could legitimately have "back" as a real choice.
 */
export const BACK: unique symbol = Symbol("failproofai.back");
export type Back = typeof BACK;

// Overloaded so `BACK` appears in the return type ONLY where it was asked for.
// Widening every caller to `T | Back | null` would make dozens of call sites
// handle a value they can never receive.
export function selectOne<T>(opts: SelectOneOptions<T> & { allowBack: true }): Promise<T | Back | null>;
export function selectOne<T>(opts: SelectOneOptions<T>): Promise<T | null>;
export function selectOne<T>(opts: SelectOneOptions<T>): Promise<T | Back | null> {
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
      const hint = choice.hint
        ? `  ${c.dim(ellipsize(choice.hint, hintBudget(choice.label, nameCol, budget)))}`
        : "";
      return `${dot} ${label}${hint}`;
    },
    allowBack: opts.allowBack,
    footer: opts.allowBack
      ? "↑/↓ navigate · enter to select · ← back · esc to cancel"
      : "↑/↓ navigate · enter to select · esc to cancel",
    onKey: (key, cursor) =>
      key.name === "return" ? { done: choices[cursor].value } : undefined,
    summaryFor: (value) =>
      value === null
        ? "cancelled"
        : (choices.find((ch) => ch.value === value)?.label ?? String(value)),
  });
}

// ── multiSelect (checklist) ────────────────────────────────────────────────────

export function multiSelect<T>(opts: MultiSelectOptions<T> & { allowBack: true }): Promise<T[] | null | Back>;
export function multiSelect<T>(opts: MultiSelectOptions<T>): Promise<T[] | null>;
export function multiSelect<T>(opts: MultiSelectOptions<T>): Promise<T[] | null | Back> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const choices = opts.choices;
  const minSelected = opts.minSelected ?? 0;
  const noun = opts.summaryNoun ?? "selected";
  // A locked row defaults to on, but may opt out with an explicit `checked:false`.
  const checked = choices.map((ch) => (ch.locked ? (ch.checked ?? true) : !!ch.checked));

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
      // Locked rows use the teal guide hue rather than selection pink, so they
      // read as "already true" instead of "you picked this"; an unchecked
      // locked row is a dim empty box — nothing there yet.
      const box = choice.locked
        ? checked[index]
          ? c.guide(CHECK_ON)
          : c.dim(CHECK_OFF)
        : checked[index]
          ? c.pink(CHECK_ON)
          : c.dim(CHECK_OFF);
      const rawLabel = choice.label.padEnd(nameCol);
      const label = active ? c.pinkBold(rawLabel) : checked[index] ? rawLabel : c.dim(rawLabel);
      const hint = choice.hint
        ? `  ${c.dim(ellipsize(choice.hint, hintBudget(choice.label, nameCol, budget)))}`
        : "";
      return `${caret} ${box} ${label}${hint}`;
    },
    warnLine: () => (warn ? c.warn(`Select at least ${minSelected}.`) : null),
    allowBack: opts.allowBack,
    // Reads the SAME `checked` array the prompt is driving, so what the caller
    // learns is exactly what was on screen when ← was pressed.
    onBack: opts.onBack
      ? () => opts.onBack?.(choices.filter((_, i) => checked[i]).map((ch) => ch.value))
      : undefined,
    footer:
      opts.hint ??
      (opts.allowBack
        ? "↑/↓ move · space select · ctrl+a all · ← back · enter confirm"
        : "↑/↓ move · space select · ctrl+a all · enter confirm"),
    onKey: (key, cursor) => {
      if (key.name === "space") {
        if (choices[cursor]?.locked) return "redraw"; // always on — not a choice
        checked[cursor] = !checked[cursor];
        warn = false;
        return "redraw";
      }
      if (key.ctrl && key.name === "a") {
        const allOn = choices.every((ch, i) => checked[i] || ch.locked);
        for (let i = 0; i < checked.length; i++) {
          checked[i] = choices[i]?.locked ? true : !allOn;
        }
        return "redraw";
      }
      if (key.name === "return") {
        const selected = choices.filter((_, i) => checked[i]).map((ch) => ch.value);
        // Locked rows don't count toward the minimum — they're on regardless,
        // so counting them would let the user through having chosen nothing.
        const chosen = choices.filter((ch, i) => checked[i] && !ch.locked).length;
        if (chosen < minSelected) {
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
            choices
              .filter((ch) => values.includes(ch.value) && !ch.summaryExclude)
              .map((ch) => ch.label),
            noun,
          ),
  });
}

// ── promptText (single line, optionally masked) ───────────────────────────────

export interface PromptTextOptions {
  message: string;
  /**
   * Printed before the message on the prompt's own line — the `│` spine, for a
   * prompt inside an `intro`/`outro` flow.
   *
   * Part of the line rather than a separate write because the prompt redraws
   * itself with `\r\x1b[2K` on every keystroke, which erases the row the cursor
   * is on: anything written to that row beforehand is gone by the first
   * character typed. Counted in the truncation, which is already ANSI-aware.
   */
  prefix?: string;
  /** Shown dimmed under the prompt. */
  hint?: string;
  /** Used when the user submits an empty line. */
  defaultValue?: string;
  /**
   * Render `•` instead of the typed characters. For credentials: the wizard is
   * routinely run while screen-sharing, and a pasted key would otherwise sit in
   * the scrollback of every recording of that session.
   */
  mask?: boolean;
  /** Return an error string to reject and re-ask, or null to accept. */
  validate?: (value: string) => string | null;
  stdin?: TTYIn;
  stdout?: TTYOut;
}

/**
 * Read one line. Resolves `null` on Ctrl-C / Escape, which every caller in the
 * wizard treats as "cancel the whole run" — consistent with selectOne.
 *
 * Falls back to a plain non-TTY read so `failproofai config` still works when
 * driven from a pipe or a test, the same way the other prompts do.
 */
export function promptText(opts: PromptTextOptions): Promise<string | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  const c = paint(colorsEnabled(stdout));

  const accept = (raw: string): { ok: true; value: string } | { ok: false; error: string } => {
    const value = raw.trim() || opts.defaultValue || "";
    const error = opts.validate?.(value) ?? null;
    return error ? { ok: false, error } : { ok: true, value };
  };

  if (!stdin.isTTY) {
    // Non-TTY: read whatever is piped, validate once, no re-ask loop (there is
    // no one to re-ask).
    return new Promise((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer | string) => {
        buf += String(chunk);
        if (buf.includes("\n")) done();
      };
      const done = () => {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", done);
        const r = accept(buf.split("\n")[0] ?? "");
        resolve(r.ok ? r.value : null);
      };
      stdin.on("data", onData);
      stdin.on("end", done);
    });
  }

  return new Promise((resolve) => {
    let value = "";
    const draw = (error?: string) => {
      const cols = stdout.columns || 80;
      const shown = opts.mask ? "•".repeat(value.length) : value;
      // The hint is a PLACEHOLDER — an example of what belongs here — so it
      // steps aside as soon as there is a real answer to look at. Keeping both
      // on one line put the example and the input side by side, which is the
      // arrangement most likely to make somebody wonder which one is theirs.
      const hint = opts.hint && value.length === 0 ? `  ${c.dim(opts.hint)}` : "";
      // Truncate to ONE physical row. `\r\x1b[2K` erases the row the cursor is
      // on and nothing above it — so a line wider than the terminal wraps, the
      // erase reaches only its last row, and every keystroke leaves the earlier
      // rows behind. That is why pasting a 40-character API key printed 40
      // stacked copies of the prompt: `API key for <host>` plus the masked
      // value plus the `needs events:add · policies:pull …` hint is past 80
      // columns before the key is even half typed.
      const line = truncate(`${opts.prefix ?? ""}${c.bold(opts.message)} ${shown}${hint}`, cols - 1);
      const err = error
        ? `\n${opts.prefix ?? "  "}${truncate(c.warn(error), cols - 3)}`
        : "";
      stdout.write(`\r\x1b[2K${line}${err}`);
      if (err) stdout.write("\x1b[1A");
    };
    draw();

    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdout.write("\n");
    };

    function onKey(str: string | undefined, key: readline.Key): void {
      if (!key) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const r = accept(value);
        if (r.ok) {
          cleanup();
          resolve(r.value);
        } else {
          draw(r.error);
        }
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        draw();
        return;
      }
      // Ignore control keys; accept any printable character, including a
      // bracketed paste arriving as one chunk.
      if (str && !key.ctrl && !key.meta) {
        value += str;
        draw();
      }
    }

    stdin.on("keypress", onKey);
  });
}

// ── the kit ──────────────────────────────────────────────────────────────────
/**
 * The block builders every PRINTED surface is assembled from.
 *
 * The prompts above dress the wizard. Everything else the CLI prints grew its
 * own dialect instead: `policies` renders a table with `── rules ──` and colored
 * chips, `pack list` and `harness list` print a bare sentence plus an indented
 * example, `config --status` opens with a prose line and then label/value rows at
 * label width 9, `audit --status` indents by three and misaligns its own value
 * column (col 21 on the first row, 18 on the rest, plus a whitespace-only line),
 * and `uninstall` prints `•` bullets with no header and no color at all. Six
 * answers to "how does this product state a fact".
 *
 * These are the one answer. Every builder is pure — `(spec, opts) => string[]` —
 * so a surface can be asserted at any width, with color on or off, without a pty;
 * that is the same shape `renderBrandLogo`, `reviewLines` and `buildSummary`
 * already have, and the reason they are the only rendering we can currently test.
 *
 * Callers pass `optsFor(stdout)` and print with `printBlock`, which owns the
 * outer margins so no surface has to remember them.
 */

/** Every printed line starts here. Two spaces, never three. */
export const INDENT = "  ";

export interface RenderOpts {
  /** Terminal width. Defaults to 80 so a piped or asserted render is deterministic. */
  cols?: number;
  /** Whether to emit ANSI at all. Defaults to OFF — colour is opt-in via `optsFor`. */
  color?: boolean;
}

function ctx(opts?: RenderOpts): { cols: number; c: ReturnType<typeof paint> } {
  return { cols: Math.max(20, opts?.cols ?? 80), c: paint(opts?.color ?? false) };
}

/** Derive render options from a real stream, honouring NO_COLOR and non-TTY. */
export function optsFor(stdout: TTYOut = process.stdout): Required<RenderOpts> {
  return { cols: stdout.columns || 80, color: colorsEnabled(stdout) };
}

/** Visible width of a line, skipping ANSI CSI sequences — the counterpart to
 *  `truncate`, needed wherever a column has to line up under coloured content. */
export function visibleWidth(line: string): number {
  let width = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
      i = j + 1;
    } else {
      width++;
      i++;
    }
  }
  return width;
}

/** Wrap PLAIN text to `width`. A single word longer than the budget (a path, a
 *  URL) overflows its own line rather than being broken — a split path is worse
 *  than a long one, because it cannot be copied. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** One visible character plus whatever SGR codes are in effect at it. */
interface AnsiCell {
  ch: string;
  active: string;
}

function toAnsiCells(text: string): AnsiCell[] {
  const cells: AnsiCell[] = [];
  let active = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC && text[i + 1] === "[") {
      let j = i + 2;
      while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
      const code = text.slice(i, j + 1);
      // A reset clears everything; anything else stacks on top.
      active = /\[0?m$/.test(code) ? "" : active + code;
      i = j + 1;
    } else {
      cells.push({ ch: text[i], active });
      i++;
    }
  }
  return cells;
}

function renderAnsiCells(line: AnsiCell[]): string {
  let out = "";
  let active = "";
  for (const cell of line) {
    if (cell.active !== active) {
      if (active) out += ANSI_RESET;
      out += cell.active;
      active = cell.active;
    }
    out += cell.ch;
  }
  // Every produced line closes what it opened. A line that ends mid-SGR bleeds
  // its colour into everything printed after it.
  return active ? out + ANSI_RESET : out;
}

/**
 * Wrap text that carries colour, on visible width.
 *
 * `wrap` counts escape bytes as characters, so a coloured value used to be
 * handed back unwrapped — and then `writeLines` cut it at the terminal edge with
 * `truncate`, which stops at the first plain character past the limit. That lost
 * the tail of the sentence with no ellipsis to say so, AND dropped the closing
 * reset, so the colour ran on into every line that followed. Both were
 * reproduced on `audit --status` at 80 columns.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (!text.includes(ESC)) return wrap(text, width);
  const words: AnsiCell[][] = [];
  let word: AnsiCell[] = [];
  for (const cell of toAnsiCells(text)) {
    if (/\s/.test(cell.ch)) {
      if (word.length > 0) words.push(word);
      word = [];
    } else {
      word.push(cell);
    }
  }
  if (word.length > 0) words.push(word);

  const lines: string[] = [];
  let line: AnsiCell[] = [];
  for (const next of words) {
    if (line.length > 0 && line.length + 1 + next.length > width) {
      lines.push(renderAnsiCells(line));
      line = [...next];
      continue;
    }
    if (line.length > 0) line.push({ ch: " ", active: line[line.length - 1].active });
    line.push(...next);
  }
  if (line.length > 0) lines.push(renderAnsiCells(line));
  return lines;
}

/** Close any SGR a hard cut left open, for the same reason. */
function closeSgr(text: string): string {
  const cells = toAnsiCells(text);
  const last = cells[cells.length - 1];
  return last && last.active ? text + ANSI_RESET : text;
}

/** Fit one cell to `width`: ANSI-safe hard cut when it carries colour, a proper
 *  single-ellipsis cut when it is plain. */
function fit(cell: string, width: number): string {
  if (visibleWidth(cell) <= width) return cell;
  return cell.includes(ESC) ? closeSgr(truncate(cell, width)) : ellipsize(cell, width);
}

/** Pad a possibly-coloured cell to `width` visible columns. */
function pad(cell: string, width: number, align: "left" | "right" = "left"): string {
  const gap = Math.max(0, width - visibleWidth(cell));
  return align === "right" ? " ".repeat(gap) + cell : cell + " ".repeat(gap);
}

/**
 * Join blocks with exactly one blank line between them.
 *
 * This is blank-line discipline as code rather than as a rule people remember:
 * whitespace-only lines normalise to empty, two blanks never survive next to
 * each other, and a block cannot open with one. `audit --status` prints a line
 * containing a single space today; assembled through here it cannot.
 */
export function stack(...groups: Array<string[] | null | undefined>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    if (!group || group.length === 0) continue;
    const body: string[] = [];
    for (const line of group) {
      const normalised = line.trim() === "" ? "" : line;
      if (normalised === "" && (body.length === 0 || body[body.length - 1] === "")) continue;
      body.push(normalised);
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    if (body.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(...body);
  }
  return out;
}

/**
 * Print an assembled block with its outer margins. One place decides them.
 *
 * Deliberately NOT `writeLines`, which truncates each line to the terminal
 * width. Every builder above already fits its content, so the only lines that
 * can exceed the width are ones holding a token that cannot be broken — a path,
 * a URL, a session id. Cutting those loses characters silently and with no
 * ellipsis to admit it; letting the terminal wrap keeps them copyable, which is
 * the entire reason they are printed.
 */
export function printBlock(stdout: TTYOut, lines: string[]): void {
  if (lines.length === 0) return;
  stdout.write(["", ...lines.map(closeSgr), ""].join("\n") + "\n");
}

/**
 * The heading every surface opens with: what you are looking at, and the state
 * it describes, right-aligned and dim.
 *
 * Six of our printed surfaces open with nothing at all, so output arrives with
 * no statement of what it is — which is survivable on a screen you asked for and
 * confusing in scrollback next to five other commands.
 */
export function title(name: string, meta?: string, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const left = `${INDENT}${c.bold(name)}`;
  if (!meta) return [left];
  const right = c.dim(meta);
  const gap = cols - visibleWidth(left) - visibleWidth(right) - INDENT.length;
  // Too narrow to sit on one line: drop it under rather than let it wrap into
  // the middle of the heading, where it reads as a second, broken title.
  if (gap < 2) return [left, `${INDENT}${c.dim(meta)}`];
  return [left + " ".repeat(gap) + right];
}

/** A section divider — the `── Convention Policies ──────` shape `policies`
 *  already uses, available to every surface instead of one. */
export function rule(label?: string, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const width = Math.max(4, cols - INDENT.length * 2);
  if (!label) return [`${INDENT}${c.dim("─".repeat(width))}`];
  const tail = Math.max(3, width - `━━ ${label} `.length);
  // The one accent every sectioned surface carries: a pink lead into a bold
  // label. Decoration only — the glyphs and the spacing are identical without
  // colour, so a piped render and a painted one are the same width and say the
  // same thing. Changing it here moves `policies`, `harness`, `pack list`,
  // every `table` section and all twelve help screens together, which is the
  // reason they share this function instead of each drawing their own line.
  return [`${INDENT}${c.pink("━━")} ${c.bold(label)} ${c.dim("━".repeat(tail))}`];
}

export interface Row {
  label: string;
  value: string;
}

/**
 * Label/value rows on ONE computed column.
 *
 * The column is derived from the widest label in the block and never hardcoded,
 * which is the entire fix for `audit --status` printing its first row's value at
 * column 21 and the rest at 18 — two hand-counted paddings in one block, in the
 * same file.
 */
export function rows(items: Array<Row | [string, string]>, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const pairs = items.map((item) =>
    Array.isArray(item) ? { label: item[0], value: item[1] } : item,
  );
  if (pairs.length === 0) return [];
  // The column grows to the widest label and the label is NEVER cut. It used to
  // be capped at 24 and ellipsized, which quietly ate the pause session id —
  // the one string `--resume --session <id>` needs, printed nowhere else. Half
  // an id is not a shorter fact, it is an unusable one; a label past the cap
  // takes its own line instead, so the value column survives.
  const widest = Math.max(...pairs.map((p) => visibleWidth(p.label)));
  const labelWidth = Math.min(widest, Math.max(12, Math.floor((cols - INDENT.length * 2) / 2)));
  const valueBudget = Math.max(8, cols - INDENT.length * 2 - labelWidth - 2);
  const out: string[] = [];
  for (const { label, value } of pairs) {
    if (visibleWidth(label) > labelWidth) {
      out.push(`${INDENT}${c.dim(label)}`);
      for (const extra of wrapAnsi(value, valueBudget)) {
        out.push(" ".repeat(INDENT.length + labelWidth + 2) + extra);
      }
      continue;
    }
    const gutter = `${INDENT}${pad(c.dim(label), labelWidth)}  `;
    const hang = " ".repeat(visibleWidth(gutter));
    // Wrapped with a hanging indent rather than cut. Cutting looks tidier and is
    // worse: these values are URLs, machine ids and paths, and half of one is
    // not a shorter fact, it is an unusable one. Neither `wrap` nor `wrapAnsi`
    // splits a single token, so a long URL survives whole on its own line — the
    // only case that can still pass the right edge, and the right trade.
    const wrapped = wrapAnsi(value, valueBudget);
    if (wrapped.length === 0) {
      out.push(gutter.trimEnd());
      continue;
    }
    out.push(gutter + wrapped[0]);
    for (const extra of wrapped.slice(1)) out.push(hang + extra);
  }
  return out;
}

/** A row, optionally with dim continuation lines under it — configured params,
 *  a policy hint, the reason a file would not load. */
export interface TableRow {
  cells: string[];
  notes?: string[];
}

/** A heading between rows. Widths are computed across the WHOLE table, so the
 *  columns line up through every section instead of jumping at each one — which
 *  is what a table-per-section does, along with repeating the column labels. */
export interface TableSection {
  section: string;
}

export interface TableSpec {
  head: string[];
  rows: Array<string[] | TableRow | TableSection>;
  /** Per-column alignment. Numbers read right, everything else left. */
  align?: Array<"left" | "right">;
  /** Which column absorbs the leftover width (default: the last). */
  flex?: number;
  /**
   * Columns the shrink pass may not touch. The second pass takes width from the
   * WIDEST column, which in a path table is the path — cutting the one value the
   * listing exists to hand back to the user.
   */
  protect?: number[];
}

/** The `policies` table, available to every surface that lists things. */
export function table(spec: TableSpec, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const count = spec.head.length;
  if (count === 0) return [];
  const flex = spec.flex ?? count - 1;
  const body: Array<TableRow | TableSection> = spec.rows.map((r) =>
    Array.isArray(r) ? { cells: r } : r,
  );
  const dataRows = body.filter((r): r is TableRow => "cells" in r);
  const natural = spec.head.map((h, i) =>
    Math.max(visibleWidth(h), ...dataRows.map((r) => visibleWidth(r.cells[i] ?? ""))),
  );
  const budget = cols - INDENT.length * 2 - (count - 1) * 2;
  // The flex column gives way first, and only when it has nothing left to give
  // do the others shrink — widest first, so a narrow terminal costs the column
  // that can most afford it. Without the second pass a single long cell (a path,
  // a description) pushed the whole row past the terminal edge, which is the
  // overrun this kit exists to end.
  let overflow = natural.reduce((a, b) => a + b, 0) - budget;
  if (overflow > 0) {
    const give = Math.min(overflow, Math.max(0, natural[flex] - 8));
    natural[flex] -= give;
    overflow -= give;
  }
  const protectedCols = new Set(spec.protect ?? []);
  while (overflow > 0) {
    let widest = -1;
    for (let i = 0; i < natural.length; i += 1) {
      if (protectedCols.has(i) || natural[i] <= 4) continue;
      if (widest === -1 || natural[i] > natural[widest]) widest = i;
    }
    // Everything left is protected or already at its floor: leave the row long
    // and let the terminal wrap it rather than cut a protected value.
    if (widest === -1) break;
    natural[widest] -= 1;
    overflow -= 1;
  }
  const line = (cells: string[]) =>
    INDENT +
    cells
      .map((cell, i) => pad(fit(cell, natural[i]), natural[i], spec.align?.[i] ?? "left"))
      .join("  ")
      .trimEnd();
  // Notes hang under the row's LAST fixed column — i.e. where the name starts —
  // so a hint reads as belonging to its row rather than to the table.
  const noteIndent =
    INDENT.length + natural.slice(0, Math.max(0, flex - 1)).reduce((a, b) => a + b + 2, 0);
  // All-empty headings mean a table that does not want a header row: repeating
  // column labels above every section is chrome, not content.
  const wantsHead = spec.head.some((h) => h.length > 0);
  const out = wantsHead ? [line(spec.head.map((h) => c.dim(h))), ...rule(undefined, opts)] : [];
  for (const row of body) {
    if ("section" in row) {
      if (out.length > 0) out.push("");
      out.push(...rule(row.section, opts));
      continue;
    }
    out.push(line(row.cells));
    for (const n of row.notes ?? []) {
      for (const wrapped of wrap(n, Math.max(8, cols - noteIndent - INDENT.length))) {
        out.push(" ".repeat(noteIndent) + c.dim(wrapped));
      }
    }
  }
  return out;
}

/** Every state a listed thing can be in. Symbol AND colour, never colour alone,
 *  so the list still reads under NO_COLOR and for a red/green-blind reader. */
export type ChipState =
  | "on"
  | "off"
  | "mixed"
  | "locked"
  | "cloud"
  | "pack"
  | "failed"
  | "observe";

const CHIP_LABELS: Record<ChipState, string> = {
  on: "✓ ON",
  off: "· OFF",
  // A convention FILE holds several hooks and some of them can be disabled
  // individually, so "on" and "off" cannot describe it between them.
  mixed: "◐ MIXED",
  locked: "✓ LOCK",
  cloud: "✓ CLOUD",
  pack: "✓ PACK",
  failed: "\u25B2 FAIL",
  observe: "◉ OBS",
};

/** Width of the widest chip, so a column of them lines up without the caller
 *  knowing which states it happens to contain. */
export const CHIP_WIDTH = Math.max(...Object.values(CHIP_LABELS).map((l) => l.length));

export function chip(state: ChipState, opts?: RenderOpts): string {
  const { c } = ctx(opts);
  const label = CHIP_LABELS[state];
  const painted =
    state === "on" || state === "pack"
      ? c.pink(label)
      : state === "failed" || state === "mixed"
        ? c.warn(label)
        : state === "cloud" || state === "observe"
          ? c.guide(label)
          : c.dim(label);
  return pad(painted, CHIP_WIDTH);
}

/** A bulleted list, wrapped, with continuation lines aligned under the text —
 *  `uninstall` prints 200-column bullets today that wrap into column 0. */
export function bullets(items: string[], opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const budget = Math.max(8, cols - INDENT.length - 4);
  const out: string[] = [];
  for (const item of items) {
    const [first, ...rest] = wrap(item, budget);
    if (first === undefined) continue;
    out.push(`${INDENT}${c.pink("•")} ${first}`);
    for (const line of rest) out.push(`${INDENT}  ${line}`);
  }
  return out;
}

/** A dim aside under a block. */
export function note(text: string, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  return wrap(text, Math.max(8, cols - INDENT.length * 2)).map((l) => `${INDENT}${c.dim(l)}`);
}

/**
 * "Here is the command to run next" — the single most repeated shape in the CLI
 * and, today, invented separately by `policies`, `pack list` and `harness list`.
 */
export function nextStep(cmd: string, why?: string, opts?: RenderOpts): string[] {
  const { c } = ctx(opts);
  const out: string[] = [];
  if (why) out.push(...note(why, opts));
  out.push(`${INDENT}${INDENT}${c.pink(cmd)}`);
  return out;
}

function gutterBlock(symbol: string, lines: string[], opts?: RenderOpts): string[] {
  const { cols } = ctx(opts);
  const budget = Math.max(8, cols - INDENT.length - 3);
  const out: string[] = [];
  for (const line of lines) {
    for (const wrapped of wrap(line, budget)) {
      out.push(out.length === 0 ? `${INDENT}${symbol}  ${wrapped}` : `${INDENT}   ${wrapped}`);
    }
  }
  return out;
}

/** Amber gutter. One shape for every warning, whether it is two lines about
 *  scopes or six about the daemon. */
export function warning(lines: string[], opts?: RenderOpts): string[] {
  const { c } = ctx(opts);
  return gutterBlock(c.warn("\u25B2"), lines, opts);
}

/** The same, for the ones that destroy something. */
export function danger(lines: string[], opts?: RenderOpts): string[] {
  const { c } = ctx(opts);
  return gutterBlock(c.pink("!"), lines, opts);
}

/** Nothing to show, said the same way everywhere: what is empty, then the one
 *  command that changes that. */
export function emptyState(
  spec: { what: string; hint?: string; cmd?: string },
  opts?: RenderOpts,
): string[] {
  return stack(note(spec.what, opts), spec.cmd ? nextStep(spec.cmd, spec.hint, opts) : null);
}

export interface HelpSpec {
  usage: Array<[string, string?]>;
  options?: Array<[string, string]>;
  examples?: string[];
  /** Free lines above the first section. */
  lead?: string[];
}

/**
 * The description column for one block of entries, derived from its widest
 * described name and capped.
 *
 * Its own step because the callers differ on the SCOPE they compute it over —
 * {@link helpBlock} across usage and options together, {@link helpScreen} per
 * section — and neither should be restating the cap or the floor.
 */
export function helpColumn(entries: Array<[string, string?]>): number {
  // Only DESCRIBED entries set the column. A bare usage line — `failproofai
  // flush [--wait] [--timeout <secs>]`, which describes itself — is 44
  // characters and has nothing in the second column, so letting it vote pushed
  // every real description on the screen out to column 38.
  const named = entries.filter(([, d]) => d).map(([n]) => visibleWidth(n));
  return Math.min(34, Math.max(12, ...named));
}

/** `<name>  <description>` at a column the caller fixed. */
export function helpEntries(
  items: Array<[string, string?]>,
  nameWidth: number,
  opts?: RenderOpts,
): string[] {
  const { cols, c } = ctx(opts);
  const out: string[] = [];
  for (const [raw, description] of items) {
    // Pink is what you TYPE, dim is what it means, bold is the section it sits
    // in. Three tones, the same three on every screen, so a flag looks like a
    // flag whether you found it on `publish --help` or on the index. Decoration
    // only: the column already separates the two halves, so the screen reads
    // the same piped to a file or under NO_COLOR.
    const name = c.pink(raw);
    if (!description) {
      out.push(`${INDENT}${name}`);
      continue;
    }
    const budget = Math.max(12, cols - INDENT.length * 2 - nameWidth - 2);
    const [first, ...rest] = wrap(description, budget);
    // A name wider than the column takes its own line rather than shoving the
    // description out — the top-level help has several of these today.
    if (visibleWidth(raw) > nameWidth) {
      out.push(`${INDENT}${name}`);
      for (const line of [first, ...rest]) {
        if (line !== undefined) out.push(`${INDENT}${" ".repeat(nameWidth)}  ${c.dim(line)}`);
      }
      continue;
    }
    // Padded on the VISIBLE width, so a painted name still lands the column
    // where an unpainted one does.
    const gap = nameWidth - visibleWidth(raw);
    out.push(`${INDENT}${name}${" ".repeat(gap)}  ${c.dim(first ?? "")}`);
    for (const line of rest) out.push(`${INDENT}${" ".repeat(nameWidth)}  ${c.dim(line)}`);
  }
  return out;
}

/**
 * A usage/options/examples block, on one column across all three.
 *
 * The plain shape, for a surface with nothing else to say. A screen with prose
 * sections, a heading, or a footer wants {@link helpScreen}, which is what the
 * twelve `--help` screens use.
 */
export function helpBlock(spec: HelpSpec, opts?: RenderOpts): string[] {
  const nameWidth = helpColumn([...spec.usage, ...(spec.options ?? [])]);
  const section = (label: string, body: string[]): string[] =>
    body.length === 0 ? [] : [...rule(label, opts), ...body];
  return stack(
    spec.lead ? spec.lead.map((l) => `${INDENT}${l}`) : null,
    section("usage", helpEntries(spec.usage, nameWidth, opts)),
    section("options", helpEntries(spec.options ?? [], nameWidth, opts)),
    section("examples", (spec.examples ?? []).map((e) => `${INDENT}${e}`)),
  );
}

/**
 * Help is the one family of screens read at every width that belongs to no
 * terminal in particular. Capped at 80 so `publish --help` is the same shape in
 * a maximised window as in a tmux pane — and never wider than the terminal it
 * is actually in, so the cap can only ever narrow.
 */
export const HELP_COLS = 80;

/** {@link optsFor}, capped to {@link HELP_COLS}. Every help screen uses this. */
export function helpOptsFor(stdout: TTYOut = process.stdout): Required<RenderOpts> {
  const base = optsFor(stdout);
  return { cols: Math.min(base.cols, HELP_COLS), color: base.color };
}

export interface HelpHeading {
  /** The command being documented. Omitted for the top-level index. */
  command?: string;
  version: string;
  /** One line: what this command is for. */
  tagline: string;
}

/**
 * The two lines every help screen opens with.
 *
 * The wordmark carries the same pink on `il` that {@link renderBrandLogo} tints,
 * so a help screen and the wizard are visibly one product rather than two that
 * happen to ship together. The version sits right-aligned and dim because it is
 * the fact you want when a help screen and its binary disagree, and the fact you
 * never want in the way otherwise.
 */
export function helpHeading(spec: HelpHeading, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const mark = `${c.bold("fa")}${c.pink("il")}${c.bold("proofai")}`;
  const left = `${INDENT}${mark}${spec.command ? ` ${c.bold(spec.command)}` : ""}`;
  const right = c.dim(`v${spec.version}`);
  const gap = cols - visibleWidth(left) - visibleWidth(right) - INDENT.length;
  // Too narrow for both: the version goes under rather than wrapping into the
  // middle of the name, where it reads as part of the command.
  const head = gap < 2 ? [left, `${INDENT}${right}`] : [left + " ".repeat(gap) + right];
  return [...head, ...note(spec.tagline, opts)];
}

/**
 * A section of a help screen: a table of names, a paragraph, or lines that are
 * already laid out. Every one of them gets the same `rule` heading, which is
 * what makes twelve screens one screen.
 */
export type HelpSection =
  /** A table of names. `after` is a paragraph under it, in the same section —
   *  the alternative was a second heading over three lines of caveat, or an
   *  unlabelled `rule` that read as the screen having lost its place. */
  | { label: string; entries: Array<[string, string?]>; after?: string[] }
  | { label: string; prose: string }
  | { label: string; lines: string[] };

export interface HelpScreenSpec extends HelpHeading {
  sections: HelpSection[];
  /** Dim closing lines — where to read more. */
  footer?: string[];
}

/**
 * A whole `--help`, assembled the same way twelve times.
 *
 * Before this, every screen was its own template literal: `USAGE` here and
 * `Usage:` there, a description column hand-counted per file, no version on the
 * page, and no colour on any of them while the index it was reached from had
 * all three. The screens still say exactly what their authors wrote — this owns
 * only the shape.
 */
export function helpScreen(spec: HelpScreenSpec, opts?: RenderOpts): string[] {
  const { cols, c } = ctx(opts);
  const width = Math.max(12, cols - INDENT.length * 2);
  const groups: Array<string[] | null> = [helpHeading(spec, opts)];
  for (const section of spec.sections) {
    // Per SECTION, not per screen. One column across the whole page is what a
    // screen of like-shaped entries wants, and it is exactly wrong on a screen
    // that has both: `failproofai policies show <owner>/<repo>` is 40 columns
    // and `--all` is 5, so a shared column left every flag description hanging
    // 34 columns out with nothing under it. What made two screens read as two
    // products was the INDENT and the heading, and those are shared here.
    const body =
      "entries" in section
        ? [
            ...helpEntries(section.entries, helpColumn(section.entries), opts),
            ...(section.after?.length
              ? ["", ...section.after.map((l) => (l.trim() === "" ? "" : `${INDENT}${l}`))]
              : []),
          ]
        : "prose" in section
          ? wrap(section.prose, width).map((l) => `${INDENT}${l}`)
          : section.lines.map((l) => (l.trim() === "" ? "" : `${INDENT}${l}`));
    if (body.length === 0) continue;
    groups.push([...rule(section.label, opts), ...body]);
  }
  if (spec.footer?.length) groups.push(spec.footer.map((l) => `${INDENT}${c.dim(l)}`));
  return stack(...groups);
}
