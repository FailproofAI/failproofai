// @vitest-environment node
/**
 * The logomark's shape.
 *
 * Ported from main's tui.test.ts, where these ran against renderBrandLogo. That
 * helper was retired, but LOGO_GRID was not: screenKit().logo() draws it on the
 * `failproofai` and `config` screens, and rule 1 above the grid in tui.ts (the
 * two uprights are the SAME width) still holds. tui-kit.test.ts checks only the
 * line count, the indent and the absence of escapes, which a grid edit that
 * narrows one upright would pass.
 */
import { describe, it, expect } from "vitest";
import { screenKit } from "../../src/hooks/tui";

// Colours are off, so each cell is a bare block glyph and a run of them
// measures the mark's width in columns.
const logoRows = (cols = 80): string[][] =>
  screenKit({ cols, color: false })
    .logo()
    .map((l) => l.match(/[█▀▄]+/g) ?? []);

describe("the logomark", () => {
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
});
