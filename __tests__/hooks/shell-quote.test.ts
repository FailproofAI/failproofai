// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../../src/hooks/shell-quote";

describe("shellQuote", () => {
  it.each([
    ["/opt/failproofai/tester/bin/failproofaid-1.0.13"],
    ["/home/First Last/.failproofai/bin/failproofaid"],
    ["/Users/o'brien/bin"],
    ["$(touch pwned) `id` *.service ; rm -rf ~"],
  ])("survives a shell unchanged: %s", (value) => {
    // The shell, not a regex, decides whether the quoting holds.
    const echoed = execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
    expect(echoed).toBe(value);
  });
});
