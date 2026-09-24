#!/usr/bin/env node
/**
 * The release scheme for `@failproofai/sdk`, and the only place it is written
 * down.
 *
 * The publish workflow calls this rather than restating the arithmetic, for the
 * same reason `scripts/python-version.py` exists on the Python side: a release
 * rule spelled out in YAML is a release rule nothing can test.
 *
 * ## The scheme
 *
 * | from                  | next                    |
 * |-----------------------|-------------------------|
 * | beta `X.Y.Z-beta.N`   | `X.Y.Z-beta.(N+1)`      |
 * | stable `X.Y.Z`        | `X.Y.(Z+1)-beta.0`      |
 *
 * The same rule `publish.yml` applies to the `failproofai` npm package. Unlike
 * PyPI, npm HAS dist-tags, so a pre-release publishes behind `beta` and a bare
 * `npm install @failproofai/sdk` never resolves it — which is why a prerelease
 * here is a cheaper mistake than one on PyPI, and why the guard rails below are
 * about not BURNING a version rather than about not shipping one.
 *
 * ## Commands
 *
 *   resolve            print the version in src/version.ts, and what follows it
 *   write <version>    move src/version.ts and package.json to <version>
 *   changelog <version> print that version's CHANGELOG section
 *
 * Node's standard library only: this runs in the preflight job, which installs
 * nothing precisely so that no third-party code decides whether a release may
 * proceed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_FILE = join(root, "src/version.ts");
const MANIFEST_FILE = join(root, "package.json");
const CHANGELOG_FILE = join(root, "CHANGELOG.md");

/**
 * Only canonical spellings are accepted.
 *
 * `1.2.3-beta.01`, `v1.2.3` and `1.2.3-beta` are all things a human types and
 * npm stores as something else or refuses outright. Every consumer in the
 * pipeline compares version STRINGS — this file, the tarball name, the dist-tag
 * and the "is this published" query — so a spelling that round-trips
 * differently is a release that half-succeeds.
 */
const CANONICAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function readVersion() {
  const source = readFileSync(VERSION_FILE, "utf8");
  const match = /export const VERSION = "([^"]+)";/.exec(source);
  if (match === null) fail(`could not find VERSION in ${VERSION_FILE}`);
  return match[1];
}

function parse(version) {
  const match = CANONICAL.exec(version);
  if (match === null) {
    fail(
      `${version} is not a canonical version. This package uses X.Y.Z or ` +
        "X.Y.Z-beta.N with no leading zeroes and no other pre-release kinds — " +
        "anything else stores on npm as a different string than the one in the " +
        "source, and the pipeline compares strings.",
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[5] === undefined ? null : Number(match[5]),
  };
}

function next(version) {
  const { major, minor, patch, beta } = parse(version);
  return beta === null
    ? `${major}.${minor}.${patch + 1}-beta.0`
    : `${major}.${minor}.${patch}-beta.${beta + 1}`;
}

/**
 * The CHANGELOG section for `version`, which becomes the GitHub Release body.
 *
 * A release whose section is missing or empty is refused before anything is
 * built. A published version nobody can read the changes for is a version that
 * may as well not have shipped.
 */
function changelogSection(version) {
  const lines = readFileSync(CHANGELOG_FILE, "utf8").split("\n");
  const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    fail(
      `CHANGELOG.md has no "## ${version} — <date>" section. Add one before releasing; ` +
        "it becomes the GitHub Release body.",
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") fail(`CHANGELOG.md's "## ${version}" section is empty.`);
  return body;
}

function write(version) {
  parse(version);
  const source = readFileSync(VERSION_FILE, "utf8");
  writeFileSync(
    VERSION_FILE,
    source.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`),
  );
  const manifest = readFileSync(MANIFEST_FILE, "utf8");
  // A targeted replacement rather than a parse-and-re-serialise: rewriting the
  // whole manifest would reformat every line and make the release commit
  // unreadable in review.
  const replaced = manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (replaced === manifest) fail("could not find a version field in package.json");
  writeFileSync(MANIFEST_FILE, replaced);
}

function emit(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const multiline = value.includes("\n");
  const line = multiline
    ? `${name}<<__RELEASE_EOF__\n${value}\n__RELEASE_EOF__\n`
    : `${name}=${value}\n`;
  if (file) writeFileSync(file, line, { flag: "a" });
  process.stdout.write(multiline ? `${name}:\n${value}\n` : `${name}=${value}\n`);
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "resolve": {
    const version = readVersion();
    parse(version);
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
    if (manifest.version !== version) {
      fail(
        `package.json says ${manifest.version} but src/version.ts says ${version}. ` +
          "They are read by different consumers and must agree.",
      );
    }
    emit("version", version);
    emit("next_version", next(version));
    emit("is_prerelease", String(parse(version).beta !== null));
    emit("dist_tag", parse(version).beta === null ? "latest" : "beta");
    emit("tag", `ts-sdk-v${version}`);
    break;
  }
  case "write": {
    if (!argument) fail("write needs a version");
    write(argument);
    process.stdout.write(`release: moved to ${argument}\n`);
    break;
  }
  case "changelog": {
    emit("body", changelogSection(argument ?? readVersion()));
    break;
  }
  case "next": {
    process.stdout.write(`${next(argument ?? readVersion())}\n`);
    break;
  }
  default:
    fail("usage: release.mjs resolve | write <version> | changelog [version] | next [version]");
}
