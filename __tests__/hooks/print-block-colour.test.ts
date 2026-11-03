// @vitest-environment node
/**
 * printBlock decides colour from the stream it writes to.
 *
 * backfill, uninstall, harness and jev render their lines for stdout before
 * they know whether the run succeeds, then print a failure to stderr. With
 * stdout a terminal and stderr redirected, `2>err.log` captured
 * `^[[38;2;240;113;120m✕^[[0m Unknown harness: bogus.`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { paint, printBlock, type TTYOut } from "../../src/hooks/tui";

const coloured = `${paint(true).err("✕")} Unknown harness: bogus.`;

function capture(isTTY: boolean): { out: TTYOut; text: () => string } {
  const write = vi.fn((_chunk: unknown) => true);
  return { out: { isTTY, columns: 80, write } as unknown as TTYOut, text: () => String(write.mock.calls[0]?.[0]) };
}

describe("printBlock colour", () => {
  const savedNoColor = process.env.NO_COLOR;
  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
  });

  it("writes no escape codes to a stream that is not a terminal, whatever the lines were drawn for", () => {
    delete process.env.NO_COLOR;
    expect(coloured).toContain("\x1b[");
    const { out, text } = capture(false);
    printBlock(out, [coloured, `  Known: claude, ${paint(true).pink("codex")}`]);
    expect(text()).not.toContain("\x1b");
    expect(text()).toBe("\n✕ Unknown harness: bogus.\n  Known: claude, codex\n\n");
  });

  it("drops colour under NO_COLOR even on a terminal", () => {
    process.env.NO_COLOR = "1";
    const { out, text } = capture(true);
    printBlock(out, [coloured]);
    expect(text()).not.toContain("\x1b");
  });

  it("keeps colour on a terminal that shows it", () => {
    delete process.env.NO_COLOR;
    const { out, text } = capture(true);
    printBlock(out, [coloured]);
    expect(text()).toContain(coloured);
  });
});
