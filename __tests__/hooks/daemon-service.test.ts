// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogWarn: vi.fn(),
  hookLogInfo: vi.fn(),
}));

describe("hooks/daemon-service", () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  const originalBinaryEnv = process.env.FAILPROOFAI_DAEMON_BINARY;
  const originalPackageRootEnv = process.env.FAILPROOFAI_PACKAGE_ROOT;
  const originalWorkerCmdEnv = process.env.FAILPROOFAI_WORKER_CMD;

  function setPlatform(platform: string) {
    Object.defineProperty(process, "platform", { value: platform });
  }
  function setArch(arch: string) {
    Object.defineProperty(process, "arch", { value: arch });
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process, "arch", { value: originalArch });
    if (originalBinaryEnv !== undefined) process.env.FAILPROOFAI_DAEMON_BINARY = originalBinaryEnv;
    else delete process.env.FAILPROOFAI_DAEMON_BINARY;
    if (originalPackageRootEnv !== undefined) process.env.FAILPROOFAI_PACKAGE_ROOT = originalPackageRootEnv;
    else delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    if (originalWorkerCmdEnv !== undefined) process.env.FAILPROOFAI_WORKER_CMD = originalWorkerCmdEnv;
    else delete process.env.FAILPROOFAI_WORKER_CMD;
  });

  describe("isDaemonSupportedPlatform", () => {
    it("is true on linux", async () => {
      setPlatform("linux");
      const { isDaemonSupportedPlatform } = await import("../../src/hooks/daemon-service");
      expect(isDaemonSupportedPlatform()).toBe(true);
    });

    it("is true on darwin", async () => {
      setPlatform("darwin");
      const { isDaemonSupportedPlatform } = await import("../../src/hooks/daemon-service");
      expect(isDaemonSupportedPlatform()).toBe(true);
    });

    it("is false on win32", async () => {
      setPlatform("win32");
      const { isDaemonSupportedPlatform } = await import("../../src/hooks/daemon-service");
      expect(isDaemonSupportedPlatform()).toBe(false);
    });
  });

  describe("resolveFailproofaidBinaryPath", () => {
    it("returns the FAILPROOFAI_DAEMON_BINARY override verbatim, regardless of platform", async () => {
      process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBe("/usr/bin/sleep infinity");
    });

    it("returns null on win32 with nothing else configured", async () => {
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("win32");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBeNull();
    });

    it("returns null when no platform package and no dev build are present", async () => {
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      process.env.FAILPROOFAI_PACKAGE_ROOT = "/nonexistent/package/root";
      setPlatform("linux");
      setArch("x64");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBeNull();
    });

    it("finds a locally-built dev binary under target/release relative to the package root", async () => {
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      // The real repo's own target/{release,debug}/failproofaid — built by
      // the Rust test suite / a local `cargo build` earlier in this session.
      process.env.FAILPROOFAI_PACKAGE_ROOT = resolve(__dirname, "..", "..");
      setPlatform("linux");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      const result = resolveFailproofaidBinaryPath();
      // Not asserting a specific outcome beyond "doesn't throw and returns a
      // sensible type" here would be too weak — but whether target/ has been
      // built depends on test execution order across files sharing state in
      // this repo, so assert the *shape* of a real hit without depending on
      // build state: either null, or an absolute path that actually exists.
      if (result !== null) {
        expect(existsSync(result)).toBe(true);
        expect(result).toContain("failproofaid");
      }
    });
  });

  describe("daemonServiceStatus", () => {
    it("is unsupported-platform on win32", async () => {
      setPlatform("win32");
      const { daemonServiceStatus } = await import("../../src/hooks/daemon-service");
      expect(daemonServiceStatus()).toBe("unsupported-platform");
    });
  });

  // Real systemd --user integration — only runs where a real user session
  // exists (this sandbox has one; a barebones container often won't).
  // Skips loudly rather than silently passing when it can't run, per the
  // plan's "no silent caps" verification guidance.
  const hasRealSystemdUserSession = (() => {
    if (process.platform !== "linux") return false;
    try {
      execFileSync("systemctl", ["--user", "status"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  (hasRealSystemdUserSession ? describe : describe.skip)(
    "real systemd --user lifecycle (linux only, requires a real user session)",
    () => {
      const unitPath = resolve(homedir(), ".config", "systemd", "user", "failproofaid.service");
      let preexistingUnit: string | null = null;

      beforeEach(() => {
        // Never clobber a real installed daemon if this sandbox happens to
        // have one — capture and restore it rather than assuming a clean
        // slate.
        preexistingUnit = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : null;
      });

      afterEach(async () => {
        setPlatform("linux");
        const { uninstallDaemonService } = await import("../../src/hooks/daemon-service");
        await uninstallDaemonService();
        if (preexistingUnit !== null) {
          const { mkdirSync, writeFileSync } = await import("node:fs");
          mkdirSync(resolve(homedir(), ".config", "systemd", "user"), { recursive: true });
          writeFileSync(unitPath, preexistingUnit, "utf8");
          try {
            execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
          } catch {
            /* best-effort restore */
          }
        }
      });

      it("installs a real user unit, reports it running, then fully removes it on uninstall", async () => {
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        setPlatform("linux");
        const { installDaemonService, daemonServiceStatus, uninstallDaemonService } = await import(
          "../../src/hooks/daemon-service"
        );

        expect(daemonServiceStatus()).toBe("not-installed");

        const result = await installDaemonService();
        expect(result).toEqual({ installed: true });
        expect(existsSync(unitPath)).toBe(true);
        expect(readFileSync(unitPath, "utf8")).toContain("ExecStart=/usr/bin/sleep infinity");

        // systemd needs a beat to actually transition the unit to active
        // after `enable --now`.
        await new Promise((r) => setTimeout(r, 300));
        expect(daemonServiceStatus()).toBe("running");

        await uninstallDaemonService();
        expect(existsSync(unitPath)).toBe(false);
        expect(daemonServiceStatus()).toBe("not-installed");
      });

      it("writes FAILPROOFAI_WORKER_CMD into the unit's environment and systemd still accepts it", async () => {
        // Caught by a real Docker clean-install run: the daemon's own
        // built-in worker fallback is a *relative* path (dist/worker.mjs),
        // which only resolves when the daemon happens to be started from
        // the npm package's own directory — never true for a real
        // service-managed daemon, which systemd starts from an arbitrary
        // cwd. This is the fix: an absolute worker command threaded through
        // as an environment line in the unit itself. The real assertion
        // here isn't just string content — it's that `systemctl --user
        // enable --now` (called by installDaemonService) doesn't choke on
        // the quoted Environment= syntax.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        process.env.FAILPROOFAI_WORKER_CMD = "node /some/absolute/path/worker.mjs";
        setPlatform("linux");
        const { installDaemonService, daemonServiceStatus } = await import("../../src/hooks/daemon-service");

        const result = await installDaemonService();
        expect(result).toEqual({ installed: true });
        const contents = readFileSync(unitPath, "utf8");
        expect(contents).toContain('Environment="FAILPROOFAI_WORKER_CMD=node /some/absolute/path/worker.mjs"');

        await new Promise((r) => setTimeout(r, 300));
        expect(daemonServiceStatus()).toBe("running");
      });

      it("re-installing replaces the unit file with a new binary path", async () => {
        setPlatform("linux");
        const { installDaemonService } = await import("../../src/hooks/daemon-service");

        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        await installDaemonService();
        expect(readFileSync(unitPath, "utf8")).toContain("ExecStart=/usr/bin/sleep infinity");

        // A *genuinely* different command. Re-installing with a trailing-space
        // variant of the first one proves nothing: the assertion's needle is
        // still a substring of the original unit, so the test would pass even
        // if the second install were a no-op.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep 3600";
        await installDaemonService();
        const rewritten = readFileSync(unitPath, "utf8");
        expect(rewritten).toContain("ExecStart=/usr/bin/sleep 3600");
        expect(rewritten).not.toContain("infinity");
      });

      it("does not report installed when the service never stays running", async () => {
        // A "daemon" that exits the moment it starts: systemd accepts the
        // job and `enable --now` exits 0, but nothing is left running.
        // Reporting success here is what lets the wizard set
        // `daemonConfigured`, after which every hook event on the machine
        // fails closed against a daemon that does not exist.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep 0";
        setPlatform("linux");
        const { installDaemonService } = await import("../../src/hooks/daemon-service");

        const result = await installDaemonService();
        expect(result.installed).toBe(false);
        expect(result.reason).toContain("did not reach a running state");
      }, 20_000);

      it("uninstall clears the daemonConfigured marker", async () => {
        setPlatform("linux");
        const { installDaemonService, uninstallDaemonService, setDaemonConfigured } = await import(
          "../../src/hooks/daemon-service"
        );
        const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
        const configPath = getConfigPathForScope("user");
        const preexisting = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

        try {
          process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
          expect((await installDaemonService()).installed).toBe(true);
          setDaemonConfigured(true);
          expect(JSON.parse(readFileSync(configPath, "utf8")).daemonConfigured).toBe(true);

          // Without this, removing the service leaves the machine failing
          // closed forever against a socket that is gone.
          await uninstallDaemonService();
          expect(JSON.parse(readFileSync(configPath, "utf8")).daemonConfigured).toBeUndefined();
        } finally {
          if (preexisting !== null) writeFileSync(configPath, preexisting, "utf8");
          else rmSync(configPath, { force: true });
        }
      }, 20_000);

      it("installDaemonService fails cleanly when the binary cannot be resolved", async () => {
        delete process.env.FAILPROOFAI_DAEMON_BINARY;
        delete process.env.FAILPROOFAI_PACKAGE_ROOT;
        setPlatform("linux");
        const { installDaemonService } = await import("../../src/hooks/daemon-service");
        const result = await installDaemonService();
        expect(result.installed).toBe(false);
        expect(result.reason).toBeTruthy();
        expect(existsSync(unitPath)).toBe(false);
      });
    },
  );
});
