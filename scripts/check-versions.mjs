#!/usr/bin/env node
/**
 * Version-consistency gate for the CI `quality` job.
 *
 * Replaces the inline shell that used to live in `.github/workflows/ci.yml`.
 * That shell looped over `packages/*​/package.json` and read
 * `packages/wrapper/package.json` — neither of which has ever existed in this
 * repository — so the check passed vacuously from the initial import onward.
 * Its semantics are preserved here (they still apply if `packages/` ever
 * appears) and three real assertions are added on top:
 *
 *   1. `Cargo.toml`'s `[workspace.package] version` equals package.json's.
 *   2. Every `crates/*​/Cargo.toml` inherits with `version.workspace = true`
 *      rather than pinning a literal version that would drift.
 *   3. package.json declares NO npm lifecycle script. This is what makes the
 *      `prepare` removal permanent: `prepare` was the only thing populating the
 *      gitignored `dist/` and `.next/standalone/` before `npm publish`, the
 *      publish workflow now builds explicitly, and a re-added lifecycle script
 *      would quietly re-enter that path.
 *
 * Dependency-free by design — it runs before anything is guaranteed installed,
 * and the TOML it reads is two known keys deep, not a general document.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * npm lifecycle scripts — the ones npm itself invokes during `install`,
 * `publish` or `pack`. `predev`/`prestart` and friends are NOT in this set:
 * those are pre-hooks for user-defined scripts and only run when someone runs
 * that script by name, never on install or publish.
 */
export const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "preinstall",
  "install",
  "postinstall",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Strip TOML comments and extract the body of a top-level table.
 *
 * Not a general TOML parser and deliberately not a dependency: the only thing
 * anything here needs is "the lines between `[<table>]` and the next top-level
 * table header". Quoted `#` inside a value would be mangled by naive comment
 * stripping, so a `#` is only treated as a comment when it is outside quotes.
 *
 * @param {string} src   full Cargo.toml text
 * @param {string} table table name, e.g. "workspace.package"
 * @returns {string|null} the table body, or null when the table is absent
 */
export function extractTomlTable(src, table) {
  const lines = src.split(/\r?\n/);
  const header = `[${table}]`;
  let inTable = false;
  const body = [];

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      inTable = line === header;
      continue;
    }
    if (inTable) body.push(line);
  }

  return body.length > 0 || src.includes(header) ? body.join("\n") : null;
}

/** Remove a trailing `# comment`, respecting single- and double-quoted strings. */
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Read a `key = "value"` string from a top-level TOML table.
 *
 * @returns {string|null} the value, or null when the key or table is absent
 */
export function readTomlString(src, table, key) {
  const body = extractTomlTable(src, table);
  if (body === null) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Does this crate manifest inherit its version from the workspace?
 *
 * Accepts both spellings cargo allows:
 *   version.workspace = true
 *   version = { workspace = true }
 */
export function inheritsWorkspaceVersion(src) {
  const body = extractTomlTable(src, "package");
  if (body === null) return false;
  if (/^version\s*\.\s*workspace\s*=\s*true\s*$/m.test(body)) return true;
  if (/^version\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b[^}]*\}\s*$/m.test(body)) return true;
  return false;
}

/**
 * Run every consistency check against a repository root.
 *
 * Pure: takes a directory, touches nothing else, returns findings rather than
 * printing or exiting — which is what makes it testable against temp fixtures.
 *
 * @param {string} rootDir absolute path to the repository root
 * @returns {{ file: string, message: string }[]} one entry per violation
 */
export function checkVersions(rootDir) {
  /** @type {{ file: string, message: string }[]} */
  const violations = [];
  const add = (file, message) => violations.push({ file, message });

  const rootPkgPath = join(rootDir, "package.json");
  if (!existsSync(rootPkgPath)) {
    add("package.json", "No package.json at the repository root");
    return violations;
  }

  /** @type {Record<string, unknown>} */
  let rootPkg;
  try {
    rootPkg = readJson(rootPkgPath);
  } catch (err) {
    add("package.json", `Could not parse package.json: ${err.message}`);
    return violations;
  }

  const rootVersion = rootPkg.version;
  if (typeof rootVersion !== "string" || rootVersion.length === 0) {
    add("package.json", "Root package.json has no `version`");
    return violations;
  }

  // --- 1. Lifecycle scripts (this is what keeps `prepare` from coming back) ---
  const scripts = rootPkg.scripts ?? {};
  for (const name of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) {
      add(
        "package.json",
        `Lifecycle script "${name}" is declared. npm runs lifecycle scripts implicitly on ` +
          `install/pack/publish, and this package builds gitignored directories that sit in ` +
          `the \`files\` allowlist — the publish workflow builds them explicitly instead. ` +
          `Move the work into a named script and call it from the workflow.`,
      );
    }
  }

  // --- 2. packages/*/package.json version parity (preserved semantics) ---
  const packagesDir = join(rootDir, "packages");
  if (isDirectory(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const rel = `packages/${entry.name}/package.json`;
      const pkgPath = join(packagesDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;

      let pkg;
      try {
        pkg = readJson(pkgPath);
      } catch (err) {
        add(rel, `Could not parse: ${err.message}`);
        continue;
      }

      if (pkg.version !== rootVersion) {
        add(rel, `Version mismatch: has ${pkg.version}, expected ${rootVersion}`);
      }
    }

    // --- 3. packages/wrapper optionalDependencies parity (preserved) ---
    const wrapperRel = "packages/wrapper/package.json";
    const wrapperPath = join(packagesDir, "wrapper", "package.json");
    if (existsSync(wrapperPath)) {
      let wrapper;
      try {
        wrapper = readJson(wrapperPath);
      } catch {
        // Already reported by the loop above.
        wrapper = null;
      }
      for (const [dep, depVersion] of Object.entries(wrapper?.optionalDependencies ?? {})) {
        if (depVersion !== rootVersion) {
          add(
            wrapperRel,
            `optionalDependency "${dep}" is ${depVersion}, expected ${rootVersion}`,
          );
        }
      }
    }
  }

  // --- 4. Cargo workspace version parity ---
  const cargoPath = join(rootDir, "Cargo.toml");
  if (existsSync(cargoPath)) {
    const cargoSrc = readFileSync(cargoPath, "utf8");
    const workspaceVersion = readTomlString(cargoSrc, "workspace.package", "version");
    if (workspaceVersion === null) {
      add("Cargo.toml", "No `[workspace.package] version` — crates cannot inherit a version");
    } else if (workspaceVersion !== rootVersion) {
      add(
        "Cargo.toml",
        `[workspace.package] version is ${workspaceVersion}, expected ${rootVersion} ` +
          `(from package.json)`,
      );
    }
  }

  // --- 5. Every crate inherits, none pins ---
  const cratesDir = join(rootDir, "crates");
  if (isDirectory(cratesDir)) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(cratesDir, entry.name, "Cargo.toml");
      if (!existsSync(manifestPath)) continue;
      const rel = `crates/${entry.name}/Cargo.toml`;
      const src = readFileSync(manifestPath, "utf8");
      if (!inheritsWorkspaceVersion(src)) {
        const literal = readTomlString(src, "package", "version");
        add(
          rel,
          literal === null
            ? "Crate declares no version — use `version.workspace = true`"
            : `Crate pins version = "${literal}" — use \`version.workspace = true\` so it ` +
              `cannot drift from the root package.json`,
        );
      }
    }
  }

  return violations;
}

/* c8 ignore start -- CLI wrapper, exercised by CI rather than by unit tests */
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootDir = resolve(process.argv[2] ?? join(here, ".."));
  const violations = checkVersions(rootDir);

  for (const { file, message } of violations) {
    console.log(`::error file=${file}::${message}`);
  }

  if (violations.length > 0) {
    console.log(
      `::error::check-versions found ${violations.length} violation(s) — see the annotations above`,
    );
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version;
  console.log(`check-versions: OK — everything agrees on ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
/* c8 ignore stop */
