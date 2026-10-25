import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A TypeScript SDK integration fixture named for a release line — `ai-4`,
 * `langchain-0.3`, `mastra-0` — exists to hold its framework on that line: the
 * pinned release is the subject of the test (SECURITY.md, "Triaging a Dependabot
 * alert in an integration fixture"). A move off it still installs and still
 * passes, against a different major, so the matrix loses a supported floor with
 * every check green. Dependabot security updates have made that move twice
 * (#838, #931), both times to reach a fix the fixture could not take. This fails
 * on the manifest, before anything installs.
 *
 * #931 also moved the `runtimes` fixture's zod without the `npm:zod@…` specifier
 * its Deno program imports, which Deno resolves against the fixture's
 * `node_modules` and so could no longer find. That half is checked here too.
 */

const fixturesDir = join(__dirname, "..", "..", "sdk", "typescript", "integration", "fixtures");

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

describe("TS SDK integration fixtures named for a release line", () => {
  it("finds them, every framework's supported floor among them", () => {
    expect(named.map((f) => f.fixture)).toEqual(
      expect.arrayContaining(["ai-4", "langchain-0.3", "llamaindex-0.11", "mastra-0"]),
    );
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
