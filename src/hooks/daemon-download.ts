/**
 * Fetches the compiled `failproofaid` binary for this platform from the
 * GitHub Release that matches this CLI's own version.
 *
 * Why a download rather than a dependency: the daemon is a 4-way
 * cross-compiled Rust binary, and shipping it through npm means four
 * per-platform packages that every install resolves, an npm org to own the
 * scope, and a second publish channel that can silently drift from the first
 * (it already did — the platform packages were declared as
 * `optionalDependencies` and never published, so every install of them 404'd).
 * The release assets have to exist for standalone installs regardless, so
 * pointing the CLI at the same artifacts leaves exactly one channel.
 *
 * The URL is *constructed*, never discovered — no API call, no `releases/latest`
 * redirect, no rate limit, and no chance of fetching a daemon built from
 * different source than the CLI talking to it: the tag is this package's own
 * version, so a CLI upgrade downloads its own matching binary.
 *
 * Everything here fails closed and never throws. A daemon that cannot be
 * fetched leaves the machine on the in-process path it was already using;
 * a daemon fetched over a corrupted connection is refused outright, because
 * this writes an executable that a service manager will then run at login.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { version } from "../../package.json";
import type { PlatformKey } from "./daemon-service";

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
  return resolve(homedir(), ".failproofai", "bin");
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
  // Same directory as the target so the install is a rename within one
  // filesystem — atomic, and never a half-written binary a service manager
  // could pick up. The pid keeps two concurrent wizards off each other's file.
  const tempPath = `${target}.${process.pid}.tmp`;

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

    const binary = gunzipSync(asset);
    mkdirSync(daemonBinaryDir(), { recursive: true });
    writeFileSync(tempPath, binary);
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, target);
    return { path: target };
  } catch (err) {
    rmSync(tempPath, { force: true });
    const message = err instanceof Error ? err.message : String(err);
    return { error: `failed to download failproofaid v${version} for ${key}: ${message}` };
  }
}
