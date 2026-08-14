// @vitest-environment node
/**
 * Drift guard for what users actually RECEIVE.
 *
 * Every other test in this repo checks what the repo contains. This one checks
 * the shipped surface, which drifts independently: `package.json` "files" ships
 * whole directories (`src/`, `lib/`, `scripts/`), and Next's tracer sweeps
 * arbitrary repo content into `.next/standalone`. Both are how dead weight
 * reaches users with nothing failing.
 *
 * Two real cases this exists for:
 *   - `src/audit/report.ts` was 348 lines of renderer for CLI flags
 *     `runAuditCli()` rejects. Unreachable since the dashboard flow replaced it,
 *     and published in every tarball because "files" ships `src/`.
 *   - Five dogfood hook-config directories and the `skills` submodule were
 *     traced into `.next/standalone` and published — configuration pointing at
 *     `scripts/dev-hook.mjs`, which exists only in a checkout.
 *
 * DELIBERATELY STATIC. The first version of this file shelled out to
 * `npm pack --dry-run --json`, and that was a mistake twice over. npm does not
 * guarantee stdout is only json — the runner's npm interleaves file-list
 * notices, and those paths contain `[project]` (Turbopack chunk names), so
 * every attempt to locate the array by bracket found a notice instead. And
 * packing a 12 MB / 54 MB-unpacked tarball on three matrix legs at once starved
 * the runner enough that a neighbouring test spawning `node dist/cli.mjs` blew
 * its 30s timeout. A guard that fails for reasons unrelated to what it guards
 * is worse than no guard, so this now reads the manifest instead of invoking
 * the packer. `__tests__/ci/standalone-prune.test.ts` covers the bundle side by
 * the same principle.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  files: string[];
  bin: Record<string, string>;
};

/** Load-bearing paths. Each is depended on by an INSTALLED user, so dropping it
 *  from "files" breaks them and nothing else in this repo would fail. Every
 *  entry is checked two ways: covered by a `files` entry, and present on disk
 *  when it is a source file rather than build output. */
const MUST_SHIP = [
  { path: "bin/failproofaid-shim.mjs", built: false }, // package.json bin.failproofaid
  { path: "bin/failproofai.mjs", built: false }, // pi/openclaw source-fallback imports out of this
  { path: "pi-extension/index.ts", built: false }, // directory name frozen by installed users' settings
  { path: "openclaw-plugin/index.js", built: false }, // same
  { path: "dist/cli.mjs", built: true }, // package.json bin.failproofai
  { path: "dist/index.js", built: true }, // what `from 'failproofai'` resolves to in a user policy
  { path: "dist/worker.mjs", built: true }, // spawned by the Rust daemon
];

/** Files removed as unreachable. `files` ships `src/` and `lib/` wholesale, so
 *  each of these was published before it was deleted — if one comes back, it
 *  ships again silently. */
const MUST_NOT_EXIST = [
  "src/audit/report.ts",
  "lib/claude-config.ts",
  "lib/extract-subagent-ids.ts",
];

const coveredByFiles = (p: string): boolean =>
  pkg.files.some((entry) => {
    const e = entry.replace(/\/$/, "");
    return p === e || p.startsWith(`${e}/`);
  });

describe("npm tarball surface", () => {
  it("ships every path an installed user depends on", () => {
    for (const { path } of MUST_SHIP) {
      expect(
        coveredByFiles(path),
        `${path} is not covered by any package.json "files" entry`,
      ).toBe(true);
    }
  });

  it("has those paths on disk, so the entry is not covering a hole", () => {
    for (const { path, built } of MUST_SHIP) {
      // Build output only exists after `bun run build`. In CI's test job it
      // does, because `bun install` runs `prepare` — but that is incidental,
      // and a missing dist/ is not this test's finding to report.
      if (built && !existsSync(join(ROOT, "dist"))) continue;
      expect(existsSync(join(ROOT, path)), `${path} is missing on disk`).toBe(
        true,
      );
    }
  });

  it("keeps both frozen plugin-package directories in files", () => {
    // Already-installed users have these absolute paths written into their own
    // settings files, and integrations.ts resolves them from
    // FAILPROOFAI_PACKAGE_ROOT. Renaming either orphans their uninstall path.
    for (const dir of ["pi-extension/", "openclaw-plugin/"]) {
      expect(pkg.files, `${dir} must stay in package.json "files"`).toContain(
        dir,
      );
    }
  });

  it("declares both bin entries against shipped paths", () => {
    for (const [name, target] of Object.entries(pkg.bin)) {
      const rel = target.replace(/^\.\//, "");
      expect(
        coveredByFiles(rel),
        `bin.${name} -> ${target} is not covered by "files"`,
      ).toBe(true);
    }
  });

  it("has not resurrected a file deleted as unreachable", () => {
    for (const gone of MUST_NOT_EXIST) {
      expect(
        existsSync(join(ROOT, gone)),
        `${gone} is back — it would ship again, since "files" covers its directory`,
      ).toBe(false);
    }
  });
});
