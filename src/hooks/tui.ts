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
import { version as cliVersion } from "../../package.json";

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
  /** Grey text after the heading — what the list is, e.g. "9 found on this machine". */
  meta?: string;
  /** The lines the prompt collapses to once answered, instead of `✓ <label>`. */
  collapsed?: (value: T) => string[];
  /** Let space pick the row as well as enter, for a menu that always took both. */
  spaceSelects?: boolean;
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
  /** What `✕` says when enter is pressed with fewer than `minSelected` ticked. */
  minMessage?: string;
  /** Replaces the key hints at the foot. Rarely right: the default IS the design. */
  hint?: string;
  /**
   * Grey text after the heading, redrawn on every toggle. Defaults to
   * "n of m selected"; a function gets what is ticked now; `null` shows none.
   */
  meta?: string | null | ((checked: T[]) => string);
  /**
   * A tag after a row's name, already coloured — "will be added", "new on this
   * machine" — recomputed on every toggle, so it can describe the change a
   * toggle would make. Shown instead of the row's hint when present.
   */
  tag?: (value: T, checked: boolean) => string | undefined;
  /** The lines the prompt collapses to once answered, instead of `✓ <summary>`. */
  collapsed?: (values: T[]) => string[];
  /** Noun used when collapsing many selections to a count (e.g. "assistants"). */
  summaryNoun?: string;
  stdin?: TTYIn;
  stdout?: TTYOut;
}

const ESC = "\x1B";

/** How every "the key was on argv" warning opens, whichever command took it (`jev setup --token`, `config --token`). */
export const TOKEN_ON_ARGV =
  "--token was on the command line: your shell history has it, and while this command ran any process of yours could read it from the process list.";

const RADIO_ON = "●";
const RADIO_OFF = "○";
// The redesign's boxes: ■ ticked, □ not. Two new names rather than new values
// for the two above, which install-prompt.ts still draws its own menus with.
const CHECK_SELECTED = "■";
const CHECK_EMPTY = "□";
/** The return key, as the multi-select hints already spell it. */
export const CARET_RETURN = "↵";
 // ▮▮ — the brand mark, per the design system

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
   * Optional because the greys (`dim`, `ink3`, `track`) have no honest answer:
   * their `basic` is SGR 2, an ATTRIBUTE that steps down whatever foreground the
   * user's theme is already using, and the cube's nearest grey (243, #767676)
   * is a fixed colour that fights every theme that is not ours. So a grey keeps
   * the attribute below 24-bit and this stays undefined.
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
  // The 2026-10 screen language's two greys. Both are the designed hex at 24-bit
  // and the SGR 2 ATTRIBUTE below it, for the reason `dim` gives above: a fixed
  // cube grey fights every theme that is not ours, and the basic tier's "bright
  // black" (90) is the BACKGROUND colour in Solarized Dark, so a label drawn in
  // it would vanish.
  //
  // There is no `ink2`: descriptions use the terminal's own foreground at every
  // tier. The designed #a7adb6 is tuned for a dark ground, nothing here can tell
  // which ground it is on, and on a light one it measures about 2.2:1 — half of
  // what today's dim descriptions get. `paint().ink2` is therefore the identity.
  ink3: { rgb: [118, 127, 139], basic: "2" }, // #767f8b — kv labels, heading meta, key hints
  track: { rgb: [62, 67, 76], basic: "2" }, // #3e434c — the empty part of a progress bar, never text
  // A state, never branding: the ✕ on a failed line. 203 rather than 204, which
  // is the nearest cube entry by distance but differs from the brand pink's 168
  // only in its red channel and reads as pink at that tier — the one deliberate,
  // eyeballed exception to the nearest-entry rule above.
  err: { rgb: [240, 113, 120], c256: 203, basic: "31" }, // #f07178
} satisfies Record<string, Hue>;

export function colorsEnabled(out: TTYOut): boolean {
  return !!out.isTTY && !process.env.NO_COLOR;
}

export const ANSI_RESET = `${ESC}[0m`;

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
    // The 2026-10 roles. `ink2` is the terminal's own foreground on purpose —
    // see the note on HUES — so it is the identity at every tier, and exists
    // so a call site says which role it means rather than leaving text bare.
    ink2: (s: string): string => s,
    ink3: mk(HUES.ink3),
    track: mk(HUES.track),
    err: mk(HUES.err),
  };
}

// ── brand logo (befailproof.ai logomark) ────────────────────────────────────
// Half-block rendition of the real site mark — the teal flower, the pink cross,
// and the tall bar joined at the base — downscaled from the actual artwork so it
// stays faithful at terminal size. Each character cell packs two vertical pixels
// (▀ top, ▄ bottom); `t` = teal, `p` = pink, `.` = transparent. Shown when
// there's room, else a compact one-liner.
const LOGO_MIN_COLS = 22;

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

// ── framing ─────────────────────────────────────────────────────────────────

// ── shared render engine ─────────────────────────────────────────────────────

type Region = { lastCount: number };

const WINDOW = 12; // visible rows before a list scrolls; 12 reproduces every frame in the redesign

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
 *
 * `frame` is for a caller that has to change a terminal mode alongside a frame
 * — hide the cursor on the first, show it on the last — inside the SAME write,
 * and for a last frame that must not be cut: lines are truncated so each one is
 * exactly one row and the next cursor-up lands where it should, but a frame
 * nothing will repaint stays in scrollback, where a cut is permanent.
 */
function repaint(
  out: TTYOut,
  region: Region,
  lines: string[],
  frame: { lead?: string; tail?: string; cut?: boolean } = {},
): void {
  const cols = out.columns || 80;
  const cut = frame.cut ?? true;
  const body = lines.map((l) => (l === "" || !cut ? l : truncate(l, cols))).join("\n") + "\n";
  const clear = region.lastCount > 0 ? `${ESC}[${region.lastCount}A${ESC}[J` : "";
  out.write(`${ESC}[?2026h${frame.lead ?? ""}${clear}${body}${frame.tail ?? ""}${ESC}[?2026l`);
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
  /** A whole row, cursor gutter included: " › ■ name  hint". */
  renderRow: (index: number, active: boolean, budget: number) => string;
  /** Grey text after the heading, re-read on every frame. */
  meta?: () => string | null | undefined;
  /** Extra line(s) above the footer (e.g. a min-selected warning). */
  warnLine?: () => string | null;
  /** When set, ← resolves `BACK` so the caller can step backwards. */
  allowBack?: boolean;
  /** Called just before ← resolves, so a caller can keep in-progress state. */
  onBack?: () => void;
  footer: string;
  /** Handle non-navigation keys. `{done}` finishes, `"redraw"` repaints. */
  onKey: (key: readline.Key, cursor: number) => { done: R } | "redraw" | undefined;
  /** The answer, said once the prompt collapses: `✓ <this>`. */
  summaryFor: (result: R | null) => string;
  /** The collapsed lines, when a caller says the answer its own way. */
  collapsed?: (result: R) => string[];
}

/**
 * A prompt's heading: the question in bold UPPERCASE, with grey meta after it —
 * the same shape as `screenKit().head`, so a picker and the screen around it
 * read as one page.
 */
function promptHeading(c: ReturnType<typeof paint>, message: string, meta?: string | null): string {
  return c.bold(message.toUpperCase()) + (meta ? `  ${c.ink3(meta)}` : "");
}

function runPrompt<R>(p: PromptSpec<R>): Promise<R | null> {
  const { stdin, stdout, c, choices } = p;
  const region: Region = { lastCount: 0 };
  const nameCol = nameWidth(choices.map((ch) => ch.label));
  let cursor = 0;

  const build = (): string[] => {
    const cols = stdout.columns || 80;
    const lines: string[] = [promptHeading(c, p.message, p.meta?.())];
    for (const b of p.body ?? []) lines.push(`${INDENT}${c.ink2(b)}`);

    const rows = displayRows(choices);
    let cursorRow = 0;
    rows.forEach((r, ri) => {
      if (r.kind === "item" && r.index === cursor) cursorRow = ri;
    });
    const { start, end } = viewport(rows, cursorRow, WINDOW);
    const above = rows.slice(0, start).filter((r) => r.kind === "item").length;
    const below = rows.slice(end).filter((r) => r.kind === "item").length;
    if (above > 0) lines.push(`   ${c.ink2(`↑ ${above} more`)}`);

    // The room a row's hint has: the terminal, less the 3-column cursor gutter,
    // the name column and the gap after it. A checklist's box takes two more,
    // which its renderRow subtracts itself.
    const budget = Math.max(6, cols - nameCol - 6);
    for (let ri = start; ri < end; ri++) {
      const row = rows[ri];
      if (row.kind === "header") {
        lines.push(`${INDENT}${c.bold(row.text)}`);
      } else {
        lines.push(p.renderRow(row.index, row.index === cursor, budget));
      }
    }
    if (below > 0) lines.push(`   ${c.ink2(`↓ ${below} more`)}`);

    const warn = p.warnLine?.();
    if (warn) lines.push(warn);
    lines.push("", c.ink3(p.footer));
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
    const heading = promptHeading(c, p.message);
    const lines =
      (result as unknown) === BACK
        ? [heading, c.ink3("back")]
        : result === null
          ? [heading, c.ink3(p.summaryFor(null))]
          : p.collapsed
            ? p.collapsed(result)
            : [heading, `${c.guide("✓")} ${p.summaryFor(result)}`];
    repaint(stdout, region, lines);
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
    meta: () => opts.meta,
    renderRow: (index, active, budget) => {
      const choice = choices[index];
      const rawLabel = choice.hint ? choice.label.padEnd(nameCol) : choice.label;
      const label = active ? c.bold(rawLabel) : rawLabel;
      const hint = choice.hint
        ? `  ${c.ink2(ellipsize(choice.hint, hintBudget(choice.label, nameCol, budget)))}`
        : "";
      return `${active ? c.pink(" › ") : "   "}${label}${hint}`;
    },
    allowBack: opts.allowBack,
    footer: ["↑↓ move", "enter select", ...(opts.allowBack ? ["← back"] : []), "esc cancel"].join("  ·  "),
    onKey: (key, cursor) =>
      key.name === "return" || (opts.spaceSelects && key.name === "space")
        ? { done: choices[cursor].value }
        : undefined,
    collapsed: opts.collapsed,
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
    meta: () => {
      if (opts.meta === null) return null;
      if (typeof opts.meta === "string") return opts.meta;
      if (typeof opts.meta === "function") {
        return opts.meta(choices.filter((_, i) => checked[i]).map((ch) => ch.value));
      }
      // Selector rows ("Everything available") are not one of the things counted.
      const counted = choices.map((ch, i) => (ch.summaryExclude ? null : checked[i])).filter((v) => v !== null);
      return `${counted.filter(Boolean).length} of ${counted.length} selected`;
    },
    renderRow: (index, active, budget) => {
      const choice = choices[index];
      // Locked rows use the mint guide hue rather than selection pink, so they
      // read as "already true" instead of "you picked this"; an unchecked
      // locked row is an empty grey box — nothing there yet.
      const box = choice.locked
        ? checked[index]
          ? c.guide(CHECK_SELECTED)
          : c.ink3(CHECK_EMPTY)
        : checked[index]
          ? c.pink(CHECK_SELECTED)
          : c.ink3(CHECK_EMPTY);
      const tag = opts.tag?.(choice.value, checked[index]);
      const rawLabel = tag || choice.hint ? choice.label.padEnd(nameCol) : choice.label;
      const label = active ? c.bold(rawLabel) : checked[index] ? rawLabel : c.ink2(rawLabel);
      const trail = tag
        ? `  ${tag}`
        : choice.hint
          ? `  ${c.ink2(ellipsize(choice.hint, hintBudget(choice.label, nameCol, budget - 2)))}`
          : "";
      return `${active ? c.pink(" › ") : "   "}${box} ${label}${trail}`;
    },
    warnLine: () =>
      warn ? `${c.err("✕")} ${opts.minMessage ?? `Select at least ${minSelected}.`}` : null,
    allowBack: opts.allowBack,
    // Reads the SAME `checked` array the prompt is driving, so what the caller
    // learns is exactly what was on screen when ← was pressed.
    onBack: opts.onBack
      ? () => opts.onBack?.(choices.filter((_, i) => checked[i]).map((ch) => ch.value))
      : undefined,
    footer:
      opts.hint ??
      ["↑↓ move", "space toggle", "a all", ...(opts.allowBack ? ["← back"] : []), "enter confirm", "esc cancel"].join(
        "  ·  ",
      ),
    collapsed: opts.collapsed,
    onKey: (key, cursor) => {
      if (key.name === "space") {
        if (choices[cursor]?.locked) return "redraw"; // always on — not a choice
        checked[cursor] = !checked[cursor];
        warn = false;
        return "redraw";
      }
      // Plain `a`, as the redesign's hints spell it; ctrl+a stays as an alias,
      // since GNU screen swallows it as its command prefix anyway.
      if (key.name === "a") {
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
  /**
   * Draw the 2026-10 field instead of the spine prompt: `  <message>  › <value>`
   * — the label in the terminal's own ink at a ten-column label, a pink `›`, the
   * hint in the label grey, and a refusal as a `✕` line under the field that is
   * cleared again as soon as the value changes. `prefix` is ignored. For the
   * screens that have moved to the new language; the spine form stays for the
   * rest until they move.
   */
  field?: boolean;
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

  // A default nobody can see is a default nobody uses.
  //
  // `defaultValue` is applied on an empty submit and is otherwise INVISIBLE, so
  // every prompt carrying one had to remember to spell it into its own hint —
  // and the one where it mattered most, "Where should this publish?", spelled
  // out the value while never saying that return was the key that took it.
  // Somebody looking at a prefilled-looking placeholder types the whole thing
  // out again. Owned here so a prompt cannot be added without it.
  //
  // Never for a masked prompt: those hold credentials, and the entire reason
  // the characters are hidden is that the screen is being shared or recorded.
  const hintText = [
    opts.defaultValue && !opts.mask ? `${CARET_RETURN} ${opts.defaultValue}` : "",
    opts.hint ?? "",
  ]
    .filter(Boolean)
    .join("  ·  ");

  return new Promise((resolve) => {
    let value = "";
    // Whether a field's `✕` line is on the row under it right now.
    let refused = false;
    /**
     * The field form, in ONE write per keystroke. The refusal goes on the row
     * under the field and the field is drawn LAST, so the cursor ends where the
     * typing is — the spine form moves back up after its error line and leaves
     * the cursor at the end of the error instead. A refusal still on screen is
     * cleared the moment the value changes, so a corrected answer never sits
     * above the complaint about the old one.
     */
    const drawField = (cols: number, shown: string, error?: string) => {
      const hint = hintText && value.length === 0 ? `  ${c.ink3(hintText)}` : "";
      const line = truncate(`${INDENT}${opts.message.padEnd(10)}${c.pink("›")} ${shown}${hint}`, cols - 1);
      if (error) {
        const refusal = truncate(`${c.err("✕")} ${error}`, cols - 1);
        stdout.write(`\n\x1b[2K${refusal}\x1b[1A\r\x1b[2K${line}`);
        refused = true;
        return;
      }
      // Down, clear, back up: the row under the field exists, because the
      // refusal being cleared was written there.
      const clearRefusal = refused ? "\x1b[1B\x1b[2K\x1b[1A" : "";
      stdout.write(`${clearRefusal}\r\x1b[2K${line}`);
      refused = false;
    };
    const draw = (error?: string) => {
      const cols = stdout.columns || 80;
      const shown = opts.mask ? "•".repeat(value.length) : value;
      if (opts.field) {
        drawField(cols, shown, error);
        return;
      }
      // The hint is a PLACEHOLDER — an example of what belongs here — so it
      // steps aside as soon as there is a real answer to look at. Keeping both
      // on one line put the example and the input side by side, which is the
      // arrangement most likely to make somebody wonder which one is theirs.
      const hint = hintText && value.length === 0 ? `  ${c.dim(hintText)}` : "";
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
      // Past a field's refusal, when one is still showing (a cancel right after
      // it), so whatever prints next starts on a clean row instead of on top of
      // the complaint.
      stdout.write(refused ? "\n\n" : "\n");
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

/**
 * Run something that writes straight to the terminal — `sudo -v` and its
 * password prompt — then erase whatever it wrote, so the step around it can
 * collapse to one line.
 *
 * The rows are reserved FIRST: `reserve` newlines then back up, so that what
 * the child prints never scrolls the screen. A scroll would move the saved
 * cursor position off the line it was saved on, and the erase would then land
 * below the prompt instead of on it. Three failed sudo attempts print about
 * six lines, so ten is enough room. Without a terminal it just runs.
 */
export function collapseAfter<T>(stdout: TTYOut, reserve: number, run: () => T): T {
  if (!stdout.isTTY) return run();
  stdout.write(`${"\n".repeat(reserve)}${ESC}[${reserve}A${ESC}7`);
  try {
    return run();
  } finally {
    stdout.write(`${ESC}8${ESC}[J`);
  }
}

// ── the cloud-key prompt ─────────────────────────────────────────────────────

/** What `promptCloudKey` resolves when Tab is pressed: no new connection. */
export const OPEN_SOURCE: unique symbol = Symbol("failproofai.open-source");
export type OpenSource = typeof OPEN_SOURCE;

/**
 * What a key check found, in words the prompt prints as they are. `ok` with a
 * `line` is a key that works for part of what it was asked: the caller says
 * which part, as a `▲` line after the prompt collapses. `usable` marks a SAVED
 * key that could not be checked (offline, a timeout) rather than one that was
 * refused, so Enter can still keep it.
 */
export type KeyVerdict = { ok: true; line?: string } | { ok: false; line: string; usable?: boolean };

export type CloudKeyAnswer =
  | { kind: "typed"; key: string; note?: string }
  | { kind: "saved"; verified: boolean };

export interface CloudKeyPromptOptions {
  /** The heading, e.g. "Connect to cloud". */
  message: string;
  /** Grey text after the heading: where the key will be sent. */
  meta?: string;
  /** What Tab does, for the key hints: "use open source instead", or "skip". */
  tabHint: string;
  /** The `✕` line for Enter on an empty field with no saved key to use. */
  emptyError: string;
  /** A key already on this machine: drawn at once, checked in the background. */
  saved?: { masked: string; check: () => Promise<KeyVerdict> };
  /** Checks a typed key. Never called for one shorter than `minLength`. */
  check: (key: string) => Promise<KeyVerdict>;
  minLength?: number;
  /** The lines the prompt collapses to once answered. */
  collapsed?: (answer: CloudKeyAnswer | OpenSource) => string[];
  stdin?: TTYIn;
  stdout?: TTYOut;
}

/**
 * One masked `API key ›` field, with Tab as the way out to open source.
 *
 * Its own prompt rather than options on `promptText`, which keeps a one-row
 * rule its other callers depend on. This one needs rows above and below the
 * field: a saved key's state, a spinner while a key is checked, and a `✕` line
 * that keeps the typed key in place so Enter can retry it.
 *
 * Three rules hold for every state:
 *  - Tab inside a paste is part of the paste. A pasted key arrives as keys,
 *    so a tab in it would otherwise switch to open source halfway through.
 *    Bracketed paste is switched on for exactly this, and Enter inside a paste
 *    (a copied trailing newline) never submits either.
 *  - Keys are ignored while a typed key is being checked, Esc excepted: a
 *    check can take ten seconds and leaving must stay possible.
 *  - The terminal is put back on every way out: cursor, raw mode and paste
 *    mode, including a process exit while the prompt is open.
 */
export function promptCloudKey(opts: CloudKeyPromptOptions): Promise<CloudKeyAnswer | OpenSource | null> {
  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;
  // Nobody is there to type a key. The wizard never asks without a terminal;
  // this answers the same way a cancel would rather than hang on a pipe.
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);

  const c = paint(colorsEnabled(stdout));
  const kit = screenKit({ cols: stdout.columns || 80, color: colorsEnabled(stdout) });
  const minLength = opts.minLength ?? 8;
  const spinnerFrames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const region: Region = { lastCount: 0 };

  let typed = "";
  let inPaste = false;
  // The saved key's state: being checked, works, could not be checked, or
  // refused — and a refused key is treated as no saved key at all.
  let savedState: "checking" | "works" | "unchecked" | "refused" | "none" = opts.saved ? "checking" : "none";
  let savedLine = "";
  let enterWaiting = false;
  let checkingTyped = false;
  let fieldError = "";
  let refusedOnce = false;
  let frame = 0;
  let spinning = false;
  let settled = false;
  let spinDelay: ReturnType<typeof setTimeout> | null = null;
  let spinTimer: ReturnType<typeof setInterval> | null = null;

  const savedUsable = (): boolean => savedState === "checking" || savedState === "works" || savedState === "unchecked";

  const spinGlyph = (): string => (spinning ? c.ink3(spinnerFrames[frame % spinnerFrames.length]) : " ");

  const build = (): string[] => {
    const lines: string[] = [promptHeading(c, opts.message, opts.meta)];
    if (opts.saved) {
      if (savedState === "checking") lines.push(`  ${spinGlyph()} Checking your saved key ${opts.saved.masked}…`);
      else if (savedState === "works") lines.push(kit.ok(savedLine));
      else if (savedState === "unchecked" || savedState === "refused") lines.push(kit.caution(savedLine));
    }
    lines.push(`${INDENT}${"API key".padEnd(10)}${c.pink("› ")}${"•".repeat(typed.length)}`);
    if (checkingTyped) {
      lines.push(`  ${spinGlyph()} Checking the key…`);
      return lines;
    }
    if (fieldError) lines.push(kit.fail(fieldError));
    // "type to replace it", not the reference's "type a new key to replace it":
    // the reference is drawn at 104 columns, and at 80 the longer line is cut
    // through the Tab hint, which is the only place Tab is mentioned.
    const hints =
      fieldError && refusedOnce
        ? ["enter try again", `tab ${opts.tabHint}`, "esc cancel"]
        : savedUsable() && typed.length === 0
          ? ["enter use saved key", "type to replace it", `tab ${opts.tabHint}`]
          : ["enter connect", `tab ${opts.tabHint}`, "esc cancel"];
    lines.push("", kit.keys(hints));
    return lines;
  };

  const draw = (): void => {
    if (!settled) repaint(stdout, region, build());
  };

  const stopSpinner = (): void => {
    if (spinDelay) clearTimeout(spinDelay);
    if (spinTimer) clearInterval(spinTimer);
    spinDelay = null;
    spinTimer = null;
    spinning = false;
  };
  // 150 ms before the first frame, so a check that answers at once never
  // flashes a spinner; 80 ms a frame after that.
  const startSpinner = (): void => {
    stopSpinner();
    spinDelay = setTimeout(() => {
      spinning = true;
      draw();
      spinTimer = setInterval(() => {
        frame++;
        draw();
      }, 80);
      spinTimer.unref?.();
    }, 150);
    spinDelay.unref?.();
  };

  const restoreTerminal = (): void => {
    stdout.write(`${ESC}[?2004l`);
    showCursor(stdout);
  };

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    const finish = (answer: CloudKeyAnswer | OpenSource | null): void => {
      if (settled) return;
      stopSpinner();
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.removeListener("exit", restoreTerminal);
      const lines =
        answer === null
          ? [promptHeading(c, opts.message), c.ink3("cancelled")]
          : (opts.collapsed?.(answer) ?? [promptHeading(c, opts.message)]);
      repaint(stdout, region, lines);
      settled = true;
      restoreTerminal();
      resolve(answer);
    };

    const keepSaved = (): void => {
      if (savedState === "checking") {
        // Enter waits for a check still in flight, and says so by spinning.
        enterWaiting = true;
        return;
      }
      finish({ kind: "saved", verified: savedState === "works" });
    };

    const submit = (): void => {
      if (typed.length === 0) {
        if (savedUsable()) return keepSaved();
        fieldError = opts.emptyError;
        refusedOnce = false;
        return draw();
      }
      if (typed.length < minLength) {
        fieldError = "That looks too short to be a key.";
        refusedOnce = false;
        return draw();
      }
      checkingTyped = true;
      fieldError = "";
      startSpinner();
      draw();
      const key = typed;
      opts.check(key).then(
        (verdict) => {
          if (settled) return;
          checkingTyped = false;
          stopSpinner();
          if (verdict.ok) return finish({ kind: "typed", key, note: verdict.line });
          fieldError = verdict.line;
          refusedOnce = true;
          draw();
        },
        (err: unknown) => {
          if (settled) return;
          checkingTyped = false;
          stopSpinner();
          fieldError = `Couldn't check the key: ${err instanceof Error ? err.message : String(err)}`;
          refusedOnce = true;
          draw();
        },
      );
    };

    function onKey(str: string | undefined, key: readline.Key): void {
      if (!key || settled) return;
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") return finish(null);
      if (key.name === "paste-start") {
        inPaste = true;
        return;
      }
      if (key.name === "paste-end") {
        inPaste = false;
        return draw();
      }
      if (checkingTyped || enterWaiting) return;
      if (key.name === "tab") {
        if (!inPaste) finish(OPEN_SOURCE);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (!inPaste) submit();
        return;
      }
      if (key.name === "backspace") {
        typed = typed.slice(0, -1);
        if (fieldError) fieldError = "";
        return draw();
      }
      // A key is never whitespace, so a copied newline or space is dropped
      // rather than becoming part of what gets sent.
      if (str && !key.ctrl && !key.meta) {
        const clean = str.replace(/\s+/g, "");
        if (!clean) return;
        typed += clean;
        if (fieldError) fieldError = "";
        if (!inPaste) draw();
      }
    }

    process.once("exit", restoreTerminal);
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    hideCursor(stdout);
    stdout.write(`${ESC}[?2004h`);
    stdin.on("keypress", onKey);
    if (opts.saved) startSpinner();
    draw();

    opts.saved?.check().then(
      (verdict) => {
        if (settled) return;
        if (verdict.ok) {
          savedState = "works";
          savedLine = verdict.line ?? `Your saved key works: ${opts.saved?.masked}`;
        } else {
          savedState = verdict.usable ? "unchecked" : "refused";
          savedLine = verdict.line;
        }
        if (!checkingTyped) stopSpinner();
        if (enterWaiting) {
          enterWaiting = false;
          if (savedUsable()) return keepSaved();
        }
        draw();
      },
      (err: unknown) => {
        if (settled) return;
        savedState = "unchecked";
        savedLine = `Couldn't check your saved key: ${err instanceof Error ? err.message : String(err)}`;
        if (!checkingTyped) stopSpinner();
        if (enterWaiting) {
          enterWaiting = false;
          return keepSaved();
        }
        draw();
      },
    );
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
 * so a surface can be asserted at any width, with color on or off, without a pty.
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

/** Nothing to show, said the same way everywhere: what is empty, then the one
 *  command that changes that. */
export function emptyState(
  spec: { what: string; hint?: string; cmd?: string },
  opts?: RenderOpts,
): string[] {
  return stack(note(spec.what, opts), spec.cmd ? nextStep(spec.cmd, spec.hint, opts) : null);
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

// ── the 2026-10 screen language ─────────────────────────────────────────────
/**
 * The redesign's building blocks: open text on the terminal — the wordmark
 * header, UPPERCASE headings at column 0, rows indented two, colour by role, and
 * no boxes or rules. The byte-level target is `reference/screens.js` →
 * `FP.primitives` in the design handoff; the bytes differ only where the tiers
 * above say how a colour is spelled.
 *
 * Commands, URLs, paths and ids are never cut: they are the part a person
 * copies, and half of one runs the wrong thing. Prose may be shortened with `…`
 * when `fit` is on, which a caller sets only for a terminal — piped output is
 * never cut.
 *
 * ONE exported factory rather than a dozen functions, on purpose. The CLI ships
 * as a single scope-hoisted bundle, and a new top-level name that matches a
 * local inside a builtin policy or an audit detector (`cmd`, `row`, `head`, …)
 * makes the bundler rename that local. That changes the function source the
 * audit cache keys on (`engineVersion` / `detectorVersion`), and every user's
 * history is rescanned from zero at upgrade. Everything here lives inside the
 * factory, so the bundle gains exactly one name.
 */
export interface ScreenKitOpts extends RenderOpts {
  /** The version the header shows. Defaults to this build's. */
  version?: string;
  /** Shorten prose that does not fit `cols`, ending on `…`. Terminal only. */
  fit?: boolean;
}

export function screenKit(opts: ScreenKitOpts = {}) {
  const { cols, c } = ctx(opts);
  const colour = opts.color ?? false;
  const version = opts.version ?? cliVersion;
  const sep = c.ink3("  ·  ");
  // Never paint nothing: an empty span is two escapes with no text between.
  const tint = (paintFn: (s: string) => string, s: string): string => (s ? paintFn(s) : "");

  /** Typeable: every command on a screen is pink. */
  const cmd = (s: string): string => c.pink(s);
  const on = c.guide(RADIO_ON);
  const off = c.ink3(RADIO_OFF);
  /** A row whose thing could not run — a file that is missing or will not load. */
  const failed = c.err("✕");
  /** Picked and not picked: a pack's defaults on `policies show`, a checklist row. */
  const selected = c.pink("■");
  const unselected = c.ink3("□");
  /** Grey text that qualifies a value rather than being one: `observe` beside a pack. */
  const meta = (s: string): string => tint(c.ink3, s);

  /** Prose shortened to `room` columns when fitting is on; untouched otherwise. */
  const prose = (s: string, room: number): string =>
    opts.fit && visibleWidth(s) > room ? fit(s, Math.max(1, room)) : s;

  /** `failproof ai  v1.0.11  ·  Context` — the line every screen opens with. */
  const header = (context?: string): string =>
    `${c.bold("fa")}${c.pinkBold("il")}${c.bold("proof ai")}  ${c.ink3(`v${version}`)}` +
    (context ? `${sep}${context}` : "");

  /** An UPPERCASE heading, with optional grey meta after it. */
  const head = (text: string, meta?: string): string =>
    c.bold(text.toUpperCase()) + (meta ? `  ${c.ink3(meta)}` : "");

  /**
   * `name  description` rows on one column for the block: at least `minCol`
   * wide, and always two spaces past the widest name. The design fixes its
   * columns by hand, and the longest real policy name is exactly the 32 it
   * fixes, so a fixed column runs that name into its description. Names are
   * never cut; descriptions are prose and give up the room.
   */
  const rows = (items: Array<[string, string?]>, minCol = 0): string[] => {
    const width = Math.max(minCol, ...items.map(([name, desc]) => (desc ? visibleWidth(name) + 2 : 0)));
    return items.map(([name, desc]) => {
      if (!desc) return `${INDENT}${name}`;
      const lead = `${INDENT}${pad(name, width)}`;
      return lead + prose(c.ink2(desc), cols - visibleWidth(lead));
    });
  };

  /**
   * Grey labels and their values, on one column at least nine wide — where the
   * reference starts its values. Values are never cut: they are URLs, ids and
   * counts, and a line that outgrows the terminal is left for it to wrap.
   *
   * An empty label continues the row above it, under the same value column —
   * `config --status` lists each paused session that way.
   */
  const kv = (items: Array<[string, string]>, minLabel = 9): string[] => {
    const width = Math.max(minLabel, ...items.map(([label]) => visibleWidth(label))) + 2;
    return items.map(([label, value]) =>
      value ? `${INDENT}${pad(tint(c.ink3, label), width)}${value}` : `${INDENT}${tint(c.ink3, label)}`,
    );
  };

  /** `✓ Done, said in the past tense.` with optional grey detail. */
  const ok = (text: string, detail?: string): string =>
    `${c.guide("✓")} ${text}${detail ? `  ${c.ink3(detail)}` : ""}`;

  /** `▲ Needs attention.  ·  the fix` */
  const caution = (text: string, fix?: string): string =>
    `${c.warn("▲")} ${text}${fix ? `${sep}${cmd(fix)}` : ""}`;

  /** `✕ Failed, said plainly.  ·  the fix` */
  const fail = (text: string, fix?: string): string =>
    `${c.err("✕")} ${text}${fix ? `${sep}${cmd(fix)}` : ""}`;

  /**
   * A message as every notice prints it: the first line after one state glyph,
   * each later line a fix line indented two (keeping any indentation of its
   * own), and each `backticked` span painted as a command with the backticks
   * dropped. A message author writes `Run  \`failproofai help\`  for usage.`,
   * and it reads `Run  failproofai help  for usage.` in a pipe, with the
   * command in pink on a terminal. Unbalanced backticks are left as written
   * rather than guessed at.
   *
   * Never cut: a notice holds the reason something failed and the command that
   * fixes it, and half of either is worse than a line the terminal wraps.
   */
  const notice = (state: "ok" | "caution" | "fail", message: string): string[] => {
    const typeable = (line: string): string =>
      (line.split("`").length - 1) % 2 === 0 ? line.replace(/`([^`]+)`/g, (_whole, typed: string) => cmd(typed)) : line;
    const glyph = state === "ok" ? c.guide("✓") : state === "caution" ? c.warn("▲") : c.err("✕");
    const [first = "", ...rest] = message.split("\n");
    return [
      `${glyph} ${typeable(first)}`,
      ...rest.map((line) => (line.trim() === "" ? "" : `${INDENT}${typeable(line)}`)),
    ];
  };

  /**
   * `Continue? y/N` — the one question a destructive command asks, after the
   * caller has printed what it would do. Only `y` or `yes`, in any case, then
   * Enter, is a yes. Enter alone, anything else, Esc, Ctrl+C, Ctrl+D or the
   * input closing is a no: the default answer to "remove these?" has to be the
   * one that removes nothing, and one stray key must not be consent. Keys are
   * read the way the pickers read them (raw, echoed here), so it behaves the
   * same on every terminal. Callers ask only when there is one to answer on.
   */
  const confirm = (io: { stdin: TTYIn; stdout: TTYOut }, question = "Continue?"): Promise<boolean> =>
    new Promise((resolve) => {
      const { stdin, stdout } = io;
      let typed = "";
      let settled = false;
      const wasRaw = stdin.isRaw;
      const settle = (answer: boolean): void => {
        if (settled) return;
        settled = true;
        stdin.removeListener("keypress", onKey);
        stdin.removeListener("end", onEnd);
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdout.write("\n");
        resolve(answer);
      };
      function onEnd(): void {
        settle(false);
      }
      function onKey(sequence: string | undefined, key: readline.Key | undefined): void {
        const name = key?.name;
        if ((key?.ctrl && (name === "c" || name === "d")) || name === "escape") settle(false);
        else if (name === "return" || name === "enter") settle(/^y(es)?$/i.test(typed.trim()));
        else if (name === "backspace") {
          if (typed) {
            typed = typed.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (sequence && sequence.length === 1 && sequence >= " " && !key?.ctrl && !key?.meta) {
          typed += sequence;
          stdout.write(sequence);
        }
      }
      stdout.write(`${question} ${c.ink3("y/N")} `);
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode?.(true);
      stdin.on("keypress", onKey);
      stdin.on("end", onEnd);
      stdin.resume();
    });

  /** Lowercase key hints at the foot of an interactive screen. */
  const keys = (list: string[]): string => c.ink3(list.join("  ·  "));

  /**
   * A progress bar `width` cells wide and `fraction` full: the filled part pink,
   * the rest the track grey. With colour off the rest is blank, because one
   * unbroken run of `━` would show no progress at all.
   */
  const bar = (width: number, fraction: number): string => {
    const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
    const rest = Math.max(0, width - filled);
    return tint(c.pink, "━".repeat(filled)) + (colour ? tint(c.track, "━".repeat(rest)) : " ".repeat(rest));
  };

  /**
   * The logomark with a two-space margin, or nothing on a terminal too narrow
   * to draw it — the old `▮▮` one-liner is retired with the rest of that mark.
   * Callers show it only on a TTY, and only on bare `failproofai` and at the
   * start of a `config` run.
   */
  const logo = (): string[] => {
    if (cols < LOGO_MIN_COLS) return [];
    const tier: ColorTier = colour ? colorTier() : "basic";
    return renderLogo(tier).map((line) => `${INDENT}${line}`);
  };

  /** A command's `--help`: usage, options and examples. Nothing else. */
  const helpPage = (spec: {
    name: string;
    usage: Array<[string, string?]>;
    options?: Array<[string, string]>;
    examples?: string[];
    /** The options column, when the design fixes a wider one than the data needs. */
    optionsCol?: number;
  }): string[] => {
    const out = [header(spec.name), "", head("Usage"), ...rows(spec.usage)];
    if (spec.options?.length) out.push("", head("Options"), ...rows(spec.options, spec.optionsCol ?? 0));
    if (spec.examples?.length) out.push("", head("Examples"), ...spec.examples.map((e) => `${INDENT}${cmd(e)}`));
    return out;
  };

  /**
   * A block that redraws in place: a progress screen.
   *
   * Every frame is ONE write, through the same atomic `repaint` the prompts use,
   * and frames are held to one per 100 ms — the design's progress tempo — with
   * the newest always landing. `build` runs only for a frame that is actually
   * drawn, so a caller can ask after every event it hears about.
   *
   * The cursor is hidden while the block is live and shown again when it ends:
   * on `done`, on exit, and on SIGINT or SIGTERM. A signal is re-raised once the
   * cursor is back, so Ctrl+C still stops the command exactly as it did before
   * anything was listening for it. TTY only: everywhere else the caller prints
   * its last screen once, with no frames.
   */
  const live = (out: TTYOut) => {
    const region: Region = { lastCount: 0 };
    const every = 100;
    let lastAt = 0;
    let pending: (() => string[]) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hidden = false;
    let over = false;

    const showAgain = (): void => {
      out.write(`${ESC}[?25h`);
    };
    const release = (): void => {
      process.removeListener("exit", showAgain);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      over = true;
      if (timer) clearTimeout(timer);
      release();
      showAgain();
      process.kill(process.pid, signal);
    };
    const flush = (): void => {
      timer = null;
      const build = pending;
      pending = null;
      if (!build || over) return;
      lastAt = Date.now();
      let lead = "";
      if (!hidden) {
        hidden = true;
        lead = `${ESC}[?25l`;
        process.once("exit", showAgain);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }
      repaint(out, region, build(), { lead });
    };

    return {
      /** Ask for a frame; it is drawn now, or as soon as the tempo allows. */
      draw(build: () => string[]): void {
        if (over) return;
        pending = build;
        if (timer) return;
        const wait = lastAt + every - Date.now();
        if (wait <= 0) {
          flush();
          return;
        }
        timer = setTimeout(flush, wait);
        timer.unref?.();
      },
      /**
       * Draw the last frame at once and give the cursor back. Never cut: nothing
       * repaints it, so it stays in scrollback exactly as written.
       */
      done(lines: string[]): void {
        if (over) return;
        over = true;
        if (timer) clearTimeout(timer);
        timer = null;
        pending = null;
        release();
        repaint(out, region, lines, { cut: false, tail: hidden ? `${ESC}[?25h` : "" });
      },
    };
  };

  return {
    cols, sep, cmd, on, off, failed, selected, unselected, meta,
    header, head, rows, kv, ok, caution, fail, notice, confirm, keys, bar, logo, helpPage, live,
  };
}
