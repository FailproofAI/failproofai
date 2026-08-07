/**
 * Remembering why setup stopped, so it stops relaunching on every command.
 *
 * The bug: every abort path writes NOTHING (deliberately — a half-configured
 * machine with `daemonConfigured` set and no daemon denies every tool call), so
 * "never tried" and "tried and could not finish" were indistinguishable. On a
 * box without passwordless sudo the wizard reopened on every single command.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import {
  attemptHintLines,
  blockerCleared,
  clearOnboardingAttempt,
  readOnboardingAttempt,
  recordOnboardingAttempt,
  type OnboardingAttempt,
  type RetryProbe,
} from "../../src/hooks/onboarding-attempt";
import { onboardingAttemptFile } from "../../src/hooks/fp-home";
import { isConfigured, detectSetupState } from "../../src/hooks/setup-state";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-attempt-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const probe = (over: Partial<RetryProbe> = {}): RetryProbe => ({
  canElevate: () => false,
  daemonStatus: () => "not-installed",
  cliVersion: "1.0.0",
  ...over,
});

const attempt = (over: Partial<OnboardingAttempt> = {}): OnboardingAttempt => ({
  schemaVersion: 1,
  reason: "needs_root",
  cliVersion: "1.0.0",
  daemonStatus: "not-installed",
  at: 1,
  ...over,
});

describe("recording an attempt", () => {
  it("round-trips the reason and the state it was made in", () => {
    recordOnboardingAttempt("needs_root", "1.2.3", "not-installed", 42);
    expect(readOnboardingAttempt()).toEqual({
      schemaVersion: 1,
      reason: "needs_root",
      cliVersion: "1.2.3",
      daemonStatus: "not-installed",
      at: 42,
    });
  });

  it("creates state/ rather than assuming it", () => {
    // The abort happens before anything else has written to the home, so on a
    // genuinely fresh machine this directory does not exist yet.
    expect(existsSync(dirname(onboardingAttemptFile()))).toBe(false);
    recordOnboardingAttempt("cancelled", "1.0.0", "running");
    expect(readOnboardingAttempt()?.reason).toBe("cancelled");
  });

  it("is cleared once setup completes", () => {
    recordOnboardingAttempt("needs_root", "1.0.0", "not-installed");
    clearOnboardingAttempt();
    expect(readOnboardingAttempt()).toBeNull();
  });

  it("clearing is safe when there is nothing to clear", () => {
    expect(() => clearOnboardingAttempt()).not.toThrow();
  });
});

describe("a record that cannot be trusted", () => {
  function writeRaw(contents: string) {
    mkdirSync(dirname(onboardingAttemptFile()), { recursive: true });
    writeFileSync(onboardingAttemptFile(), contents, "utf8");
  }

  it("reads corrupt JSON as no record, never as configured", () => {
    // Degrading to "offer the wizard" is the safe direction; degrading to
    // "this machine is set up" would silently leave it unprotected.
    writeRaw("{not json");
    expect(readOnboardingAttempt()).toBeNull();
  });

  it("ignores a record from a future schema", () => {
    writeRaw(JSON.stringify({ schemaVersion: 99, reason: "needs_root", cliVersion: "1" }));
    expect(readOnboardingAttempt()).toBeNull();
  });

  it("ignores a record missing its required fields", () => {
    writeRaw(JSON.stringify({ schemaVersion: 1, at: 5 }));
    expect(readOnboardingAttempt()).toBeNull();
  });
});

describe("THE INVARIANT: an attempt never means configured", () => {
  it("a recorded failure leaves the machine unconfigured", () => {
    // The single most important property here. A failed attempt must keep
    // reading as unconfigured to `--status`, to the hook path, and to the
    // wizard when asked for by name — it only suppresses the unprompted offer.
    recordOnboardingAttempt("needs_root", "1.0.0", "not-installed");

    const state = detectSetupState(home, home);
    expect(state.hasGlobalConfig).toBe(false);
    expect(state.hasLegacyMarker).toBe(false);

    // `hasGlobalHooks` is pinned rather than read. `detectSetupState` takes an
    // injectable home and its docstring promises "every path is derived from
    // an injectable home/cwd" — but `hasGlobalHooksInstalled()` takes no home
    // and walks the REAL user's settings files, so this assertion flipped the
    // moment a developer had failproofai hooks installed on their own machine.
    // Neutralising it here keeps the test about the attempt record, which is
    // what it is for; the injectability gap is a separate problem.
    expect(isConfigured({ ...state, hasGlobalHooks: false })).toBe(false);
  });
});

describe("needs_root — the common case", () => {
  it("stays blocked while elevation is still impossible", () => {
    expect(blockerCleared(attempt({ reason: "needs_root" }), probe({ canElevate: () => false })))
      .toBe(false);
  });

  it("clears the moment sudo works", () => {
    // The exact case this exists for: someone hits the prompt, gives up, and
    // comes back later able to elevate. A hint that never became an offer
    // again would be its own kind of broken.
    expect(blockerCleared(attempt({ reason: "needs_root" }), probe({ canElevate: () => true })))
      .toBe(true);
  });
});

describe("daemon_failed", () => {
  it("stays blocked while the service manager says the same thing", () => {
    expect(
      blockerCleared(
        attempt({ reason: "daemon_failed", daemonStatus: "not-installed" }),
        probe({ daemonStatus: () => "not-installed" }),
      ),
    ).toBe(false);
  });

  it("clears on ANY movement, not only on `running`", () => {
    // A partially-repaired machine must be offered setup again rather than
    // waiting for a state it cannot reach without the wizard's help.
    for (const now of ["stopped", "running", "unsupported-platform"]) {
      expect(
        blockerCleared(
          attempt({ reason: "daemon_failed", daemonStatus: "not-installed" }),
          probe({ daemonStatus: () => now }),
        ),
        now,
      ).toBe(true);
    }
  });

  it("also clears when elevation becomes possible", () => {
    // An install that failed for want of root is reported as daemon_failed by
    // some paths and needs_root by others; both remedies are the same.
    expect(
      blockerCleared(
        attempt({ reason: "daemon_failed", daemonStatus: "not-installed" }),
        probe({ daemonStatus: () => "not-installed", canElevate: () => true }),
      ),
    ).toBe(true);
  });
});

describe("cancelled — a deliberate stop", () => {
  it("does not re-offer on the very next command", () => {
    // Re-asking immediately is exactly the nagging this removes.
    expect(
      blockerCleared(attempt({ reason: "cancelled", cliVersion: "1.0.0" }), probe({ cliVersion: "1.0.0" })),
    ).toBe(false);
  });

  it("asks once more after an upgrade", () => {
    // A new version is a new thing to say, and the only event that justifies
    // reopening something the user deliberately closed.
    expect(
      blockerCleared(attempt({ reason: "cancelled", cliVersion: "1.0.0" }), probe({ cliVersion: "1.1.0" })),
    ).toBe(true);
  });
});

describe("unsupported_platform — a permanent property of the machine", () => {
  it("stays blocked on the same CLI version", () => {
    // Nagging every command would just repeat the hard-fail this reason
    // records — the machine's platform has not changed.
    expect(
      blockerCleared(
        attempt({ reason: "unsupported_platform", cliVersion: "1.0.0" }),
        probe({ cliVersion: "1.0.0" }),
      ),
    ).toBe(false);
  });

  it("re-offers after an upgrade, in case the new version supports it", () => {
    expect(
      blockerCleared(
        attempt({ reason: "unsupported_platform", cliVersion: "1.0.0" }),
        probe({ cliVersion: "1.1.0" }),
      ),
    ).toBe(true);
  });
});

describe("reasons that are properties of the invocation, not the machine", () => {
  it("re-offers for not_a_tty and running_as_sudo", () => {
    for (const reason of ["not_a_tty", "running_as_sudo"] as const) {
      expect(blockerCleared(attempt({ reason }), probe()), reason).toBe(true);
    }
  });

  it("re-offers for a reason it does not recognise", () => {
    // A blocker we cannot prove is still present must not silently withhold
    // setup — the safe direction is offering it.
    expect(
      blockerCleared(attempt({ reason: "something-new" as never }), probe()),
    ).toBe(true);
  });
});

describe("what the user is told", () => {
  it("names the reason and the one command that fixes it", () => {
    const text = attemptHintLines(attempt({ reason: "needs_root" })).join("\n");
    expect(text).toContain("root");
    expect(text).toContain("failproofai config");
  });

  it("has a line for every reason, so none renders as a bare sentence", () => {
    for (const reason of [
      "needs_root",
      "daemon_failed",
      "cancelled",
      "unsupported_platform",
      "not_a_tty",
      "running_as_sudo",
    ] as const) {
      const text = attemptHintLines(attempt({ reason })).join("\n");
      expect(text, reason).toContain("Setup is not finished");
      expect(text, reason).not.toContain("undefined");
    }
  });
});
