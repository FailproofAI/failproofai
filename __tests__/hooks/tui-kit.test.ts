import { describe, it, expect, vi } from "vitest";
import {
  INDENT,
  CHIP_WIDTH,
  bullets,
  chip,
  danger,
  emptyState,
  helpBlock,
  note,
  nextStep,
  optsFor,
  printBlock,
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
