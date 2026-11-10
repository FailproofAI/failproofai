// @vitest-environment node
/**
 * Which line of a failed action report carries the ✕.
 *
 * printReport used to put it on the FIRST top-level line whatever that line
 * said, and indent everything after it as "the fix". `update` opens on "no
 * migration was needed", `migrate` on its backup, `flush --wait` on "Requested
 * delivery" — so the ✕ landed on a success and the real error read as its
 * remedy.
 */
import { describe, it, expect } from "vitest";
import { reportBody } from "../../src/hooks/report-body";

describe("reportBody", () => {
  it("leads an unmarked failure with ✕ and indents the fix under it", () => {
    expect(
      reportBody(["failproofaid is stopped, and it is what delivers batches.", "Start it with `failproofai config`."], {
        ok: false,
        width: 80,
      }),
    ).toEqual(["✕ failproofaid is stopped, and it is what delivers batches.", "  Start it with `failproofai config`."]);
  });

  it("adds no glyph to a run that succeeded", () => {
    expect(reportBody(["2 batches spooled. Requested delivery.", "Spool drained."], { ok: true, width: 80 })).toEqual([
      "2 batches spooled. Requested delivery.",
      "Spool drained.",
    ]);
  });

  it("never puts the ✕ on update's success line when the daemon marks its own failure", () => {
    const body = reportBody(
      [
        "Home is at layout 3; no migration was needed.",
        "",
        "✕ failproofaid 1.0.0 was not installed: root privileges are required.",
        "  Run `sudo -v` and then `failproofai update` again.",
      ],
      { ok: false, width: 120 },
    );
    expect(body[0]).toBe("Home is at layout 3; no migration was needed.");
    expect(body.filter((l) => l.includes("✕"))).toEqual([
      "✕ failproofaid 1.0.0 was not installed: root privileges are required.",
    ]);
  });

  it("keeps migrate's failed step as the failure, not as a fix under the backup line", () => {
    const body = reportBody(
      [
        "  migrated layout 2 → 3",
        "  FAILED   layout 3 → 4",
        "",
        "Saved first: config.json, credentials.json",
        "",
        "✕ Step 3 → 4 did not finish: EACCES",
        "  The home is still marked layout 2 and will be retried.",
      ],
      { ok: false, width: 120 },
    );
    expect(body).toContain("Saved first: config.json, credentials.json");
    expect(body).toContain("✕ Step 3 → 4 did not finish: EACCES");
    expect(body.join("\n")).not.toMatch(/✕ Saved first/);
  });

  it("treats a ▲ line as marked too: flush --wait's timeout gets no ✕ on its first line", () => {
    const body = reportBody(
      ["3 batches spooled. Requested delivery.", "▲ Still 1 batch spooled after 3s.", "  Delivery continues in the background."],
      { ok: false, width: 80 },
    );
    expect(body[0]).toBe("3 batches spooled. Requested delivery.");
    expect(body.join("\n")).not.toContain("✕");
  });

  it("continues a wrapped glyph line under its words, not at column 0", () => {
    const body = reportBody(["✕ " + "word ".repeat(12).trim()], { ok: false, width: 30 });
    expect(body.length).toBeGreaterThan(1);
    for (const continuation of body.slice(1)) expect(continuation.startsWith("  ")).toBe(true);
  });

  it("continues a wrapped auto-led line under its words, within the width", () => {
    const body = reportBody(["word ".repeat(12).trim()], { ok: false, width: 30 });
    expect(body[0].startsWith("✕ ")).toBe(true);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(30);
    for (const continuation of body.slice(1)) expect(continuation.startsWith("  ")).toBe(true);
  });
});
