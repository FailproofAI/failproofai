/**
 * Gets the compiled `failproofaid` binary for this platform onto disk, from
 * whichever of its two channels can supply it.
 *
 * **npm first.** The four binaries publish as
 * `@failproofai/failproofaid-<os>-<arch>` platform packages, pinned as
 * `optionalDependencies` of this package, so `npm install failproofai` has
 * usually already brought down the one matching this machine — `os`/`cpu`
 * make npm skip the other three. Copying that file costs no network at all,
 * which is the only thing that works behind a proxy or air-gapped.
 *
 * **The GitHub Release second.** `failproofaid-<os>-<arch>.gz` plus a
 * `SHA256SUMS` manifest are attached to the release tagged with this CLI's own
 * version. That channel has to exist regardless — it is how anyone installs
 * the daemon standalone, and how an install that skipped optional dependencies
 * still gets one.
 *
 * The pair failed once before in a way worth keeping in mind: the platform
 * packages were declared as `optionalDependencies` and never published, so
 * every install resolved four 404s (see CHANGELOG 1.0.0-beta.3). What makes
 * them safe now is that `scripts/build-daemon-packages.mjs` publishes them
 * *before* the root package that pins them, and fails the release if it
 * cannot — the names always exist by the time anything depends on them.
 *
 * The download URL is *constructed*, never discovered — no API call, no
 * `releases/latest` redirect, no rate limit, and no chance of fetching a daemon
 * built from different source than the CLI talking to it: the tag is this
 * package's own version, so a CLI upgrade fetches its own matching binary.
 *
 * Everything here fails closed and never throws. A daemon that cannot be
 * fetched leaves the machine on the in-process path it was already using;
 * a daemon fetched over a corrupted connection is refused outright, because
 * this writes an executable that a service manager will then run at login.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { version } from "../../package.json";
// A DEFAULT import, never a named one. `failproofaidBinaries` is written into
// the manifest at publish time (see `pinRootManifest`), so it is absent from
// every dev build and every unpublished commit — and a named import of a
// missing export throws at MODULE LOAD, before any code can guard it. On this
// module that is not a broken feature: `handler.ts` pulls it in on the hook
// path, so the throw denies every tool call on the machine. Learned the hard
// way; the runtime lookup below is the only safe shape.
import rootManifest from "../../package.json";
import type { PlatformKey } from "./daemon-service";
import { binDir as layoutBinDir } from "./fp-home";

/**
 * Where release assets live. Overridable so an air-gapped or proxied site can
 * mirror the four binaries internally — and so tests can serve them from a
 * local HTTP server without touching the network.
 */
const DEFAULT_BASE_URL = "https://github.com/FailproofAI/failproofai/releases/download";

/**
 * One bound for the whole fetch. Long enough for a ~2 MB asset on a slow
 * connection, short enough that a black-holed proxy doesn't turn the config
 * wizard into a hang — the failure mode this replaces is a user staring at a
 * spinner with no output.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

function baseUrl(): string {
  return (process.env.FAILPROOFAI_DAEMON_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Where downloaded binaries live. One directory, one file per version. */
export function daemonBinaryDir(): string {
  return layoutBinDir();
}

/**
 * The path this CLI's own daemon binary occupies.
 *
 * Versioned on purpose. An in-place overwrite would hit `ETXTBSY` against the
 * running daemon on Linux, and would silently repoint a service unit at a
 * binary built from different source; a per-version filename makes an upgrade
 * a new file plus a rewritten unit, and leaves the old one recoverable.
 */
export function installedBinaryPath(ver: string = version): string {
  return resolve(daemonBinaryDir(), `failproofaid-${ver}`);
}

/** The release asset URL for a platform — constructed, never discovered. */
export function daemonAssetUrl(key: PlatformKey, ver: string = version): string {
  return `${baseUrl()}/v${ver}/failproofaid-${key}.gz`;
}

/** The checksum manifest published alongside the four binaries. */
export function checksumsUrl(ver: string = version): string {
  return `${baseUrl()}/v${ver}/SHA256SUMS`;
}

export interface DaemonDownloadResult {
  /** Absolute path to the installed, executable binary. */
  path?: string;
  /** Local diagnostic — never sent off the machine verbatim. */
  error?: string;
}

/** The npm package carrying the daemon binary for one platform. */
export function platformPackageName(key: PlatformKey): string {
  return `@failproofai/failproofaid-${key}`;
}

/**
 * Locates the binary inside the installed platform package, or null.
 *
 * Resolution is anchored at `FAILPROOFAI_PACKAGE_ROOT` (set by
 * `bin/failproofai.mjs` and the bundled `dist/cli.mjs`) rather than at
 * `import.meta.url`, which does not survive the CJS bundle. Node's algorithm
 * walks up from there, which covers both real layouts: a global install nests
 * its dependencies at `<root>/node_modules/@failproofai/…`, a local one hoists
 * them to `<project>/node_modules/@failproofai/…`.
 *
 * The specifier is *computed*, deliberately. A literal would make the bundler
 * try to resolve a package that is optional, platform-specific, and absent on
 * three machines out of four at build time.
 */
export function npmPlatformBinaryPath(key: PlatformKey): string | null {
  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (!packageRoot) return null;
  const name = platformPackageName(key);

  try {
    const requireFromRoot = createRequire(resolve(packageRoot, "package.json"));
    const found = platformPackageBinary(dirname(requireFromRoot.resolve(`${name}/package.json`)));
    if (found) return found;
  } catch {
    // Not installed (the common case on a machine that skipped optional
    // dependencies), or a resolver that cannot see it. The direct check below
    // is the fallback, not a failure.
  }

  return platformPackageBinary(resolve(packageRoot, "node_modules", name));
}

/**
 * The binary inside one candidate platform-package directory, if it is the
 * right one.
 *
 * The version check is not belt-and-braces. npm pins the exact version, but a
 * workspace holding two `failproofai` versions can hoist the other one's
 * platform package to the top of the tree — and installing that binary under
 * *this* version's filename would put a daemon built from different source
 * behind a CLI that believes it matches, which is the single thing the
 * versioned install path exists to prevent. A mismatch falls through to the
 * download, whose URL is pinned to this version.
 */
function platformPackageBinary(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    if (manifest.version !== version) return null;
  } catch {
    return null;
  }
  const candidate = resolve(dir, "bin", "failproofaid");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Writes the daemon binary to its versioned path.
 *
 * Shared by both channels so a binary lands identically however it arrived:
 * staged in the same directory as the target (so the install is an atomic
 * rename within one filesystem, never a half-written executable a service
 * manager could pick up), mode 0755, pid-suffixed so two concurrent wizards
 * stay off each other's file.
 */
/**
 * Delete daemon binaries older than the current and previous versions.
 *
 * Called AFTER the new binary is in place and the unit repointed, never
 * before: a binary a running service points at must not be removed out from
 * under it. One previous version is kept deliberately — a rollback is then a
 * local file rather than a re-download, which is the difference between
 * working and not on a machine that is offline or behind a proxy.
 *
 * Sorted by mtime rather than by parsing versions out of filenames: a
 * prerelease ordering (`1.0.0-beta.10` vs `1.0.0-beta.9`) is easy to get
 * subtly wrong, and "which did we install most recently" is the question that
 * actually matters here.
 */
export function pruneOldDaemonBinaries(keep = 2): string[] {
  const removed: string[] = [];
  try {
    const dir = daemonBinaryDir();
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith("failproofaid-") && !f.endsWith(".tmp"))
      .map((f) => {
        const full = resolve(dir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of entries.slice(keep)) {
      try {
        rmSync(stale.full, { force: true });
        removed.push(stale.full);
      } catch {
        // In use, or not ours to delete. Leaving it costs disk; removing it by
        // force could break a running service.
      }
    }
  } catch {
    // No directory yet, or unreadable — nothing to prune.
  }
  return removed;
}

function installBinaryBytes(binary: Buffer): string {
  const target = installedBinaryPath();
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(daemonBinaryDir(), { recursive: true });
    writeFileSync(tempPath, binary);
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, target);
    return target;
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

/**
 * The SHA-256 the publish recorded for each platform's binary, or null when
 * this build has none.
 *
 * `scripts/build-daemon-packages.mjs` writes these into the ROOT manifest at
 * publish time — the same step that pins the four `optionalDependencies` — so
 * they are absent from a local dev build and from any tree built off an
 * unpublished commit. Absent means "nothing to compare against", never "the
 * comparison passed".
 */
export function expectedNpmBinaryDigest(key: PlatformKey): string | null {
  const map = (rootManifest as Record<string, unknown>).failproofaidBinaries as
    | Record<string, string>
    | undefined;
  const digest = map?.[key];
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * Installs the daemon from the npm platform package, if one is present.
 *
 * Verified against the digest the publish recorded, when this build carries
 * one. It used to do no integrity check at all on the grounds that "npm
 * verified the tarball when it installed it" — true, and about a different
 * moment. npm checks the tarball at EXTRACTION; this reads a loose file out of
 * a shared, writable `node_modules` some time later, and installs the result as
 * a root-owned, boot-persistent system service. Anything that touched the file
 * in between — another package's postinstall, a partial write, a half-upgraded
 * tree — went in unexamined, while the sibling download channel had verified
 * against `SHA256SUMS` since it existed.
 *
 * What this is worth, stated plainly: the digest travels in a DIFFERENT package
 * from the bytes it describes, and `bun build` inlines it into `dist/cli.mjs`,
 * so it is not simply a second file the same writer could edit. It is still not
 * proof against an attacker already executing code in this tree — such an
 * attacker can write `~/.failproofai/bin` directly and skip all of this. It
 * closes accidental corruption and the non-adaptive overwrite, and it makes the
 * two install channels make the same promise.
 *
 * Deliberately NOT gated on `FAILPROOFAI_NO_DOWNLOAD` — that variable exists
 * so an air-gapped machine does not reach out, and this is a local copy. On
 * exactly those machines it is the only channel that can work.
 */
export function installFromNpmPackage(key: PlatformKey): DaemonDownloadResult {
  const source = npmPlatformBinaryPath(key);
  if (!source) return { error: `${platformPackageName(key)} is not installed` };
  try {
    const bytes = readFileSync(source);
    const mismatch = binaryDigestMismatch(expectedNpmBinaryDigest(key), bytes, source);
    // An error, never a silent fall-through to installing it anyway. The
    // caller's next channel is the release download, which is pinned to this
    // version and verifies its own digest — so a machine whose package is
    // tampered or corrupt still has a correct route to a good binary.
    if (mismatch) return { error: mismatch };
    return { path: installBinaryBytes(bytes) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `failed to install failproofaid from ${source}: ${message}` };
  }
}

/**
 * Why `bytes` may not be installed, or null if it may.
 *
 * Split out from `installFromNpmPackage` so the comparison is testable without
 * mocking `package.json` — the digest map is inlined at build time, so a test
 * cannot otherwise reach the branch that matters.
 *
 * A null `expected` is "this build recorded no digest", which is every dev
 * build and every unpublished commit, and means there is nothing to compare
 * against — never that the comparison passed.
 */
export function binaryDigestMismatch(
  expected: string | null,
  bytes: Buffer,
  source: string,
): string | null {
  if (!expected) return null;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual === expected) return null;
  return (
    `refusing to install failproofaid from ${source}: its SHA-256 is ${actual}, ` +
    `but this build of failproofai expects ${expected}`
  );
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Parses a `sha256sum`-format manifest and returns the digest for one asset.
 *
 * A missing line is an error rather than a skipped check: the manifest is the
 * only thing standing between a truncated or substituted download and an
 * executable this process is about to install as a login service.
 */
export function digestFor(manifest: string, assetName: string): string | null {
  for (const line of manifest.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Downloads, verifies and installs the daemon binary for `key`.
 *
 * Idempotent: an already-installed binary for this version is returned as-is,
 * so re-running the wizard costs nothing.
 */
export async function downloadFailproofaidBinary(key: PlatformKey): Promise<DaemonDownloadResult> {
  const target = installedBinaryPath();
  if (existsSync(target)) return { path: target };

  if (process.env.FAILPROOFAI_NO_DOWNLOAD) {
    return { error: "daemon downloads are disabled (FAILPROOFAI_NO_DOWNLOAD)" };
  }

  const assetName = `failproofaid-${key}.gz`;

  try {
    const [asset, manifest] = await Promise.all([
      fetchBytes(daemonAssetUrl(key)),
      fetchBytes(checksumsUrl()).then((b) => b.toString("utf8")),
    ]);

    const expected = digestFor(manifest, assetName);
    if (!expected) {
      return { error: `SHA256SUMS for v${version} has no entry for ${assetName}` };
    }
    const actual = createHash("sha256").update(asset).digest("hex");
    if (actual !== expected) {
      return { error: `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})` };
    }

    return { path: installBinaryBytes(gunzipSync(asset)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `failed to download failproofaid v${version} for ${key}: ${message}` };
  }
}
