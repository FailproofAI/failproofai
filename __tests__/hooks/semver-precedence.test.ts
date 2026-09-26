// @vitest-environment node
/**
 * Version PRECEDENCE, and specifically the case a naive comparator gets
 * backwards.
 *
 * `package.json` is `1.0.7-beta.0`, and the beta cut from this branch is the
 * first build that can read a pack's `semantic` array — so it is the build a
 * pack's `minCliVersion` is aimed at. Compare on numbers alone and
 * `1.0.7-beta.0` satisfies a minimum of `1.0.7`, which reads the beta as the
 * NEWER build. The pack then installs on a CLI that may not have the feature the
 * minimum exists to require, and does it silently.
 *
 * So the ordering below is the test, not an illustration.
 */
import { describe, it, expect } from "vitest";
import { compareSemver, compareVersions, parseSemver } from "@/src/hooks/semver-precedence";
import { version as packageVersion } from "../../package.json";

/** Ascending, and every neighbouring pair is an assertion. */
const ORDER = [
  "0.9.9",
  "1.0.0",
  "1.0.6",
  "1.0.7-alpha",
  "1.0.7-alpha.1",
  "1.0.7-beta.0",
  "1.0.7-beta.1",
  "1.0.7-beta.10",
  "1.0.7-rc.1",
  "1.0.7",
  "1.0.8-beta.0",
  "1.0.8",
  "1.1.0-beta.0",
  "1.1.0",
  "2.0.0",
];

describe("parseSemver", () => {
  it("decomposes a release and a prerelease", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("1.0.7-beta.0")).toEqual({ major: 1, minor: 0, patch: 7, prerelease: ["beta", 0] });
  });

  it("drops build metadata, which carries no precedence", () => {
    expect(parseSemver("1.0.7+2026.09.24")?.prerelease).toEqual([]);
    expect(compareVersions("1.0.7+a", "1.0.7+b")).toBe(0);
  });

  it("refuses the spellings that have no single ordering", () => {
    // Each of these is something a person writes and no two consumers agree on.
    for (const bad of ["v1.0.0", "1.0", "1", "01.2.3", "1.0.7-", "1.0.7-beta..0", "", "1.0.7 ", "latest"]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it("refuses anything that is not a string", () => {
    for (const bad of [undefined, null, 107, {}, ["1.0.7"], true]) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
});

describe("compareSemver precedence", () => {
  it("orders the whole ladder, neighbour by neighbour", () => {
    for (let i = 0; i < ORDER.length - 1; i++) {
      const lower = ORDER[i];
      const higher = ORDER[i + 1];
      expect(compareVersions(lower, higher), `${lower} < ${higher}`).toBe(-1);
      expect(compareVersions(higher, lower), `${higher} > ${lower}`).toBe(1);
    }
  });

  it("makes a prerelease LOWER than its own release, which is the case that matters", () => {
    expect(compareVersions("1.0.7-beta.0", "1.0.7")).toBe(-1);
    // And therefore: this branch's own version does NOT satisfy a 1.0.7 minimum.
    expect(compareVersions(packageVersion, "1.0.7")).toBe(-1);
    // While it DOES satisfy the minimum FailproofAI/jev-policies declares, which
    // is the comparison with something riding on it: that pack's manifest says
    // `minCliVersion: 1.0.7-beta.0`, and a build that failed this check would
    // refuse to install the pack it was written for.
    //
    // Not pinned to equality. It was, and the first beta bump broke it — which
    // is the wrong thing for this test to notice. Every later 1.0.7 prerelease
    // must keep satisfying that minimum, and that is what this asserts.
    expect(compareVersions(packageVersion, "1.0.7-beta.0")).toBeGreaterThanOrEqual(0);
  });

  it("compares numeric identifiers numerically, not as strings", () => {
    expect(compareVersions("1.0.7-beta.10", "1.0.7-beta.9")).toBe(1);
  });

  it("puts a numeric identifier below an alphanumeric one (semver §11.4.3)", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBe(1);
  });

  it("treats a longer identifier list as later when every shared one is equal", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
  });

  it("is reflexive and total on itself", () => {
    for (const v of ORDER) {
      expect(compareVersions(v, v), v).toBe(0);
      expect(compareSemver(parseSemver(v)!, parseSemver(v)!), v).toBe(0);
    }
  });
});

describe("compareVersions on the unorderable", () => {
  it("returns null rather than 0, so nobody can read it as equal", () => {
    expect(compareVersions("garbage", "1.0.7")).toBeNull();
    expect(compareVersions("1.0.7", "garbage")).toBeNull();
    expect(compareVersions(undefined, "1.0.7")).toBeNull();
    expect(compareVersions("1.0.7", undefined)).toBeNull();
  });
});
