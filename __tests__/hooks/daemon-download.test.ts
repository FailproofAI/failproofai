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
import packageJson, { version } from "../../package.json";
import { binDir } from "../../src/hooks/fp-home";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogWarn: vi.fn(),
  hookLogInfo: vi.fn(),
}));

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const BINARY = Buffer.from("#!/bin/sh\necho failproofaid " + version + "\n");
const GZIPPED = gzipSync(BINARY);
const DIGEST = sha256(GZIPPED);
/** What the publish records for BINARY in a released package's manifest. */
const BINARY_DIGEST = sha256(BINARY);
/** A binary the release never built. */
const TAMPERED = Buffer.from("#!/bin/sh\necho not the daemon this release built\n");

/**
 * Gives the modules imported after this call the `failproofaidBinaries` map a
 * published build carries. `scripts/build-daemon-packages.mjs` writes it into
 * the manifest at publish time, so this repo's own package.json never has it.
 */
function recordDigests(digests: Record<string, string>): void {
  const manifest = { ...packageJson, failproofaidBinaries: digests };
  vi.doMock("../../package.json", () => ({ ...manifest, default: manifest }));
}

/** Serves the four assets + SHA256SUMS the release job publishes. */
function startServer(options: { manifest?: string; assetStatus?: number; asset?: Buffer } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  server: Server;
}> {
  const asset = options.asset ?? GZIPPED;
  const manifest = options.manifest ?? `${sha256(asset)}  failproofaid-linux-x64.gz\n`;
  const server = createServer((req, res) => {
    if (req.url === `/v${version}/SHA256SUMS`) {
      res.writeHead(200).end(manifest);
    } else if (req.url === `/v${version}/failproofaid-linux-x64.gz`) {
      if (options.assetStatus && options.assetStatus !== 200) {
        res.writeHead(options.assetStatus).end("nope");
      } else {
        res.writeHead(200).end(asset);
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
    vi.doUnmock("../../package.json");
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

  // Over plain http, SHA256SUMS arrives on the same unauthenticated connection
  // as the binary, so anyone on the network path rewrites both — and the
  // result is installed as a boot-persistent service. (#1800)
  describe("the mirror base URL", () => {
    it.each([
      ["no override", undefined],
      ["an https mirror", "https://mirror.internal/failproofai/"],
      ["plain http on 127.0.0.1", "http://127.0.0.1:8080"],
      ["plain http on localhost", "http://localhost:8080/releases"],
      ["plain http on [::1]", "http://[::1]:8080"],
    ])("accepts %s", async (_label, url) => {
      if (url === undefined) delete process.env.FAILPROOFAI_DAEMON_BASE_URL;
      else process.env.FAILPROOFAI_DAEMON_BASE_URL = url;
      const { daemonBaseUrlProblem } = await import("../../src/hooks/daemon-download");
      expect(daemonBaseUrlProblem()).toBeNull();
    });

    it.each([
      ["plain http to another host", "http://mirror.internal/failproofai"],
      ["plain http to a private address", "http://10.0.0.5:8080"],
      ["a host that only starts with localhost", "http://localhost.attacker.invalid/"],
      ["another scheme", "ftp://mirror.internal/failproofai"],
      ["a value that is not a URL", "mirror.internal/failproofai"],
    ])("refuses %s", async (_label, url) => {
      process.env.FAILPROOFAI_DAEMON_BASE_URL = url;
      const { daemonBaseUrlProblem } = await import("../../src/hooks/daemon-download");
      expect(daemonBaseUrlProblem()).toContain("FAILPROOFAI_DAEMON_BASE_URL");
    });

    it("refuses a plain-http mirror before fetching anything", async () => {
      process.env.FAILPROOFAI_DAEMON_BASE_URL = "http://mirror.invalid/failproofai";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
      try {
        const { downloadFailproofaidBinary, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await downloadFailproofaidBinary("linux-x64");
        expect(result.path).toBeUndefined();
        expect(result.error).toContain("must be an https:// URL");
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(existsSync(installedBinaryPath())).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
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
        expect(readdirSync(binDir(home))).toEqual([`failproofaid-${version}`]);
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
      mkdirSync(binDir(home), { recursive: true });
      writeFileSync(installedBinaryPath(), BINARY);
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";

      const result = await downloadFailproofaidBinary("linux-x64");
      expect(result.path).toBe(installedBinaryPath());
    });

    // SHA256SUMS is published in the same release as the asset, so whoever can
    // replace one can replace both. A published build carries each binary's
    // digest in its own manifest, out of that reach. (#1675, #1800)
    describe("against the digest this build recorded", () => {
      it("installs a download that matches it", async () => {
        recordDigests({ "linux-x64": BINARY_DIGEST });
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
        } finally {
          await server.close();
        }
      });

      it("refuses a replaced asset even when the release's SHA256SUMS was rewritten to match", async () => {
        recordDigests({ "linux-x64": BINARY_DIGEST });
        // Asset and manifest agree with each other: what editing the release produces.
        const server = await startServer({ asset: gzipSync(TAMPERED) });
        process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
        try {
          const { downloadFailproofaidBinary, installedBinaryPath, daemonBinaryDir } = await import(
            "../../src/hooks/daemon-download"
          );
          const result = await downloadFailproofaidBinary("linux-x64");

          expect(result.path).toBeUndefined();
          expect(result.error).toContain("refusing to install");
          expect(result.error).toContain(BINARY_DIGEST);
          expect(existsSync(installedBinaryPath())).toBe(false);
          expect(existsSync(daemonBinaryDir()) ? readdirSync(daemonBinaryDir()) : []).toEqual([]);
        } finally {
          await server.close();
        }
      });

      it("does not reuse an installed copy that no longer matches: it downloads and replaces it", async () => {
        recordDigests({ "linux-x64": BINARY_DIGEST });
        const server = await startServer();
        process.env.FAILPROOFAI_DAEMON_BASE_URL = server.url;
        try {
          const { downloadFailproofaidBinary, installedBinaryPath } = await import(
            "../../src/hooks/daemon-download"
          );
          mkdirSync(binDir(home), { recursive: true });
          writeFileSync(installedBinaryPath(), TAMPERED);

          const result = await downloadFailproofaidBinary("linux-x64");
          expect(result.error).toBeUndefined();
          expect(result.path).toBe(installedBinaryPath());
          expect(readFileSync(installedBinaryPath())).toEqual(BINARY);
        } finally {
          await server.close();
        }
      });

      it("reuses an installed copy that matches, without a fetch", async () => {
        recordDigests({ "linux-x64": BINARY_DIGEST });
        process.env.FAILPROOFAI_DAEMON_BASE_URL = "http://127.0.0.1:1/never";
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
          const { downloadFailproofaidBinary, installedBinaryPath } = await import(
            "../../src/hooks/daemon-download"
          );
          mkdirSync(binDir(home), { recursive: true });
          writeFileSync(installedBinaryPath(), BINARY);

          await expect(downloadFailproofaidBinary("linux-x64")).resolves.toEqual({
            path: installedBinaryPath(),
          });
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      });

      it("never hands back a copy that does not match, even when it cannot replace it", async () => {
        recordDigests({ "linux-x64": BINARY_DIGEST });
        process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
        const { downloadFailproofaidBinary, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        mkdirSync(binDir(home), { recursive: true });
        writeFileSync(installedBinaryPath(), TAMPERED);

        const result = await downloadFailproofaidBinary("linux-x64");
        expect(result.path).toBeUndefined();
        expect(result.error).toContain("downloads are disabled");
      });
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
      expect(readdirSync(binDir(home))).toEqual([`failproofaid-${version}`]);
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

    // The npm channel used to install with NO integrity step of any kind, on
    // the reasoning that "npm verified the tarball when it installed it" —
    // which is true, and about a different moment. npm checks at EXTRACTION;
    // this reads a loose file out of a shared, writable node_modules some time
    // later and installs it as a root-owned, boot-persistent system service.
    // The sibling download channel has verified against SHA256SUMS since it
    // existed.
    describe("integrity of the npm-channel binary", () => {
      it("refuses a binary whose digest does not match what this build recorded", async () => {
        const { binaryDigestMismatch } = await import("../../src/hooks/daemon-download");
        const expected = createHash("sha256").update(Buffer.from("the real binary")).digest("hex");

        const problem = binaryDigestMismatch(expected, Buffer.from("tampered"), "/pkg/bin/failproofaid");

        expect(problem).toContain("refusing to install");
        expect(problem).toContain(expected);
        // Names the path, so an operator can see WHICH copy is wrong.
        expect(problem).toContain("/pkg/bin/failproofaid");
      });

      it("accepts a binary that matches", async () => {
        const { binaryDigestMismatch } = await import("../../src/hooks/daemon-download");
        const bytes = Buffer.from("the real binary");
        const expected = createHash("sha256").update(bytes).digest("hex");
        expect(binaryDigestMismatch(expected, bytes, "/pkg/bin/failproofaid")).toBeNull();
      });

      it("treats 'no recorded digest' as nothing to compare, not as a pass", async () => {
        // `failproofaidBinaries` is written into the manifest at publish time,
        // so it is absent from every dev build and unpublished commit. The
        // install must still work there — this channel is the only one that
        // functions air-gapped.
        const { binaryDigestMismatch } = await import("../../src/hooks/daemon-download");
        expect(binaryDigestMismatch(null, Buffer.from("anything"), "/pkg/bin/failproofaid")).toBeNull();
      });

      it("expectedNpmBinaryDigest ignores a malformed entry rather than trusting it", async () => {
        const { expectedNpmBinaryDigest } = await import("../../src/hooks/daemon-download");
        // This repo's committed manifest carries no digests, so every platform
        // reads as "not recorded" — the property that keeps dev builds working.
        expect(expectedNpmBinaryDigest("linux-x64")).toBeNull();
      });

      it("still installs on a build with no recorded digest", async () => {
        installPlatformPackage("linux-x64");
        const { installFromNpmPackage, installedBinaryPath } = await import(
          "../../src/hooks/daemon-download"
        );
        const result = await installFromNpmPackage("linux-x64");
        expect(result.error).toBeUndefined();
        expect(result.path).toBe(installedBinaryPath());
      });
    });

    it("ensureFailproofaidBinary prefers the package and never touches the network", async () => {
      // This entry point resolves the real host, unlike the explicit-key helpers.
      installPlatformPackage(`${process.platform}-${process.arch}`);
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

    // The install path reused whatever sat at ~/.failproofai/bin/failproofaid-<version>
    // and staged it as the root-installed service binary, unread. (#1800)
    describe("an installed copy that no longer matches the recorded digest", () => {
      const hostKey = `${process.platform}-${process.arch}`;

      it("is reinstalled from a verified channel instead of reused", async () => {
        recordDigests({ [hostKey]: BINARY_DIGEST });
        installPlatformPackage(hostKey);
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
        mkdirSync(binDir(home), { recursive: true });
        writeFileSync(installedBinaryPath(), TAMPERED);

        const result = await ensureFailproofaidBinary();
        expect(result.reason).toBeUndefined();
        expect(result.path).toBe(installedBinaryPath());
        expect(readFileSync(installedBinaryPath())).toEqual(BINARY);
      });

      it("is refused, with the reason, when no channel can replace it", async () => {
        recordDigests({ [hostKey]: BINARY_DIGEST });
        process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
        mkdirSync(binDir(home), { recursive: true });
        writeFileSync(installedBinaryPath(), TAMPERED);

        const result = await ensureFailproofaidBinary();
        expect(result.path).toBeUndefined();
        expect(result.reason).toContain("the installed copy was not reused");
        expect(result.reason).toContain(BINARY_DIGEST);
      });

      it("is still reused as before on a build that recorded no digest", async () => {
        // Every dev build and unpublished commit: nothing to compare against.
        process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
        mkdirSync(binDir(home), { recursive: true });
        writeFileSync(installedBinaryPath(), TAMPERED);

        await expect(ensureFailproofaidBinary()).resolves.toEqual({ path: installedBinaryPath() });
      });
    });

    it("works on an air-gapped machine, where the download channel is switched off", async () => {
      // FAILPROOFAI_NO_DOWNLOAD gates fetching, not copying — on exactly these
      // machines npm is the only channel that can supply a daemon at all.
      installPlatformPackage(`${process.platform}-${process.arch}`);
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
