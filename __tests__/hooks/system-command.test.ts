// @vitest-environment node
/**
 * Programs failproofai runs as root are found in root's own directories, never
 * through PATH, and start with root's PATH rather than the caller's
 * environment.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  SYSTEM_BIN_DIRS,
  SYSTEM_PATH,
  privilegedEnv,
  requireSystemCommand,
  sudoCommandLine,
  sudoPath,
  systemCommandPath,
} from "../../src/hooks/system-command";

const KEYS = ["PATH", "SUDO_ASKPASS", "BASH_ENV", "LANG", "TERM", "SSH_AUTH_SOCK", "KRB5CCNAME"] as const;

describe("system-command", () => {
  const saved = new Map<string, string | undefined>();
  let planted: string;

  beforeEach(() => {
    for (const key of KEYS) saved.set(key, process.env[key]);
    // Programs of the same names first on PATH.
    planted = mkdtempSync(resolve(tmpdir(), "fpai-planted-"));
    for (const name of ["sudo", "sh", "failproofai-only-on-path"]) {
      writeFileSync(resolve(planted, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    process.env.PATH = `${planted}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(planted, { recursive: true, force: true });
  });

  it("finds a program only in root's own directories, never through PATH", () => {
    expect(SYSTEM_BIN_DIRS).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(SYSTEM_PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");

    const sh = systemCommandPath("sh");
    expect(sh).not.toBeNull();
    expect(SYSTEM_BIN_DIRS).toContain(dirname(sh!));
    const sudo = systemCommandPath("sudo");
    if (sudo) expect(SYSTEM_BIN_DIRS).toContain(dirname(sudo));
    expect(sudo).not.toBe(resolve(planted, "sudo"));

    // Only on PATH: not found at all, rather than found there.
    expect(systemCommandPath("failproofai-only-on-path")).toBeNull();
    expect(() => requireSystemCommand("failproofai-only-on-path")).toThrow(/not found in \/usr\/bin, \/bin/);
    // A name, never a path.
    expect(systemCommandPath("../bin/sh")).toBeNull();
    expect(systemCommandPath(`${planted}/sudo`)).toBeNull();
  });

  it("starts privileged commands with root's PATH and what sudo itself uses, nothing else", () => {
    process.env.SUDO_ASKPASS = resolve(planted, "sudo");
    process.env.BASH_ENV = resolve(planted, "sh");
    process.env.LANG = "C.UTF-8";
    process.env.TERM = "xterm-256color";
    // What PAM modules authenticate sudo with on some fleets.
    process.env.SSH_AUTH_SOCK = "/run/user/1000/ssh-agent.socket";
    process.env.KRB5CCNAME = "KCM:";

    const env = privilegedEnv();

    expect(env.PATH).toBe(SYSTEM_PATH);
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.SSH_AUTH_SOCK).toBe("/run/user/1000/ssh-agent.socket");
    expect(env.KRB5CCNAME).toBe("KCM:");
    expect(env).not.toHaveProperty("SUDO_ASKPASS");
    expect(env).not.toHaveProperty("BASH_ENV");
    const allowed = ["PATH", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "SSH_AUTH_SOCK", "KRB5CCNAME"];
    expect(Object.keys(env).every((key) => allowed.includes(key))).toBe(true);
  });

  it("prints sudo and the program by absolute path, and the bare name where root has none", () => {
    expect(sudoCommandLine("sh", "-c", "'true'")).toBe(`${sudoPath()} ${systemCommandPath("sh")} -c 'true'`);
    expect(sudoCommandLine("failproofai-only-on-path", "-x")).toBe(`${sudoPath()} failproofai-only-on-path -x`);
    expect(sudoPath()).toBe(systemCommandPath("sudo") ?? "sudo");
  });
});
