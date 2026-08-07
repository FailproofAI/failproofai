import { describe, it, expect } from "vitest";
import { shouldOfferFirstRun } from "../../src/hooks/first-run-gate";

describe("shouldOfferFirstRun", () => {
  it("offers onboarding for a bare invocation", () => {
    expect(shouldOfferFirstRun([])).toBe(true);
  });

  it("offers onboarding for audit", () => {
    expect(shouldOfferFirstRun(["audit"])).toBe(true);
  });

  it("offers onboarding for an unknown subcommand", () => {
    // The unknown-command error is still more useful after setup than before,
    // and this keeps the rule "everything except the exemptions".
    expect(shouldOfferFirstRun(["wat"])).toBe(true);
  });

  it("never interrupts --hook", () => {
    // A hook runs once per tool call, with an agent waiting on stdout. An
    // interactive prompt there hangs the agent until its hook timeout.
    expect(shouldOfferFirstRun(["--hook", "PreToolUse"])).toBe(false);
    expect(shouldOfferFirstRun(["--hook", "PreToolUse", "--cli", "claude"])).toBe(false);
  });

  it("never interrupts --version or --help, in any position", () => {
    expect(shouldOfferFirstRun(["--version"])).toBe(false);
    expect(shouldOfferFirstRun(["-v"])).toBe(false);
    expect(shouldOfferFirstRun(["--help"])).toBe(false);
    expect(shouldOfferFirstRun(["-h"])).toBe(false);
    // Subcommand help must not be gated behind setup either.
    expect(shouldOfferFirstRun(["policies", "--help"])).toBe(false);
    expect(shouldOfferFirstRun(["audit", "--help"])).toBe(false);
  });

  it("never interrupts the configuration subcommands", () => {
    // These ARE setup. A wizard in front of them overrides a stated intent and
    // hangs any script that calls them non-interactively.
    for (const sub of ["config", "policies", "policy"]) {
      expect(shouldOfferFirstRun([sub])).toBe(false);
    }
    expect(shouldOfferFirstRun(["policies", "--install", "--cli", "claude"])).toBe(false);
    expect(shouldOfferFirstRun(["policy", "add", "block-sudo"])).toBe(false);
  });

  it("only exempts a configuration word in the SUBCOMMAND position", () => {
    // `failproofai audit --project policies` must still onboard — "policies"
    // here is an argument, not the command.
    expect(shouldOfferFirstRun(["audit", "policies"])).toBe(true);
  });
});
