// @vitest-environment node
//
// NO_COLOR=1 `failproofai policies` still emitted ANSI (issue #688): the
// duplicate-scope warning in manager.ts hardcoded `\x1B[33m`, and there was
// no --no-color flag at all. The listing itself already routes through
// paint(), so the fix is three small things: the warning uses the shared
// painter, the bin spells the env var as a flag, and these lock both.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyNoColorFlag, colorsEnabled, paint } from "../../src/hooks/tui";

describe("NO_COLOR support", () => {
  const saved = process.env.NO_COLOR;

  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });

  it("colorsEnabled reports false for a TTY when NO_COLOR is set", () => {
    const tty = { isTTY: true } as typeof process.stdout;
    expect(colorsEnabled(tty)).toBe(true);
    process.env.NO_COLOR = "1";
    expect(colorsEnabled(tty)).toBe(false);
  });

  it("the painter the warning now uses emits no ESC bytes under NO_COLOR", () => {
    const text = "Warning: Failproof AI hooks are also installed at user (user).";
    expect(paint(true).warn(text)).toContain("\x1B[");
    process.env.NO_COLOR = "1";
    expect(paint(!process.env.NO_COLOR).warn(text)).toBe(text);
  });

  it("--no-color sets NO_COLOR and strips the flag so subcommand parsers never see it", () => {
    const args = ["policies", "--no-color"];
    expect(applyNoColorFlag(args)).toBe(true);
    expect(process.env.NO_COLOR).toBe("1");
    expect(args).toEqual(["policies"]);
  });

  it("applyNoColorFlag is a no-op when the flag is absent", () => {
    const args = ["policies", "--list"];
    expect(applyNoColorFlag(args)).toBe(false);
    expect(process.env.NO_COLOR).toBeUndefined();
    expect(args).toEqual(["policies", "--list"]);
  });

  it("manager.ts holds no hardcoded ANSI escapes - the 16-site bug stays dead", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "src", "hooks", "manager.ts"),
      "utf-8",
    );
    expect(src.match(/\\x1[Bb]\[|\\u001[bB]\[|\\033\[/)).toBeNull();
  });
});
