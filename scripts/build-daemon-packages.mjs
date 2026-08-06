#!/usr/bin/env node
/**
 * Publishes the four `failproofaid` binaries as npm platform packages, so a
 * plain `npm install failproofai` already carries the daemon for the machine
 * it landed on instead of fetching one from the GitHub Release later.
 *
 * The release assets stay exactly as they are — this is a second channel, not
 * a replacement. `src/hooks/daemon-download.ts` prefers whichever binary is
 * already on disk, then this npm package, then the release; the npm path is
 * the only one that works with no network at `failproofai config` time.
 *
 * Two rules make this safe, and both come from the way the first attempt at
 * npm-shipping the daemon failed (CHANGELOG 1.0.0-beta.3 — four
 * `optionalDependencies` were declared and never published, so every install
 * resolved four 404s):
 *
 *   1. These packages publish BEFORE the root package that pins them, so the
 *      names always exist by the time anything depends on them.
 *   2. A publish failure here is fatal, not a warning (unlike the alias stubs
 *      in publish-aliases.mjs, where a missing name costs nothing). Failing
 *      the job leaves the registry untouched; publishing a root package whose
 *      optional dependency 404s would ship the broken state to every user.
 *
 * Usage:
 *   node scripts/build-daemon-packages.mjs --artifacts <dir> [--dist-tag <tag>]
 *                                          [--version <v>] [--pin-root] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DAEMON_PLATFORMS,
  daemonAssetName,
  daemonOptionalDependencies,
  daemonPackageName,
} from "./daemon-platforms.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the generated packages are staged — **outside the repo**, and that is
 * load-bearing rather than tidy.
 *
 * `npm publish` re-runs `prepare`, so the Next build happens again *after*
 * this script has run, and Next's file tracing pulls the whole project root
 * into `.next/standalone` (see the "over-traced project artifacts" prune list
 * in scripts/prune-standalone.mjs). Anything staged inside the checkout
 * therefore ends up inside the published CLI tarball — measured: a dry run
 * shipped 16 MB of daemon `.gz` assets under
 * `.next/standalone/release-assets/`. Staging in the temp dir cannot be swept
 * up by a build. `--staging` overrides it for tests.
 */
export const STAGING_DIR = resolve(tmpdir(), "failproofaid-packages");

/**
 * The manifest for one platform package.
 *
 * Deliberately carries no `bin` (it would shadow the root package's own
 * `failproofaid` shim, which is what a user invoking the daemon by hand
 * should reach) and no `exports` (so `require.resolve("<pkg>/package.json")`
 * — how the CLI finds this package — keeps working).
 */
export function platformPackageManifest(platform, version, rootPkg = {}) {
  return {
    name: daemonPackageName(platform.key),
    version,
    description: `The failproofaid background daemon binary for ${platform.os} ${platform.cpu}. Installed automatically as an optional dependency of failproofai.`,
    // npm's own platform filters: with both set, only the matching package is
    // installed and the other three are skipped without a warning.
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["bin/"],
    publishConfig: { access: "public" },
    repository: rootPkg.repository,
    homepage: rootPkg.homepage,
    bugs: rootPkg.bugs,
    license: rootPkg.license,
  };
}

/**
 * Stages one platform package on disk and returns its directory.
 *
 * The binary is written decompressed and mode 0755: npm records the executable
 * bit in the tarball, so it survives publish → install, which is how esbuild
 * and swc ship their binaries.
 */
export function stagePlatformPackage(platform, version, rootPkg, artifactsDir, stagingRoot = STAGING_DIR) {
  const asset = resolve(artifactsDir, daemonAssetName(platform.key));
  if (!existsSync(asset)) {
    throw new Error(`missing artifact ${asset} — the daemon build did not produce ${daemonAssetName(platform.key)}`);
  }

  const dir = join(stagingRoot, `failproofaid-${platform.key}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  const binary = gunzipSync(readFileSync(asset));
  const binaryPath = join(dir, "bin", "failproofaid");
  writeFileSync(binaryPath, binary);
  chmodSync(binaryPath, 0o755);

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(platformPackageManifest(platform, version, rootPkg), null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${daemonPackageName(platform.key)}\n\n` +
      `The \`failproofaid\` background daemon binary for ${platform.os} ${platform.cpu}.\n\n` +
      `Installed automatically as an optional dependency of [failproofai](https://www.npmjs.com/package/failproofai) — ` +
      `you do not need to install it yourself.\n`,
  );

  return dir;
}

/**
 * The SHA-256 of the binary inside a staged platform package.
 *
 * Read back off disk rather than returned from `stagePlatformPackage` so that
 * function's contract stays a plain directory path, and so the digest describes
 * the bytes that will actually be packed — not an in-memory buffer that was
 * supposed to become them.
 */
export function stagedBinaryDigest(dir) {
  return createHash("sha256")
    .update(readFileSync(join(dir, "bin", "failproofaid")))
    .digest("hex");
}

/**
 * Writes the four platform packages into the root manifest's
 * `optionalDependencies`, pinned to `version`.
 *
 * Called at publish time rather than committed: a pin to a version that does
 * not exist yet breaks `bun install --frozen-lockfile` in this repo's own CI,
 * and keeping four pins in step with every version bump by hand is the drift
 * this whole file exists to avoid.
 *
 * @param {string} version
 * @param {string} [packageJsonPath]
 * @param {Record<string, string> | null} [digests] platform key → SHA-256 of
 *   that platform's staged binary. Omitted leaves the key ABSENT, which
 *   `expectedNpmBinaryDigest` reads as "nothing to compare against".
 */
export function pinRootManifest(version, packageJsonPath = resolve(REPO_ROOT, "package.json"), digests = null) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  pkg.optionalDependencies = { ...pkg.optionalDependencies, ...daemonOptionalDependencies(version) };
  // The SHA-256 of each binary as it was staged, recorded in the ROOT manifest
  // so `installFromNpmPackage` has something to check the file it copies
  // against. The download channel has verified against `SHA256SUMS` since it
  // existed; the npm channel had no integrity step of any kind, and it installs
  // its result as a root-owned, boot-persistent system service.
  //
  // Written here rather than into each platform package because a digest
  // shipped alongside the bytes it describes verifies nothing. This one travels
  // in a different package, published separately, and `bun build` INLINES it
  // into dist/cli.mjs — so it is not merely a second file in the same tree.
  if (digests) pkg.failproofaidBinaries = digests;
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
  return pkg.optionalDependencies;
}

function parseArgs(argv) {
  const valueOf = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    artifacts: valueOf("--artifacts", "release-assets"),
    staging: valueOf("--staging", STAGING_DIR),
    distTag: valueOf("--dist-tag", null),
    version: valueOf("--version", null),
    pinRoot: argv.includes("--pin-root"),
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * `npm publish`, with provenance when the registry will take it.
 *
 * Provenance needs a supported CI and a repository field npm can match to the
 * building workflow; when it refuses, the publish itself is still correct, so
 * this retries once without the flag rather than failing the release.
 */
function publishPackage(dir, distTag, dryRun) {
  const args = ["publish", "--tag", distTag];
  if (dryRun) args.push("--dry-run");

  const attempt = (extra) =>
    execFileSync("npm", [...args, ...extra], { cwd: dir, stdio: "pipe", encoding: "utf8" });

  const withProvenance = !dryRun && process.env.GITHUB_ACTIONS === "true";
  try {
    return attempt(withProvenance ? ["--provenance"] : []);
  } catch (err) {
    const output = (err.stdout ?? "") + (err.stderr ?? "");
    if (output.includes("cannot publish over")) return "[skip] already published at this version";
    if (withProvenance && /provenance/i.test(output)) {
      console.log("::warning::provenance was rejected — retrying the publish without it");
      return attempt([]);
    }
    // Fatal on purpose: see the header. The root package pins these names, so
    // a half-published set must stop the release rather than ship 404s.
    throw new Error(`npm publish failed for ${dir}:\n${output.trim()}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const version = options.version ?? rootPkg.version;
  const distTag = options.distTag ?? (version.includes("-") ? "beta" : "latest");
  const artifactsDir = resolve(process.cwd(), options.artifacts);

  console.log(
    `Publishing ${DAEMON_PLATFORMS.length} failproofaid platform packages at ${version} ` +
      `(tag: ${distTag}${options.dryRun ? ", dry run" : ""}) from ${artifactsDir}`,
  );

  const digests = {};
  for (const platform of DAEMON_PLATFORMS) {
    const dir = stagePlatformPackage(platform, version, rootPkg, artifactsDir, options.staging);
    const sha256 = stagedBinaryDigest(dir);
    digests[platform.key] = sha256;
    const name = daemonPackageName(platform.key);
    console.log(`\n${name}@${version}  sha256:${sha256}`);
    console.log(publishPackage(dir, distTag, options.dryRun).trim());
  }

  if (options.pinRoot) {
    const pins = pinRootManifest(version, resolve(REPO_ROOT, "package.json"), digests);
    console.log("\nPinned in the root manifest's optionalDependencies:");
    console.log(JSON.stringify(pins, null, 2));
    console.log("\nRecorded binary digests (failproofaidBinaries):");
    console.log(JSON.stringify(digests, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
