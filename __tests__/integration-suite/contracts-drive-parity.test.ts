// @vitest-environment node
/**
 * `contracts-probe.sh` carries its own copy of `drive()` rather than importing
 * one, because `probe-cli.sh` is the canary's working code, several tests
 * assert on its contents, and refactoring it to share a function would put the
 * boss's nightly run at risk for a tidiness win.
 *
 * The cost of copying is drift: a flag added to one and not the other means the
 * two harnesses are driving different CLIs, and the contracts lab would report
 * on an invocation nobody actually ships. This pins them together — per CLI,
 * byte for byte — so the copy is safe rather than merely convenient.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SUITE = path.join(__dirname, "..", "..", "integration-suite");
const probeSh = readFileSync(path.join(SUITE, "probe-cli.sh"), "utf8");
const contractsSh = readFileSync(path.join(SUITE, "contracts-probe.sh"), "utf8");

/** The body of `drive()`, as a map of cli -> its case arm, whitespace-normalised. */
function driveArms(script: string): Record<string, string> {
  const start = script.indexOf("drive() {");
  expect(start).toBeGreaterThan(-1);
  const body = script.slice(start, script.indexOf("\n}", start));
  const arms: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^\s*([a-z]+)\)\s*\(\s*cd "\$BASE" &&(.*)$/.exec(line);
    if (!m) continue;
    arms[m[1]] = m[2]
      // Trailing comments differ between the two files by design.
      .replace(/#.*$/, "")
      // Session keys are per-run identifiers, deliberately namespaced per
      // harness so one run's sessions are never mistaken for the other's.
      // What must match is the FLAGS, not the label.
      .replace(/--session-key "[^"]*"/, '--session-key "<per-run>"')
      .replace(/\s+/g, " ")
      .trim();
  }
  return arms;
}

describe("contracts-probe drive() parity with probe-cli", () => {
  const canary = driveArms(probeSh);
  const contracts = driveArms(contractsSh);

  it("covers every CLI the canary drives", () => {
    expect(Object.keys(contracts).sort()).toEqual(Object.keys(canary).sort());
  });

  it.each(Object.keys(canary))("drives %s identically", (cli) => {
    // A difference here means the lab is measuring an invocation the canary
    // does not use, or vice versa.
    expect(contracts[cli]).toBe(canary[cli]);
  });

  it("finds a non-trivial number of CLIs, so a parsing slip cannot pass vacuously", () => {
    expect(Object.keys(canary).length).toBeGreaterThanOrEqual(12);
  });
});
