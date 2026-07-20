import { describe, it, expect, vi } from "vitest";
import {
  selectOne,
  multiSelect,
  ellipsize,
  summarize,
  renderBrandLogo,
  type TTYIn,
  type TTYOut,
} from "../../src/hooks/tui";

const mkStdin = (): TTYIn => ({ isTTY: false }) as unknown as TTYIn;
const mkStdout = (): TTYOut =>
  ({ isTTY: false, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;

describe("tui non-TTY fallbacks", () => {
  it("selectOne returns the first choice value when not a TTY", async () => {
    const value = await selectOne({
      message: "t",
      choices: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toBe("a");
  });

  it("selectOne returns null with no choices and no TTY", async () => {
    const value = await selectOne({
      message: "t",
      choices: [],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toBeNull();
  });

  it("multiSelect returns the pre-checked values when not a TTY", async () => {
    const value = await multiSelect({
      message: "t",
      choices: [
        { label: "X", value: "x", checked: true },
        { label: "Y", value: "y" },
        { label: "Z", value: "z", checked: true },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toEqual(["x", "z"]);
  });

  it("multiSelect returns [] when nothing pre-checked and no TTY", async () => {
    const value = await multiSelect({
      message: "t",
      choices: [
        { label: "X", value: "x" },
        { label: "Y", value: "y" },
      ],
      stdin: mkStdin(),
      stdout: mkStdout(),
    });
    expect(value).toEqual([]);
  });
});

describe("tui text helpers", () => {
  it("ellipsize leaves short text untouched", () => {
    expect(ellipsize("hello", 10)).toBe("hello");
    expect(ellipsize("hello", 5)).toBe("hello");
  });

  it("ellipsize ends on a single ellipsis instead of a mid-word cut", () => {
    const out = ellipsize("Redact secrets in tool output", 12);
    expect(out).toHaveLength(12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("……");
  });

  it("ellipsize handles degenerate widths", () => {
    expect(ellipsize("anything", 0)).toBe("");
    expect(ellipsize("anything", 1)).toBe("…");
  });

  it("summarize joins a few labels verbatim", () => {
    expect(summarize([], "assistants")).toBe("none");
    expect(summarize(["Claude Code"], "assistants")).toBe("Claude Code");
    expect(summarize(["A", "B", "C"], "assistants")).toBe("A, B, C");
  });

  it("summarize collapses many labels to a count plus a head", () => {
    const out = summarize(["A", "B", "C", "D", "E"], "assistants");
    expect(out).toBe("5 assistants · A, B, C +2");
  });
});

describe("brand logomark", () => {
  // The logo lines are the ones before the blank separator that precedes the
  // wordmark. Colours are off here (not a TTY), so each cell is a bare block
  // glyph and a run of them measures the mark's width in columns.
  const logoRows = (cols = 80): string[][] => {
    const lines = renderBrandLogo({
      isTTY: false,
      write: vi.fn(() => true),
      columns: cols,
    } as unknown as TTYOut);
    const art = lines.slice(0, lines.indexOf(""));
    return art.map((l) => l.match(/[█▀▄]+/g) ?? []);
  };

  // Regression: the right-hand bar once shipped a column narrower than the
  // left, which read as a drawing mistake at every terminal size. In the source
  // artwork both bars are the same width, so the narrowest left-hand run (the
  // upright, excluding the wider cross) must equal the right-hand run.
  it("draws both uprights the same width", () => {
    const twoRun = logoRows().filter((runs) => runs.length === 2);
    expect(twoRun.length).toBeGreaterThan(0);

    const rightWidths = new Set(twoRun.map((r) => r[1].length));
    expect(rightWidths.size).toBe(1); // the tall bar is a constant width

    const leftUpright = Math.min(...twoRun.map((r) => r[0].length));
    expect(leftUpright).toBe([...rightWidths][0]);
  });

  it("draws the cross wider than the upright it sits on", () => {
    const twoRun = logoRows().filter((runs) => runs.length === 2);
    const lefts = twoRun.map((r) => r[0].length);
    expect(Math.max(...lefts)).toBeGreaterThan(Math.min(...lefts));
  });

  it("collapses to a single line on a narrow terminal", () => {
    const lines = renderBrandLogo({
      isTTY: false,
      write: vi.fn(() => true),
      columns: 21,
    } as unknown as TTYOut);
    expect(lines).toHaveLength(1);
  });
});
