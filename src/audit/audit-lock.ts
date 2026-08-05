/**
 * One audit at a time on this machine, across processes.
 *
 * Three entry points can start a scan — a scheduled run, an explicit
 * `failproofai audit`, and the dashboard's `/api/audit/run` — and every one of
 * them writes the same sha1-keyed per-transcript cache files and the same
 * single-slot `audit/dashboard.json`. The only lock that existed before this
 * was `app/api/audit/_state.ts`, a module-level singleton inside the Next.js
 * server: invisible to the other two, and by its own admission invisible to a
 * second Next.js worker as well.
 *
 * ## Why a lockfile and not a flock
 *
 * `flock()` releases itself when the holder dies, which is exactly the property
 * we would want — but it needs a held file descriptor, and the interactive path
 * hands off to `launch()` and lives on for as long as the user leaves the
 * dashboard open. A lockfile whose contents name the holder can be released at
 * the end of the SCAN, which is the thing being serialised, and it can be
 * inspected by a human wondering why their audit refused to start. The cost is
 * that a crash leaves the file behind, which the stale rules below cover.
 *
 * ## The two stale rules
 *
 * **A dead pid** is the primary one and the one that fires in practice:
 * Ctrl+C, SIGKILL and a laptop lid are all "the lock is on disk, the process is
 * not". **Age** is the backstop for the cases a pid check cannot see — a
 * recycled pid, or a lock written by a machine that shares this home over a
 * network filesystem.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { auditLockFile, failproofaiHome, runDir } from "../hooks/fp-home";

/**
 * How old a lock has to be before its holder is presumed gone even though the
 * pid still resolves.
 *
 * A full scan measured ~104 seconds over 3,277 transcripts on a development
 * machine with a warm cache. The ceiling has to clear the worst plausible
 * HONEST run by a wide margin, because stealing from a live audit is the one
 * outcome this module exists to prevent — it puts two writers on the same cache
 * files. A cold cache, a much longer history, a spinning disk, or the `nice(19)`
 * scheduled run competing with a busy laptop can each cost an order of
 * magnitude, so: one hour, roughly 35× the measured run. Nothing is lost by
 * being generous here, since the dead-pid rule already collects every crash.
 */
export const AUDIT_LOCK_MAX_AGE_MS = 60 * 60_000;

/**
 * Which entry point holds the lock. Recorded so a refusal can say who it lost
 * to. `dashboard` and `onboarding` are declared but not yet wired — see the
 * note in `src/audit/cli.ts`.
 */
export type AuditLockSource = "cli" | "scheduled" | "dashboard" | "onboarding";

export interface AuditLockInfo {
  pid: number;
  /** Wall-clock ms. Monotonic time would reset every process start. */
  startedAt: number;
  source: AuditLockSource;
}

export interface AuditLockHandle {
  info: AuditLockInfo;
  /** Idempotent, never throws, and only ever removes a lock this handle owns. */
  release(): void;
}

export type AcquireAuditLockResult =
  | { ok: true; lock: AuditLockHandle }
  /** `heldBy` is null when the holder's lock could not be read at all. */
  | { ok: false; heldBy: AuditLockInfo | null };

/**
 * Take the lock, stealing a provably-abandoned one.
 *
 * Never throws: a caller deciding whether to run an audit must not have to
 * handle an exception from the thing that decides.
 */
export function acquireAuditLock(source: AuditLockSource, now: number = Date.now()): AcquireAuditLockResult {
  const path = auditLockFile();
  const info: AuditLockInfo = { pid: process.pid, startedAt: now, source };

  try {
    ensureRunDir();
  } catch {
    // We could not even create the directory the lock lives in, so we cannot
    // prove exclusivity. Report contention rather than running: a refused audit
    // is a retry, whereas two unserialised ones corrupt a shared cache.
    return { ok: false, heldBy: null };
  }

  if (writeLockExclusive(path, info)) return { ok: true, lock: handleFor(path, info) };

  const held = readLock(path);
  if (!isStale(held, now)) return { ok: false, heldBy: held };

  try {
    unlinkSync(path);
  } catch {
    // Already gone — another process judged it stale at the same moment. The
    // O_EXCL retry below is what decides between us.
  }
  // Exactly one retry, deliberately. Two processes that both called the lock
  // stale race here and O_EXCL picks one; looping would let the loser keep
  // going until it stole the WINNER's brand-new lock.
  if (writeLockExclusive(path, info)) return { ok: true, lock: handleFor(path, info) };
  return { ok: false, heldBy: readLock(path) };
}

/** Whoever holds the lock right now, or null if it is free/unreadable. */
export function readAuditLock(): AuditLockInfo | null {
  return readLock(auditLockFile());
}

function isStale(held: AuditLockInfo | null, now: number): boolean {
  // EEXIST with nothing parseable inside it: either a truncated write or a file
  // from a version that wrote a different shape. Neither names a holder we
  // could ever wait for.
  if (!held) return true;
  if (!isProcessAlive(held.pid)) return true;
  // A startedAt in the future (clock skew, a shared home across machines) reads
  // as fresh, not as stale — the subtraction goes negative and the comparison
  // fails, which is the direction that does not steal from a live run.
  return now - held.startedAt > AUDIT_LOCK_MAX_AGE_MS;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to somebody else — two OS
    // users on one box, or a shared home. Alive is the safe reading of that.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function handleFor(path: string, info: AuditLockInfo): AuditLockHandle {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    // Only ever remove OUR lock. After a steal the file on disk can already
    // belong to a third process, and deleting that one would hand a live audit
    // the co-writer this whole module exists to prevent.
    const current = readLock(path);
    if (current && current.pid !== info.pid) return;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };

  // `process.exit()` does not unwind, so a `finally` cannot be relied on here:
  // `failproofai audit` exits directly on both its failure and its
  // empty-history path. An exit hook covers those, a normal return, and an
  // uncaught throw. It does NOT run when the default SIGINT disposition kills
  // the process — Ctrl+C during a scan is precisely what the dead-pid rule is
  // there for.
  process.once("exit", release);
  return { info, release };
}

function readLock(path: string): AuditLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AuditLockInfo>;
    if (typeof parsed?.pid !== "number" || typeof parsed?.startedAt !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      source: (parsed.source ?? "cli") as AuditLockSource,
    };
  } catch {
    return null;
  }
}

/** True when this call created the file; false when it already existed (or the
 *  write failed for any other reason, which is equally "not ours to hold"). */
function writeLockExclusive(path: string, info: AuditLockInfo): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeSync(fd, JSON.stringify(info));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do with a failed close on a lockfile */
      }
    }
  }
}

function ensureRunDir(): void {
  // The home first and at the default mode: `run/` below is created 0700, and
  // letting a recursive mkdir apply that to `~/.failproofai` itself would hide
  // config.toml, which is world-readable by design.
  mkdirSync(failproofaiHome(), { recursive: true });
  // 0700 explicitly, because failproofaid REFUSES TO START when run/ exists
  // with any other mode (`ensure_run_dir` in crates/failproofaid/src/paths.rs).
  // A lock file that created this directory under the ambient umask would
  // therefore stop the daemon coming up — and on a daemon-configured machine a
  // daemon that cannot start denies every tool call across all 12 CLIs.
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
}
