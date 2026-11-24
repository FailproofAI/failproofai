// @vitest-environment node
/**
 * Everything root writes for the daemon service (the systemd unit, the launchd
 * plist, the copy of the binary under /opt) must reach root as bytes, never as
 * a path the user can write, and must land exactly as failproofai produced it;
 * and sudo, and every program it runs, must be named by absolute path rather
 * than found through PATH.
 *
 * The install tests stand in for sudo with a mock that runs each privileged
 * command as this (unprivileged) user, after changing any file under the
 * user's home or temp directory that the command names: root must be handed
 * none, so none of those changes may reach what is installed. No real sudo
 * runs anywhere in this file, and nothing outside its scratch directory is
 * written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync as realExecFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { installedBinaryPath } from "../../src/hooks/daemon-download";
import { logsDir } from "../../src/hooks/fp-home";
import { shellQuote } from "../../src/hooks/shell-quote";
import packageJson from "../../package.json";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogWarn: vi.fn(),
  hookLogInfo: vi.fn(),
}));

type DaemonService = typeof import("../../src/hooks/daemon-service");
type SystemCommand = typeof import("../../src/hooks/system-command");

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** What the managed daemon binary holds. */
const BINARY = "#!/bin/sh\nexec sleep infinity\n";
/** Some file other than the ones failproofai wrote. */
const OTHER = "the content of some other file\n";
/** What a file failproofai wrote is changed to. */
const CHANGED = "changed after failproofai wrote it\n";
const WORKER = "'/usr/bin/node' '/pkg/dist/worker.mjs'";
const CLI = "'/usr/bin/node' '/pkg/dist/cli.mjs'";

const ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SUDO_ASKPASS",
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_SYSTEMD_DIR",
  "FAILPROOFAI_SYSTEM_BIN_DIR",
  "FAILPROOFAI_LAUNCHD_DIR",
  "FAILPROOFAI_DAEMON_BINARY",
  "FAILPROOFAI_PACKAGE_ROOT",
  "FAILPROOFAI_WORKER_CMD",
  "FAILPROOFAI_CLI_CMD",
  "FAILPROOFAI_NO_DOWNLOAD",
] as const;

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

/** Imported where used, so a test that does not need it still runs on its own. */
async function systemCommand(): Promise<SystemCommand> {
  return import("../../src/hooks/system-command");
}

// Meaningless as root, where nothing goes through sudo.
describe.skipIf(isRoot)("privileged service install: root is handed bytes, never a user path", () => {
  const originalPlatform = process.platform;
  const saved = new Map<string, string | undefined>();
  let scratch: string;
  /** The user's home and temp directory: anything running as the user can change them. */
  let home: string;
  let userTmp: string;
  /** Stands in for the directories only root can write. */
  let rootDir: string;
  let otherPath: string;

  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    scratch = mkdtempSync(resolve(tmpdir(), "fpai-priv-install-"));
    // A space in the home, as on many Macs: every path in a recipe is quoted.
    home = resolve(scratch, "first last");
    userTmp = resolve(scratch, "user-tmp");
    rootDir = resolve(scratch, "root");
    for (const dir of [home, userTmp, resolve(rootDir, "systemd"), resolve(rootDir, "LaunchDaemons")]) {
      mkdirSync(dir, { recursive: true });
    }
    otherPath = resolve(rootDir, "other");
    writeFileSync(otherPath, OTHER);

    process.env.HOME = home;
    process.env.TMPDIR = userTmp;
    process.env.FAILPROOFAI_HOME = resolve(home, ".failproofai");
    process.env.FAILPROOFAI_SYSTEMD_DIR = resolve(rootDir, "systemd");
    process.env.FAILPROOFAI_SYSTEM_BIN_DIR = resolve(rootDir, "opt");
    process.env.FAILPROOFAI_LAUNCHD_DIR = resolve(rootDir, "LaunchDaemons");
    process.env.FAILPROOFAI_WORKER_CMD = WORKER;
    process.env.FAILPROOFAI_CLI_CMD = CLI;
    // Nothing here may reach the network.
    process.env.FAILPROOFAI_NO_DOWNLOAD = "1";
    delete process.env.FAILPROOFAI_DAEMON_BINARY;
    delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../src/hooks/system-command");
    vi.doUnmock("../../package.json");
    vi.resetModules();
    setPlatform(originalPlatform);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The binary failproofai installed for this version, under the user's home. */
  function writeManagedBinary(): string {
    const path = installedBinaryPath();
    expect(path.startsWith(`${home}/`)).toBe(true);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BINARY, { mode: 0o755 });
    return path;
  }

  /** The arguments of a privileged command that name something under the user's home or temp directory. */
  function userWritable(argv: readonly string[]): string[] {
    return argv.filter((arg) => arg.startsWith(`${home}/`) || arg.startsWith(`${userTmp}/`));
  }

  interface RootCall {
    /** How sudo itself was named. */
    sudo: string;
    /** What it was asked to run, `-n` taken off. */
    argv: string[];
    input?: Buffer;
    env?: NodeJS.ProcessEnv;
  }
  type BeforeRoot = (call: RootCall, options: ExecFileSyncOptions) => void;

  /**
   * Stands in for sudo: runs each privileged command as this user, after
   * `beforeRoot` has had its turn. `elevate: false` is a machine where sudo
   * cannot run anything; `warmUp: true` one where it can only after `sudo -v`.
   * `onElevate` runs at each `sudo -n true`, the check made just before the
   * install starts copying.
   */
  function mockSudo(
    opts: { beforeRoot?: BeforeRoot; elevate?: boolean; warmUp?: boolean; onElevate?: () => void } = {},
  ): RootCall[] {
    const calls: RootCall[] = [];
    let warm = !opts.warmUp;
    standInSystemPrograms();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[] = [], options: ExecFileSyncOptions = {}) => {
          if (basename(cmd) === "sudo") {
            const argv = args[0] === "-n" ? args.slice(1) : [...args];
            const call: RootCall = {
              sudo: cmd,
              argv,
              input: Buffer.isBuffer(options.input) ? options.input : undefined,
              env: options.env,
            };
            calls.push(call);
            if (opts.elevate === false) throw new Error("sudo: a password is required");
            if (argv[0] === "-v") {
              warm = true;
              return Buffer.alloc(0);
            }
            if (!warm) throw new Error("sudo: a password is required");
            if (argv.length === 1 && basename(argv[0]) === "true") {
              opts.onElevate?.();
              return Buffer.alloc(0);
            }
            opts.beforeRoot?.(call, options);
            switch (basename(argv[0])) {
              case "install":
              case "mv":
              case "rm":
              case "sh":
                return actual.execFileSync(argv[0], argv.slice(1), options);
              case "systemctl":
              case "restorecon":
                return Buffer.alloc(0);
              case "launchctl":
                return Buffer.from(argv[1] === "print" ? "state = running\n" : "");
              default:
                throw new Error(`unexpected privileged command: ${argv.join(" ")}`);
            }
          }
          if (basename(cmd) === "systemctl" && args[0] === "is-active") return Buffer.from("active\n");
          throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
        },
      };
    });
    return calls;
  }

  /**
   * The install looks programs up only in root's own directories, and a test
   * machine may lack some: launchctl on Linux, systemctl on a Mac or in a
   * container, sudo itself. Each of these the sudo mock answers for without
   * running it, so where one is missing a path stands in for it. Programs the
   * mock does run (install, mv, rm, sh) are always the machine's own.
   */
  function standInSystemPrograms(): void {
    const answered = new Set(["sudo", "true", "systemctl", "launchctl", "restorecon"]);
    vi.doMock("../../src/hooks/system-command", async (importOriginal) => {
      const actual = await importOriginal<SystemCommand>();
      return {
        ...actual,
        requireSystemCommand: (name: string) =>
          actual.systemCommandPath(name) ?? (answered.has(name) ? `/usr/bin/${name}` : actual.requireSystemCommand(name)),
      };
    });
  }

  /**
   * Before each privileged command, every file under the user's home or temp
   * directory that the command names is changed: replaced by a link to OTHER,
   * or rewritten.
   */
  function changeUserFiles(how: "link" | "rewrite"): BeforeRoot {
    return (call) => {
      for (const path of userWritable(call.argv)) {
        if (!existsSync(path) || !lstatSync(path).isFile()) continue;
        if (how === "link") {
          unlinkSync(path);
          symlinkSync(otherPath, path);
        } else {
          writeFileSync(path, CHANGED);
        }
      }
    };
  }

  async function loadService(): Promise<DaemonService> {
    return import("../../src/hooks/daemon-service");
  }

  const changes: ("link" | "rewrite")[] = ["link", "rewrite"];
  describe.each(changes)("while user files are changed (%s)", (how) => {
    it("linux: the unit and the /opt binary are exactly what failproofai produced", async () => {
      setPlatform("linux");
      const managed = writeManagedBinary();
      const calls = mockSudo({ beforeRoot: changeUserFiles(how) });
      const svc = await loadService();
      const target = svc.systemBinaryTarget(managed)!;
      expect(target.startsWith(`${rootDir}/`)).toBe(true);

      expect(await svc.installDaemonService()).toEqual({ installed: true });

      // Root was handed nothing under the user's home or temp directory.
      expect(calls.flatMap((call) => userWritable(call.argv))).toEqual([]);
      expect(readFileSync(target, "utf8")).toBe(BINARY);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      const unitPath = svc.daemonServiceFilePath()!;
      expect(readFileSync(unitPath, "utf8")).toBe(svc.systemdUnitContents(target, WORKER, CLI));
      expect(statSync(unitPath).mode & 0o777).toBe(0o644);
      // Nothing staged is left beside either.
      expect(readdirSync(dirname(unitPath))).toEqual([basename(unitPath)]);
      expect(readdirSync(dirname(target))).toEqual([basename(target)]);
      expect(filesUnder(rootDir).filter((p) => p !== otherPath).map((p) => readFileSync(p, "utf8"))).not.toContain(
        OTHER,
      );
    }, 20_000);

    it("macOS: the plist is exactly what failproofai rendered, and launchd loads it after it is in place", async () => {
      setPlatform("darwin");
      const managed = writeManagedBinary();
      const calls = mockSudo({ beforeRoot: changeUserFiles(how) });
      const svc = await loadService();

      expect(await svc.installDaemonService()).toEqual({ installed: true });

      expect(calls.flatMap((call) => userWritable(call.argv))).toEqual([]);
      const plistPath = svc.daemonServiceFilePath()!;
      expect(plistPath).toBe(
        resolve(rootDir, "LaunchDaemons", `ai.failproof.failproofaid.${userInfo().username}.plist`),
      );
      expect(readFileSync(plistPath, "utf8")).toBe(svc.launchdPlistContents(managed, logsDir(), WORKER, CLI));
      expect(statSync(plistPath).mode & 0o777).toBe(0o644);
      expect(readdirSync(dirname(plistPath))).toEqual([basename(plistPath)]);
      const write = calls.findIndex((call) => basename(call.argv[0]) === "sh" && call.argv.includes(plistPath));
      const load = calls.findIndex((call) => basename(call.argv[0]) === "launchctl" && call.argv[1] === "load");
      expect(write).toBeGreaterThanOrEqual(0);
      expect(load).toBeGreaterThan(write);
    }, 20_000);
  });

  it("linux: refuses a daemon binary that is a symbolic link, and copies nothing", async () => {
    setPlatform("linux");
    const managed = installedBinaryPath();
    mkdirSync(dirname(managed), { recursive: true });
    symlinkSync(otherPath, managed);
    mockSudo();
    const svc = await loadService();

    const result = await svc.installDaemonService();

    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/symbolic link/);
    expect(filesUnder(rootDir).filter((p) => p !== otherPath).map((p) => readFileSync(p, "utf8"))).not.toContain(
      OTHER,
    );
    expect(existsSync(svc.daemonServiceFilePath()!)).toBe(false);
  });

  it("linux: installs under /opt only the binary bytes this build recorded, even if the file changes once checked", async () => {
    setPlatform("linux");
    writeManagedBinary();
    // The digest a published build records for its own platform binary.
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const manifest = { ...packageJson, failproofaidBinaries: { [`linux-${arch}`]: sha256(BINARY) } };
    vi.doMock("../../package.json", () => ({ ...manifest, default: manifest }));
    // Checked once before the install starts copying, then changed.
    mockSudo({ onElevate: () => writeFileSync(installedBinaryPath(), CHANGED) });
    const svc = await loadService();

    const result = await svc.installDaemonService();

    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/expects [0-9a-f]{64}/);
    expect(filesUnder(rootDir).filter((p) => p !== otherPath)).toEqual([]);
  });

  it("never runs a sudo or a program that PATH finds first, credential warm-up included, and gives sudo root's PATH", async () => {
    setPlatform("linux");
    writeManagedBinary();
    // Programs of the same names first on PATH, in a directory the user owns.
    // Each leaves a mark if it ever runs.
    const planted = resolve(home, ".local", "bin");
    const marks = resolve(scratch, "marks");
    mkdirSync(planted, { recursive: true });
    mkdirSync(marks);
    const names = ["sudo", "install", "mv", "rm", "sh", "systemctl", "restorecon", "true", "mktemp", "cat", "chmod", "sha256sum"];
    for (const name of names) {
      writeFileSync(resolve(planted, name), `#!/bin/sh\n: > '${resolve(marks, name)}'\nexit 1\n`, { mode: 0o755 });
    }
    process.env.PATH = `${planted}:${process.env.PATH ?? ""}`;
    process.env.SUDO_ASKPASS = resolve(planted, "sudo");
    const calls = mockSudo({ warmUp: true });
    const sys = await systemCommand();
    const svc = await loadService();

    // The wizard's warm-up: the one place the user types their password.
    expect(svc.primeElevation()).toBe(true);
    expect(calls.some((call) => call.argv[0] === "-v")).toBe(true);
    expect(await svc.installDaemonService()).toEqual({ installed: true });

    expect(readdirSync(marks)).toEqual([]);
    for (const call of calls) {
      expect(call.sudo).toBe(sys.requireSystemCommand("sudo"));
      if (call.argv[0] !== "-v") expect(sys.SYSTEM_BIN_DIRS).toContain(dirname(call.argv[0]));
      expect(call.env?.PATH).toBe(sys.SYSTEM_PATH);
      expect(call.env).not.toHaveProperty("SUDO_ASKPASS");
    }
  }, 20_000);

  const alterations: [string, (bytes: Buffer) => Buffer][] = [
    ["appended to", (bytes) => Buffer.concat([bytes, Buffer.from(CHANGED)])],
    ["substituted for", () => Buffer.from(CHANGED)],
  ];
  describe.each(alterations)("bytes %s what failproofai sent on the way to root", (_what, alter) => {
    it("are refused, and the destination keeps what it had", async () => {
      const dest = resolve(rootDir, "systemd", "x.service");
      writeFileSync(dest, "previous\n");
      mockSudo({
        beforeRoot: (_call, options) => {
          if (Buffer.isBuffer(options.input)) options.input = alter(options.input);
        },
      });
      const { writePrivilegedFile } = await loadService();

      expect(() => writePrivilegedFile(dest, "[Unit]\nDescription=x\n")).toThrow(/do not match sha256/);
      expect(readFileSync(dest, "utf8")).toBe("previous\n");
      expect(readdirSync(dirname(dest))).toEqual(["x.service"]);
    });
  });

  it("refuses a relative destination or a mode that is not octal, before anything runs", async () => {
    const calls = mockSudo();
    const { writePrivilegedFile } = await loadService();
    expect(() => writePrivilegedFile("etc/x.service", "x\n")).toThrow(/relative path/);
    expect(() => writePrivilegedFile(resolve(rootDir, "x"), "x\n", "u+s")).toThrow(/mode/);
    expect(calls).toEqual([]);
  });

  describe("the manual recipe printed when sudo is not available", () => {
    /**
     * A stand-in sudo, at a path of its own: it runs the command as this user,
     * and does nothing for the service managers.
     */
    function fakeSudo(): string {
      const dir = resolve(scratch, "fake-bin");
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, "sudo");
      writeFileSync(
        path,
        [
          "#!/bin/sh",
          "while [ $# -gt 0 ]; do case $1 in -*) shift ;; *) break ;; esac; done",
          'case "${1##*/}" in systemctl|launchctl|restorecon) exit 0 ;; esac',
          'exec "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return path;
    }

    async function printedRecipe(platform: NodeJS.Platform): Promise<{ recipe: string; svc: DaemonService }> {
      setPlatform(platform);
      mockSudo({ elevate: false });
      const svc = await loadService();
      const result = await svc.installDaemonService();
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/root privileges are required/);
      const marker = "To install by hand, run:\n";
      expect(result.reason).toContain(marker);
      return { recipe: result.reason!.slice(result.reason!.indexOf(marker) + marker.length), svc };
    }

    /**
     * Runs the recipe as pasted, with the stand-in in place of every sudo it
     * names. Refuses to run one that still names a real sudo.
     */
    async function runRecipe(recipe: string): Promise<{ status: number; stderr: string }> {
      const sudo = (await systemCommand()).sudoPath();
      const stand = fakeSudo();
      const runnable = sudo.startsWith("/") ? recipe.split(`${sudo} `).join(`${stand} `) : recipe;
      if (sudo.startsWith("/")) expect(runnable).not.toContain(sudo);
      try {
        realExecFileSync("/bin/sh", ["-c", runnable], {
          env: { ...process.env, PATH: `${dirname(stand)}:/usr/bin:/bin` },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 30_000,
        });
        return { status: 0, stderr: "" };
      } catch (err) {
        const e = err as { status?: number | null; stderr?: Buffer };
        return { status: e.status ?? -1, stderr: e.stderr?.toString() ?? "" };
      }
    }

    it("linux: installs exactly the binary and unit the install would, run as printed", async () => {
      const managed = writeManagedBinary();
      const { recipe, svc } = await printedRecipe("linux");
      const sys = await systemCommand();
      const target = svc.systemBinaryTarget(managed)!;
      // Rendered before the recipe runs, as the recipe's own copy was.
      const unit = svc.systemdUnitContents(target, WORKER, CLI);

      // Root reads the binary from stdin; the user's shell opens it.
      expect(recipe).toContain(`< '${managed}'`);
      expect(recipe).not.toMatch(/sudo (install -m|tee|cp) /);
      // sudo and the programs it runs, by absolute path.
      expect(recipe).toContain(sys.sudoCommandLine("systemctl", "daemon-reload"));

      expect(await runRecipe(recipe)).toEqual({ status: 0, stderr: "" });
      expect(readFileSync(target, "utf8")).toBe(BINARY);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(readFileSync(svc.daemonServiceFilePath()!, "utf8")).toBe(unit);
    });

    it("linux: stops before any unit is written when the binary changed after it was printed", async () => {
      const managed = writeManagedBinary();
      const { recipe, svc } = await printedRecipe("linux");

      writeFileSync(managed, CHANGED);
      const { status, stderr } = await runRecipe(recipe);

      expect(status).not.toBe(0);
      expect(stderr).toMatch(/do not match sha256/);
      expect(existsSync(svc.systemBinaryTarget(managed)!)).toBe(false);
      expect(existsSync(svc.daemonServiceFilePath()!)).toBe(false);
    });

    it("macOS: carries the plist inline and installs exactly it, run as printed", async () => {
      const managed = writeManagedBinary();
      const { recipe, svc } = await printedRecipe("darwin");
      const plist = svc.launchdPlistContents(managed, logsDir(), WORKER, CLI);

      // Single-quoted, never a here-document: zsh (the macOS default) expands
      // `!` in a here-document's body, and the plist has `<!DOCTYPE`.
      expect(recipe).toContain(`printf '%s' ${shellQuote(plist)} | failproofai_install`);
      expect(recipe).not.toMatch(/<<-?\s*['"]?\w/);
      expect(recipe).toContain(sha256(plist));

      expect(await runRecipe(recipe)).toEqual({ status: 0, stderr: "" });
      const plistPath = svc.daemonServiceFilePath()!;
      expect(readFileSync(plistPath, "utf8")).toBe(plist);
      expect(statSync(plistPath).mode & 0o777).toBe(0o644);
      expect(existsSync(logsDir())).toBe(true);
    });
  });
});

describe("PRIVILEGED_INSTALL_SCRIPT", () => {
  /** Whether root's fixed PATH has `tool`. */
  function has(tool: string): boolean {
    try {
      realExecFileSync("/bin/sh", ["-c", `PATH=/usr/bin:/bin:/usr/sbin:/sbin; command -v ${tool}`], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  // Each later branch is forced by naming the tools before it as ones no
  // system has: Linux runners have all three, macOS has the last two.
  const NONE = "command -v failproofai-no-such-tool";
  const variants: [string, (script: string) => string][] = [
    ["sha256sum", (s) => s],
    ["shasum", (s) => s.replace("command -v sha256sum", NONE)],
    ["openssl", (s) => s.replace("command -v sha256sum", NONE).replace("command -v shasum", NONE)],
  ];

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fpai-priv-script-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(script: string, dest: string, digest: string, mode: string, input: Buffer): void {
    realExecFileSync("/bin/sh", ["-c", script, "failproofai-install", dest, digest, mode], {
      input,
      stdio: ["pipe", "ignore", "pipe"],
    });
  }

  for (const [tool, edit] of variants) {
    it.skipIf(!has(tool))(`with ${tool}: installs exactly the bytes, with the mode, and refuses any others`, async () => {
      const { PRIVILEGED_INSTALL_SCRIPT } = await import("../../src/hooks/daemon-service");
      const script = edit(PRIVILEGED_INSTALL_SCRIPT);
      if (tool !== "sha256sum") expect(script).not.toContain("command -v sha256sum");
      // Binary-safe: a NUL, a lone CR, no trailing newline.
      const bytes = Buffer.from([0, 1, 2, 255, 13, 10, 65]);
      const dest = resolve(dir, "file");

      run(script, dest, sha256(bytes), "0640", bytes);
      expect(readFileSync(dest).equals(bytes)).toBe(true);
      expect(statSync(dest).mode & 0o777).toBe(0o640);

      expect(() =>
        run(script, resolve(dir, "other"), sha256(bytes), "0640", Buffer.concat([bytes, Buffer.from("x")])),
      ).toThrow();
      expect(() => run(script, dest, sha256(bytes), "0640", Buffer.from("x"))).toThrow();
      // The refused writes left nothing behind, and the earlier file as it was.
      expect(readdirSync(dir)).toEqual(["file"]);
      expect(readFileSync(dest).equals(bytes)).toBe(true);
    });
  }

  it("never contains a single quote, so a recipe can quote it verbatim", async () => {
    const { PRIVILEGED_INSTALL_SCRIPT } = await import("../../src/hooks/daemon-service");
    expect(PRIVILEGED_INSTALL_SCRIPT).not.toContain("'");
  });
});
