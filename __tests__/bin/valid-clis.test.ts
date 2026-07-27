// @vitest-environment node
/**
 * Guards the CLI allowlist in bin/failproofai.mjs against drift.
 *
 * The allowlist used to be duplicated once per subcommand parser (--hook,
 * policies --install, policies --uninstall, policy add/remove). Adding a new CLI
 * to only some copies made it installable but NOT removable, which is how the
 * AdaL integration first shipped. It is now a single module-scope `VALID_CLIS`
 * shared by every parser; these tests fail if anyone reintroduces a local copy
 * or lets the list drift from INTEGRATION_TYPES.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

const BIN_SOURCE = readFileSync(resolve(__dirname, "../../bin/failproofai.mjs"), "utf-8");

describe("bin/failproofai.mjs CLI allowlist", () => {
  it("declares exactly one VALID_CLIS set (no per-parser copies)", () => {
    const declarations = BIN_SOURCE.match(/const VALID_CLIS = new Set\(/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("covers every INTEGRATION_TYPES entry", () => {
    const block = BIN_SOURCE.split("const VALID_CLIS = new Set(")[1]?.split("]);")[0] ?? "";
    for (const cli of INTEGRATION_TYPES) {
      expect(block).toContain(`"${cli}"`);
    }
  });

  it("is consulted by every subcommand parser that accepts --cli", () => {
    // install, uninstall, and policy add/remove each guard with VALID_CLIS.has.
    const uses = BIN_SOURCE.match(/VALID_CLIS\.has\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts adal in the --hook parser as well", () => {
    expect(BIN_SOURCE).toContain('cliArg === "adal"');
  });
});
