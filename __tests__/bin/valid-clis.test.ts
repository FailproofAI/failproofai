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

    // Also assert the reverse direction: VALID_CLIS must not contain any
    // entries beyond INTEGRATION_TYPES, so the two sets are exactly equal
    // (no missing, no extra) rather than just a superset check.
    const declaredClis = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const expectedClis: Set<string> = new Set(INTEGRATION_TYPES);
    for (const cli of declaredClis) {
      expect(expectedClis.has(cli), `VALID_CLIS has unexpected extra entry: ${cli}`).toBe(true);
    }
    expect(declaredClis.size).toBe(expectedClis.size);
  });

  it("is consulted by every subcommand parser that accepts --cli", () => {
    // install, uninstall, and policy add/remove each guard with VALID_CLIS.has.
    // Slice the source by each parser's unique surrounding context so a
    // missing guard in one parser can't be masked by extra guards elsewhere
    // (a global count could pass even if one parser lost its check).
    const installBlock = BIN_SOURCE.split("if (isInstall) {")[1]?.split("if (isUninstall) {")[0] ?? "";
    const uninstallBlock = BIN_SOURCE.split("if (isUninstall) {")[1]?.split("// Default: list policies")[0] ?? "";
    const policyBlock = BIN_SOURCE.split('if (args[0] === "policy") {')[1]?.split("// config — the interactive setup launcher")[0] ?? "";

    const parserBlocks: Array<[string, string]> = [
      ["install", installBlock],
      ["uninstall", uninstallBlock],
      ["policy add/remove", policyBlock],
    ];
    for (const [label, block] of parserBlocks) {
      expect(block.length, `${label} parser slice not found`).toBeGreaterThan(0);
      expect(block, `${label} parser is missing its own VALID_CLIS.has(...) guard`).toContain("VALID_CLIS.has(");
    }
  });

  it("accepts adal in the --hook parser as well", () => {
    expect(BIN_SOURCE).toContain('cliArg === "adal"');
  });
});
