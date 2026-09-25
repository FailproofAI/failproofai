/**
 * What connecting to, and disconnecting from, FailproofAI Cloud does to Jev.
 *
 * `config --token` with a key that carries `jev:evaluate` stores the key in the
 * `jev` slot of `credentials.json` (`cloud-connection.ts`) and then, ONLY when
 * this machine has no `jev.json` at all, writes one that turns Jev on through
 * FailproofAI Cloud in shadow mode — logged, never enforced, until its owner
 * says otherwise. Never under `--no-transcripts`: that connection asked for
 * decisions only, so it stores the key and says Jev is available, and
 * `jev setup --provider failproofai` is the opt-in. `config --disconnect`
 * clears the slot and deletes `jev.json` only when that file names the Cloud
 * provider.
 *
 * # Never overwrite
 *
 * A `jev.json` that exists is somebody's decision: a BYOK endpoint with its own
 * key, a Cloud file switched to enforce or off, a hand-written one. Connecting
 * is not a reason to replace any of those, so the file is created with a
 * no-clobber primitive — written to a temp file, then HARD-LINKED into place,
 * which fails if anything is already there — rather than checked for and then
 * written: between a check and a rename another writer can land, and a rename
 * replaces whatever it finds. The link is also what keeps a hook from ever
 * reading a half-written file.
 *
 * # Only the Cloud's own file is removed
 *
 * Disconnect removes the Cloud key, so a Cloud `jev.json` would be left naming a
 * route with no key — harmless (`not-connected`, Jev off) but a lie on every
 * status screen. A BYOK file keeps working without the Cloud and is not the
 * Cloud's to delete, so it stays; so does a file this build cannot read. The
 * file is moved aside before it is judged, so the file judged is the file
 * deleted — see `removeCloudJevConfig`.
 *
 * Loaded lazily by its two callers, so connecting without Jev pulls in nothing
 * of it and the hook path never does.
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { JEV_CLOUD_PROVIDER, jevCloudBaseUrl, jevConfigPath, readJevConfigFileForUpdate } from "./semantic/jev-config";

/** The mode a Cloud `jev.json` starts in (the user's decision: log first, enforce later). */
export const CLOUD_JEV_INITIAL_MODE = "shadow" as const;

export type CloudJevConfigWrite =
  | { status: "written"; path: string; mode: typeof CLOUD_JEV_INITIAL_MODE; baseUrl: string }
  /** A `jev.json` already exists and was left exactly as it was. */
  | {
      status: "kept";
      path: string;
      /** The provider it names, when it can be read. */
      provider: string | null;
      /**
       * Set when it names the Cloud provider on ANOTHER origin than the one just
       * connected to: it stays off (`the key is only sent where it was issued`)
       * until pointed at this one, which is worth one line at connect time.
       */
      otherOrigin?: string;
    }
  | { status: "error"; path: string; problem: string };

/**
 * Create `jev.json` for the Cloud provider unless one exists. Never throws and
 * never replaces a file.
 */
export function writeCloudJevConfigIfAbsent(cloudBase: string): CloudJevConfigWrite {
  const path = jevConfigPath();
  let baseUrl: string;
  try {
    baseUrl = jevCloudBaseUrl(cloudBase);
  } catch {
    return { status: "error", path, problem: "the FailproofAI Cloud URL is not a URL" };
  }
  if (existsSync(path)) return kept(path, cloudBase);

  const body = `${JSON.stringify({ provider: JEV_CLOUD_PROVIDER, baseUrl, mode: CLOUD_JEV_INITIAL_MODE }, null, 2)}\n`;
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return kept(path, cloudBase);
      throw err;
    }
  } catch (err) {
    return { status: "error", path, problem: `could not write ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A stray temp file holds no key; nothing to do.
    }
  }
  tightenDir(dir);
  return { status: "written", path, mode: CLOUD_JEV_INITIAL_MODE, baseUrl };
}

/**
 * What `writeCloudJevConfigIfAbsent` would report for a `jev.json` that is
 * already there — without writing anything when there is none. For a connect
 * that must not switch Jev on (`--no-transcripts`) but still says what an
 * existing file does. Null when there is no file.
 */
export function existingJevConfig(cloudBase: string): CloudJevConfigWrite | null {
  const path = jevConfigPath();
  return existsSync(path) ? kept(path, cloudBase) : null;
}

function kept(path: string, cloudBase: string): CloudJevConfigWrite {
  const raw = readJevConfigFileForUpdate()?.raw ?? null;
  const provider = typeof raw?.provider === "string" ? raw.provider : null;
  let otherOrigin: string | undefined;
  if (provider === JEV_CLOUD_PROVIDER && typeof raw?.baseUrl === "string") {
    try {
      const theirs = new URL(raw.baseUrl).origin;
      if (theirs !== new URL(cloudBase).origin) otherOrigin = theirs;
    } catch {
      // Unreadable: the loader will say so; nothing to add here.
    }
  }
  return { status: "kept", path, provider, ...(otherOrigin ? { otherOrigin } : {}) };
}

/**
 * The directory's group/other WRITE bits, taken off exactly as `jev setup`
 * takes them off: a directory others can write into defeats the file's 0600.
 */
function tightenDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const before = statSync(dir).mode & 0o777;
    if ((before & 0o022) !== 0) chmodSync(dir, before & ~0o022);
  } catch {
    // Not fatal: the loader refuses a directory it will not read from.
  }
}

export type CloudJevConfigRemoval =
  | { status: "removed"; path: string }
  | { status: "absent"; path: string }
  /** A `jev.json` that is not the Cloud's — BYOK, or unreadable — left in place. */
  | { status: "kept"; path: string; provider: string | null }
  /**
   * Not the Cloud's, and another `jev.json` was written in its place while it
   * was being checked. Neither is deleted: the new one stays at `path`, the one
   * that was there is kept at `setAside`.
   */
  | { status: "set-aside"; path: string; provider: string | null; setAside: string }
  | { status: "error"; path: string; problem: string };

/**
 * Delete `jev.json` iff it names the FailproofAI Cloud provider. Never throws,
 * and never deletes a file it has not judged.
 *
 * # Moved aside, then judged
 *
 * Checking the file's provider and then unlinking the PATH is a race: `jev
 * setup` (or the dashboard's save) replaces jev.json by atomic rename, and a
 * BYOK file renamed into place between the check and the unlink is the file
 * the unlink removes. So the file is first RENAMED to a name only this call
 * knows — atomic, and whatever lands at the path afterwards is untouched by
 * anything below — and it is that file, which nobody else can now replace,
 * whose provider decides. The Cloud's is deleted. Anything else is linked back
 * to the path (same inode, bytes and mode) with a no-clobber link, so a file
 * written at the path meanwhile is never overwritten either; when one was, the
 * original is left beside it under the set-aside name rather than deleted.
 */
export function removeCloudJevConfig(): CloudJevConfigRemoval {
  const path = jevConfigPath();
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent", path };
    return { status: "error", path, problem: `could not read ${path} (${code ?? "error"})` };
  }
  // Only a regular file can be the one `config --token` wrote. A symlink, a
  // directory or a FIFO in its place is somebody else's, and is not touched.
  if (!st.isFile()) return { status: "kept", path, provider: null };

  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.disconnecting`;
  try {
    renameSync(path, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent", path };
    return { status: "error", path, problem: `could not remove ${path} (${code ?? "error"})` };
  }

  const provider = providerOf(aside);
  if (provider === JEV_CLOUD_PROVIDER) {
    try {
      unlinkSync(aside);
      return { status: "removed", path };
    } catch (err) {
      return { status: "error", path, problem: `could not remove ${aside} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }

  // Not the Cloud's: back where it was, and never over a file written since.
  try {
    linkSync(aside, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { status: "set-aside", path, provider, setAside: aside };
    return { status: "error", path, problem: `${path} is not FailproofAI Cloud's and was kept at ${aside}; putting it back failed (${code ?? "error"})` };
  }
  try {
    unlinkSync(aside);
  } catch {
    // A second name for the same file, harmless; it holds nothing the original does not.
  }
  return { status: "kept", path, provider };
}

/** The `provider` a config file names, read without following links or blocking on a FIFO; null when unreadable. */
function providerOf(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_JEV_CONFIG_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const parsed: unknown = JSON.parse(buf.subarray(0, off).toString("utf8"));
    const provider = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).provider : undefined;
    return typeof provider === "string" ? provider : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do.
    }
  }
}

/** The loader's own bound on a config file (`jev-config.ts`); nothing legitimate is near it. */
const MAX_JEV_CONFIG_BYTES = 64 * 1024;
