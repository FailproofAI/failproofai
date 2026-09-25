/**
 * What connecting to, and disconnecting from, FailproofAI Cloud does to Jev.
 *
 * `config --token` with a key that carries `jev:evaluate` stores the key in the
 * `jev` slot of `credentials.json` (`cloud-connection.ts`) and then, ONLY when
 * this machine has no `jev.json` at all, writes one that turns Jev on through
 * FailproofAI Cloud in shadow mode — logged, never enforced, until its owner
 * says otherwise. `config --disconnect` clears the slot and deletes `jev.json`
 * only when that file names the Cloud provider.
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
 * Cloud's to delete, so it stays; so does a file this build cannot read.
 *
 * Loaded lazily by its two callers, so connecting without Jev pulls in nothing
 * of it and the hook path never does.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  | { status: "error"; path: string; problem: string };

/** Delete `jev.json` iff it names the FailproofAI Cloud provider. Never throws. */
export function removeCloudJevConfig(): CloudJevConfigRemoval {
  const path = jevConfigPath();
  if (!existsSync(path)) return { status: "absent", path };
  const raw = readJevConfigFileForUpdate()?.raw ?? null;
  const provider = typeof raw?.provider === "string" ? raw.provider : null;
  if (provider !== JEV_CLOUD_PROVIDER) return { status: "kept", path, provider };
  try {
    unlinkSync(path);
    return { status: "removed", path };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent", path };
    return { status: "error", path, problem: `could not remove ${path} (${code ?? "error"})` };
  }
}
