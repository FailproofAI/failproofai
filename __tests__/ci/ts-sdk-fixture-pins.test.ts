import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * A TypeScript SDK integration fixture named for a release line — `ai-4`,
 * `langchain-0.3`, `mastra-0` — exists to hold its framework on that line: the
 * pinned release is the subject of the test (SECURITY.md, "Triaging a Dependabot
 * alert in an integration fixture"). A move off it still installs and still
 * passes, against a different major, so the matrix loses a supported floor with
 * every check green. Dependabot security updates have made that move three times
 * (#838, #931, #935), each to reach a fix the fixture could not take; #935 opened
 * three minutes after #934 put the pins back. This fails on the manifest, before
 * anything installs, and on a `.github/dependabot.yml` that no longer stops the
 * move from being proposed for a supported floor.
 *
 * #931 also moved the `runtimes` fixture's zod without the `npm:zod@…` specifier
 * its Deno program imports, which Deno resolves against the fixture's
 * `node_modules` and so could no longer find. That half is checked here too.
 */

const root = join(__dirname, "..", "..");
const fixturesDir = join(root, "sdk", "typescript", "integration", "fixtures");

/** Every framework's supported floor: where the SDK's peer range starts. */
const FLOORS = ["ai-4", "langchain-0.3", "llamaindex-0.11", "mastra-0"];

/** The package each fixture-name prefix pins. */
const FRAMEWORK: Record<string, string> = {
  ai: "ai",
  langchain: "@langchain/core",
  llamaindex: "llamaindex",
  mastra: "@mastra/core",
};

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const named = fixtures
  .map((name) => /^([a-z]+)-(\d+(?:\.\d+)?)$/.exec(name))
  .filter((match): match is RegExpExecArray => match !== null)
  .map(([fixture, prefix, line]) => ({ fixture: fixture!, framework: FRAMEWORK[prefix!], line: line! }));

const readJson = (fixture: string, file: string) =>
  JSON.parse(readFileSync(join(fixturesDir, fixture, file), "utf8")) as {
    dependencies?: Record<string, string>;
    packages?: Record<string, { version?: string }>;
  };

/** Every `npm:<name>@<version>` a fixture's top-level programs import, once each. */
const NPM_SPECIFIER = /["']npm:((?:@[\w.-]+\/)?[\w.-]+)@([^"'/]+)/g;
const specifiers = fixtures.flatMap((fixture) =>
  readdirSync(join(fixturesDir, fixture))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const source = readFileSync(join(fixturesDir, fixture, file), "utf8");
      const found = new Set([...source.matchAll(NPM_SPECIFIER)].map(([, name, version]) => `${name}@${version}`));
      return [...found].map((spec) => {
        const at = spec.lastIndexOf("@");
        return { fixture, file, name: spec.slice(0, at), version: spec.slice(at + 1) };
      });
    }),
);

type DependabotUpdate = {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  "open-pull-requests-limit"?: number;
  ignore?: { "dependency-name": string; versions?: string[] }[];
};

/** Each fixture directory `.github/dependabot.yml` names, with the entry naming it. */
const FIXTURE_DIR = "/sdk/typescript/integration/fixtures/";
const dependabot = parse(readFileSync(join(root, ".github", "dependabot.yml"), "utf8")) as {
  updates: DependabotUpdate[];
};
const fixtureEntries = dependabot.updates
  .filter((update) => update["package-ecosystem"] === "npm")
  .flatMap((update) =>
    [update.directory, ...(update.directories ?? [])]
      .filter((dir): dir is string => dir?.startsWith(FIXTURE_DIR) === true)
      .map((dir) => ({ fixture: dir.slice(FIXTURE_DIR.length), update })),
  );

type Version = [number, number, number];
const versionOf = (text: string): Version => {
  const [major = 0, minor = 0, patch = 0] = text.split(".").map(Number);
  return [major, minor, patch];
};
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The first release past a line: `4` → 5.0.0, `0.3` → 0.4.0. */
const nextLine = (line: string): Version => {
  const [major, minor] = line.split(".").map(Number);
  return minor === undefined ? [major! + 1, 0, 0] : [major!, minor + 1, 0];
};

/** Whether a `dependency-name`, which may use `*`, matches `name`. */
const namesMatch = (pattern: string, name: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);

/**
 * Whether `update` ignores `name` from the next line on, while still letting a
 * fix on the line replace `pinned`. Only `>=` ranges in `versions` count: security
 * updates read `versions`, and do not read `update-types`.
 */
const holdsOnLine = (update: DependabotUpdate, name: string, pinned: string, line: string) =>
  (update.ignore ?? [])
    .filter((rule) => namesMatch(rule["dependency-name"], name))
    .flatMap((rule) => rule.versions ?? [])
    .map((range) => /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim())?.[1])
    .filter((bound): bound is string => bound !== undefined)
    .some((bound) => compare(versionOf(bound), nextLine(line)) <= 0 && compare(versionOf(bound), versionOf(pinned)) > 0);

describe("TS SDK integration fixtures named for a release line", () => {
  it("finds them, every framework's supported floor among them", () => {
    expect(named.map((f) => f.fixture)).toEqual(expect.arrayContaining(FLOORS));
  });

  it("know which framework each name pins", () => {
    expect(named.filter((f) => f.framework === undefined).map((f) => f.fixture)).toEqual([]);
  });

  it.each(named)("$fixture pins $framework exactly, on $line", ({ fixture, framework, line }) => {
    const pinned = readJson(fixture, "package.json").dependencies?.[framework!];
    expect(pinned, `${fixture}: ${framework} in package.json`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned!.startsWith(`${line}.`), `${fixture} pins ${framework}@${pinned}`).toBe(true);
    const locked = readJson(fixture, "package-lock.json").packages?.[`node_modules/${framework}`]?.version;
    expect(locked, `${fixture}: ${framework} in package-lock.json`).toBe(pinned);
  });
});

describe("Dependabot security updates on the supported floors", () => {
  const floors = named.filter((f) => FLOORS.includes(f.fixture));
  const zod3 = floors.filter((f) => readJson(f.fixture, "package.json").dependencies?.zod?.startsWith("3."));

  it("finds every floor, and the ones held to zod 3", () => {
    expect(floors.map((f) => f.fixture).sort()).toEqual([...FLOORS].sort());
    expect(zod3.map((f) => f.fixture)).toEqual(expect.arrayContaining(["ai-4", "langchain-0.3", "llamaindex-0.11"]));
  });

  it.each(floors)("$fixture has one security-only entry holding $framework on $line", ({ fixture, framework, line }) => {
    const entries = fixtureEntries.filter((e) => e.fixture === fixture).map((e) => e.update);
    expect(entries, `${fixture}: npm entries in .github/dependabot.yml`).toHaveLength(1);
    expect(entries[0]!["open-pull-requests-limit"], `${fixture}: version updates`).toBe(0);
    const pinned = readJson(fixture, "package.json").dependencies![framework!]!;
    expect(holdsOnLine(entries[0]!, framework!, pinned, line), `${fixture}: ignore for ${framework}`).toBe(true);
  });

  it.each(zod3)("$fixture holds zod on 3, which its framework requires", ({ fixture }) => {
    const entry = fixtureEntries.find((e) => e.fixture === fixture)!.update;
    const pinned = readJson(fixture, "package.json").dependencies!.zod!;
    expect(holdsOnLine(entry, "zod", pinned, "3"), `${fixture}: ignore for zod`).toBe(true);
  });

  it("names only fixtures that exist", () => {
    expect(fixtureEntries.map((e) => e.fixture).filter((f) => !fixtures.includes(f))).toEqual([]);
  });
});

describe("TS SDK integration fixtures' npm: specifiers", () => {
  it("finds the Deno program's", () => {
    expect(specifiers.map((s) => s.name)).toEqual(expect.arrayContaining(["ai", "zod"]));
  });

  it.each(specifiers)("$fixture/$file imports npm:$name@$version, the version it installs", (spec) => {
    const { fixture, name, version } = spec;
    const locked = readJson(fixture, "package-lock.json").packages?.[`node_modules/${name}`]?.version;
    expect(locked, `${fixture}: ${name} in package-lock.json`).toBe(version);
  });
});
