/**
 * The platforms `failproofaid` is cross-compiled for, and the npm packages
 * those binaries publish under.
 *
 * One list, three consumers: `build-daemon-packages.mjs` (publishes them),
 * `publish-aliases.mjs` (pins them in every typo-squat stub), and the root
 * package's injected `optionalDependencies`. They have to agree exactly — a
 * name that appears in a dependency but never gets published is a 404 in
 * every install, which is precisely how the first attempt at npm-shipping the
 * daemon failed (see CHANGELOG 1.0.0-beta.3).
 *
 * `os` / `cpu` are npm's own filters, spelled in `process.platform` /
 * `process.arch` values: with both set, npm and bun install only the package
 * matching the machine and silently skip the other three.
 */

export const DAEMON_PLATFORMS = [
  { key: "linux-x64", os: "linux", cpu: "x64" },
  { key: "linux-arm64", os: "linux", cpu: "arm64" },
  { key: "darwin-x64", os: "darwin", cpu: "x64" },
  { key: "darwin-arm64", os: "darwin", cpu: "arm64" },
];

/** The npm package name carrying the binary for one platform key. */
export function daemonPackageName(key) {
  return `@failproofai/failproofaid-${key}`;
}

/** The release asset the binary for one platform key arrives in. */
export function daemonAssetName(key) {
  return `failproofaid-${key}.gz`;
}

/**
 * The `optionalDependencies` block that pins all four platform packages to one
 * version — what the root package and every alias stub carry when published.
 */
export function daemonOptionalDependencies(version) {
  return Object.fromEntries(
    DAEMON_PLATFORMS.map((platform) => [daemonPackageName(platform.key), version]),
  );
}
