// @vitest-environment node
/**
 * Drift guard for what users actually RECEIVE.
 *
 * Every other test in this repo checks what the repo contains. This one checks
 * the npm tarball, which is a different thing and drifts independently: the
 * package.json "files" array ships whole directories (`src/`, `lib/`,
 * `scripts/`), and Next's file tracer sweeps arbitrary repo content into
 * `.next/standalone`. Both are how dead weight reaches users without any test
 * noticing.
 *
 * Two real cases this would have caught:
 *   - `src/audit/report.ts` was 348 lines of renderer for CLI flags that
 *     `runAuditCli()` rejects. Unreachable since the dashboard flow replaced
 *     it, and published in every tarball because "files" ships `src/`.
 *   - `assets/` was traced into `.next/standalone` and shipped — 612 KB of
 *     design lab the dashboard never imports. Moving the 11 MB
 *     `readme-arch-hq.gif` in there would have put it in front of every
 *     `npm install` with nothing to stop it.
 *
 * The assertions are deliberately shaped as invariants, not a file-list
 * snapshot: a snapshot of ~1,775 paths would be updated reflexively on every
 * legitimate addition, which is how a tripwire stops working.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** `dist/` is build output, not source. It exists in CI only because the `test`
 *  job's `bun install` runs the `prepare` script — which is incidental, not a
 *  guarantee, and is absent entirely in a fresh clone or under
 *  `--ignore-scripts`. The MUST_SHIP assertions are meaningless without it, so
 *  they skip rather than fail; the leak assertions below need no build and
 *  always run, because those are the ones that catch a regression. */
const DIST_BUILT = existsSync(join(ROOT, "dist", "cli.mjs"));

/** Directories that are traced into `.next/standalone` by Next and then removed
 *  by scripts/prune-standalone.mjs. The dashboard reads none of them at
 *  runtime; each one is repo content that a tracer over-collected. */
const MUST_NOT_SHIP_UNDER_STANDALONE = [
  "assets",
  "crates",
  "target",
  "docs",
  "examples",
  "__tests__",
  "integration-suite",
  "docker-hook-sync",
  "src",
  "scripts",
  "bin",
];

/** Load-bearing paths. Each is depended on by an INSTALLED user, so dropping it
 *  from "files" breaks them and nothing in this repo would fail. */
const MUST_SHIP = [
  "dist/cli.mjs", // package.json "bin".failproofai
  "dist/index.js", // what `import ... from 'failproofai'` resolves to in a user policy
  "dist/worker.mjs", // spawned by the Rust daemon
  "bin/failproofaid-shim.mjs", // package.json "bin".failproofaid
  "bin/failproofai.mjs", // the pi/openclaw source-fallback path imports out of this
  "package.json",
  "README.md",
];

let files: string[];

beforeAll(() => {
  // --ignore-scripts: `prepare` runs a full Next build, which is not this
  // test's business and would make it minutes long.
  const raw = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=error"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  // `--json` does not guarantee that stdout is ONLY json. The npm on this
  // machine (11.x) emits a clean array; the one on the CI runner prefixes it
  // with a `Bundled 3 …` notice, which made `JSON.parse(raw)` throw
  // "Unexpected token 'B'" — green locally, red in CI, for a reason that has
  // nothing to do with the tarball. Slice from the opening bracket instead of
  // trusting the whole stream, so this test reports on packaging and not on
  // whichever npm the runner happens to ship.
  const start = raw.indexOf("[");
  if (start === -1) {
    throw new Error(
      `npm pack --json produced no JSON array. Raw output:\n${raw.slice(0, 500)}`,
    );
  }
  files = JSON.parse(raw.slice(start))[0].files.map(
    (f: { path: string }) => f.path,
  );
}, 300_000);

describe("npm tarball surface", () => {
  it.skipIf(!DIST_BUILT)("ships every path an installed user depends on", () => {
    for (const p of MUST_SHIP) {
      expect(files, `${p} is missing from the tarball`).toContain(p);
    }
  });

  it("does not ship repo content that only the tracer pulled in", () => {
    for (const dir of MUST_NOT_SHIP_UNDER_STANDALONE) {
      const leaked = files.filter((f) =>
        f.startsWith(`.next/standalone/${dir}/`),
      );
      expect(
        leaked,
        `.next/standalone/${dir}/ reached the tarball — add "${dir}" to ` +
          `STANDALONE_ROOT_PRUNE in scripts/prune-standalone.mjs`,
      ).toEqual([]);
    }
  });

  it.skipIf(!DIST_BUILT)("ships the plugin packages from the package root, not the bundle", () => {
    // Both directory names are frozen: already-installed users have these
    // absolute paths written into their own settings files, and
    // integrations.ts resolves them via FAILPROOFAI_PACKAGE_ROOT.
    for (const pkg of ["pi-extension", "openclaw-plugin"]) {
      expect(
        files.some((f) => f.startsWith(`${pkg}/`)),
        `${pkg}/ must ship from the package root`,
      ).toBe(true);
      expect(
        files.filter((f) => f.startsWith(`.next/standalone/${pkg}/`)),
        `${pkg}/ must not ALSO ship inside the standalone bundle`,
      ).toEqual([]);
    }
  });

  it("ships no file deleted as unreachable", () => {
    // Regression pins. Each was confirmed dead by an exhaustive reference
    // search, and each was published before it was removed.
    for (const gone of [
      "src/audit/report.ts",
      "lib/claude-config.ts",
      "lib/extract-subagent-ids.ts",
    ]) {
      expect(files, `${gone} is back in the tarball`).not.toContain(gone);
    }
  });
});
