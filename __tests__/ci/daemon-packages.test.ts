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
import { gzipSync } from "node:zlib";
import {
  DAEMON_PLATFORMS,
  daemonAssetName,
  daemonOptionalDependencies,
  daemonPackageName,
} from "../../scripts/daemon-platforms.mjs";
import {
  pinRootManifest,
  platformPackageManifest,
  stagePlatformPackage,
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

  it("fails loudly when the daemon build did not produce an artifact", () => {
    expect(() => stagePlatformPackage(DAEMON_PLATFORMS[0], VERSION, ROOT_PKG, artifacts, staging)).toThrow(
      /missing artifact/,
    );
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
