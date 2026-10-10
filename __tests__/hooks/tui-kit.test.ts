import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  type TTYIn,
  multiSelect,
  selectOne,
  INDENT,
  CHIP_WIDTH,
  brandAnsi,
  bullets,
  chip,
  colorsEnabled,
  danger,
  emptyState,
  helpBlock,
  helpColumn,
  helpHeading,
  helpOptsFor,
  helpScreen,
  note,
  nextStep,
  optsFor,
  paint,
  printBlock,
  renderBrandLogo,
  rows,
  rule,
  screenKit,
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

describe("the 2026-10 roles", () => {
  const INK3_24 = "38;2;118;127;139"; // #767f8b
  const TRACK_24 = "38;2;62;67;76"; // #3e434c
  const ERR_24 = "38;2;240;113;120"; // #f07178

  it("paints ink3 and track in their designed greys at 24-bit", () => {
    expect(withEnv(TRUECOLOR, () => paint(true).ink3("x"))).toBe(`\x1B[${INK3_24}mx\x1B[0m`);
    expect(withEnv(TRUECOLOR, () => paint(true).track("x"))).toBe(`\x1B[${TRACK_24}mx\x1B[0m`);
  });

  it("keeps both greys as the dim ATTRIBUTE below 24-bit, never a fixed colour", () => {
    // A cube grey fights every theme that is not ours, and the basic tier's
    // bright black (90) IS the background in Solarized Dark.
    for (const env of [ANSI256, BASIC]) {
      expect(withEnv(env, () => paint(true).ink3("x"))).toBe("\x1B[2mx\x1B[0m");
      expect(withEnv(env, () => paint(true).track("x"))).toBe("\x1B[2mx\x1B[0m");
    }
  });

  it("leaves ink2 in the terminal's own foreground at every tier", () => {
    // The designed #a7adb6 is about 2.2:1 on a light ground and nothing detects
    // which ground we are on, so descriptions are never painted.
    for (const env of [TRUECOLOR, ANSI256, BASIC]) {
      expect(withEnv(env, () => paint(true).ink2("Block sudo"))).toBe("Block sudo");
    }
  });

  it("paints err as a red at every tier, and not the brand pink's neighbour at 256", () => {
    expect(withEnv(TRUECOLOR, () => paint(true).err("x"))).toBe(`\x1B[${ERR_24}mx\x1B[0m`);
    // 204 is nearest by distance but differs from pink's 168 only in red.
    expect(withEnv(ANSI256, () => paint(true).err("x"))).toBe("\x1B[38;5;203mx\x1B[0m");
    expect(withEnv(ANSI256, () => paint(true).err("x"))).not.toContain("38;5;204");
    expect(withEnv(BASIC, () => paint(true).err("x"))).toBe("\x1B[31mx\x1B[0m");
  });

  it("routes the new roles through brandAnsi too, so no caller hard-codes them", () => {
    expect(withEnv(TRUECOLOR, () => brandAnsi("err"))).toBe(`\x1B[${ERR_24}m`);
    expect(withEnv(ANSI256, () => brandAnsi("ink3"))).toBe("\x1B[2m");
    expect(withEnv(BASIC, () => brandAnsi("track"))).toBe("\x1B[2m");
  });

  it("emits ZERO escapes for the new roles when colour is off", () => {
    const c = withEnv(TRUECOLOR, () => paint(false));
    const painted = [c.ink2("a"), c.ink3("b"), c.track("c"), c.err("d")].join("");
    expect(painted).toBe("abcd");
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
    // `▲`, not `⚠`. The design system forbids emoji outright, and `⚠` takes
    // EMOJI presentation on most terminals — which also makes it two columns
    // wide on some, breaking the very hang-indent this test pins.
    expect(out[0]).toContain("\u25B2");
    expect(out[0]).not.toContain("\u26A0");
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

describe("a repaint is one atomic frame", () => {
  /**
   * Anti-pattern #2 in the house TUI guide: flickering from full redraws. The
   * clear and the redraw used to be two separate `write()` calls, so a terminal
   * could paint the CLEARED state before the new lines arrived — invisible on a
   * local terminal, and a blank flash on every keystroke over SSH or inside
   * tmux, where the two writes cross a network or a multiplexer between frames.
   */
  const drawTwice = async (): Promise<string[]> => {
    const written: string[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    } as unknown as TTYOut;
    const stdin = new PassThrough() as unknown as TTYIn & PassThrough;
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};

    const pending = multiSelect<string>({
      message: "pick",
      choices: [
        { label: "one", value: "one" },
        { label: "two", value: "two" },
      ],
      stdin: stdin as unknown as TTYIn,
      stdout,
    });
    stdin.write("\u001b[B"); // down — forces a second frame
    stdin.write("\u001b"); // esc — cancel
    await pending;
    return written;
  };

  it("wraps every frame in synchronized output, so the terminal holds it", async () => {
    const written = await drawTwice();
    const frames = written.filter((c) => c.includes("\u001b[?2026h"));
    expect(frames.length).toBeGreaterThan(0);
    // Opened and closed in the SAME write. A frame left open would suppress
    // painting until the next one happened to close it.
    for (const frame of frames) expect(frame).toContain("\u001b[?2026l");
  });

  it("clears and redraws in ONE write, never two", async () => {
    const written = await drawTwice();
    // The cursor-up-and-clear must never arrive on its own — that lone write is
    // precisely the blank frame.
    // Case-insensitive: the redesign prints the question as an UPPERCASE heading.
    const clearOnly = written.filter(
      (c) => /\u001b\[\d+A\u001b\[J/.test(c) && !/pick/i.test(c),
    );
    expect(clearOnly).toEqual([]);
  });
});

describe("helpScreen — the one shape all twelve --help screens take", () => {
  const SPEC = {
    command: "policies",
    version: "9.9.9",
    tagline: "manage the policies your agents run under",
    sections: [
      {
        label: "usage",
        entries: [
          ["add <name>", "Turn one policy on"],
          ["show <owner>/<repo>", "What a pack holds, before you take it"],
        ] as Array<[string, string?]>,
      },
      {
        label: "options",
        entries: [["--beta", "Include beta policies"]] as Array<[string, string?]>,
        after: ["A pause always expires on its own."],
      },
      { label: "examples", lines: ["failproofai policies add block-sudo"] },
    ],
    footer: ["policy, pack and p are all spellings of policies."],
  };

  it("opens with the command, the version and one line of what it is", () => {
    const out = helpScreen(SPEC, PLAIN);
    expect(out[0]).toContain("failproofai policies");
    expect(out[0]).toContain("v9.9.9");
    expect(out[1]).toContain("manage the policies your agents run under");
  });

  it("gives every section the same rule heading", () => {
    const out = helpScreen(SPEC, PLAIN).filter((l) => l.includes("━"));
    expect(out).toHaveLength(3);
    for (const label of ["usage", "options", "examples"]) {
      expect(out.some((l) => l.includes(label))).toBe(true);
    }
  });

  it("computes the description column PER SECTION, not per screen", () => {
    // One column across the page is what a screen of like-shaped entries wants
    // and exactly wrong on a screen that has both: `show <owner>/<repo>` is 19
    // columns and `--beta` is 6, and a shared column left every flag on the
    // page hanging with nothing under it.
    const out = helpScreen(SPEC, PLAIN);
    const usageRow = out.find((l) => l.includes("Turn one policy on"))!;
    const optionRow = out.find((l) => l.includes("Include beta policies"))!;
    expect(usageRow.indexOf("Turn one")).toBeGreaterThan(optionRow.indexOf("Include beta"));
  });

  it("puts a section's `after` note under its table, in the same section", () => {
    const out = helpScreen(SPEC, PLAIN);
    const note = out.findIndex((l) => l.includes("always expires on its own"));
    const examples = out.findIndex((l) => l.includes("examples"));
    expect(note).toBeGreaterThan(-1);
    // Under options, above the next heading — not orphaned after the screen.
    expect(note).toBeLessThan(examples);
  });

  it("emits no ANSI at all when colour is off, at every width", () => {
    for (const cols of WIDTHS) {
      expect(helpScreen(SPEC, { cols, color: false }).join("")).not.toContain("\x1B");
    }
  });

  it("fits the width it was given, coloured or not", () => {
    for (const cols of WIDTHS) {
      for (const color of [true, false]) {
        for (const line of helpScreen(SPEC, { cols, color })) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it("skips a section with nothing in it rather than printing a bare heading", () => {
    const out = helpScreen(
      { ...SPEC, sections: [...SPEC.sections, { label: "empty", lines: [] }] },
      PLAIN,
    );
    expect(out.some((l) => l.includes("empty"))).toBe(false);
  });
});

describe("helpColumn", () => {
  it("ignores entries with no description", () => {
    // A bare usage line describes itself and has nothing in the second column.
    // Letting it vote pushed every real description out to its own width.
    const wide: Array<[string, string?]> = [
      ["failproofai flush [--wait] [--timeout <secs>]"],
      ["--wait", "Block until the spool drains"],
    ];
    expect(helpColumn(wide)).toBe(helpColumn([["--wait", "Block until the spool drains"]]));
  });

  it("caps the column so one long flag cannot push every description off", () => {
    expect(helpColumn([["-".repeat(60), "x"]])).toBeLessThanOrEqual(34);
  });
});

describe("helpHeading", () => {
  it("drops the version onto its own line rather than wrapping it into the name", () => {
    const out = helpHeading(
      { command: "policies add|remove|show", version: "1.0.0-beta.6", tagline: "t" },
      { cols: 30, color: false },
    );
    expect(out[0]).toContain("policies add|remove|show");
    expect(out[1].trim()).toBe("v1.0.0-beta.6");
  });

  it("paints the wordmark without changing what it occupies", () => {
    const plain = helpHeading({ version: "1.0.0", tagline: "t" }, PLAIN);
    const painted = helpHeading({ version: "1.0.0", tagline: "t" }, COLOR);
    expect(painted[0]).toContain("\x1B");
    expect(visibleWidth(painted[0])).toBe(visibleWidth(plain[0]));
  });
});

describe("helpOptsFor", () => {
  it("never renders help wider than 80, however wide the terminal is", () => {
    expect(helpOptsFor({ isTTY: true, columns: 220, write: () => true } as unknown as TTYOut).cols).toBe(80);
  });

  it("still narrows to a terminal smaller than that", () => {
    expect(helpOptsFor({ isTTY: true, columns: 60, write: () => true } as unknown as TTYOut).cols).toBe(60);
  });
});

describe("rule — the one accent every sectioned surface carries", () => {
  it("paints the lead but occupies the same columns either way", () => {
    const plain = rule("Convention Policies", PLAIN)[0];
    const painted = rule("Convention Policies", COLOR)[0];
    expect(painted).toContain(brandAnsi("pink"));
    expect(visibleWidth(painted)).toBe(visibleWidth(plain));
    expect(visibleWidth(plain)).toBe(80 - INDENT.length);
  });
});


describe("screenKit — the 2026-10 building blocks", () => {
  const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const plain = screenKit({ version: "1.0.11", cols: 104, color: false });

  it("opens every screen with the wordmark, version and context", () => {
    expect(plain.header("Policies")).toBe("failproof ai  v1.0.11  ·  Policies");
    expect(plain.header()).toBe("failproof ai  v1.0.11");
  });

  it("paints the wordmark's `il` pink and bold, and the version grey", () => {
    const k = withEnv(TRUECOLOR, () => screenKit({ version: "1.0.11", color: true }));
    const h = k.header("Status");
    expect(h).toContain(`\x1B[1;${PINK_24}mil\x1B[0m`);
    expect(h).toContain("\x1B[38;2;118;127;139mv1.0.11\x1B[0m");
    expect(strip(h)).toBe("failproof ai  v1.0.11  ·  Status");
  });

  it("uppercases headings and keeps their meta grey and as written", () => {
    expect(plain.head("Dashboard")).toBe("DASHBOARD");
    expect(plain.head("Which agents should failproofai trace?", "8 of 9 selected")).toBe(
      "WHICH AGENTS SHOULD FAILPROOFAI TRACE?  8 of 9 selected",
    );
  });

  it("lines up kv values where the reference does", () => {
    // Copied from the reference's launch screen, plain.
    expect(
      plain.kv([
        ["url", "http://127.0.0.1:8020  ● live"],
        ["policies", "10 on from FailproofAI/policies@06b802b"],
        ["agents", "9 traced: Claude Code, Codex, Copilot, Cursor and 5 more"],
        ["cloud", "Connected as chetanraghuvanshi85"],
      ]),
    ).toEqual([
      "  url        http://127.0.0.1:8020  ● live",
      "  policies   10 on from FailproofAI/policies@06b802b",
      "  agents     9 traced: Claude Code, Codex, Copilot, Cursor and 5 more",
      "  cloud      Connected as chetanraghuvanshi85",
    ]);
  });

  it("widens the kv column for a long label instead of running it into its value", () => {
    const [line] = plain.kv([["would block", "7: block-env-files 4"]]);
    expect(line).toBe("  would block  7: block-env-files 4");
  });

  it("continues a kv row under the value column when the label is empty", () => {
    expect(plain.kv([["paused", "1 session"], ["", "s-1  28m left"]])).toEqual([
      "  paused     1 session",
      "             s-1  28m left",
    ]);
    // An empty label paints nothing: no escape pair with no text between.
    const k = withEnv(TRUECOLOR, () => screenKit({ color: true }));
    const [, continued] = k.kv([["paused", "1 session"], ["", "s-1"]]);
    expect(continued).toBe("             s-1");
  });

  it("never cuts a kv value, however narrow the terminal", () => {
    const url = "https://app.befailproof.ai/settings/machines/0b1c2d3e-0000-4000-8000-000000000001";
    const k = screenKit({ cols: 40, color: false, fit: true });
    expect(k.kv([["dashboard", url]])[0]).toContain(url);
  });

  it("renders a `command  description` row at the reference's column", () => {
    expect(plain.rows([["command", "What it does, in a short sentence"]], 14)).toEqual([
      "  command       What it does, in a short sentence",
    ]);
  });

  it("always leaves two spaces after the widest name — the longest real policy name is 32", () => {
    const name = "require-no-conflicts-before-stop";
    expect(name).toHaveLength(32);
    const [line] = plain.rows([[name, "Require no merge conflicts before stopping"]], 32);
    expect(line).toBe(`  ${name}  Require no merge conflicts before stopping`);
  });

  it("shortens a description to fit the terminal, but never the name", () => {
    const k = screenKit({ cols: 40, color: false, fit: true });
    const [line] = k.rows([["failproofai policies show <owner/repo>", "See what a pack holds before installing it"]]);
    expect(line.startsWith("  failproofai policies show <owner/repo>  ")).toBe(true);
    const [short] = k.rows([["--wait", "Wait until everything is delivered to the cloud dashboard"]]);
    expect(visibleWidth(short)).toBeLessThanOrEqual(40);
    expect(short.endsWith("…")).toBe(true);
  });

  it("never shortens anything when fitting is off — piped output is never cut", () => {
    const k = screenKit({ cols: 40, color: false });
    const [line] = k.rows([["--wait", "Wait until everything is delivered to the cloud dashboard"]]);
    expect(line).toBe("  --wait  Wait until everything is delivered to the cloud dashboard");
  });

  it("states results, cautions and failures with one glyph and an inline fix", () => {
    expect(plain.ok("Done, said in the past tense")).toBe("✓ Done, said in the past tense");
    expect(plain.ok("Published acme/guards", "in 2.1s")).toBe("✓ Published acme/guards  in 2.1s");
    expect(plain.caution("Needs attention", "the fix")).toBe("▲ Needs attention  ·  the fix");
    expect(plain.fail("Failed, said plainly", "the fix")).toBe("✕ Failed, said plainly  ·  the fix");
  });

  it("paints the state glyphs by role and every fix as a command", () => {
    const k = withEnv(TRUECOLOR, () => screenKit({ color: true }));
    expect(k.ok("x")).toContain(`\x1B[${MINT_24}m✓`);
    expect(k.caution("x", "failproofai config")).toContain(`\x1B[${PINK_24}mfailproofai config`);
    expect(k.fail("x")).toContain("\x1B[38;2;240;113;120m✕");
  });

  it("draws the row glyphs a listing needs: failed, selected and unselected", () => {
    expect([plain.failed, plain.selected, plain.unselected]).toEqual(["✕", "■", "□"]);
    const k = withEnv(TRUECOLOR, () => screenKit({ color: true }));
    // A state colour for a failure, the brand pink for picked, grey for not.
    expect(k.failed).toBe("\x1B[38;2;240;113;120m✕\x1B[0m");
    expect(k.selected).toBe(`\x1B[${PINK_24}m■\x1B[0m`);
    expect(k.unselected).toBe("\x1B[38;2;118;127;139m□\x1B[0m");
  });

  it("paints a value's grey qualifier, and never an empty span", () => {
    expect(plain.meta("observe")).toBe("observe");
    const k = withEnv(TRUECOLOR, () => screenKit({ color: true }));
    expect(k.meta("observe")).toBe("\x1B[38;2;118;127;139mobserve\x1B[0m");
    expect(k.meta("")).toBe("");
  });

  it("joins key hints with a spaced dot", () => {
    expect(plain.keys(["↑↓ move", "space toggle", "enter confirm"])).toBe(
      "↑↓ move  ·  space toggle  ·  enter confirm",
    );
  });

  it("draws a progress bar: pink fill and a grey track in colour, a blank track without it", () => {
    expect(plain.bar(10, 0.6)).toBe("━━━━━━    ");
    const k = withEnv(TRUECOLOR, () => screenKit({ color: true }));
    const painted = k.bar(10, 0.6);
    expect(painted).toContain(`\x1B[${PINK_24}m━━━━━━\x1B[0m`);
    expect(painted).toContain("\x1B[38;2;62;67;76m━━━━\x1B[0m");
    // No empty colour span at either end.
    expect(k.bar(10, 0)).not.toContain(`\x1B[${PINK_24}m\x1B[0m`);
    expect(k.bar(10, 1)).not.toContain("38;2;62;67;76");
  });

  it("shows the logomark only where it fits, and never the retired ▮▮ one-liner", () => {
    const art = screenKit({ cols: 80, color: false }).logo();
    expect(art).toHaveLength(10);
    for (const line of art) expect(line.startsWith("  ")).toBe(true);
    expect(art.join("")).not.toContain("\x1B");
    expect(screenKit({ cols: 21, color: false }).logo()).toEqual([]);
    expect(art.join("")).not.toContain("▮");
  });

  it("builds a command's --help from usage, options and examples, and nothing else", () => {
    const page = plain.helpPage({
      name: "flush",
      usage: [["failproofai flush [options]", "Send queued events to cloud now"]],
      options: [
        ["--wait", "Wait until everything is delivered"],
        ["--timeout <secs>", "How long to wait (default 60)"],
      ],
      optionsCol: 20,
    });
    expect(page).toEqual([
      "failproof ai  v1.0.11  ·  flush",
      "",
      "USAGE",
      "  failproofai flush [options]  Send queued events to cloud now",
      "",
      "OPTIONS",
      // The reference's option column, exactly.
      "  --wait              Wait until everything is delivered",
      "  --timeout <secs>    How long to wait (default 60)",
    ]);
  });

  it("emits no escape at all when colour is off", () => {
    const all = [
      plain.header("x"),
      plain.head("x", "m"),
      ...plain.kv([["a", "b"]]),
      ...plain.rows([["a", "b"]]),
      plain.ok("x", "d"),
      plain.caution("x", "f"),
      plain.fail("x", "f"),
      plain.keys(["a"]),
      plain.bar(5, 0.5),
      plain.on,
      plain.off,
      plain.failed,
      plain.selected,
      plain.unselected,
      plain.meta("observe"),
      plain.cmd("failproofai config"),
    ].join("\n");
    expect(all).not.toContain("\x1B");
  });

  it("defaults the header's version to this build's", async () => {
    const { version } = await import("../../package.json");
    expect(screenKit().header()).toBe(`failproof ai  v${version}`);
  });
});


describe("pickers in the 2026-10 language", () => {
  const plainText = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

  /** Drive a prompt through a real PassThrough, sending `keys` after the first frame. */
  const drive = async <R,>(start: (io: { stdin: TTYIn; stdout: TTYOut }) => Promise<R>, keys: string[], columns = 100) => {
    const written: string[] = [];
    const stdout = { isTTY: true, columns, write: (chunk: string) => { written.push(chunk); return true; } } as unknown as TTYOut;
    const stdin = new PassThrough() as unknown as TTYIn & PassThrough;
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    const pending = start({ stdin: stdin as unknown as TTYIn, stdout });
    for (const k of keys) stdin.write(k);
    const result = await pending;
    // Cursor show/hide go out as writes of their own, which strip to nothing.
    const frames = written.map(plainText).filter((f) => f.trim() !== "");
    return { result, frames, last: frames[frames.length - 1] ?? "", all: frames.join("") };
  };

  const POLICIES = ["block-sudo", "block-rm-rf", "block-env-files"].map((name, i) => ({
    label: name,
    value: name,
    hint: `Description ${i}`,
    checked: i === 0,
  }));

  it("draws the heading in UPPERCASE with a live count, a › cursor and ■ □ boxes", async () => {
    const { frames } = await drive(
      (io) => multiSelect<string>({ message: "Choose policies", choices: POLICIES, ...io }),
      ["\u001b"],
    );
    const first = frames[0];
    expect(first).toContain("CHOOSE POLICIES  1 of 3 selected");
    expect(first).toContain(" › ■ block-sudo");
    expect(first).toContain("   □ block-rm-rf");
    expect(first).toContain("↑↓ move  ·  space toggle  ·  a all  ·  enter confirm  ·  esc cancel");
    // No spine glyphs from the old flow.
    expect(first).not.toMatch(/[│◆◇❯◼◻]/);
  });

  it("toggles everything with a plain `a`, and keeps ctrl+a as an alias", async () => {
    const plainA = await drive((io) => multiSelect<string>({ message: "pick", choices: POLICIES, ...io }), ["a", "\r"]);
    expect(plainA.result).toEqual(["block-sudo", "block-rm-rf", "block-env-files"]);
    const ctrlA = await drive((io) => multiSelect<string>({ message: "pick", choices: POLICIES, ...io }), ["\u0001", "\r"]);
    expect(ctrlA.result).toEqual(["block-sudo", "block-rm-rf", "block-env-files"]);
  });

  it("says the caller's minimum with ✕ and stays put", async () => {
    const none = POLICIES.map((p) => ({ ...p, checked: false }));
    const { all } = await drive(
      (io) => multiSelect<string>({ message: "Which agents should failproofai trace?", choices: none, minSelected: 1, minMessage: "pick at least one agent", ...io }),
      ["\r", "\u001b"],
    );
    expect(all).toContain("✕ pick at least one agent");
  });

  it("recomputes a row's tag on every toggle", async () => {
    const { frames } = await drive(
      (io) =>
        multiSelect<string>({
          message: "pick",
          choices: POLICIES,
          tag: (value, on) => (value === "block-rm-rf" && on ? "will be added" : undefined),
          ...io,
        }),
      ["\u001b[B", " ", "\u001b"],
    );
    expect(frames[0]).not.toContain("will be added");
    expect(frames.some((f) => f.includes("block-rm-rf") && f.includes("will be added"))).toBe(true);
  });

  it("collapses to `✓ <summary>` under the heading, or to the caller's own lines", async () => {
    const plain = await drive((io) => multiSelect<string>({ message: "Choose policies", choices: POLICIES, ...io }), ["\r"]);
    expect(plain.last).toContain("CHOOSE POLICIES");
    expect(plain.last).toContain("✓ block-sudo");
    const custom = await drive(
      (io) => multiSelect<string>({ message: "Choose policies", choices: POLICIES, collapsed: (v) => ["AGENTS", `✓ Tracing ${v.length} agents`], ...io }),
      ["\r"],
    );
    expect(custom.last).toContain("✓ Tracing 1 agents");
  });

  it("shows twelve rows before it scrolls, and says how many more are below", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ label: `policy-${i}`, value: `p${i}` }));
    const { frames } = await drive((io) => multiSelect<string>({ message: "pick", choices: many, ...io }), ["\u001b"]);
    expect(frames[0]).toContain("policy-11");
    expect(frames[0]).not.toContain("policy-12");
    expect(frames[0]).toContain("↓ 3 more");
  });

  it("selectOne: grey meta after the heading, a bold cursor row, and the redesign's key hints", async () => {
    const { frames, result } = await drive(
      (io) =>
        selectOne<string>({
          message: "Choose agents",
          meta: "9 found on this machine",
          choices: [
            { label: "All 9 agents", value: "all" },
            { label: "Claude Code", value: "claude" },
          ],
          ...io,
        }),
      ["\u001b[B", "\r"],
    );
    expect(frames[0]).toContain("CHOOSE AGENTS  9 found on this machine");
    expect(frames[0]).toContain(" › All 9 agents");
    expect(frames[0]).toContain("↑↓ move  ·  enter select  ·  esc cancel");
    expect(result).toBe("claude");
  });

  it("selectOne picks on space only when the caller asks for it", async () => {
    const choices = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
    const asked = await drive((io) => selectOne<string>({ message: "pick", choices, spaceSelects: true, ...io }), [" "]);
    expect(asked.result).toBe("a");
    const notAsked = await drive((io) => selectOne<string>({ message: "pick", choices, ...io }), [" ", "\u001b"]);
    expect(notAsked.result).toBeNull();
  });
});

describe("screenKit().live — a block that redraws in place", () => {
  const fakeTty = (columns = 40) => {
    const writes: string[] = [];
    const out = {
      isTTY: true,
      columns,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
    } as unknown as TTYOut;
    return { out, writes };
  };
  /** The listeners `live` added for an event, by diffing against what was there. */
  const added = (event: "exit" | "SIGINT" | "SIGTERM", before: Function[]) =>
    process.listeners(event).filter((l) => !before.includes(l)) as Array<(...args: unknown[]) => void>;

  it("draws every frame as ONE write, held in synchronized output, with the cursor hidden from the first", () => {
    const { out, writes } = fakeTty();
    const region = screenKit().live(out);
    region.draw(() => ["one", "two"]);
    expect(writes).toEqual(["\x1B[?2026h\x1B[?25lone\ntwo\n\x1B[?2026l"]);
    region.done(["done"]);
  });

  it("draws at most every 100 ms, and the newest frame is the one that lands", () => {
    vi.useFakeTimers();
    try {
      const { out, writes } = fakeTty();
      const region = screenKit().live(out);
      region.draw(() => ["frame 1"]);
      region.draw(() => ["frame 2"]);
      region.draw(() => ["frame 3"]);
      expect(writes).toHaveLength(1);
      vi.advanceTimersByTime(99);
      expect(writes).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(writes).toHaveLength(2);
      // Cleared the one row the first frame drew, then the newest frame.
      expect(writes[1]).toBe("\x1B[?2026h\x1B[1A\x1B[Jframe 3\n\x1B[?2026l");
      region.done(["done"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds only the frames it draws", () => {
    vi.useFakeTimers();
    try {
      const { out } = fakeTty();
      const region = screenKit().live(out);
      const build = vi.fn(() => ["x"]);
      region.draw(build);
      for (let i = 0; i < 50; i += 1) region.draw(build);
      vi.advanceTimersByTime(100);
      expect(build).toHaveBeenCalledTimes(2);
      region.done(["done"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts a live frame to the terminal so its rows stay countable, and never the last one", () => {
    const { out, writes } = fakeTty(10);
    const region = screenKit().live(out);
    region.draw(() => ["0123456789abcdef"]);
    expect(writes[0]).toContain("0123456789\n");
    expect(writes[0]).not.toContain("abcdef");
    region.done(["0123456789abcdef"]);
    // The last frame stays in scrollback, so it is written whole.
    expect(writes[1]).toContain("0123456789abcdef\n");
  });

  it("ends in ONE write that clears the live frame, draws the last one and shows the cursor", () => {
    const { out, writes } = fakeTty();
    const region = screenKit().live(out);
    region.draw(() => ["a", "b", "c"]);
    region.done(["final"]);
    expect(writes[1]).toBe("\x1B[?2026h\x1B[3A\x1B[Jfinal\n\x1B[?25h\x1B[?2026l");
    // Nothing draws after the end.
    region.draw(() => ["late"]);
    region.done(["later"]);
    expect(writes).toHaveLength(2);
  });

  it("gives the cursor back on exit and on SIGINT/SIGTERM, and lets the signal through", () => {
    const before = {
      exit: process.listeners("exit"),
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { out, writes } = fakeTty();
      const region = screenKit().live(out);
      // Nothing is registered until something is drawn.
      expect(added("SIGINT", before.SIGINT)).toHaveLength(0);
      region.draw(() => ["scanning"]);

      const [onExit] = added("exit", before.exit);
      expect(onExit).toBeTypeOf("function");
      onExit();
      expect(writes[writes.length - 1]).toBe("\x1B[?25h");

      const [onSigint] = added("SIGINT", before.SIGINT);
      expect(added("SIGTERM", before.SIGTERM)).toHaveLength(1);
      onSigint("SIGINT");
      expect(writes[writes.length - 1]).toBe("\x1B[?25h");
      // Re-raised once the cursor is back, with every hook of ours removed, so
      // the default disposition stops the command as it always did.
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(added("SIGINT", before.SIGINT)).toHaveLength(0);
      expect(added("SIGTERM", before.SIGTERM)).toHaveLength(0);
      expect(added("exit", before.exit)).toHaveLength(0);
      // And the block is over: a frame after the signal draws nothing.
      const count = writes.length;
      region.draw(() => ["after"]);
      expect(writes).toHaveLength(count);
    } finally {
      kill.mockRestore();
    }
  });

  it("removes every hook when it ends normally", () => {
    const before = {
      exit: process.listeners("exit"),
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const { out } = fakeTty();
    const region = screenKit().live(out);
    region.draw(() => ["scanning"]);
    region.done(["done"]);
    expect(added("exit", before.exit)).toHaveLength(0);
    expect(added("SIGINT", before.SIGINT)).toHaveLength(0);
    expect(added("SIGTERM", before.SIGTERM)).toHaveLength(0);
  });
});
