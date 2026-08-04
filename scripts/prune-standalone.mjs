#!/usr/bin/env node
// Prune .next/standalone to shrink the published npm tarball.
// Safe because (a) images.unoptimized: true in next.config.ts, so sharp never loads,
// and (b) we only touch .next/standalone/node_modules — server.js and app code untouched.

import { readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const STANDALONE = join(ROOT, ".next", "standalone");
const NM = join(STANDALONE, "node_modules");

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

function measure(dir) {
  let bytes = 0, files = 0;
  function walk(p) {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = join(p, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) { bytes += statSync(child).size; files += 1; }
    }
  }
  walk(dir);
  return { bytes, files };
}

const JUNK_DIRS = new Set([
  "test", "tests", "__tests__",
  "doc", "docs",
  "example", "examples",
  ".github", ".vscode", ".idea",
]);

const JUNK_FILE_BASENAMES = new Set([
  ".npmignore", ".gitignore", ".gitattributes",
  ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml",
  ".prettierrc", ".prettierrc.js", ".prettierrc.json",
  ".editorconfig", ".travis.yml", ".nycrc",
  "AUTHORS", "CONTRIBUTORS", "HISTORY", "HISTORY.md",
  "CHANGELOG", "CHANGELOG.md", "CHANGES", "CHANGES.md",
]);

function isJunkFile(name) {
  const lower = name.toLowerCase();
  if (JUNK_FILE_BASENAMES.has(name) || JUNK_FILE_BASENAMES.has(lower)) return true;
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return true;
  if (lower.endsWith(".map")) return true;
  if (lower.endsWith(".ts.map")) return true;
  return false;
}

function prune(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (JUNK_DIRS.has(e.name)) {
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      prune(p);
    } else if (e.isFile()) {
      if (isJunkFile(e.name)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }
}

if (!exists(STANDALONE)) {
  console.error(`[prune-standalone] ${STANDALONE} does not exist — did you run \`next build\`?`);
  process.exit(1);
}

const before = measure(STANDALONE);

// 1. Drop sharp — image optimization is disabled globally (next.config.ts).
for (const pkg of ["@img", "sharp"]) {
  rmSync(join(NM, pkg), { recursive: true, force: true });
}

// 2. Strip docs / tests / sourcemaps from remaining node_modules.
if (exists(NM)) prune(NM);

// 3. Remove over-traced project artifacts from the standalone root.
// Next.js NFT pulls in too much (tracked warning: "whole project was traced
// unintentionally"). The Next server only actually needs server.js, .next/,
// node_modules/, package.json, public/, and the compiled app code — the rest
// is source/dev/docs that the runtime never reads.
const STANDALONE_ROOT_PRUNE = [
  // Doc / dev directories
  "docs", "examples", "design-docs", "__tests__",
  ".claude", ".failproofai", ".github", ".vscode", ".idea",
  // Failproofai CLI artifacts — the dashboard never loads these
  "bin", "dist", "scripts", "src",
  // Release-pipeline scratch: the daemon binaries downloaded from the build
  // matrix and the staged platform packages. Both are written into the
  // workspace only by a local/manual run (the publish workflow keeps them in
  // RUNNER_TEMP precisely so this cannot happen), and 16 MB of `.gz` shipped
  // inside the CLI tarball once already because nothing pruned them.
  "release-assets", ".daemon-packages",
];
const STANDALONE_ROOT_PRUNE_FILES = [
  // Top-level markdown / licenses / docs
  "README.md", "CHANGELOG.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md",
  "LICENSE", "Dockerfile.docs",
  // Build / lint / test config (applied at build time, not runtime)
  "tsconfig.json", "eslint.config.mjs", "tailwind.config.ts", "components.json",
  "vitest.config.mts", "vitest.config.e2e.mts",
  // Lockfiles
  "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock",
];
for (const d of STANDALONE_ROOT_PRUNE) {
  rmSync(join(STANDALONE, d), { recursive: true, force: true });
}
for (const f of STANDALONE_ROOT_PRUNE_FILES) {
  try { unlinkSync(join(STANDALONE, f)); } catch { /* ignore */ }
}

const after = measure(STANDALONE);
const mb = (b) => (b / (1024 * 1024)).toFixed(2);
console.log(
  `[prune-standalone] ${before.files} files / ${mb(before.bytes)} MB -> ` +
  `${after.files} files / ${mb(after.bytes)} MB ` +
  `(saved ${before.files - after.files} files / ${mb(before.bytes - after.bytes)} MB)`
);
