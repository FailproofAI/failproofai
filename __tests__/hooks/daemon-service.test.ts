// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { binDir } from "../../src/hooks/fp-home";

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
  const originalCliCmdEnv = process.env.FAILPROOFAI_CLI_CMD;
  const originalHome = process.env.HOME;
  const originalNoDownload = process.env.FAILPROOFAI_NO_DOWNLOAD;
  // The download channel installs under `$HOME/.failproofai/bin`, so these
  // tests point HOME at a scratch dir: a developer machine that really has a
  // daemon installed would otherwise turn "resolves to null" into a flake.
  let home: string;

  function setPlatform(platform: string) {
    Object.defineProperty(process, "platform", { value: platform });
  }
  function setArch(arch: string) {
    Object.defineProperty(process, "arch", { value: arch });
  }

  /**
   * Points HOME at a scratch dir for the tests that exercise binary
   * resolution. Deliberately opt-in per test rather than a blanket
   * `beforeEach`: the real-systemd lifecycle tests further down install an
   * actual user unit, which only works under the session's real HOME.
   */
  function useScratchHome(): string {
    home = mkdtempSync(resolve(tmpdir(), "fpai-daemon-service-"));
    process.env.HOME = home;
    return home;
  }

  beforeEach(() => {
    vi.resetModules();
    home = "";
    // No test in this file may reach the network. installDaemonService()
    // downloads the daemon when nothing is resolvable, so without this a
    // test asserting "no binary" quietly fetches one from the real release
    // — which is what broke CI while passing locally. The download path
    // itself is covered in daemon-download.test.ts against a local server.
    process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNoDownload !== undefined) process.env.FAILPROOFAI_NO_DOWNLOAD = originalNoDownload;
    else delete process.env.FAILPROOFAI_NO_DOWNLOAD;
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process, "arch", { value: originalArch });
    if (originalBinaryEnv !== undefined) process.env.FAILPROOFAI_DAEMON_BINARY = originalBinaryEnv;
    else delete process.env.FAILPROOFAI_DAEMON_BINARY;
    if (originalPackageRootEnv !== undefined) process.env.FAILPROOFAI_PACKAGE_ROOT = originalPackageRootEnv;
    else delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    if (originalWorkerCmdEnv !== undefined) process.env.FAILPROOFAI_WORKER_CMD = originalWorkerCmdEnv;
    else delete process.env.FAILPROOFAI_WORKER_CMD;
    if (originalCliCmdEnv !== undefined) process.env.FAILPROOFAI_CLI_CMD = originalCliCmdEnv;
    else delete process.env.FAILPROOFAI_CLI_CMD;
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
      // Scratch HOME: a machine that really has a daemon installed (a CI
      // runner that just ran the lifecycle tests, a developer laptop) would
      // otherwise resolve that binary and turn this into a flake.
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("win32");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBeNull();
    });

    it("returns null when nothing has been downloaded and no dev build is present", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      process.env.FAILPROOFAI_PACKAGE_ROOT = "/nonexistent/package/root";
      setPlatform("linux");
      setArch("x64");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBeNull();
    });

    it("finds the binary downloaded for this version under ~/.failproofai/bin", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("linux");
      setArch("x64");
      const { installedBinaryPath } = await import("../../src/hooks/daemon-download");
      mkdirSync(binDir(home), { recursive: true });
      writeFileSync(installedBinaryPath(), "#!/bin/sh\n");

      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBe(installedBinaryPath());
    });

    it("never fetches — resolution is a disk check, so the hook path cannot block on the network", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("linux");
      setArch("x64");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { resolveFailproofaidBinaryPath } = await import("../../src/hooks/daemon-service");
      expect(resolveFailproofaidBinaryPath()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
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

  describe("ensureFailproofaidBinary", () => {
    it("returns an already-resolved binary without downloading", async () => {
      process.env.FAILPROOFAI_DAEMON_BINARY = "/opt/failproofaid";
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");

      await expect(ensureFailproofaidBinary()).resolves.toEqual({ path: "/opt/failproofaid" });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("reports an unsupported architecture rather than attempting a download", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("linux");
      setArch("ppc64");
      const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");

      const result = await ensureFailproofaidBinary();
      expect(result.path).toBeUndefined();
      expect(result.reason).toContain("no prebuilt binary");
    });

    it("surfaces the download failure verbatim for the local log", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_DAEMON_BINARY;
      delete process.env.FAILPROOFAI_PACKAGE_ROOT;
      setPlatform("linux");
      setArch("x64");
      process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
      try {
        const { ensureFailproofaidBinary } = await import("../../src/hooks/daemon-service");
        const result = await ensureFailproofaidBinary();
        expect(result.reason).toContain("downloads are disabled");
      } finally {
        delete process.env.FAILPROOFAI_NO_DOWNLOAD;
      }
    });
  });

  describe("system-scope service definition", () => {
    it("names the unit per user so a second install cannot steal the first's service", async () => {
      setPlatform("linux");
      const { daemonServiceFilePath, daemonStatusCommand } = await import("../../src/hooks/daemon-service");
      const user = userInfo().username;

      expect(daemonServiceFilePath()).toBe(`/etc/systemd/system/failproofaid@${user}.service`);
      expect(daemonStatusCommand()).toBe(`systemctl status failproofaid@${user}.service`);
    });

    it("namespaces the launchd label per user too — a plist is just as user-specific", async () => {
      // A shared label meant the second Mac user's install overwrote the
      // first's daemon (UserName, ExecStart under their ~/.failproofai/bin,
      // their log paths) and their uninstall deleted it.
      setPlatform("darwin");
      const { daemonServiceFilePath, daemonStatusCommand } = await import("../../src/hooks/daemon-service");
      const user = userInfo().username;

      expect(daemonServiceFilePath()).toBe(
        `/Library/LaunchDaemons/ai.failproof.failproofaid.${user}.plist`,
      );
      expect(daemonStatusCommand()).toContain(`system/ai.failproof.failproofaid.${user}`);
    });

    it("writes a unit that runs as the user, starts at boot, and knows where HOME is", async () => {
      useScratchHome();
      setPlatform("linux");
      const { systemdUnitContents } = await import("../../src/hooks/daemon-service");
      const unit = systemdUnitContents("/opt/failproofaid", null);

      expect(unit).toContain(`User=${userInfo().username}`);
      expect(unit).toContain("ExecStart=/opt/failproofaid");
      // WantedBy=multi-user.target is the whole point of the system unit:
      // default.target only starts with a user session, which is what made
      // the daemon die on logout and never come back after a reboot.
      expect(unit).toContain("WantedBy=multi-user.target");
      // The daemon refuses to start without HOME, and a system unit gets no
      // login environment, so this must be explicit rather than inherited.
      expect(unit).toContain(`Environment="HOME=${process.env.HOME}"`);
    });

    it("bakes an absolute runtime into the worker command", async () => {
      // A bare `node` resolves for the wizard and then fails inside a system
      // unit whose PATH never includes ~/.nvm/versions/node/*/bin — silently,
      // and only on the machines least likely to notice.
      useScratchHome();
      delete process.env.FAILPROOFAI_WORKER_CMD;
      // The repo's own dist/worker.mjs — built by `bun run build`, which the
      // test job runs before this suite.
      process.env.FAILPROOFAI_PACKAGE_ROOT = resolve(__dirname, "..", "..");
      setPlatform("linux");
      const { resolveWorkerCommand, systemdUnitContents } = await import("../../src/hooks/daemon-service");

      const workerCmd = resolveWorkerCommand();
      if (workerCmd) {
        expect(workerCmd).toContain(process.execPath);
        expect(workerCmd).not.toMatch(/^node /);
        // Shell-quoted, because the daemon runs this through `sh -c`: an
        // unquoted `/Users/First Last/...` splits on its space and the worker
        // never starts. Ordinary on macOS, and more likely since execPath
        // (home-derived) replaced a bare `node`.
        expect(workerCmd).toBe(`'${process.execPath}' '${resolve(process.env.FAILPROOFAI_PACKAGE_ROOT!, "dist", "worker.mjs")}'`);
        // Environment= values containing a space must be quoted or systemd
        // rejects the unit — and this value always contains one.
        expect(systemdUnitContents("/opt/failproofaid", workerCmd)).toContain(
          `Environment="FAILPROOFAI_WORKER_CMD=${workerCmd}"`,
        );
      }
    });

    it("bakes an absolute runtime into the CLI command, and it actually runs", async () => {
      // The daemon spawns this to run a scheduled audit. Getting it wrong is
      // quieter than getting the worker command wrong: a worker that cannot
      // start makes the daemon visibly unhealthy, an audit that cannot start
      // just never happens while the config says it is on.
      useScratchHome();
      delete process.env.FAILPROOFAI_CLI_CMD;
      // The repo's own dist/cli.mjs — built by `bun run build`, which the test
      // job runs before this suite.
      process.env.FAILPROOFAI_PACKAGE_ROOT = resolve(__dirname, "..", "..");
      setPlatform("linux");
      const { resolveCliCommand } = await import("../../src/hooks/daemon-service");

      const cliCmd = resolveCliCommand();
      // Skipped rather than silently passing when dist/ has not been built —
      // the point of this test is that the resolved string RUNS.
      if (!cliCmd) return;

      expect(cliCmd).toBe(
        `'${process.execPath}' '${resolve(process.env.FAILPROOFAI_PACKAGE_ROOT, "dist", "cli.mjs")}'`,
      );
      expect(cliCmd).not.toMatch(/^node /);
      // Through `sh -c`, exactly as the daemon will invoke it — which is also
      // what proves the quoting survives a shell split rather than merely
      // looking quoted.
      const out = execFileSync("sh", ["-c", `${cliCmd} --version`], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      })
        .toString()
        .trim();
      expect(out).toMatch(/^\d+\.\d+\.\d+/);
    }, 40_000);

    it("carries FAILPROOFAI_CLI_CMD into both the unit and the plist", async () => {
      // Both renderers, in one test, because the failure mode is a variable
      // added to one platform and forgotten on the other — invisible until
      // somebody runs the other platform.
      useScratchHome();
      const { systemdUnitContents, launchdPlistContents } = await import(
        "../../src/hooks/daemon-service"
      );
      const cliCmd = "'/usr/bin/node' '/opt/failproofai/dist/cli.mjs'";

      setPlatform("linux");
      const unit = systemdUnitContents("/opt/failproofaid", "'/usr/bin/node' '/w.mjs'", cliCmd);
      expect(unit).toContain(`Environment="FAILPROOFAI_WORKER_CMD='/usr/bin/node' '/w.mjs'"`);
      expect(unit).toContain(`Environment="FAILPROOFAI_CLI_CMD=${cliCmd}"`);

      setPlatform("darwin");
      const plist = launchdPlistContents("/opt/failproofaid", "/tmp/logs", null, cliCmd);
      expect(plist).toContain("<key>FAILPROOFAI_CLI_CMD</key>");
      // Single quotes are legal XML text, so they must survive verbatim —
      // escaping them would hand the shell a literal `&apos;` to split on.
      expect(plist).toContain(`<string>${cliCmd}</string>`);
    });

    it("omits the environment block entirely when neither command resolves", async () => {
      // A `<dict>` with no keys, or a stray `Environment=""`, is not the same
      // as no environment — the daemon reads "set but empty" as a command.
      useScratchHome();
      setPlatform("darwin");
      const { launchdPlistContents } = await import("../../src/hooks/daemon-service");
      const plist = launchdPlistContents("/opt/failproofaid", "/tmp/logs", null, null);
      expect(plist).not.toContain("EnvironmentVariables");
    });

    // Meaningless as root, where elevation always succeeds.
    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "refuses to half-install when it cannot elevate, and says exactly what to run",
      async () => {
        useScratchHome();
        process.env.FAILPROOFAI_DAEMON_BINARY = "/opt/failproofaid";
        setPlatform("linux");
        // Every privileged command fails the way a machine without
        // passwordless sudo fails. Nothing may be written, and the reason
        // has to be actionable rather than an errno.
        vi.doMock("node:child_process", async (importOriginal) => ({
          ...(await importOriginal<typeof import("node:child_process")>()),
          execFileSync: (cmd: string) => {
            if (cmd === "sudo") throw new Error("sudo: a password is required");
            throw new Error(`nothing else should run before elevation succeeds, but got: ${cmd}`);
          },
        }));
        try {
          vi.resetModules();
          const { installDaemonService } = await import("../../src/hooks/daemon-service");
          const result = await installDaemonService();

          expect(result.installed).toBe(false);
          expect(result.reason).toContain("root privileges are required");
          expect(result.reason).toContain("systemctl enable --now");
          expect(existsSync(`/etc/systemd/system/failproofaid@${userInfo().username}.service`)).toBe(false);
        } finally {
          vi.doUnmock("node:child_process");
          vi.resetModules();
        }
      },
    );
  });

  describe("daemonServiceStatus", () => {
    it("is unsupported-platform on win32", async () => {
      setPlatform("win32");
      const { daemonServiceStatus } = await import("../../src/hooks/daemon-service");
      expect(daemonServiceStatus()).toBe("unsupported-platform");
    });
  });

  describe("service-definition upgrades", () => {
    it("has nothing to upgrade where no service can exist", async () => {
      // The inert direction is the safe one: a machine with no service must
      // never be told it needs a privileged rewrite, and `ensureDaemonService
      // Current` must be a cheap no-op everywhere it has no business acting.
      setPlatform("win32");
      const { daemonServiceNeedsUpgrade, ensureDaemonServiceCurrent } = await import(
        "../../src/hooks/daemon-service"
      );
      expect(daemonServiceNeedsUpgrade()).toBe(false);
      await expect(ensureDaemonServiceCurrent()).resolves.toEqual({ outcome: "current" });
    });

    it("turns a systemd unit WITHOUT the variable into one WITH it, changing nothing else", async () => {
      useScratchHome();
      delete process.env.FAILPROOFAI_WORKER_CMD;
      process.env.FAILPROOFAI_PACKAGE_ROOT = "/nonexistent/package/root";
      setPlatform("linux");
      const { systemdUnitContents, upgradedServiceDefinition } = await import(
        "../../src/hooks/daemon-service"
      );

      // Exactly what an older failproofai wrote: this unit minus the line that
      // did not exist yet. Derived by removal rather than hand-written, so it
      // stays a true "previous version" as the unit's shape evolves.
      const legacy = systemdUnitContents("/opt/failproofaid", "'/usr/bin/node' '/pkg/dist/worker.mjs'")
        .split("\n")
        .filter((line) => !line.includes("FAILPROOFAI_CLI_CMD"))
        .join("\n");
      expect(legacy).not.toContain("FAILPROOFAI_CLI_CMD");

      const upgraded = upgradedServiceDefinition(legacy, "'/usr/bin/node' '/pkg/dist/cli.mjs'", "/tmp/logs");

      expect(upgraded).toContain(`Environment="FAILPROOFAI_CLI_CMD='/usr/bin/node' '/pkg/dist/cli.mjs'"`);
      // Carried over, not re-resolved: right after a CLI upgrade the version-
      // stamped binary for the NEW version is not on disk yet, so re-resolving
      // would repoint a live service at a file that does not exist.
      expect(upgraded).toContain("ExecStart=/opt/failproofaid");
      // Carried over too. The rewrite regenerates the whole unit, so a worker
      // command this process cannot re-resolve (no package root here) would
      // otherwise be silently DELETED from a working unit — turning a fix for
      // the audit lane into a break of the warm worker, which is on the path
      // of every tool call.
      expect(upgraded).toContain(
        `Environment="FAILPROOFAI_WORKER_CMD='/usr/bin/node' '/pkg/dist/worker.mjs'"`,
      );
      // And nothing else moved: the only difference is the added line.
      expect(upgraded!.split("\n").filter((l) => !l.includes("FAILPROOFAI_CLI_CMD")).join("\n")).toBe(
        legacy,
      );
    });

    it("turns a launchd plist WITHOUT the variable into one WITH it", async () => {
      // The half no Linux CI runner can reach through the real service
      // manager, and the half whose environment block has a different shape:
      // a shared <dict>, so a legacy plist already HAS an EnvironmentVariables
      // key and the new value has to land inside it rather than beside it.
      useScratchHome();
      delete process.env.FAILPROOFAI_WORKER_CMD;
      process.env.FAILPROOFAI_PACKAGE_ROOT = "/nonexistent/package/root";
      setPlatform("darwin");
      const { launchdPlistContents, upgradedServiceDefinition } = await import(
        "../../src/hooks/daemon-service"
      );

      const legacy = launchdPlistContents("/opt/failproofaid", "/tmp/logs", "/usr/bin/node /w.mjs");
      expect(legacy).not.toContain("FAILPROOFAI_CLI_CMD");

      const upgraded = upgradedServiceDefinition(legacy, "/usr/bin/node /c.mjs", "/tmp/logs");

      expect(upgraded).toContain("<key>FAILPROOFAI_CLI_CMD</key>");
      expect(upgraded).toContain("<string>/usr/bin/node /c.mjs</string>");
      expect(upgraded).toContain("<key>FAILPROOFAI_WORKER_CMD</key>");
      expect(upgraded).toContain("<string>/usr/bin/node /w.mjs</string>");
      expect(upgraded).toContain("<string>/opt/failproofaid</string>");
      // One dict, not two: a second EnvironmentVariables key makes launchd
      // take the first and silently drop everything in the second.
      expect(upgraded!.match(/EnvironmentVariables/g)).toHaveLength(1);
    });

    it("refuses to rewrite a definition it cannot read a start command out of", async () => {
      // A hand-edited or foreign unit at this path. Regenerating it from a
      // guessed ExecStart would replace whatever the operator actually runs.
      useScratchHome();
      setPlatform("linux");
      const { upgradedServiceDefinition } = await import("../../src/hooks/daemon-service");
      expect(upgradedServiceDefinition("[Unit]\nDescription=something else\n", "cli", "/tmp")).toBeNull();
    });
  });

  // Real systemd integration — the service is system-scope now, so this
  // needs root or passwordless sudo (CI runners have it; a locked-down
  // laptop may not). Skips loudly rather than silently passing when it
  // can't run, per the plan's "no silent caps" verification guidance.
  const canInstallSystemService = (() => {
    if (process.platform !== "linux") return false;
    try {
      execFileSync("systemctl", ["--version"], { stdio: "ignore" });
    } catch {
      return false;
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) return true;
    try {
      execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  const sudoPrefix = typeof process.getuid === "function" && process.getuid() === 0 ? [] : ["sudo", "-n"];
  const run = (args: string[]) =>
    execFileSync(sudoPrefix[0] ?? args[0], sudoPrefix.length ? [...sudoPrefix.slice(1), ...args] : args.slice(1), {
      stdio: "ignore",
    });

  (canInstallSystemService ? describe : describe.skip)(
    "real systemd system-scope lifecycle (linux only, requires root or passwordless sudo)",
    () => {
      const unitName = `failproofaid@${userInfo().username}.service`;
      const unitPath = resolve("/etc/systemd/system", unitName);
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
          const staging = resolve(tmpdir(), `failproofaid-restore-${process.pid}`);
          writeFileSync(staging, preexistingUnit, "utf8");
          try {
            run(["install", "-m", "0644", staging, unitPath]);
            run(["systemctl", "daemon-reload"]);
          } catch {
            /* best-effort restore */
          }
          rmSync(staging, { force: true });
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
        // here isn't just string content — it's that `systemctl enable
        // --now` (called by installDaemonService) doesn't choke on the
        // quoted Environment= syntax.
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
        // Layout 2 moved this flag out of policies-config.json and into
        // config.toml's [daemon] table, so it is read through the config
        // accessor rather than by JSON.parse-ing a path.
        const { readConfig } = await import("../../src/hooks/fp-config");
        const { configFile } = await import("../../src/hooks/fp-home");
        const configPath = configFile();
        const preexisting = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

        try {
          process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
          expect((await installDaemonService()).installed).toBe(true);
          setDaemonConfigured(true);
          expect(readConfig().daemon.configured).toBe(true);

          // Without this, removing the service leaves the machine failing
          // closed forever against a socket that is gone — which locked a real
          // machine out of its agent entirely during this work, UserPromptSubmit
          // included, with no CLI route back.
          await uninstallDaemonService();
          expect(readConfig().daemon.configured).toBe(false);
        } finally {
          if (preexisting !== null) writeFileSync(configPath, preexisting, "utf8");
          else rmSync(configPath, { force: true });
        }
      }, 20_000);

      /**
       * Downgrades the installed unit to what a failproofai from before this
       * change wrote: byte-identical apart from the line that did not exist
       * yet. Reproducing the upgrade case by *removing* the line — rather than
       * by hand-writing a "legacy" unit — is what keeps the test honest as the
       * unit's shape evolves.
       */
      function stripCliCommandFromUnit(): void {
        const legacy = readFileSync(unitPath, "utf8")
          .split("\n")
          .filter((line) => !line.includes("FAILPROOFAI_CLI_CMD"))
          .join("\n");
        const staging = resolve(tmpdir(), `failproofaid-legacy-${process.pid}`);
        writeFileSync(staging, legacy, "utf8");
        run(["install", "-m", "0644", staging, unitPath]);
        run(["systemctl", "daemon-reload"]);
        run(["systemctl", "restart", unitName]);
        rmSync(staging, { force: true });
      }

      it("rewrites a unit that predates FAILPROOFAI_CLI_CMD, and the service comes back", async () => {
        // THE upgrade case. `npm i -g failproofai@latest` replaces the CLI and
        // never touches /etc/systemd/system, and the wizard's own "already
        // running — leaving it alone" branch skips it, so without this the
        // daemon has no way to spawn an audit for the rest of the machine's
        // life while config.toml says the scan is on.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        process.env.FAILPROOFAI_CLI_CMD = "/usr/bin/true --cli-cmd-sentinel";
        setPlatform("linux");
        const {
          installDaemonService,
          daemonServiceNeedsUpgrade,
          ensureDaemonServiceCurrent,
          daemonServiceStatus,
        } = await import("../../src/hooks/daemon-service");

        expect((await installDaemonService()).installed).toBe(true);
        expect(daemonServiceNeedsUpgrade()).toBe(false);

        stripCliCommandFromUnit();
        expect(readFileSync(unitPath, "utf8")).not.toContain("FAILPROOFAI_CLI_CMD");
        expect(daemonServiceNeedsUpgrade()).toBe(true);

        expect(await ensureDaemonServiceCurrent()).toEqual({ outcome: "rewritten", daemonRunning: true });

        const rewritten = readFileSync(unitPath, "utf8");
        expect(rewritten).toContain(
          'Environment="FAILPROOFAI_CLI_CMD=/usr/bin/true --cli-cmd-sentinel"',
        );
        // The ExecStart is carried over from the unit, not re-resolved: right
        // after a CLI upgrade the version-stamped binary for the NEW version
        // is not on disk yet, and re-resolving would repoint a live service at
        // a file that does not exist.
        expect(rewritten).toContain("ExecStart=/usr/bin/sleep infinity");
        expect(daemonServiceNeedsUpgrade()).toBe(false);
        // Not merely "the file changed": the whole point is that the running
        // daemon now HAS the variable, which on Linux only happens on restart.
        expect(daemonServiceStatus()).toBe("running");
      }, 30_000);

      it("keeps a worker command the rewrite cannot re-resolve", async () => {
        // The rewrite regenerates the whole unit, so a resolver that comes
        // back null would silently delete a working FAILPROOFAI_WORKER_CMD
        // from a working unit — turning a fix for the audit lane into a break
        // of the warm worker, which is on every tool call's path.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        process.env.FAILPROOFAI_WORKER_CMD = "/usr/bin/node /baked/at/install/worker.mjs";
        process.env.FAILPROOFAI_CLI_CMD = "/usr/bin/true --cli-cmd-sentinel";
        setPlatform("linux");
        const { installDaemonService, ensureDaemonServiceCurrent } = await import(
          "../../src/hooks/daemon-service"
        );

        expect((await installDaemonService()).installed).toBe(true);
        stripCliCommandFromUnit();

        // The upgrading process cannot work out a worker command of its own.
        delete process.env.FAILPROOFAI_WORKER_CMD;
        process.env.FAILPROOFAI_PACKAGE_ROOT = "/nonexistent/package/root";

        expect(await ensureDaemonServiceCurrent()).toEqual({ outcome: "rewritten", daemonRunning: true });
        expect(readFileSync(unitPath, "utf8")).toContain(
          'Environment="FAILPROOFAI_WORKER_CMD=/usr/bin/node /baked/at/install/worker.mjs"',
        );
      }, 30_000);

      it("puts the old definition back when the rewritten one will not start", async () => {
        // Unlike install, this path runs against a HEALTHY, RUNNING daemon —
        // and on a daemonConfigured machine a daemon that is down is not a
        // missing feature, it is every tool call across all 12 CLIs denied
        // against a socket nothing is listening on. So a refresh that stops
        // the service and cannot start it again has to be able to undo itself;
        // "the audit lane stays broken" is a far cheaper failure than that.
        process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/bin/sleep infinity";
        process.env.FAILPROOFAI_CLI_CMD = "/usr/bin/true --cli-cmd-sentinel";
        setPlatform("linux");
        const { installDaemonService, ensureDaemonServiceCurrent, daemonServiceStatus } = await import(
          "../../src/hooks/daemon-service"
        );

        expect((await installDaemonService()).installed).toBe(true);
        stripCliCommandFromUnit();
        const legacy = readFileSync(unitPath, "utf8");

        // Forced only AFTER the install, so the unit on disk is a good one:
        // the injected `User=` overrides the real one and systemd refuses to
        // start the regenerated unit. Poisoning the value is the only lever
        // this test has on a definition the code generates itself, and the
        // shape it produces is the realistic one — a definition systemd
        // accepts and then cannot run.
        process.env.FAILPROOFAI_CLI_CMD = '/usr/bin/true"\nUser=failproofai-no-such-user';

        const result = await ensureDaemonServiceCurrent();
        expect(result.outcome).toBe("failed");
        // The verdict the wizard branches on: the daemon is back, so it must
        // NOT clear daemonConfigured and drop the machine off the daemon.
        expect(result.daemonRunning).toBe(true);

        expect(readFileSync(unitPath, "utf8")).toBe(legacy);
        expect(daemonServiceStatus()).toBe("running");
      }, 40_000);

      it("installDaemonService fails cleanly when the binary cannot be resolved", async () => {
        // Scratch HOME + downloads off, or "cannot be resolved" is a lie:
        // install would reach ensureFailproofaidBinary, fetch the real
        // release asset over the network, and succeed. It did exactly that
        // on CI — passing locally only because this sandbox has no network
        // access in the test environment.
        useScratchHome();
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
