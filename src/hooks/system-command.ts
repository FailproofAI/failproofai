/**
 * How failproofai names the programs it runs as root: by absolute path, from
 * root's own directories, with a minimal environment. Never through PATH.
 *
 * PATH and the rest of the caller's environment belong to the user, and sudo
 * may look programs up in that PATH too. Root's programs, and the sudo the user
 * types their password into, come from root's own directories instead.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";

/** Root's own program directories, in lookup order. */
export const SYSTEM_BIN_DIRS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The PATH every privileged command runs with. */
export const SYSTEM_PATH = SYSTEM_BIN_DIRS.join(":");

/**
 * The absolute path of a system program such as `sudo`, `systemctl`,
 * `launchctl` or `install`, from {@link SYSTEM_BIN_DIRS} only, or null when
 * none of them has it.
 */
export function systemCommandPath(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  for (const dir of SYSTEM_BIN_DIRS) {
    const candidate = `${dir}/${name}`;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not in this directory: try the next.
    }
  }
  return null;
}

/** {@link systemCommandPath}, or an error that says where it looked. */
export function requireSystemCommand(name: string): string {
  const path = systemCommandPath(name);
  if (!path) throw new Error(`${name} was not found in ${SYSTEM_BIN_DIRS.join(", ")}`);
  return path;
}

/**
 * The caller's settings sudo itself may need: the terminal type and locale for
 * its prompt, and the SSH agent socket and Kerberos credential cache that PAM
 * modules such as pam_ssh_agent_auth and pam_sss_gss authenticate with. None of
 * them names code to run.
 */
const PASSED_THROUGH = ["TERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "SSH_AUTH_SOCK", "KRB5CCNAME"] as const;

/**
 * The environment every privileged command starts with: root's PATH, plus the
 * few settings above that sudo's own prompt and authentication use. Nothing
 * else of the caller's reaches sudo or what it runs: no PATH, no loader or
 * shell variables, no `SUDO_ASKPASS` or `SUDO_PROMPT`.
 */
export function privilegedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH };
  for (const key of PASSED_THROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** `sudo` as printed for someone to run: its absolute path, or the bare name where there is none. */
export function sudoPath(): string {
  return systemCommandPath("sudo") ?? "sudo";
}

/**
 * A privileged command as printed for someone to run: `sudo` and the program
 * by absolute path where root's directories have them, the bare names where
 * they do not. `args` are pasted as given, so the caller quotes them.
 */
export function sudoCommandLine(command: string, ...args: string[]): string {
  return [sudoPath(), systemCommandPath(command) ?? command, ...args].join(" ");
}
