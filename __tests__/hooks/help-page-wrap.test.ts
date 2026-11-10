// @vitest-environment node
/**
 * Help option descriptions are never cut on a narrow terminal.
 *
 * They name flags and agent ids: at 70 columns the policies page printed
 * `hermes, openclaw, factory, devin, antigravity,…` (goose gone) and
 * `Add custom policy files (repeatable); -u -c cl…`. Ids and flags are never
 * cut, so an option description that does not fit wraps under its column.
 * And a coloured cell that IS shortened still ends on `…`, instead of being
 * cut bare at the column.
 */
import { describe, it, expect } from "vitest";
import { screenKit, visibleWidth } from "../../src/hooks/tui";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const SPEC = {
  name: "policies",
  usage: [["failproofai policies add [name | owner/repo]", "Turn one on, install a pack, or pick from a list"]] as Array<
    [string, string?]
  >,
  options: [
    ["--policy, --only <a,b>", "Install only these policies from a pack"],
    ["--cli <agent...>", "Apply to these agents only"],
    ["", "hermes, openclaw, factory, devin, antigravity, goose"],
    ["--scope <scope>", "user, project, local (default user); all when removing"],
  ] as Array<[string, string]>,
};

describe("helpPage options on a narrow terminal", () => {
  it("wraps an option description under its column instead of cutting it", () => {
    const page = screenKit({ cols: 70, color: false, fit: true, version: "1.0.11" }).helpPage(SPEC);
    const options = page.slice(page.indexOf("OPTIONS") + 1);
    const text = options.join("\n");
    expect(text).not.toContain("…");
    expect(text).toMatch(/\bgoose\b/);
    expect(text).toMatch(/\ball\s+when\s+removing\b/);
    for (const line of options) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
    // Continuations sit under the description column (2 + 22 + 2 = 26).
    const goose = options.find((l) => l.includes("goose"))!;
    expect(goose).toMatch(/^ {26}\S/);
  });

  it("leaves a description that fits on one line", () => {
    const page = screenKit({ cols: 80, color: false, fit: true, version: "1.0.11" }).helpPage(SPEC);
    expect(page).toContain("  --scope <scope>         user, project, local (default user); all when removing");
  });

  it("never wraps or cuts in a pipe", () => {
    const page = screenKit({ cols: 40, color: false, version: "1.0.11" }).helpPage(SPEC);
    expect(page).toContain("                          hermes, openclaw, factory, devin, antigravity, goose");
  });

  it("still shortens usage prose with `…` on a terminal", () => {
    const page = screenKit({ cols: 70, color: false, fit: true, version: "1.0.11" }).helpPage(SPEC);
    const usage = page.find((l) => l.includes("failproofai policies add"))!;
    expect(usage.endsWith("…")).toBe(true);
  });
});

/** Colour is decided from the environment too; pin one that renders it. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("a coloured cell that is shortened", () => {
  it("ends on `…` rather than being cut bare at the column", () => {
    const [desc, row] = withEnv({ COLORTERM: "truecolor", TERM: "xterm-256color", NO_COLOR: undefined }, () => {
      const k = screenKit({ cols: 40, color: true, fit: true });
      const cell = `Redact JWTs in tool output${k.sep}${k.meta("observe")}`;
      return [cell, k.rows([["sanitize-jwt", cell]])[0]];
    });
    // The cell carries colour, which is the case that was cut with no `…`.
    expect(desc).toContain("\x1b[");
    expect(strip(row).endsWith("…")).toBe(true);
    expect(visibleWidth(row)).toBeLessThanOrEqual(40);
  });
});
