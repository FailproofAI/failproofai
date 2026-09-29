import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The TypeScript SDK's integration fixtures hold specific framework majors on
 * purpose, and `SECURITY.md` names moving one of those pins as never the answer
 * to an advisory. Dependabot proposed exactly that move twice anyway — #838 and
 * #867, the same PR six weeks apart, the second one failing `ERESOLVE` on
 * `@mastra/mcp`'s peer range and taking three CI shards down with it.
 *
 * `.github/dependabot.yml` now carries an `npm` entry that stops it: version
 * updates off, major bumps ignored, security updates still flowing. This is the
 * tripwire for that entry, because every way it can rot is silent:
 *
 *  - deleted or weakened, and the next Monday reopens #867;
 *  - `open-pull-requests-limit` raised above 0, and every fixture's exact pins
 *    start getting version-bump PRs;
 *  - a NEW fixture added at a path the `directories` glob does not match, which
 *    is the interesting one — nothing fails, the fixture simply is not covered,
 *    and that is invisible until Dependabot proposes a major bump in it.
 */

const ROOT = join(__dirname, "..", "..");
const FIXTURES_REL = "sdk/typescript/integration/fixtures";
const FIXTURES_ABS = join(ROOT, FIXTURES_REL);

interface IgnoreEntry {
  "dependency-name"?: string;
  "update-types"?: string[];
}

interface Update {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  "open-pull-requests-limit"?: number;
  ignore?: IgnoreEntry[];
  schedule?: { interval?: string };
}

const dependabot = parse(readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8")) as {
  version: number;
  updates: Update[];
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every fixture on disk, as a path relative to the fixtures root.
 *
 * Keyed on `package-lock.json`, not `package.json`: the lockfile is what
 * dependabot reads and what the shard's `npm ci` needs, and it is what separates
 * a fixture from `langchain-dup-core/vendor/lc-weather-provider`, a vendored
 * local package that has a manifest and no lockfile.
 *
 * Walks the whole tree rather than one level, because a fixture added at a
 * deeper path is exactly the case a one-level scan cannot see — it would not
 * appear here at all, and the coverage assertion below would pass by finding
 * nothing wrong.
 */
function findFixtures(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "vendor") continue;
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (isFile(join(abs, "package-lock.json"))) found.push(rel);
    else found.push(...findFixtures(abs, rel));
  }
  return found;
}

const fixturesOnDisk = findFixtures(FIXTURES_ABS);

/**
 * Dependabot's `directories` globbing, reduced to what this file actually uses:
 * `*` matches within one path segment, `**` across segments. Anchored on both
 * ends, like dependabot matches a manifest directory.
 */
function globMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("**")
    .map((chunk) =>
      chunk
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

const fixtureEntries = dependabot.updates.filter(
  (u) =>
    u["package-ecosystem"] === "npm" &&
    (u.directories ?? [u.directory ?? ""]).some((d) => d.includes(FIXTURES_REL)),
);

describe("dependabot config for the integration fixtures", () => {
  it("has exactly one npm entry covering the fixtures", () => {
    expect(fixtureEntries).toHaveLength(1);
  });

  const entry = () => {
    const found = fixtureEntries[0];
    if (!found) throw new Error("no npm dependabot entry covers the integration fixtures");
    return found;
  };

  it("switches version updates off with open-pull-requests-limit: 0", () => {
    // Not >0, and not absent (absent means dependabot's default of 5).
    expect(entry()["open-pull-requests-limit"]).toBe(0);
  });

  it("ignores every major bump, for every dependency", () => {
    const ignores = entry().ignore ?? [];
    const wildcardMajor = ignores.find(
      (i) =>
        i["dependency-name"] === "*" &&
        (i["update-types"] ?? []).includes("version-update:semver-major"),
    );
    expect(wildcardMajor).toBeDefined();
  });

  it("still carries a schedule, which dependabot requires per entry", () => {
    expect(entry().schedule?.interval).toBeTruthy();
  });

  it("covers every fixture on disk, so a new one cannot land uncovered", () => {
    expect(fixturesOnDisk.length).toBeGreaterThan(0);

    const patterns = entry().directories ?? [entry().directory ?? ""];
    const uncovered = fixturesOnDisk.filter(
      (name) =>
        !patterns.some((pattern) =>
          globMatches(pattern.replace(/^\//, ""), `${FIXTURES_REL}/${name}`),
        ),
    );

    expect(uncovered).toEqual([]);
  });

  it("does not silently widen to the SDK package itself", () => {
    // `sdk/typescript/package-lock.json` deliberately gets no version updates:
    // there is no npm entry for it, and this entry's glob must not grow one by
    // accident (e.g. by being loosened to `/sdk/typescript/**`).
    const patterns = entry().directories ?? [entry().directory ?? ""];
    const matchesSdkRoot = patterns.some((pattern) =>
      globMatches(pattern.replace(/^\//, ""), "sdk/typescript"),
    );
    expect(matchesSdkRoot).toBe(false);
  });
});
