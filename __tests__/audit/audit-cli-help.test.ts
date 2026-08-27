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
    for (const command of [
      "(bare)",
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

  it("keeps the local-only promise the docs also make", () => {
    expect(plain(render(false))).toMatch(/runs on this machine/i);
  });

  it.each([true, false])("aligns and fits 80 columns with color=%s", (color) => {
    const lines = plain(render(color)).split("\n");

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Every command row and every continuation line shares one description
    // column. Derive it from the first row rather than restating a constant,
    // so this fails on drift instead of being updated to match it.
    const first = lines.find((l) => l.trim().startsWith("(bare)"));
    expect(first).toBeDefined();
    const descCol = first!.indexOf("Scan your session history");
    expect(descCol).toBeGreaterThan(0);

    const continuations = lines.filter(
      (l) => l.startsWith(" ".repeat(descCol)) && l.trim().length > 0,
    );
    // A NON-VACUITY floor, not a layout assertion. The real check is the loop
    // below — every continuation starts exactly at `descCol` — and this only
    // proves it ran over something. Deliberately well under the count the
    // current copy produces: pinning it to the exact number is what made this
    // line fail twice for wording changes that improved the screen, once when
    // dropping the `failproofai audit` prefix widened the column and again
    // when `--email <address>` moved to a row of its own.
    expect(continuations.length).toBeGreaterThanOrEqual(2);
    for (const line of continuations) {
      expect(line[descCol]).not.toBe(" ");
    }
  });
});
