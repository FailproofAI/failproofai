/**
 * The project a session started in, pinned the first time the session is seen.
 *
 * The hook payload's `cwd` is the agent's LIVE shell directory. Claude Code
 * keeps a `cd` across calls, so a session started in `~/work` that once ran
 * `cd ~/work/api` reports `~/work/api` from then on — and `facts.projectRoot`,
 * derived from that, shrank with it. Every file elsewhere in `~/work` then read
 * as `outside_project_in_home`, and `read-outside-workspace` fired on the
 * project the human opened.
 *
 * Letting the root FOLLOW the `cd` instead would be a bypass: `cd ~/.ssh` in
 * one call and `cat id_rsa` in the next would make `~/.ssh` the project. So the
 * root is fixed at the session's first reviewed call and never moves after.
 * A `cd` can change how a relative path resolves (that is still the live cwd's
 * job, in `extractPaths`) but never what counts as inside the project.
 *
 * Failure is never stricter or looser than before this file existed: no
 * session id, an unreadable store, or a store someone else can write to all
 * fall back to the live cwd's root — exactly the old behaviour. A session whose
 * first reviewed call came after a `cd` pins that later directory; same again.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { semanticDir } from "../fp-home";
import { findProjectRoot } from "./facts";
import { looseIntentStoreDir } from "./intent";

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ROOT_FILE_RE = /^[A-Za-z0-9._-]{1,128}\.json$/;
/** Sessions outlive the intent store's six hours; a week covers any real one. */
export const SESSION_ROOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DIR_WRITABLE_BY_OTHERS = 0o022;

const rootsDir = (): string => resolve(semanticDir(), "roots");
const rootFile = (sessionId: string): string => resolve(rootsDir(), `${sessionId}.json`);

/** A stored root is only believed when it is a plain absolute path, and never `/`. */
function validRoot(v: unknown): v is string {
  return typeof v === "string" && isAbsolute(v) && resolve(v) === v && v !== "/";
}

/**
 * Whether the store may be trusted. A directory anyone else can write to lets
 * them swap in a root of their choosing — a wider root is fewer paths outside
 * it — so a loose one is ignored, after the same tightening the intent store
 * applies (`looseIntentStoreDir`).
 */
function storeIsOurs(): boolean {
  if (process.platform === "win32") return true;
  if (looseIntentStoreDir() !== null) return false;
  try {
    const mode = statSync(rootsDir()).mode & 0o777;
    return (mode & DIR_WRITABLE_BY_OTHERS) === 0;
  } catch {
    return true; // Not there yet: nothing to read out of it.
  }
}

function readPinned(sessionId: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(rootFile(sessionId), "utf8")) as { root?: unknown };
    return validRoot(parsed?.root) ? parsed.root : null;
  } catch {
    return null;
  }
}

/** Delete root files older than {@link SESSION_ROOT_MAX_AGE_MS}. Best effort. */
export function pruneSessionRoots(now: number = Date.now()): number {
  let removed = 0;
  try {
    const dir = rootsDir();
    for (const name of readdirSync(dir)) {
      if (!ROOT_FILE_RE.test(name)) continue;
      const path = resolve(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs > SESSION_ROOT_MAX_AGE_MS) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // Raced with another writer, or already gone.
      }
    }
  } catch {
    // No directory yet.
  }
  return removed;
}

/**
 * The project root to judge this call's paths against: the one pinned for the
 * session, or — on its first reviewed call — the live cwd's root, pinned now.
 * Null only when there is no cwd at all. Never throws.
 */
export function sessionProjectRoot(sessionId: string | undefined, cwd: string | undefined, now: number = Date.now()): string | null {
  if (!cwd) return null;
  const live = findProjectRoot(cwd);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return live;
  try {
    if (!storeIsOurs()) return live;
    const pinned = readPinned(sessionId);
    if (pinned !== null) return pinned;
    if (!validRoot(live)) return live;
    mkdirSync(rootsDir(), { recursive: true, mode: 0o700 });
    // `wx`: the first writer wins. Two calls racing on a new session both
    // computed a root from the same moment; whichever lands is the pin, and
    // the loser's EEXIST just means it answers with the live root this once.
    writeFileSync(rootFile(sessionId), JSON.stringify({ root: live, at: now }), { mode: 0o600, flag: "wx" });
    pruneSessionRoots(now);
  } catch {
    // Unwritable store: the old behaviour, for this call.
  }
  return live;
}
