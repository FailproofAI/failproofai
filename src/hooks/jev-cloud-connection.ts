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
 * provider and is not switched off.
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
 * Cloud's to delete, so it stays; so does a file this build cannot read, and a
 * Cloud file switched off — `--mode off` is the owner's opt-out, and deleting
 * it would let the next connect write a fresh shadow file. The
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
  readFileSync,
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
import {
  DEFAULT_JEV_MODE,
  JEV_CLOUD_PROVIDER,
  inspectJevConfig,
  jevCloudBaseUrl,
  jevConfigPath,
  readJevConfigFileForUpdate,
} from "./semantic/jev-config";

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

/**
 * The mode Jev runs in through FailproofAI Cloud right now, or null when it
 * does not: no `jev.json`, another provider, switched off, or no usable key.
 * Asked the way a hook asks (`inspectJevConfig`), so "on" here means a tool
 * call's next Jev request really goes to FailproofAI Cloud.
 */
export function cloudJevRunningMode(): "shadow" | "enforce" | null {
  try {
    const r = inspectJevConfig();
    if (r.status !== "ok" || r.config.provider !== JEV_CLOUD_PROVIDER) return null;
    return r.config.mode === "off" ? null : (r.config.mode ?? DEFAULT_JEV_MODE);
  } catch {
    return null;
  }
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
  /** The Cloud's `jev.json`, switched off: left in place so the opt-out outlives a reconnect. */
  | { status: "kept-off"; path: string }
  /** A `jev.json` that is not the Cloud's — BYOK, or unreadable — left in place. */
  | { status: "kept"; path: string; provider: string | null }
  /**
   * Not the Cloud's, and another `jev.json` was written in its place while it
   * was being checked. Neither is deleted: the new one stays at `path`, the one
   * that was there is kept at `setAside`.
   */
  | { status: "set-aside"; path: string; provider: string | null; setAside: string }
  | {
      status: "error";
      path: string;
      problem: string;
      /** Where a file that is not the Cloud's was left, when it could not be put back at `path`. */
      setAside?: string;
    };

/**
 * Delete `jev.json` iff it names the FailproofAI Cloud provider and is not
 * switched off (`mode: "off"`). Never throws,
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
 * to the path (same inode, bytes and mode) with a no-clobber link — or, where
 * the filesystem has no hard links, put back by the fallbacks in `putBack` —
 * so a file written at the path meanwhile is never overwritten either; when one
 * was, the original is left beside it under the set-aside name rather than
 * deleted, and when nothing can put it back, the result says where it is.
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

  const { provider, off } = fieldsOf(aside);
  if (provider === JEV_CLOUD_PROVIDER && !off) {
    try {
      unlinkSync(aside);
      return { status: "removed", path };
    } catch (err) {
      return { status: "error", path, problem: `could not remove ${aside} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }

  // Not the Cloud's: back where it was, and never over a file written since.
  const back = putBack(aside, path, st.mode & 0o777);
  if (back === "restored") return provider === JEV_CLOUD_PROVIDER ? { status: "kept-off", path } : { status: "kept", path, provider };
  if (back === "occupied") return { status: "set-aside", path, provider, setAside: aside };
  return {
    status: "error",
    path,
    problem: `${path} is not FailproofAI Cloud's and was kept at ${aside}; putting it back failed (${back.code})`,
    setAside: aside,
  };
}

/**
 * Put a set-aside file back at `path`, never over a file that is there now:
 * `restored`, `occupied` (another file is at `path`, and `aside` is left as it
 * is), or the error that stopped every attempt.
 *
 * 1. A hard link: atomic, the same inode, bytes and mode, and it fails with
 *    EEXIST when anything is at the path.
 * 2. Some filesystems have no hard links (FAT and exFAT, some network and FUSE
 *    mounts answer EPERM or ENOTSUP), so next a COPY created exclusively (`wx`,
 *    O_EXCL): just as no-clobber, with the file's own mode (less the umask,
 *    so never looser). A hook reading the file mid-copy sees a truncated one
 *    and refuses it — Jev off for that call, the regex verdict stands — never
 *    another config.
 * 3. When no copy can be created either (no room for one, say), a rename —
 *    which replaces what it finds, so only while the path is still empty. The
 *    moment between that check and the rename is the one place a write landing
 *    at the path could be lost, and it is reached only when neither no-clobber
 *    way works.
 *
 * Until one works, the file sits at `aside`, and the caller says where.
 */
function putBack(aside: string, path: string, mode: number): "restored" | "occupied" | { code: string } {
  const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code ?? "error";
  try {
    linkSync(aside, path);
    discard(aside);
    return "restored";
  } catch (err) {
    if (codeOf(err) === "EEXIST") return "occupied";
  }
  let created = false;
  try {
    const bytes = readFileSync(aside);
    const fd = openSync(path, "wx", mode);
    created = true;
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    discard(aside);
    return "restored";
  } catch (err) {
    if (codeOf(err) === "EEXIST") return "occupied";
    // Created, then the write failed: a truncated file is at the path now, and
    // the original is still at `aside`. Not renamed over — the path is not
    // empty, and whose file is there by now is not knowable.
    if (created) return { code: codeOf(err) };
  }
  try {
    lstatSync(path);
    return "occupied";
  } catch (err) {
    if (codeOf(err) !== "ENOENT") return { code: codeOf(err) };
  }
  try {
    renameSync(aside, path);
    return "restored";
  } catch (err) {
    return { code: codeOf(err) };
  }
}

/** Drop the set-aside name once the file is back. A leftover is 0600 in an owner-only directory, and holds nothing the file at the path does not. */
function discard(aside: string): void {
  try {
    unlinkSync(aside);
  } catch {
    // Harmless; see above.
  }
}

/** The `provider` a config file names, and whether it is switched off, read without following links or blocking on a FIFO. */
function fieldsOf(file: string): { provider: string | null; off: boolean } {
  const none = { provider: null, off: false };
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return none;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_JEV_CONFIG_BYTES) return none;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const parsed: unknown = JSON.parse(buf.subarray(0, off).toString("utf8"));
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { provider: typeof obj.provider === "string" ? obj.provider : null, off: obj.mode === "off" };
  } catch {
    return none;
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
