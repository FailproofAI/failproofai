// @vitest-environment node
/**
 * The daemon binary reaches users through two channels — the
 * `@failproofai/failproofaid-<os>-<arch>` npm package that `npm install`
 * already brought down, and the GitHub Release for this CLI's own version —
 * so this file covers both end to end: the download against a real local HTTP
 * server rather than a mocked `fetch` (URL construction, checksum
 * verification, decompression, atomic install), and the npm path against a
 * real staged `node_modules` tree. What both are guarding is an executable
 * that a service manager will run at login, so every rejection path asserts
 * that nothing was left on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { version } from "../../package.json";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogWarn: vi.fn(),
  hookLogInfo: vi.fn(),
}));

const BINARY = Buffer.from("#!/bin/sh\necho failproofaid " + version + "\n");
const GZIPPED = gzipSync(BINARY);
const DIGEST = createHash("sha256").update(GZIPPED).digest("hex");

/** Serves the four assets + SHA256SUMS the release job publishes. */
function startServer(options: { manifest?: string; assetStatus?: number } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  server: Server;
}> {
  const manifest = options.manifest ?? `${DIGEST}  failproofaid-linux-x64.gz\n`;
  const server = createServer((req, res) => {
    if (req.url === `/v${version}/SHA256SUMS`) {
      res.writeHead(200).end(manifest);
    } else if (req.url === `/v${version}/failproofaid-linux-x64.gz`) {
      if (options.assetStatus && options.assetStatus !== 200) {
        res.writeHead(options.assetStatus).end("nope");
      } else {
        res.writeHead(200).end(GZIPPED);
      }
    } else {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>((closed) => server.close(() => closed())),
      });
    });
  });
}

describe("hooks/daemon-download", () => {
  const originalHome = process.env.HOME;
  const originalBase = process.env.FAILPROOFAI_DAEMON_BASE_URL;
  const originalNoDownload = process.env.FAILPROOFAI_NO_DOWNLOAD;
  let home: string;

  beforeEach(() => {
    vi.resetModules();
    // Never touch the real ~/.failproofai — these tests install executables.
    home = mkdtempSync(resolve(tmpdir(), "fpai-daemon-download-"));
    process.env.HOME = home;
    delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalBase !== undefined) process.env.FAILPROOFAI_DAEMON_BASE_URL = originalBase;
    else delete process.env.FAILPROOFAI_DAEMON_BASE_URL;
    if (originalNoDownload !== undefined) process.env.FAILPROOFAI_NO_DOWNLOAD = originalNoDownload;
    else delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  });

  describe("URL construction", () => {
    it("pins the asset URL to this package's own version", async () => {
      delete process.env.FAILPROOFAI_DAEMON_BASE_URL;
      const { daemonAssetUrl, checksumsUrl } = await import("../../src/hooks/daemon-download");
      expect(daemonAssetUrl("linux-x64")).toBe(
        `https://github.com/FailproofAI/failproofai/releases/download/v${version}/failproofaid-linux-x64.gz`,
      );
      expect(checksumsUrl()).toContain(`/v${version}/SHA256SUMS`);
    });

    it("names a distinct asset for every supported platform", async () => {
      const { daemonAssetUrl } = await import("../../src/hooks/daemon-download");
      const urls = (["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const).map((k) =>
        daemonAssetUrl(k),
      );
      expect(new Set(urls).size).toBe(4);
    });

    it("honours a mirror base URL and tolerates a trailing slash", async () => {
      process.env.FAILPROOFAI_DAEMON_BASE_URL = "https://mirror.internal/failproofai/";
      const { daemonAssetUrl } = await import("../../src/hooks/daemon-download");
      expect(daemonAssetUrl("darwin-arm64")).toBe(
        `https://mirror.internal/failproofai/v${version}/failproofaid-darwin-arm64.gz`,
      );
    });

    it("versions the installed path so an upgrade never overwrites a running daemon", async () => {
      const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
      expect(installedBinaryPath()).toBe(resolve(home, ".failproofai", "bin", `failproofaid-${version}`));
      expect(installedBinaryPath("9.9.9")).toContain("failproofaid-9.9.9");
    });
  });

  describe("digestFor", () => {
    it("reads a sha256sum manifest, including the binary-mode marker", async () => {
      const { digestFor } = await import("../../src/hooks/daemon-download");
      const manifest = [
        `${"a".repeat(64)}  failproofaid-linux-x64.gz`,
        `${"b".repeat(64)} *failproofaid-darwin-arm64.gz`,
      ].join("\n");
      expect(digestFor(manifest, "failproofaid-linux-x64.gz")).toBe("a".repeat(64));
      expect(digestFor(manifest, "failproofaid-darwin-arm64.gz")).toBe("b".repeat(64));
    });

    it("returns null for an asset the manifest does not cover", async () => {
      const { digestFor } = await import("../../src/hooks/daemon-download");
      expect(digestFor(`${"a".repeat(64)}  other.gz`, "failproofaid-linux-x64.gz")).toBeNull();
    });
  });

  describe("downloadFailproofaidBinary", () => {
    it("downloads, verifies, decompresses and installs the binary as executable", async () => {
      const server = await startServer();
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { downloadFailproofaidBinary, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await downloadFailproofaidBinary("linux-x64");

        expect(result.error).toBeUndefined();
        expect(result.path).toBe(installedBinaryPath());
        expect(readFileSync(result.path!)).toEqual(BINARY);
        // 0o755: the service manager execs this path directly.
        expect(statSync(result.path!).mode & 0o777).toBe(0o755);
        // The install is a rename, so no temp file survives it.
        expect(readdirSync(resolve(home, ".failproofai", "bin"))).toEqual([`failproofaid-${version}`]);
      } finally {
        await server.close();
      }
    });

    it("is idempotent — an installed binary is returned without a fetch", async () => {
      const server = await startServer();
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { downloadFailproofaidBinary } = await import("../../src/hooks/daemon-download");
        const first = await downloadFailproofaidBinary("linux-x64");
        await server.close();
        // Server is down; a second call must not need it.
        const second = await downloadFailproofaidBinary("linux-x64");
        expect(second.path).toBe(first.path);
        expect(second.error).toBeUndefined();
      } finally {
        server.server.close();
      }
    });

    it("refuses to install a binary whose checksum does not match", async () => {
      const server = await startServer({ manifest: `${"f".repeat(64)}  failproofaid-linux-x64.gz\n` });
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { downloadFailproofaidBinary, installedBinaryPath, daemonBinaryDir } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await downloadFailproofaidBinary("linux-x64");

        expect(result.path).toBeUndefined();
        expect(result.error).toContain("checksum mismatch");
        expect(existsSync(installedBinaryPath())).toBe(false);
        // Nothing half-written left behind either.
        expect(existsSync(daemonBinaryDir()) ? readdirSync(daemonBinaryDir()) : []).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("refuses an asset the manifest does not cover at all", async () => {
      const server = await startServer({ manifest: `${DIGEST}  failproofaid-darwin-x64.gz\n` });
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { downloadFailproofaidBinary, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await downloadFailproofaidBinary("linux-x64");
        expect(result.error).toContain("no entry for failproofaid-linux-x64.gz");
        expect(existsSync(installedBinaryPath())).toBe(false);
      } finally {
        await server.close();
      }
    });

    it("reports a failed fetch without throwing and installs nothing", async () => {
      const server = await startServer({ assetStatus: 404 });
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { downloadFailproofaidBinary, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await downloadFailproofaidBinary("linux-x64");
        expect(result.error).toContain("failed to download");
        expect(result.error).toContain("404");
        expect(existsSync(installedBinaryPath())).toBe(false);
      } finally {
        await server.close();
      }
    });

    it("does not reach the network at all when downloads are disabled", async () => {
      // No server: an air-gapped box must fail with a clear reason rather than
      // hang on a connection to github.com.
      process.env.FAILPROOFAI_DAEMON_BASE_URL = "http://127.0.0.1:1/never";
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
      const { downloadFailproofaidBinary } = await import("../../src/hooks/daemon-download");
      const result = await downloadFailproofaidBinary("linux-x64");
      expect(result.error).toContain("downloads are disabled");
      expect(result.path).toBeUndefined();
    });

    it("still returns an already-installed binary when downloads are disabled", async () => {
      // Disabling downloads must not disable the daemon on a machine that
      // already has one — the flag gates fetching, not running.
      const { installedBinaryPath, downloadFailproofaidBinary } = await import(
        "../../src/hooks/daemon-download"
      );
      mkdirSync(resolve(home, ".failproofai", "bin"), { recursive: true });
      writeFileSync(installedBinaryPath(), BINARY);
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";

      const result = await downloadFailproofaidBinary("linux-x64");
      expect(result.path).toBe(installedBinaryPath());
    });
  });

  describe("the npm platform-package channel", () => {
    const originalRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
    let packageRoot: string;

    beforeEach(() => {
      packageRoot = mkdtempSync(resolve(tmpdir(), "fpai-package-root-"));
      // A real installed layout: the CLI package's own manifest, so
      // createRequire() has something to anchor resolution to.
      writeFileSync(
        resolve(packageRoot, "package.json"),
        JSON.stringify({ name: "failproofai", version }) + "\n",
      );
      process.env.FAILPROOFAI_PACKAGE_ROOT = packageRoot;
    });

    afterEach(() => {
      rmSync(packageRoot, { recursive: true, force: true });
      if (originalRoot !== undefined) process.env.FAILPROOFAI_PACKAGE_ROOT = originalRoot;
      else delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    });

    /** Stages what `npm install failproofai` leaves behind for this machine. */
    function installPlatformPackage(key: string, binary: Buffer = BINARY, pkgVersion = version): string {
      const dir = resolve(packageRoot, "node_modules", "@failproofai", `failproofaid-${key}`);
      mkdirSync(resolve(dir, "bin"), { recursive: true });
      writeFileSync(
        resolve(dir, "package.json"),
        JSON.stringify({ name: `@failproofai/failproofaid-${key}`, version: pkgVersion, files: ["bin/"] }) + "\n",
      );
      const binaryPath = resolve(dir, "bin", "failproofaid");
      writeFileSync(binaryPath, binary);
      chmodSync(binaryPath, 0o755);
      return binaryPath;
    }

    it("finds the binary the platform package installed", async () => {
      const staged = installPlatformPackage("linux-x64");
      const { npmPlatformBinaryPath } = await import("../../src/hooks/daemon-download");
      expect(npmPlatformBinaryPath("linux-x64")).toBe(staged);
    });

    it("returns null for a platform whose package is not installed", async () => {
      installPlatformPackage("linux-x64");
      const { npmPlatformBinaryPath } = await import("../../src/hooks/daemon-download");
      // os/cpu keep npm from installing the other three; asking for one of them
      // must not resolve the wrong machine's binary.
      expect(npmPlatformBinaryPath("darwin-arm64")).toBeNull();
    });

    it("ignores a platform package built for a different version of the CLI", async () => {
      // A workspace holding two failproofai versions can hoist the other one's
      // platform package to the top. Installing that binary under this
      // version's filename would put a daemon built from different source
      // behind a CLI that believes it matches.
      installPlatformPackage("linux-x64", BINARY, "0.0.1-not-this-cli");
      const { npmPlatformBinaryPath } = await import("../../src/hooks/daemon-download");
      expect(npmPlatformBinaryPath("linux-x64")).toBeNull();
    });

    it("returns null when there is no package root to resolve from", async () => {
      installPlatformPackage("linux-x64");
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      const { npmPlatformBinaryPath } = await import("../../src/hooks/daemon-download");
      expect(npmPlatformBinaryPath("linux-x64")).toBeNull();
    });

    it("installs from the package to the same versioned, executable path the download uses", async () => {
      installPlatformPackage("linux-x64");
      const { installFromNpmPackage, installedBinaryPath } = await import(
        "../../src/hooks/daemon-download"
      );
      const result = await installFromNpmPackage("linux-x64");

      expect(result.error).toBeUndefined();
      expect(result.path).toBe(installedBinaryPath());
      expect(readFileSync(result.path!)).toEqual(BINARY);
      expect(statSync(result.path!).mode & 0o777).toBe(0o755);
      // Same atomic rename as the download path — no temp file survives.
      expect(readdirSync(resolve(home, ".failproofai", "bin"))).toEqual([`failproofaid-${version}`]);
    });

    it("reports a missing package without throwing", async () => {
      const { installFromNpmPackage, installedBinaryPath } = await import(
        "../../src/hooks/daemon-download"
      );
      const result = await installFromNpmPackage("linux-x64");
      expect(result.path).toBeUndefined();
      expect(result.error).toContain("@failproofai/failproofaid-linux-x64 is not installed");
      expect(existsSync(installedBinaryPath())).toBe(false);
    });

    it("ensureFailproofaidBinary prefers the package and never touches the network", async () => {
      installPlatformPackage("linux-x64");
      // Any fetch at all fails this test: a machine that already has the
      // binary from npm must not wait on github.com to install it.
      const server = await startServer();
      let requests = 0;
      server.server.on("request", () => {
        requests += 1;
      });
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      try {
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
        const result = await ensureFailproofaidBinary();
        expect(result.reason).toBeUndefined();
        expect(result.path).toBe(installedBinaryPath());
        expect(requests).toBe(0);
      } finally {
        await server.close();
      }
    });

    it("works on an air-gapped machine, where the download channel is switched off", async () => {
      // FAILPROOFAI_NO_DOWNLOAD gates fetching, not copying — on exactly these
      // machines npm is the only channel that can supply a daemon at all.
      installPlatformPackage("linux-x64");
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
      process.env.FAILPROOFAI_DAEMON_BASE_URL = "http://127.0.0.1:1/never";

      const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
      const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
      const result = await ensureFailproofaidBinary();
      expect(result.path).toBe(installedBinaryPath());
    });

    it("falls back to the download when no platform package is installed", async () => {
      const server = await startServer();
      process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });
      try {
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
        const result = await ensureFailproofaidBinary();
        expect(result.path).toBe(installedBinaryPath());
        expect(readFileSync(result.path!)).toEqual(BINARY);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
        await server.close();
      }
    });

    it("names both channels when neither can supply a binary", async () => {
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });
      try {
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const result = await ensureFailproofaidBinary();
        expect(result.path).toBeUndefined();
        // "not installed" alone reads as a broken package; the download error
        // alone hides that npm could have supplied it.
        expect(result.reason).toContain("downloads are disabled");
        expect(result.reason).toContain("is not installed");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });
  });
});
