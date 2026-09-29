/**
 * Crash-safe writes for configuration files that belong to someone else.
 *
 * Every agent integration edits a file the user's agent reads on startup:
 * `~/.claude/settings.json`, `~/.hermes/config.yaml`, `~/.openclaw/openclaw.json`
 * and the rest. A plain `writeFileSync` truncates that file first and fills it
 * second, so a crash, a full disk or a killed process in between leaves the agent
 * with a half-written config — for Hermes that is a gateway that will not start.
 * And a later install then refuses to touch the file because it no longer parses,
 * so nothing repairs it.
 *
 * So the new content never goes near the live file until it is complete and on
 * disk:
 *
 *   1. write it to a uniquely named temporary file in the SAME directory (a
 *      rename is only atomic within one filesystem),
 *   2. fsync that file,
 *   3. copy the current file to `<name>.failproofai-backup` — the last version
 *      before failproofai changed it, for a person to restore by hand,
 *   4. rename the temporary file over the live one (atomic on POSIX, and a
 *      replacing move on Windows), then fsync the directory so the rename
 *      itself survives a power cut.
 *
 * Any failure before step 4 leaves the live file exactly as it was and removes
 * the temporary file. The file keeps its permission bits (Hermes keeps
 * `config.yaml` at 0600), and a config that is a symlink — a dotfiles checkout —
 * is written through to its target rather than replaced by a regular file.
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Where the copy of the previous version is kept, beside the file itself. */
export function configBackupPath(path: string): string {
  return `${resolveWriteTarget(path)}.failproofai-backup`;
}

/** Hooks for tests to simulate an interruption at the one step that matters. */
export interface AtomicWriteDeps {
  rename?: (from: string, to: string) => void;
  /** Keep `<name>.failproofai-backup` of the previous version (default true). */
  backup?: boolean;
  /**
   * What to do when the path is a symlink. `follow` (default) writes through to
   * the target — right for a user's config, which is read and parsed before it
   * is written and may live in a dotfiles checkout. `replace` swaps the link
   * itself for the new file and never touches what it pointed at — right for a
   * file failproofai generates and fully owns (a plugin shim, an ownership
   * record), which is written without being read, so a planted link must not
   * steer the write into another file.
   */
  symlinks?: "follow" | "replace";
}

/** A config that is a symlink to nothing: writing would either replace the link or create a file somewhere unknown. */
export class DanglingConfigSymlinkError extends Error {
  constructor(readonly path: string, readonly target: string) {
    super(
      `Refusing to write ${path}: it is a symlink to ${target}, which does not exist. ` +
        `Fix or remove the link, then retry — failproofai will not replace it with a regular file.`,
    );
    this.name = "DanglingConfigSymlinkError";
  }
}

/**
 * A symlinked config is written through to what it points at, so a dotfiles
 * checkout keeps its link. A link whose target does not exist is refused: the
 * rename would replace the link with a regular file (silently detaching the
 * dotfiles), and creating the target instead would write wherever the link
 * says — a path a cloned repository can choose for a project-scoped config.
 */
function resolveWriteTarget(path: string): string {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return path; // absent: a new file at the path as given
  }
  if (!isLink) return path;
  try {
    return realpathSync(path);
  } catch {
    let target = "(unreadable link)";
    try {
      target = readlinkSync(path);
    } catch {
      // keep the placeholder
    }
    throw new DanglingConfigSymlinkError(path, target);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Keep the previous version beside the file without ever following a link that
 * sits where the backup goes. `copyFileSync` onto `<name>.failproofai-backup`
 * would write THROUGH a symlink planted there — for a project-scoped config
 * inside a cloned repository, into any file the user can write. So the copy
 * goes to a fresh, exclusively created temp file and is renamed over the backup
 * path: a rename replaces a symlink, it does not follow one.
 */
function writeBackup(target: string, dir: string): void {
  const backup = `${target}.failproofai-backup`;
  const temporary = join(dir, `.${basename(target)}.failproofai-backup-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    copyFileSync(target, temporary, fsConstants.COPYFILE_EXCL);
    renameSync(temporary, backup);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

export function writeConfigFileAtomic(path: string, content: string, deps: AtomicWriteDeps = {}): void {
  const replacingLink = deps.symlinks === "replace" && isSymlink(path);
  const target = deps.symlinks === "replace" ? path : resolveWriteTarget(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  let mode: number | undefined;
  try {
    // A link being replaced lends nothing: its target's mode is someone else's.
    mode = replacingLink ? undefined : statSync(target).mode & 0o777;
  } catch {
    mode = undefined; // a new file: the process umask decides, as writeFileSync would
  }

  const temporary = join(dir, `.${basename(target)}.failproofai-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", mode ?? 0o666);
    const bytes = Buffer.from(content, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // `open` applies the umask; the live file's own bits are what should survive.
    if (mode !== undefined) chmodSync(temporary, mode);

    if (deps.backup !== false && !replacingLink && existsSync(target)) writeBackup(target, dir);

    (deps.rename ?? renameSync)(temporary, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed or never opened
      }
    }
    rmSync(temporary, { force: true });
    throw err;
  }

  // Make the rename itself durable. Not supported on every platform (Windows
  // cannot open a directory); the file content is already safe either way.
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // best effort
  }
}
