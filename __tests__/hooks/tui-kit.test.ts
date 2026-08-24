import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  type TTYIn,
  multiSelect,
  INDENT,
  CHIP_WIDTH,
  brandAnsi,
  bullets,
  chip,
  colorsEnabled,
  danger,
  emptyState,
  helpBlock,
  note,
  nextStep,
  optsFor,
  paint,
  printBlock,
  renderBrandLogo,
  rows,
  rule,
  stack,
  table,
  title,
  visibleWidth,
  warning,
  wrap,
  type ChipState,
  type RenderOpts,
  type TTYOut,
} from "../../src/hooks/tui";

const WIDTHS = [80, 120, 200] as const;
const PLAIN: RenderOpts = { cols: 80, color: false };
const COLOR: RenderOpts = { cols: 80, color: true };

/** Visual column the value starts in, i.e. after the label and its padding. */
function valueColumn(line: string): number {
  // Sliced past the block indent first, or the indent itself reads as the gap.
  const plain = line.replace(/\x1B\[[0-9;]*m/g, "").slice(INDENT.length);
  const gap = plain.search(/\s{2,}\S/);
  return gap === -1 ? -1 : INDENT.length + gap + plain.slice(gap).search(/\S/);
}

/**
 * Drive the two env vars the tier detection reads, then put the ambient ones
 * back. These tests run in whatever terminal CI happens to hand them, so a test
 * that merely set COLORTERM would pass locally and assert nothing on a runner
 * that already exports it.
 */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const TRUECOLOR = { COLORTERM: "truecolor", TERM: "xterm-256color", NO_COLOR: undefined };
const ANSI256 = { COLORTERM: undefined, TERM: "xterm-256color", NO_COLOR: undefined };
const BASIC = { COLORTERM: undefined, TERM: "xterm", NO_COLOR: undefined };

// The brand system names exactly two accents. Anything else on a surface is a
// state (amber, dim), never identity.
const PINK_24 = "38;2;228;88;125"; // #e4587d
const PINK_256 = "38;5;168"; // #d75f87, the nearest cube entry
const PINK_BASIC = "\x1B[95m";
const MINT_24 = "38;2;102;209;181"; // #66d1b5
const MINT_256 = "38;5;79"; // #5fd7af

describe("the brand palette", () => {
  it("is ONE pink — #e4587d — at 24-bit", () => {
    const painted = withEnv(TRUECOLOR, () => paint(true).pink("x"));
    expect(painted).toBe(`\x1B[${PINK_24}mx\x1B[0m`);
    // The hot #ff2e88 that used to sit in this slot is in no brand token.
    expect(painted).not.toContain("255;46;136");
  });

  it("has no second pink left to drift from the first", () => {
    // `softPink` was the logomark's own tint. Once both are the brand pink the
    // mark and the prompts cannot be recoloured apart again.
    const c = withEnv(TRUECOLOR, () => paint(true));
    expect(c.softPink("beta")).toBe(c.pink("beta"));
  });

  it("keeps the mint exactly where it was — the brand's other accent", () => {
    expect(withEnv(TRUECOLOR, () => paint(true).guide("x"))).toBe(`\x1B[${MINT_24}mx\x1B[0m`);
  });
});

describe("colour tiers", () => {
  it("emits 24-bit when COLORTERM advertises it", () => {
    const painted = withEnv(TRUECOLOR, () => paint(true).pink("x"));
    expect(painted).toContain(PINK_24);
    expect(painted).not.toContain(PINK_256);
    expect(painted).not.toContain(PINK_BASIC);
  });

  it("emits the 256 cube when TERM says 256 and COLORTERM says nothing", () => {
    // The tier this adds. Without it tmux, screen, ssh into a stock xterm and
    // most CI runners fell from 24-bit straight to generic bright magenta.
    const painted = withEnv(ANSI256, () => paint(true).pink("x"));
    expect(painted).toContain(PINK_256);
    expect(painted).not.toContain("38;2;");
    expect(painted).not.toContain(PINK_BASIC);
  });

  it("still falls back to basic ANSI when the terminal claims neither", () => {
    expect(withEnv(BASIC, () => paint(true).pink("x"))).toBe(`${PINK_BASIC}x\x1B[0m`);
    expect(withEnv(BASIC, () => paint(true).guide("x"))).toBe(`\x1B[36mx\x1B[0m`);
    expect(withEnv(BASIC, () => paint(true).warn("x"))).toBe(`\x1B[33mx\x1B[0m`);
  });

  it("resolves every hue through the same tier, not just pink", () => {
    expect(withEnv(ANSI256, () => paint(true).guide("x"))).toContain(MINT_256);
    expect(withEnv(ANSI256, () => paint(true).warn("x"))).toContain("38;5;179");
  });

  it("keeps dim as the SGR attribute in the 256 tier", () => {
    // The cube's nearest grey is a FIXED colour; SGR 2 steps down whatever
    // foreground the user's theme is already using. A fixed grey looks correct
    // on our terminal and fights every other one.
    expect(withEnv({ ...ANSI256, TERM: "screen-256color" }, () => paint(true).dim("x"))).toBe(
      "\x1B[2mx\x1B[0m",
    );
  });

  it("carries the tiers into brandAnsi, so `audit` and `config` stay one product", () => {
    expect(withEnv(TRUECOLOR, () => brandAnsi("pink"))).toBe(`\x1B[${PINK_24}m`);
    expect(withEnv(ANSI256, () => brandAnsi("pink"))).toBe(`\x1B[${PINK_256}m`);
    expect(withEnv(BASIC, () => brandAnsi("pink"))).toBe(PINK_BASIC);
    expect(withEnv(ANSI256, () => brandAnsi("guide"))).toBe(`\x1B[${MINT_256}m`);
  });

  it("emits ZERO escapes under NO_COLOR, however deep the terminal is", () => {
    const out = { isTTY: true, columns: 80, write: vi.fn(() => true) } as unknown as TTYOut;
    const painted = withEnv({ ...TRUECOLOR, NO_COLOR: "1" }, () => {
      expect(colorsEnabled(out)).toBe(false);
      const c = paint(colorsEnabled(out));
      return [c.pink("a"), c.guide("b"), c.dim("c"), c.bold("d")].join("");
    });
    expect(painted).toBe("abcd");
    expect(painted).not.toContain("\x1B");
  });

  it("emits ZERO escapes off a TTY, however deep the terminal is", () => {
    const out = { isTTY: false, columns: 80, write: vi.fn(() => true) } as unknown as TTYOut;
    const lines = withEnv(TRUECOLOR, () => renderBrandLogo(out));
    expect(lines.join("")).not.toContain("\x1B");
  });
});

describe("the logomark follows the tier", () => {
  const tty = { isTTY: true, columns: 80, write: vi.fn(() => true) } as unknown as TTYOut;

  it("paints from the cube when the terminal is 256-colour, not monochrome", () => {
    // It used to test truecolor-or-nothing, so a 256-colour terminal got the
    // mark in the foreground colour while the wordmark under it was coloured.
    const art = withEnv(ANSI256, () => renderBrandLogo(tty)).join("\n");
    expect(art).toContain(PINK_256);
    expect(art).toContain(MINT_256);
    expect(art).not.toContain("38;2;");
  });

  it("paints 24-bit from the same two accents as the prompts", () => {
    const art = withEnv(TRUECOLOR, () => renderBrandLogo(tty)).join("\n");
    expect(art).toContain(PINK_24);
    expect(art).toContain(MINT_24);
    // The mark's own softer pink is gone; it is the brand pink now.
    expect(art).not.toContain("228;88;124");
  });

  it("draws monochrome on a 16-colour terminal rather than approximate the hues", () => {
    const art = withEnv(BASIC, () => renderBrandLogo(tty)).join("\n");
    // The block glyphs still print — shape carries the mark, colour never has
    // to. No 38;/48; anywhere: basic pink is `[95m` and dim is `[2m`.
    expect(art).toContain("█");
    expect(art).not.toContain("38;");
    expect(art).not.toContain("48;");
  });
});

describe("visibleWidth", () => {
  it("ignores ANSI so a coloured cell still lines up", () => {
    expect(visibleWidth("\x1B[1mON\x1B[0m")).toBe(2);
    expect(visibleWidth("plain")).toBe(5);
  });
});

describe("wrap", () => {
  it("never breaks a single long token, because a split path cannot be copied", () => {
    const path = "/home/chetan/.failproofai/policies/packs/artifacts/deadbeef.mjs";
    expect(wrap(path, 20)).toEqual([path]);
  });

  it("wraps on word boundaries within the budget", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });
});

/** SGR openers left unclosed at the end of a line bleed into everything after. */
function unclosedSgr(line: string): boolean {
  const opens = (line.match(/\x1B\[(?!0?m)[0-9;]*m/g) ?? []).length;
  const resets = (line.match(/\x1B\[0?m/g) ?? []).length;
  return opens > resets;
}

describe("coloured values wrap instead of being clipped", () => {
  const long =
    "scans continue; digests need a fresh opt-in — run `--schedule` to turn them on";

  it("keeps every character of a coloured value", () => {
    const painted = `\x1B[38;2;255;46;136m${long}\x1B[0m`;
    const out = rows([["reports to", painted]], { cols: 80, color: true });
    const plain = out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");
    // The bug: `wrap` counted escape bytes as columns, so a coloured value was
    // handed back unwrapped and then hard-cut at the terminal edge — losing
    // " to turn them on" with no ellipsis to admit it.
    expect(plain).toContain("to turn them on");
    expect(out.length).toBeGreaterThan(1);
  });

  it("closes the colour it opened on every line", () => {
    const painted = `\x1B[38;2;255;46;136m${long}\x1B[0m`;
    for (const line of rows([["reports to", painted]], { cols: 80, color: true })) {
      expect(unclosedSgr(line)).toBe(false);
    }
  });

  it("closes the colour when a table cell is cut", () => {
    const painted = `\x1B[38;2;255;46;136m${long}\x1B[0m`;
    for (const line of table({ head: ["State"], rows: [[painted]] }, { cols: 40, color: true })) {
      expect(unclosedSgr(line)).toBe(false);
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("still never splits a single long token", () => {
    const url = `\x1B[2mhttps://app.befailproof.ai/v1/events/very/long/path\x1B[0m`;
    const out = rows([["dashboard", url]], { cols: 40, color: true });
    const plain = out.join("").replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("https://app.befailproof.ai/v1/events/very/long/path");
  });
});

describe("rows — the audit --status defect", () => {
  it("puts every value in ONE computed column, whatever the label lengths", () => {
    const out = rows(
      [
        ["scheduled audit", "off"],
        ["reports to", "— signed out"],
        ["daemon", "running"],
      ],
      PLAIN,
    );
    // The defect this fixes: col 21 on the first row, col 18 on the rest.
    const columns = out.map(valueColumn);
    expect(new Set(columns).size).toBe(1);
    // And the column is derived from the widest label, not hand-counted.
    expect(columns[0]).toBe(INDENT.length + "scheduled audit".length + 2);
    for (const line of out) expect(line.startsWith(INDENT)).toBe(true);
  });

  it("keeps that column when a value carries colour", () => {
    const withChip = rows(
      [
        ["policies", chip("on", COLOR)],
        ["packs", chip("failed", COLOR)],
      ],
      COLOR,
    );
    const columns = withChip.map(valueColumn);
    // -1 means "no value column found"; without this the assertion passed
    // precisely when the column had disappeared, which is the failure it exists
    // to catch.
    for (const column of columns) expect(column).toBeGreaterThan(0);
    expect(new Set(columns).size).toBe(1);
  });

  it("returns nothing for no rows rather than an empty frame", () => {
    expect(rows([], PLAIN)).toEqual([]);
  });
});

describe("labels are never cut", () => {
  const sessionId = "01J8ZQ7K3M4N5P6Q7R8S9T0V1W-worktree-checkout";

  it("keeps a long label whole — it is the id --resume needs", () => {
    const out = rows([[sessionId, "8m left (until 21:14)"]], PLAIN);
    expect(out.join("\n")).toContain(sessionId);
    expect(out.join("\n")).not.toContain("…");
  });

  it("gives an over-long label its own line rather than eating the value column", () => {
    const out = rows(
      [
        [sessionId, "8m left"],
        ["enforcement", "paused for 1 session"],
      ],
      { cols: 60, color: false },
    );
    expect(out.some((l) => l.trim() === sessionId)).toBe(true);
    expect(out.join("\n")).toContain("8m left");
    expect(out.join("\n")).toContain("paused for 1 session");
  });
});

describe("stack — blank-line discipline", () => {
  it("never emits two blanks, a leading blank, or a whitespace-only line", () => {
    const out = stack(["a", "", ""], [" ", "b"], [], null, ["", "c"]);
    expect(out).toEqual(["a", "", "b", "", "c"]);
  });

  it("drops groups that are entirely blank", () => {
    expect(stack(["x"], ["", " "], ["y"])).toEqual(["x", "", "y"]);
  });
});

describe("title", () => {
  it("right-aligns the meta against the terminal edge", () => {
    const [line] = title("failproofai policies", "user · 39 policies", { cols: 60, color: false });
    expect(visibleWidth(line)).toBe(60 - INDENT.length);
    expect(line.startsWith(`${INDENT}failproofai policies`)).toBe(true);
  });

  it("drops the meta to its own line rather than wrapping the heading", () => {
    const out = title("failproofai policies", "user · 39 policies", { cols: 30, color: false });
    expect(out).toHaveLength(2);
    expect(out[1].trim()).toBe("user · 39 policies");
  });
});

describe("chip", () => {
  const states: ChipState[] = ["on", "off", "locked", "cloud", "pack", "failed", "observe"];

  it("is one width for every state, so a column of them lines up", () => {
    for (const state of states) {
      expect(visibleWidth(chip(state, PLAIN))).toBe(CHIP_WIDTH);
      expect(visibleWidth(chip(state, COLOR))).toBe(CHIP_WIDTH);
    }
  });

  it("carries meaning without colour — symbol and word, never colour alone", () => {
    for (const state of states) {
      const plain = chip(state, PLAIN);
      expect(plain).not.toContain("\x1B");
      expect(plain.trim().length).toBeGreaterThan(1);
    }
    expect(chip("on", PLAIN)).not.toBe(chip("off", PLAIN));
    expect(chip("failed", PLAIN).trim()).toContain("FAIL");
  });
});

describe("table", () => {
  it("fits inside the terminal at every width, truncating the flex column", () => {
    const spec = {
      head: ["User", "Project", "Name", "Description"],
      rows: [
        [chip("on", PLAIN), chip("on", PLAIN), "block-force-push", "Prevent force-pushing to any branch, ever, under any circumstances whatsoever"],
        [chip("off", PLAIN), chip("off", PLAIN), "block-kubectl", "Block kubectl commands (Kubernetes cluster mutations)"],
      ],
    };
    for (const cols of WIDTHS) {
      for (const line of table(spec, { cols, color: false })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("keeps a long cell inside the terminal by shrinking the widest column", () => {
    // A path longer than the whole terminal used to push the row past the edge:
    // only the flex column gave way, and it had nothing left to give.
    const path = "/srv/team/very/deeply/nested/checkout/of/a/monorepo/sessions/store";
    const out = table(
      { head: ["Path", "Agent ids"], rows: [[path, "work-*"]], flex: 1 },
      { cols: 40, color: false },
    );
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("spends the flex column before any other, so the fact survives the note", () => {
    // Pinned by comparing the two flex choices on identical input: whichever
    // column is flex is the one that loses width. Asserting only that the path
    // survived passed even with the flex-first pass removed entirely.
    const spec = { head: ["Path", "Agent ids"], rows: [["/srv/team/checkout", "derived from the folder name"]] };
    const flexLast = table({ ...spec, flex: 1 }, { cols: 36, color: false });
    const flexFirst = table({ ...spec, flex: 0 }, { cols: 36, color: false });
    const row = (lines: string[]) => lines[lines.length - 1];
    expect(row(flexLast)).toContain("/srv/team/checkout");
    expect(row(flexFirst)).not.toContain("/srv/team/checkout");
  });

  it("never shrinks a protected column, even when everything else is at its floor", () => {
    const path = "/srv/team/very/deeply/nested/checkout/sessions/store";
    const out = table(
      { head: ["Path", "Agent ids"], rows: [[path, "derived from the folder name"]], flex: 1, protect: [0] },
      { cols: 40, color: false },
    );
    // The path is what the listing exists to hand back — it survives whole, and
    // the line is allowed to be long so the terminal can wrap it.
    expect(out[out.length - 1]).toContain(path);
  });

  it("renders a header and a divider above the rows", () => {
    const out = table({ head: ["Name"], rows: [["block-sudo"]] }, PLAIN);
    expect(out[0]).toContain("Name");
    expect(out[1]).toMatch(/─/);
    expect(out[2]).toContain("block-sudo");
  });
});

describe("bullets — the uninstall overrun", () => {
  it("wraps long items and aligns continuation under the text", () => {
    const long =
      "remove failproofai hook entries from 10 agent CLIs: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent, OpenCode, Pi, Factory Droid, Devin CLI, Antigravity CLI, Goose";
    const out = bullets([long], { cols: 80, color: false });
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].startsWith(`${INDENT}•`)).toBe(true);
    for (const line of out.slice(1)) expect(line.startsWith(`${INDENT}  `)).toBe(true);
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe("warning / danger", () => {
  it("hangs continuation lines under the text, not under the symbol", () => {
    const out = warning(
      ["This machine is configured to REQUIRE the daemon and the versions do not match, so the next restart denies every tool call."],
      { cols: 60, color: false },
    );
    expect(out[0]).toContain("⚠");
    expect(out.length).toBeGreaterThan(1);
    for (const line of out.slice(1)) expect(line.startsWith(`${INDENT}   `)).toBe(true);
  });

  it("danger uses its own symbol", () => {
    expect(danger(["deletes ~/.failproofai"], PLAIN)[0]).toContain("!");
  });
});

describe("emptyState", () => {
  it("says what is empty and the one command that changes it", () => {
    const out = emptyState(
      { what: "No packs installed.", hint: "Install one with:", cmd: "failproofai pack add owner/repo" },
      PLAIN,
    );
    expect(out.join("\n")).toContain("No packs installed.");
    expect(out.join("\n")).toContain("failproofai pack add owner/repo");
  });
});

describe("helpBlock", () => {
  it("puts every description in one column", () => {
    const out = helpBlock(
      {
        usage: [
          ["failproofai policy add <name>", "Enable one policy"],
          ["failproofai policy remove <name>", "Disable one policy"],
        ],
        options: [["--scope user|project|local", "Config scope (default: user)"]],
        examples: ["failproofai policy add block-sudo"],
      },
      PLAIN,
    );
    const described = out.filter((l) => /Enable one policy|Disable one policy|Config scope/.test(l));
    const starts = described.map((l) => l.search(/(Enable|Disable|Config)/));
    expect(new Set(starts).size).toBe(1);
  });

  it("gives an over-long name its own line instead of pushing the column out", () => {
    const out = helpBlock(
      {
        usage: [["failproofai policies --install --cli claude codex copilot cursor", "Install for many CLIs"]],
      },
      PLAIN,
    );
    expect(out.some((l) => l.trim() === "failproofai policies --install --cli claude codex copilot cursor")).toBe(true);
    expect(out.some((l) => l.includes("Install for many CLIs"))).toBe(true);
  });

  it("omits sections that have no entries", () => {
    const out = helpBlock({ usage: [["failproofai flush", "Deliver now"]] }, PLAIN);
    expect(out.join("\n")).not.toContain("OPTIONS");
    expect(out.join("\n")).not.toContain("EXAMPLES");
  });
});

describe("every builder, at every width", () => {
  const build = (opts: RenderOpts): string[] =>
    stack(
      title("failproofai policies", "user · 39 policies", opts),
      rule("Convention Policies", opts),
      rows([["daemon", "running"], ["scheduled audit", "off"]], opts),
      table({ head: ["Name", "Description"], rows: [["block-sudo", "Block sudo commands"]] }, opts),
      bullets(["remove hook entries from 10 agent CLIs"], opts),
      warning(["Hooks in multiple scopes (user, project)."], opts),
      note("Config: ~/.failproofai/policies-config.json", opts),
      nextStep("failproofai pack add owner/repo", "Install a pack with:", opts),
    );

  it("never exceeds the terminal width", () => {
    for (const cols of WIDTHS) {
      for (const line of build({ cols, color: false })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
      for (const line of build({ cols, color: true })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("emits no ANSI at all when colour is off", () => {
    expect(build({ cols: 80, color: false }).join("")).not.toContain("\x1B");
  });

  it("never indents by three — the audit --status dialect cannot come back", () => {
    for (const line of build({ cols: 80, color: false })) {
      if (line === "") continue;
      expect(line.startsWith(INDENT)).toBe(true);
      // 2 (block), 4 (bullet continuation) and 5 (gutter continuation) are the
      // legal indents. An odd 3 is the dialect this kit exists to delete.
      expect(/^ {3}\S/.test(line)).toBe(false);
    }
  });
});

describe("optsFor / printBlock", () => {
  it("reads width and colour off the stream, honouring non-TTY", () => {
    const out = { isTTY: false, columns: 132, write: vi.fn(() => true) } as unknown as TTYOut;
    expect(optsFor(out)).toEqual({ cols: 132, color: false });
  });

  it("falls back to 80 columns when the stream reports none", () => {
    const out = { isTTY: true, write: vi.fn(() => true) } as unknown as TTYOut;
    expect(optsFor(out).cols).toBe(80);
  });

  it("owns the outer margins so no surface has to remember them", () => {
    const write = vi.fn(() => true);
    const out = { isTTY: true, columns: 80, write } as unknown as TTYOut;
    printBlock(out, ["  body"]);
    expect(write).toHaveBeenCalledWith("\n  body\n\n");
  });

  it("does not truncate — an unbreakable token wraps at the terminal instead", () => {
    // `writeLines` cut every line to the terminal width, silently and with no
    // ellipsis. A path or session id lost its tail exactly when it mattered.
    const write = vi.fn((_chunk: unknown) => true);
    const path = "/srv/team/very/deeply/nested/checkout/of/a/monorepo/sessions/store/file.jsonl";
    printBlock({ isTTY: true, columns: 40, write } as unknown as TTYOut, [`  ${path}`]);
    expect(String(write.mock.calls[0]?.[0])).toContain(path);
  });

  it("writes nothing for an empty block", () => {
    const write = vi.fn(() => true);
    printBlock({ isTTY: true, columns: 80, write } as unknown as TTYOut, []);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("a name wider than its column", () => {
  /**
   * `nameWidth` caps the name column at 24 and the description budget is sized
   * against that cap — but `padEnd` pads and does not truncate, so a longer name
   * rendered at its true width and pushed the row past the terminal edge. The
   * description was then cut by the TERMINAL rather than by `ellipsize`, so it
   * lost its `…` and the row silently wrapped. Seen live on
   * `sanitize-connection-strings` (27 chars) in `failproofai policies add`.
   *
   * Driven through a real `PassThrough` rather than an object literal: the
   * prompt hands stdin to `readline.emitKeypressEvents`, which needs a genuine
   * stream. ESC cancels it once the first frame is painted, so nothing is left
   * listening.
   */
  const drawPicker = async (labels: string[], columns: number): Promise<string[]> => {
    const written: string[] = [];
    const stdout = {
      isTTY: true,
      columns,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    } as unknown as TTYOut;
    const stdin = new PassThrough() as unknown as TTYIn & PassThrough;
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};

    const pending = multiSelect<string>({
      message: "Which policies should be on?",
      choices: labels.map((label) => ({
        label,
        value: label,
        hint: "Stop Claude from reading database connection strings in tool responses",
      })),
      stdin: stdin as unknown as TTYIn,
      stdout,
    });
    stdin.write("\u001b");
    await pending;

    return written
      .join("")
      .split("\n")
      .map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""))
      .filter((line) => line.includes("Stop Claude"));
  };

  it("keeps every row inside the terminal, however long the name", async () => {
    const rows = await drawPicker(
      [
        "sanitize-jwt",
        "sanitize-connection-strings",
        // Long enough to WRAP rather than merely fill the last column. Measured:
        // before the fix the 27- and 28-character names landed on exactly 80,
        // which an 80-column terminal shows without wrapping — so a `<= 80`
        // assertion passed while the description was being silently cut. The
        // property is that the layout stays strictly inside its own budget.
        "sanitize-a-really-long-third-party-policy-name",
      ],
      80,
    );
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.length).toBeLessThan(80);
  });

  it("shortens the description rather than the name, which is what you type next", async () => {
    const rows = await drawPicker(["sanitize-connection-strings"], 80);
    expect(rows[0]).toContain("sanitize-connection-strings");
    // Cut by ellipsize, so it SAYS it was cut — not cut by the terminal edge.
    expect(rows[0]).toContain("\u2026");
  });

  it("gives a short name the wider description, so the cap is not a floor", async () => {
    const [shortName] = await drawPicker(["a-short-one"], 80);
    const [longName] = await drawPicker(["sanitize-private-key-content"], 80);
    const described = (row: string) => row.slice(row.indexOf("Stop Claude")).length;
    expect(described(shortName)).toBeGreaterThan(described(longName));
  });
});
