// @vitest-environment node
/**
 * Every Python package in this repo has to be registered in two places, and
 * both stay quiet when it is not.
 *
 * Dependabot resolves PER DIRECTORY: `fp-cloud-cli`'s entry does not see
 * `sdk/python`'s tree, so a package with no entry of its own simply never
 * receives an update PR — indistinguishable from a tree whose dependencies are
 * all current. And osv-scanner scans the lockfiles named on its command line;
 * it discovers none on its own, so a lockfile missing from those args is
 * reported clean because it was never read.
 *
 * The package list is derived from the lockfiles on disk rather than restated
 * here, so a third Python package fails this file until it is wired into both.
 * `failproofai-sdk-workflows.test.ts` asserts the SDK's dependabot entry from
 * the other direction, as one of that package's own invariants.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();

// Build output and installed trees carry copies of the real lockfiles
// (`.next/standalone/` holds both), and a copy is not a package to register.
const SKIP = new Set([
  ".git",
  ".next",
  ".venv",
  "dist",
  "node_modules",
  "out",
  "target",
]);

/** Repo-relative directories holding a `uv.lock`, in dependabot's `/x` spelling. */
function uvPackages(dir = ROOT, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "uv.lock") found.push(prefix || "/");
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    found.push(...uvPackages(join(dir, entry.name), `${prefix}/${entry.name}`));
  }
  return found.sort();
}

const PACKAGES = uvPackages();

const dependabot = parse(
  readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8"),
) as { updates: Record<string, unknown>[] };

const osvScanner = readFileSync(
  resolve(ROOT, ".github/workflows/osv-scanner.yml"),
  "utf8",
);

describe("Python package registration", () => {
  it("finds both packages, so the per-package checks are not vacuous", () => {
    // A discovery walk that quietly returns nothing would make every check
    // below pass by having nothing to check.
    expect(PACKAGES).toEqual(["/fp-cloud-cli", "/sdk/python"]);
  });

  describe.each(PACKAGES)("%s", (directory) => {
    it("has a dependabot entry for its own directory", () => {
      const entry = dependabot.updates.find(
        (u) => u.directory === directory && u["package-ecosystem"] === "uv",
      );
      expect(entry).toBeDefined();
    });

    it("declares the `uv` ecosystem, which is the one that reads uv.lock", () => {
      // `pip` resolves pyproject.toml and ignores the lockfile, so it would
      // open PRs that leave `uv sync --locked` pinned to the old versions.
      const entries = dependabot.updates.filter(
        (u) => u.directory === directory,
      );
      expect(entries.map((u) => u["package-ecosystem"])).toEqual(["uv"]);
    });

    it("has its lockfile named in the osv-scanner run", () => {
      expect(osvScanner).toContain(`--lockfile=${directory.slice(1)}/uv.lock`);
    });
  });
});
