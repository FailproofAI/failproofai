/**
 * Semver PRECEDENCE — ordering two version strings — for the one question a
 * pack manifest asks: is the CLI about to run this pack at least the version
 * the pack says it needs?
 *
 * ## Why this is written out rather than reused
 *
 * Nothing in this repo orders two versions. `daemonVersionSkew()` compares them
 * for EQUALITY, which is the right test there — the CLI and the daemon ship
 * from one commit, so anything but identical is skew — and it yields no
 * ordering at all. There is no semver dependency either: this module runs on
 * the hook path, and the loader's rule is that nothing there may pull in a
 * package.
 *
 * ## Why the obvious implementation is wrong here
 *
 * Splitting on dots and comparing numbers gets the release triple right and the
 * PRERELEASE exactly backwards. This package's version is `1.0.7-beta.0`, and
 * the beta cut from that line is the first build that understands
 * `minCliVersion` at all — so it is the build a pack's minimum is aimed at. On
 * numbers alone `1.0.7-beta.0` satisfies a minimum of `1.0.7`, which reads the
 * beta as the newer build when it is the older one, and the pack installs on a
 * CLI that may be missing the feature the minimum exists to require.
 *
 * So precedence follows semver §11 for real:
 *
 *     1.0.6 < 1.0.7-beta.0 < 1.0.7-beta.1 < 1.0.7 < 1.0.8
 *
 * - the release triple is compared numerically, field by field;
 * - a version WITH a prerelease is lower than the same triple without one;
 * - prerelease identifiers are compared left to right, numeric ones
 *   numerically and always below alphanumeric ones, and a longer identifier
 *   list wins when every shared identifier is equal;
 * - build metadata (`+2026.09.24`) is ignored, because it carries no precedence.
 *
 * Anything this cannot order is reported as unorderable rather than guessed at.
 * A caller comparing versions to decide whether to REFUSE something needs to
 * know the difference between "older" and "I cannot tell".
 */

/** A version decomposed far enough to be ordered. Build metadata is dropped. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, numeric ones as numbers. Empty for a release. */
  prerelease: ReadonlyArray<string | number>;
}

/**
 * Strict semver, and strict on purpose. `v1.0.0`, `1.0`, `01.2.3` and
 * `1.0.7-beta.0.` are all things people write and none of them has one
 * unambiguous ordering, so they are refused rather than normalised — a
 * `minCliVersion` nobody can order is a requirement nobody can check.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_ID = /^(?:0|[1-9]\d*)$/;

/** Decompose a version, or `null` when it is not one this can order. */
export function parseSemver(value: unknown): SemVer | null {
  if (typeof value !== "string") return null;
  const m = SEMVER_RE.exec(value);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split(".").map((id) => (NUMERIC_ID.test(id) ? Number(id) : id)),
  };
}

const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compare two prerelease identifier lists. An EMPTY list is a release, and a
 * release outranks every prerelease of the same triple — the rule the naive
 * implementation loses, and the one that decides this release's own case.
 */
function comparePrerelease(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    // "Numeric identifiers always have lower precedence than non-numeric
    // ones" (semver §11.4.3): `1.0.0-1` is below `1.0.0-alpha`, so an `rc.1`
    // line and a `1` line never interleave by accident.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (xNum && yNum) return cmp(x as number, y as number);
    return (x as string) < (y as string) ? -1 : 1;
  }
  // Every shared identifier is equal, so the longer list is the later build:
  // `1.0.0-beta` < `1.0.0-beta.1`.
  return cmp(a.length, b.length);
}

/** `-1`, `0` or `1` by semver precedence. */
export function compareSemver(a: SemVer, b: SemVer): number {
  return cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch) || comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * `-1` / `0` / `1` for two version STRINGS, or `null` when either one cannot be
 * ordered. Null is deliberately not 0: a caller that treats "unorderable" as
 * "equal" silently accepts the requirement it could not check.
 *
 * There is deliberately NO `meetsMinimum(current, minimum): boolean | null` here.
 * It existed, and it collapsed two situations that need opposite treatment into
 * one value: an ABSENT minimum (every pack published before today has none, so it
 * must satisfy) and a MALFORMED one. A call site reading `=== false` would then
 * ignore a typo'd requirement, and one reading `!== true` would refuse every
 * pre-existing pack — and on an `enforce` pack that means denying every tool call
 * the pack covers. Neither mistake shows up until a user hits it, so the decision
 * is encoded once, where the field lives: `checkPackMinCliVersion` in
 * `pack-manifest.ts`.
 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  return compareSemver(left, right);
}
