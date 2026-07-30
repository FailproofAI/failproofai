#!/usr/bin/env node
/**
 * Tripwire on what `npm publish` would actually ship.
 *
 * package.json's `files` allowlist is a set of *directories*, so adding a new
 * top-level directory to the repo — or removing one from the allowlist — changes
 * the published tarball with no diff anywhere that a reviewer looks. Both
 * directions have already bitten this repo: `.next/standalone/` over-traces the
 * project and quietly shipped the entire design-doc tree, and `dist/` is
 * gitignored, so the tarball is empty unless something built it first.
 *
 * Granularity is the FIRST PATH SEGMENT, not the file. The tarball carries
 * ~1,700 entries, almost all of them `.next/standalone/node_modules/**`, and a
 * file-level manifest would be regenerated on every dependency bump until nobody
 * read it. The set of top-level entries is small, stable, and is exactly the
 * thing that changes when a directory starts or stops shipping.
 *
 * Usage:
 *   node scripts/check-pack-allowlist.mjs            # check
 *   node scripts/check-pack-allowlist.mjs --write    # regenerate the expected file
 *
 * Dependency-free; shells out to `npm pack --dry-run --json`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, ".."));
const EXPECTED_FILE = join(ROOT, ".github", "expected-pack-files.txt");
const EXPECTED_FILE_REL = ".github/expected-pack-files.txt";

/**
 * Top-level entries that are gitignored build output, mapped to the path whose
 * presence means the build actually produced them. They appear in the tarball
 * only after `bun run build`, so in an unbuilt tree their absence is a notice
 * rather than a failure; the CI `build` job runs this same check *after*
 * building, where their absence is fatal.
 *
 * The value is the packed subpath, not the top-level directory: a failed
 * `next build` leaves a `.next/` behind with no `standalone/` inside it, and
 * treating that as "built" would turn every interrupted local build into a
 * spurious failure. An unexpected *extra* entry is always fatal regardless.
 */
const BUILD_OUTPUT_ROOTS = new Map([
  [".next", join(".next", "standalone")],
  ["dist", "dist"],
]);

/** @returns {string[]} every file path `npm publish` would include */
export function packFilePaths(rootDir = ROOT) {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  // npm has historically prefixed --json output with notices; slice from the
  // first bracket so a chatty npm cannot break the parse.
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error("npm pack --json produced no JSON array");
  const parsed = JSON.parse(stdout.slice(start));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error("npm pack --json output has no `files` array");
  }
  return entry.files.map((f) => f.path);
}

/** Reduce a list of file paths to the sorted set of their first path segments. */
export function topLevelEntries(paths) {
  const tops = new Set();
  for (const p of paths) tops.add(p.split("/")[0]);
  return [...tops].sort();
}

/** Parse the committed expected file (blank lines and `#` comments ignored). */
export function parseExpected(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .sort();
}

export function renderExpected(entries) {
  return [
    "# Top-level entries in the tarball `npm publish` would upload, one per line.",
    "#",
    "# Compared by scripts/check-pack-allowlist.mjs against the first path segment",
    "# of every file in `npm pack --dry-run --json`. Granularity is deliberate: the",
    "# tarball has ~1,700 files, nearly all under .next/standalone/node_modules, and",
    "# a file-level manifest would churn on every dependency bump.",
    "#",
    "# If this check fails, the tarball's shape changed. Decide whether that was",
    "# intended, then regenerate with:",
    "#",
    "#   bun run build && node scripts/check-pack-allowlist.mjs --write",
    "#",
    "# `.next` and `dist` are gitignored build output and only appear after a build.",
    "",
    ...entries,
    "",
  ].join("\n");
}

/**
 * @returns {{ ok: boolean, errors: string[], notices: string[], actual: string[] }}
 */
export function checkPackAllowlist({ actual, expected, rootDir = ROOT }) {
  const errors = [];
  const notices = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const entry of actual) {
    if (!expectedSet.has(entry)) {
      errors.push(
        `"${entry}" would be published but is not in ${EXPECTED_FILE_REL}. ` +
          `If shipping it is intentional, regenerate the file; if not, it is leaking ` +
          `through package.json's \`files\` allowlist (most likely via .next/standalone).`,
      );
    }
  }

  for (const entry of expected) {
    if (actualSet.has(entry)) continue;
    if (BUILD_OUTPUT_ROOTS.has(entry) && !existsSync(join(rootDir, BUILD_OUTPUT_ROOTS.get(entry)))) {
      notices.push(
        `"${entry}" is absent because this tree has not been built — skipped. ` +
          `The CI \`build\` job runs this check after \`bun run build\`, where it is fatal.`,
      );
      continue;
    }
    errors.push(
      `"${entry}" is in ${EXPECTED_FILE_REL} but would NOT be published. ` +
        `A published package missing it is broken — check package.json's \`files\` ` +
        `allowlist and whether the build produced it.`,
    );
  }

  return { ok: errors.length === 0, errors, notices, actual };
}

/* c8 ignore start -- CLI wrapper */
function main() {
  const write = process.argv.includes("--write");
  const actual = topLevelEntries(packFilePaths(ROOT));

  if (write) {
    writeFileSync(EXPECTED_FILE, renderExpected(actual));
    console.log(`Wrote ${EXPECTED_FILE_REL} with ${actual.length} entries:`);
    for (const e of actual) console.log(`  ${e}`);
    return;
  }

  if (!existsSync(EXPECTED_FILE)) {
    console.log(
      `::error file=${EXPECTED_FILE_REL}::Missing. Generate it with ` +
        `\`bun run build && node scripts/check-pack-allowlist.mjs --write\``,
    );
    process.exit(1);
  }

  const expected = parseExpected(readFileSync(EXPECTED_FILE, "utf8"));
  const { ok, errors, notices } = checkPackAllowlist({ actual, expected, rootDir: ROOT });

  for (const n of notices) console.log(`::notice file=${EXPECTED_FILE_REL}::${n}`);
  for (const e of errors) console.log(`::error file=${EXPECTED_FILE_REL}::${e}`);

  if (!ok) {
    console.log(
      `::error::The published tarball's top-level shape changed. Review the ` +
        `annotations above, then regenerate with ` +
        `\`bun run build && node scripts/check-pack-allowlist.mjs --write\` if intended.`,
    );
    process.exit(1);
  }

  console.log(`check-pack-allowlist: OK — ${actual.length} top-level entries: ${actual.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
/* c8 ignore stop */
