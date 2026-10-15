/**
 * The body of an action report (`update`, `migrate`, `flush`, `connect`, …),
 * laid out before colour: which line carries the failure's ✕, and how a
 * wrapped line continues. bin/failproofai.mjs's `printReport` paints it.
 *
 * Kept apart from `tui.ts` so it can be tested without driving the binary.
 */
import { wrap } from "./tui";

/** A line that opens on a state glyph says its own state. */
const STATE_GLYPH = /^\s*[✓▲✕] /;

/**
 * Lay out `lines` for a report `width` columns wide.
 *
 * A failed run whose lines carry no state glyph of their own opens with ✕ on
 * the first top-level line, and the top-level lines after it are the fix,
 * indented under it. That guess is only right when the failure comes first.
 * A report that marks its own lines — `update` opening on "no migration was
 * needed" before a daemon's ✕, `migrate` listing its backup before the step
 * that failed — gets no guess at all: a ✕ beside the line that succeeded
 * reads as that step failing, and the real error indented beneath it reads as
 * the remedy.
 *
 * Lines that already carry their own leading space are passed through: those
 * are sub-items a module laid out on purpose.
 */
export function reportBody(lines: readonly string[], opts: { ok: boolean; width: number }): string[] {
  const autoLead = !opts.ok && !lines.some((line) => STATE_GLYPH.test(line));
  const width = Math.max(20, opts.width);
  const body: string[] = [];
  let first = true;
  for (const line of lines) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.startsWith(" ")) {
      body.push(line);
      continue;
    }
    const glyphed = STATE_GLYPH.test(line);
    const lead = autoLead ? (first ? "✕ " : "  ") : "";
    // A glyphed line's continuation sits under its words, not under the glyph.
    const hang = lead || glyphed ? "  " : "";
    wrap(line, width - lead.length).forEach((w, i) => body.push(i === 0 ? `${lead}${w}` : `${hang}${w}`));
    first = false;
  }
  return body;
}
