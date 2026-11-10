// @vitest-environment node
/**
 * `failproofai audit --help`.
 *
 * Two things worth pinning. The obvious one is that every command a person can
 * type is listed — a scheduling flag that exists and is undiscoverable is the
 * same to a user as one that does not exist.
 *
 * The subtle one is the ALIGNMENT. The description column is produced by
 * padding against the raw command string, because `c()` wraps it in ANSI escape
 * bytes that occupy no terminal columns — pad against the coloured string and
 * every row shifts left by the width of an escape sequence, but only when
 * colour is on, which is never how the output is read in CI. So the width
 * assertions below run in BOTH modes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { helpText } from "../../src/audit/cli";

/** Strip ANSI so a rendered line can be measured in terminal columns. */
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("audit --help", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function render(color: boolean): string {
    if (color) {
      process.env.FORCE_COLOR = "1";
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = "1";
      delete process.env.FORCE_COLOR;
    }
    return helpText();
  }

  it("lists every command a person can type", () => {
    const text = plain(render(false));
    // The heading carries `failproofai audit`; the rows carry what you add to
    // it. Repeating the prefix on every row cost 17 of the 80 columns and was
    // what forced the descriptions down to four words a line.
    expect(text).toContain("failproofai audit");
    expect(text).toContain("Scan your agents' history and open the results");
    for (const command of [
      "--schedule [days]",
      "--no-schedule",
      "--status",
      "-h, --help",
    ]) {
      expect(text).toContain(command);
    }
    // --email modifies --schedule rather than standing alone. It still gets a
    // row: as a clause inside --schedule's description it wrapped, leaving the
    // flag at the end of one line and `<address>` at the start of the next —
    // which is not a spelling anybody can read off the screen or copy. Assert
    // it is CONTIGUOUS, which is the property that broke.
    expect(text).toContain("--email <address>");
  });

  it("omits --scheduled, which the daemon spawns and nobody types", () => {
    // One letter from `--schedule` and it starts a full scan instead of
    // configuring one. It still works; it is just not advertised beside it.
    expect(plain(render(false))).not.toContain("--scheduled");
  });

  it("is usage, options and examples, and nothing else", () => {
    // Decision D6 of the 2026-10 redesign removed explanatory and privacy
    // lines from help pages; the audit's local-only promise went with them.
    const headings = plain(render(false))
      .split("\n")
      .filter((l) => /^[A-Z][A-Z ]+$/.test(l));
    expect(headings).toEqual(["USAGE", "OPTIONS", "EXAMPLES"]);
  });

  it.each([true, false])("aligns and fits 80 columns with color=%s", (color) => {
    const lines = plain(render(color)).split("\n");

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Every option row shares one description column. Measured per row rather
    // than against a constant, so this fails on drift instead of being updated
    // to match it.
    const optionRows = lines.filter((l) => /^ {2}-/.test(l));
    // A non-vacuity floor: the loop below must have run over the real rows.
    expect(optionRows.length).toBeGreaterThanOrEqual(4);
    // The first character after the name's two-space gap.
    const columns = new Set(optionRows.map((l) => l.search(/(?<=\S {2,})\S/)));
    expect(columns.size).toBe(1);
  });
});
