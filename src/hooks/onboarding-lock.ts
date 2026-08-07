/**
 * A single-holder guard around first-run onboarding.
 *
 * Onboarding used to fire only on a bare `failproofai`. It now fires on any
 * command an unconfigured machine runs, which makes concurrent runs a real
 * shape rather than a theoretical one: two terminals, `failproofai audit` in
 * each, and both draw a wizard. They would then race on the same settings
 * files and, worse, both try to install the system service — two `sudo`
 * prompts and two `systemctl enable` calls against one unit.
 *
 * ## Why liveness, not a timeout
 *
 * The obvious lock carries a timestamp and is treated as stale after N
 * seconds. That cannot work here: the holder is a human answering questions,
 * so any N short enough to recover promptly from a crash is also short enough
 * to evict someone who walked away mid-setup. So the lock records a PID and is
 * considered held only while that process is actually alive — which recovers
 * instantly from a crash or a Ctrl-C, and never evicts a live wizard no matter
 * how long it sits.
 *
 * ## Failure direction
 *
 * Every failure here resolves to "do not onboard". A lock we cannot take is
 * indistinguishable from one already held, and skipping onboarding costs a
 * user one printed hint, where wrongly proceeding costs a duplicated install.
 * The command the user typed always runs either way.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { onboardingLockFile, stateDir } from "./fp-home";

interface LockBody {
  pid: number;
  startedAt: number;
}

export function onboardingLockPath(home: string = homedir()): string {
  return onboardingLockFile(home);
}

/**
 * Whether `pid` is a live process this user can signal.
 *
 * `kill(pid, 0)` performs the permission and existence checks without
 * delivering a signal. `EPERM` means the process exists but belongs to another
 * user — still alive, so still holding the lock.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readLock(path: string): LockBody | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockBody>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, startedAt: Number(parsed.startedAt) || 0 };
  } catch {
    // Absent, unreadable, or truncated by a crash mid-write. All three mean
    // "no live holder we can prove", and the liveness check below is what
    // actually decides.
    return null;
  }
}

export interface OnboardingLock {
  /** Release the lock. Safe to call more than once. */
  release(): void;
}

/**
 * Take the onboarding lock, or return `null` if another live process holds it.
 *
 * There is a small window between the liveness check and the write in which
 * two processes could both decide the lock is free. That is accepted
 * deliberately: closing it needs `O_EXCL` plus stale-file recovery, which
 * reintroduces exactly the timeout problem this design avoids — and the
 * consequence of losing that race is two wizards, which is the situation
 * before this existed, not something worse.
 */
export function acquireOnboardingLock(home: string = homedir()): OnboardingLock | null {
  const path = onboardingLockPath(home);
  try {
    const held = readLock(path);
    // Our own PID appearing here means a previous run in this same process
    // already holds it — re-entering is fine and must not deadlock.
    if (held && held.pid !== process.pid && processAlive(held.pid)) return null;

    mkdirSync(stateDir(home), { recursive: true });
    const body: LockBody = { pid: process.pid, startedAt: Date.now() };
    writeFileSync(path, JSON.stringify(body), "utf8");

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          // Only remove a lock still recorded as ours: if this process was
          // evicted as dead and another wizard took over, deleting the file
          // would release someone else's lock.
          const current = readLock(path);
          if (!current || current.pid === process.pid) rmSync(path, { force: true });
        } catch {
          /* best effort — a stray lock is reclaimed by the liveness check */
        }
      },
    };
  } catch {
    // Unwritable home, read-only filesystem, whatever it is: treat as held.
    return null;
  }
}
