// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  topLevelEntries,
  parseExpected,
  renderExpected,
  checkPackAllowlist,
} from "@/scripts/check-pack-allowlist.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const EXPECTED_FILE = join(REPO_ROOT, ".github", "expected-pack-files.txt");

describe("topLevelEntries", () => {
  it("reduces file paths to the sorted set of first path segments", () => {
    expect(
      topLevelEntries([
        ".next/standalone/server.js",
        ".next/standalone/node_modules/next/index.js",
        "dist/cli.mjs",
        "dist/index.js",
        "package.json",
        "src/hooks/handler.ts",
      ]),
    ).toEqual([".next", "dist", "package.json", "src"]);
  });

  it("collapses the ~1500 .next files that motivate the granularity", () => {
    const paths = Array.from({ length: 1500 }, (_, i) => `.next/standalone/node_modules/p${i}/i.js`);
    expect(topLevelEntries(paths)).toEqual([".next"]);
  });
});

describe("parseExpected / renderExpected", () => {
  it("ignores comments and blank lines", () => {
    expect(parseExpected("# a comment\n\n  dist  \n.next\n\n")).toEqual([".next", "dist"]);
  });

  it("round-trips through render", () => {
    const entries = [".next", "LICENSE", "bin", "dist"];
    expect(parseExpected(renderExpected(entries))).toEqual(entries);
  });

  it("tells the reader how to regenerate", () => {
    expect(renderExpected(["dist"])).toContain("node scripts/check-pack-allowlist.mjs --write");
  });
});

describe("checkPackAllowlist", () => {
  function withRoot(fn: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "pack-allowlist-"));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("passes when actual and expected agree", () => {
    withRoot((root) => {
      const result = checkPackAllowlist({
        actual: [".next", "dist", "package.json"],
        expected: [".next", "dist", "package.json"],
        rootDir: root,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  it("fails on a new top-level entry that would silently ship", () => {
    withRoot((root) => {
      const result = checkPackAllowlist({
        actual: ["dist", "desgin-docs"],
        expected: ["dist"],
        rootDir: root,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("desgin-docs");
      expect(result.errors.join("\n")).toContain("would be published");
    });
  });

  it("fails on an expected entry that would silently NOT ship", () => {
    withRoot((root) => {
      const result = checkPackAllowlist({
        actual: ["package.json"],
        expected: ["package.json", "bin"],
        rootDir: root,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("would NOT be published");
    });
  });

  it("downgrades a missing build-output root to a notice in an unbuilt tree", () => {
    // The quality job does not build, so `dist/` and `.next/` are legitimately
    // absent there. The build job runs the same check after `bun run build`.
    withRoot((root) => {
      const result = checkPackAllowlist({
        actual: ["package.json"],
        expected: ["package.json", "dist", ".next"],
        rootDir: root,
      });
      expect(result.ok).toBe(true);
      expect(result.notices).toHaveLength(2);
      expect(result.notices.join("\n")).toContain("has not been built");
    });
  });

  it("still treats .next as unbuilt when a failed build left the directory empty", () => {
    // `next build` creates `.next/` before it can fail, so keying "was this
    // built?" off the top-level directory would turn every interrupted local
    // build into a spurious failure. The packed subpath is what counts.
    withRoot((root) => {
      mkdirSync(join(root, ".next", "cache"), { recursive: true });
      const result = checkPackAllowlist({
        actual: ["package.json"],
        expected: ["package.json", ".next"],
        rootDir: root,
      });
      expect(result.ok).toBe(true);
      expect(result.notices.join("\n")).toContain("has not been built");
    });
  });

  it("fails when .next/standalone exists but is missing from the tarball", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".next", "standalone"), { recursive: true });
      writeFileSync(join(root, ".next", "standalone", "server.js"), "x");
      const result = checkPackAllowlist({
        actual: ["package.json"],
        expected: ["package.json", ".next"],
        rootDir: root,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("would NOT be published");
    });
  });

  it("still fails when a build output exists on disk but is missing from the tarball", () => {
    // This is Bug 1's failure mode: `dist/` was built, yet the `files` allowlist
    // stopped carrying it. A notice here would hide a broken publish.
    withRoot((root) => {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "cli.mjs"), "x");
      const result = checkPackAllowlist({
        actual: ["package.json"],
        expected: ["package.json", "dist"],
        rootDir: root,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("would NOT be published");
    });
  });

  it("never downgrades an unexpected entry, built tree or not", () => {
    withRoot((root) => {
      const result = checkPackAllowlist({
        actual: ["package.json", "target"],
        expected: ["package.json"],
        rootDir: root,
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe("the committed .github/expected-pack-files.txt", () => {
  const expected = parseExpected(readFileSync(EXPECTED_FILE, "utf8"));

  it("is non-empty and sorted", () => {
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toEqual([...expected].sort());
  });

  it("lists every directory in package.json's `files` allowlist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    for (const entry of pkg.files as string[]) {
      const top = entry.replace(/\/$/, "").split("/")[0];
      expect(expected, `\`files\` entry "${entry}" -> top-level "${top}"`).toContain(top);
    }
  });

  it("does not list the design-doc tree under its own top-level entry", () => {
    expect(expected).not.toContain("desgin-docs");
    expect(expected).not.toContain("design-docs");
  });

  it("does not list the Rust workspace", () => {
    expect(expected).not.toContain("crates");
    expect(expected).not.toContain("target");
    expect(expected).not.toContain("Cargo.toml");
  });
});
