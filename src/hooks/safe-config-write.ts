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
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
}

/** A symlinked config is written through to what it points at. */
function resolveWriteTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch {
    // Absent or unreadable: write to the path as given.
  }
  return path;
}

export function writeConfigFileAtomic(path: string, content: string, deps: AtomicWriteDeps = {}): void {
  const target = resolveWriteTarget(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o777;
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

    if (existsSync(target)) copyFileSync(target, `${target}.failproofai-backup`);

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
