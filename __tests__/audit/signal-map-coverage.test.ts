/**
 * SIGNAL_MAP must name every builtin policy and every audit-only detector.
 *
 * The failure this prevents is silent in both directions and visible in
 * neither: a policy with no entry contributes nothing to the archetype
 * classifier, so an agent that trips it repeatedly is described as though it
 * never did — and an entry naming a policy that no longer exists is dead weight
 * that reads as coverage. `src/audit/features.ts` asserted this in prose ("every
 * one of the 39 builtin policies…"), which had already drifted by four policies
 * before this test existed.
 */
import { describe, it, expect } from "vitest";
import { SIGNAL_MAP, shortName } from "../../src/audit/features";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { AUDIT_DETECTORS } from "../../src/audit/detectors";

/**
 * Policies deliberately left unmapped, each with the reason it is excluded.
 *
 * `block-read-outside-cwd` is off by default and fires on ambient absolute-path
 * reads present in essentially every session. The audit replay force-registers
 * every builtin regardless of config, so mapping it made it ≈37% of all signal
 * and collapsed the population onto "the explorer" — the regression
 * __tests__/audit/distribution.test.ts exists to hold down.
 */
const INTENTIONALLY_UNMAPPED = new Set(["block-read-outside-cwd"]);

describe("SIGNAL_MAP coverage", () => {
  it("maps every builtin policy exactly once", () => {
    const missing = BUILTIN_POLICIES
      .map((p) => shortName(p.name))
      .filter((n) => !INTENTIONALLY_UNMAPPED.has(n) && !(n in SIGNAL_MAP));
    expect(
      missing,
      `builtin policies with no SIGNAL_MAP entry — they will fire in audits and ` +
      `contribute nothing to the archetype: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("maps every audit-only detector", () => {
    const missing = AUDIT_DETECTORS
      .map((d) => d.name)
      .filter((n) => !(n in SIGNAL_MAP));
    expect(missing, `detectors with no SIGNAL_MAP entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("names nothing that no longer exists", () => {
    const known = new Set([
      ...BUILTIN_POLICIES.map((p) => shortName(p.name)),
      ...AUDIT_DETECTORS.map((d) => d.name),
    ]);
    const orphans = Object.keys(SIGNAL_MAP).filter((n) => !known.has(n));
    expect(
      orphans,
      `SIGNAL_MAP names these, but no policy or detector does: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the intentional exclusions real", () => {
    const known = new Set(BUILTIN_POLICIES.map((p) => shortName(p.name)));
    for (const name of INTENTIONALLY_UNMAPPED) {
      expect(known.has(name), `${name} is excluded but no longer exists`).toBe(true);
      expect(name in SIGNAL_MAP, `${name} is excluded but IS mapped`).toBe(false);
    }
  });

  it("gives every entry a positive weight and a real archetype", () => {
    for (const [name, entry] of Object.entries(SIGNAL_MAP)) {
      expect(entry.weight, `${name} weight`).toBeGreaterThan(0);
      expect(typeof entry.archetype, `${name} archetype`).toBe("string");
    }
  });
});
