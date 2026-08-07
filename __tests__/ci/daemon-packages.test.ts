// @vitest-environment node
/**
 * The npm side of the daemon's packaging.
 *
 * These four packages are the one thing in the release that cannot be
 * partially correct: the root package pins them as `optionalDependencies`, so
 * a name that is wrong, unpublished, or filtered onto the wrong machine is a
 * 404 or a missing daemon in every install. That already happened once — the
 * pins shipped before anything published them (CHANGELOG 1.0.0-beta.3) — so
 * the manifest shape, the platform filters and the pins are asserted here
 * rather than discovered on the registry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  DAEMON_PLATFORMS,
  daemonAssetName,
  daemonOptionalDependencies,
  daemonPackageName,
} from "../../scripts/daemon-platforms.mjs";
import {
  STAGING_DIR,
  pinRootManifest,
  platformPackageManifest,
  stagePlatformPackage,
  stagedBinaryDigest,
} from "../../scripts/build-daemon-packages.mjs";
import { aliasManifest, ALIASES } from "../../scripts/publish-aliases.mjs";

const VERSION = "9.9.9-beta.1";
const ROOT_PKG = {
  repository: { type: "git", url: "git+https://github.com/FailproofAI/failproofai.git" },
  homepage: "https://failproof.ai",
  bugs: { url: "https://github.com/FailproofAI/failproofai/issues" },
  license: "MIT",
};

describe("scripts/daemon-platforms", () => {
  it("covers exactly the four cross-compiled platforms", () => {
    expect(DAEMON_PLATFORMS.map((p) => p.key).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
  });

  it("names packages and release assets from the same key", () => {
    expect(daemonPackageName("linux-x64")).toBe("@failproofai/failproofaid-linux-x64");
    expect(daemonAssetName("linux-x64")).toBe("failproofaid-linux-x64.gz");
  });

  it("pins every platform at one version", () => {
    const deps = daemonOptionalDependencies(VERSION);
    expect(Object.keys(deps)).toHaveLength(4);
    expect(new Set(Object.values(deps))).toEqual(new Set([VERSION]));
    expect(deps["@failproofai/failproofaid-darwin-arm64"]).toBe(VERSION);
  });
});

describe("platformPackageManifest", () => {
  it("sets the os/cpu filters npm uses to install exactly one of the four", () => {
    for (const platform of DAEMON_PLATFORMS) {
      const manifest = platformPackageManifest(platform, VERSION, ROOT_PKG);
      expect(manifest.os).toEqual([platform.os]);
      expect(manifest.cpu).toEqual([platform.cpu]);
      expect(manifest.name).toBe(daemonPackageName(platform.key));
      expect(manifest.version).toBe(VERSION);
      expect(manifest.files).toEqual(["bin/"]);
      expect(manifest.publishConfig).toEqual({ access: "public" });
      expect(manifest.license).toBe("MIT");
    }
  });

  it("declares no bin — it must not shadow the root package's failproofaid shim", () => {
    const manifest = platformPackageManifest(DAEMON_PLATFORMS[0], VERSION, ROOT_PKG);
    expect(manifest).not.toHaveProperty("bin");
  });

  it("declares no exports — the CLI resolves <pkg>/package.json to find the binary", () => {
    const manifest = platformPackageManifest(DAEMON_PLATFORMS[0], VERSION, ROOT_PKG);
    expect(manifest).not.toHaveProperty("exports");
  });
});

describe("stagePlatformPackage", () => {
  let staging: string;
  let artifacts: string;

  beforeEach(() => {
    staging = mkdtempSync(resolve(tmpdir(), "fpai-staging-"));
    artifacts = mkdtempSync(resolve(tmpdir(), "fpai-artifacts-"));
  });

  afterEach(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("decompresses the release asset into an executable bin/failproofaid", () => {
    const binary = Buffer.from("#!/bin/sh\necho failproofaid\n");
    for (const platform of DAEMON_PLATFORMS) {
      writeFileSync(resolve(artifacts, daemonAssetName(platform.key)), gzipSync(binary));
    }

    for (const platform of DAEMON_PLATFORMS) {
      const dir = stagePlatformPackage(platform, VERSION, ROOT_PKG, artifacts, staging);
      const binaryPath = resolve(dir, "bin", "failproofaid");
      expect(readFileSync(binaryPath)).toEqual(binary);
      // npm records the executable bit in the tarball; without it the service
      // manager gets a file it cannot exec.
      expect(statSync(binaryPath).mode & 0o111).not.toBe(0);
      expect(JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).name).toBe(
        daemonPackageName(platform.key),
      );
      expect(existsSync(resolve(dir, "README.md"))).toBe(true);
    }
  });

  it("digests the bytes that were actually staged", () => {
    // The digest the root manifest records, and the one installFromNpmPackage
    // checks against, must describe the file that ships — not the artifact it
    // was decompressed from. Read back off disk for exactly that reason.
    const binary = Buffer.from("#!/bin/sh\necho failproofaid\n");
    for (const platform of DAEMON_PLATFORMS) {
      writeFileSync(resolve(artifacts, daemonAssetName(platform.key)), gzipSync(binary));
    }
    const dir = stagePlatformPackage(DAEMON_PLATFORMS[0], VERSION, ROOT_PKG, artifacts, staging);

    expect(stagedBinaryDigest(dir)).toBe(createHash("sha256").update(binary).digest("hex"));
  });

  it("fails loudly when the daemon build did not produce an artifact", () => {
    expect(() => stagePlatformPackage(DAEMON_PLATFORMS[0], VERSION, ROOT_PKG, artifacts, staging)).toThrow(
      /missing artifact/,
    );
  });

  it("stages outside the repo, where a rebuild cannot sweep it into the tarball", () => {
    // `npm publish` re-runs `prepare`, and Next's file tracing pulls the whole
    // project root into `.next/standalone` — staging inside the checkout put
    // 16 MB of daemon .gz assets inside the published CLI tarball once.
    const repoRoot = resolve(__dirname, "..", "..");
    expect(STAGING_DIR.startsWith(repoRoot)).toBe(false);
  });
});

describe("pinRootManifest", () => {
  let dir: string;
  let manifestPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fpai-pin-"));
    manifestPath = resolve(dir, "package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: "failproofai", version: VERSION, dependencies: { yaml: "2.0.0" } }, null, 2),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the four pins without disturbing the rest of the manifest", () => {
    const pins = pinRootManifest(VERSION, manifestPath);
    const written = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(pins).toEqual(daemonOptionalDependencies(VERSION));
    expect(written.optionalDependencies).toEqual(daemonOptionalDependencies(VERSION));
    expect(written.dependencies).toEqual({ yaml: "2.0.0" });
    expect(written.version).toBe(VERSION);
  });

  it("records the binary digests, in the ROOT manifest", () => {
    // Deliberately not in each platform package: a digest shipped alongside the
    // bytes it describes verifies nothing. This one travels in a different
    // package, published separately, and `bun build` inlines it into
    // dist/cli.mjs — so it is not merely a second file the same writer edits.
    const digests = { "linux-x64": "a".repeat(64), "darwin-arm64": "b".repeat(64) };
    pinRootManifest(VERSION, manifestPath, digests);

    const written = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(written.failproofaidBinaries).toEqual(digests);
    // Still does its original job.
    expect(written.optionalDependencies).toEqual(daemonOptionalDependencies(VERSION));
  });

  it("omits the digests entirely rather than writing an empty map", () => {
    // A publish that recorded nothing must leave the key ABSENT, because
    // `expectedNpmBinaryDigest` reads absence as "nothing to compare against".
    // An empty object would mean the same thing today and is easy to mistake
    // for "verified" later.
    pinRootManifest(VERSION, manifestPath);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).failproofaidBinaries).toBeUndefined();
  });

  it("pins at the version being published, not whatever the manifest carries", () => {
    // A release from a tag publishes a version the committed manifest does not
    // have yet; a pin to the old one would resolve a package that was never
    // published for it. (Always pass the path explicitly — the default is the
    // real repo manifest.)
    const pins = pinRootManifest("1.2.3", manifestPath);
    expect(new Set(Object.values(pins))).toEqual(new Set(["1.2.3"]));
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe(VERSION);
  });
});

describe("alias stubs", () => {
  it("pins the same four platform packages every typo'd name would need", () => {
    const manifest = aliasManifest("failproof-ai", VERSION, ROOT_PKG);
    expect(manifest.dependencies).toEqual({ failproofai: VERSION });
    expect(manifest.optionalDependencies).toEqual(daemonOptionalDependencies(VERSION));
  });

  it("still proxies to the real CLI from every alias", () => {
    for (const name of ALIASES) {
      const manifest = aliasManifest(name, VERSION, ROOT_PKG);
      expect(manifest.name).toBe(name);
      expect(manifest.bin).toEqual({ [name]: "./bin/proxy.js" });
      expect(manifest.optionalDependencies).toEqual(daemonOptionalDependencies(VERSION));
    }
    expect(ALIASES.length).toBeGreaterThan(10);
  });
});
