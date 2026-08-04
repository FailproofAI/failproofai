import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireOnboardingLock, onboardingLockPath } from "../../src/hooks/onboarding-lock";

let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "fpai-onboard-lock-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A PID that is almost certainly not a live process. */
const DEAD_PID = 0x7fffffff;

function writeLock(pid: number) {
  mkdirSync(resolve(home, ".failproofai"), { recursive: true });
  writeFileSync(onboardingLockPath(home), JSON.stringify({ pid, startedAt: Date.now() }));
}

describe("acquireOnboardingLock", () => {
  it("takes the lock on a clean machine and writes this process's pid", () => {
    const lock = acquireOnboardingLock(home);
    expect(lock).not.toBeNull();
    const body = JSON.parse(readFileSync(onboardingLockPath(home), "utf8"));
    expect(body.pid).toBe(process.pid);
    lock!.release();
  });

  it("refuses when another LIVE process holds it", () => {
    // The concurrency this exists for: two terminals, both unconfigured, both
    // reaching onboarding. Only one may draw a wizard.
    writeLock(process.ppid && process.ppid !== process.pid ? process.ppid : 1);
    expect(acquireOnboardingLock(home)).toBeNull();
  });

  it("reclaims a lock whose holder is gone", () => {
    // A crash or Ctrl-C mid-wizard must not lock the machine out of setup
    // forever — which is exactly what a timestamp-and-timeout lock risks,
    // since the holder here is a human who may sit on a question for an hour.
    writeLock(DEAD_PID);
    const lock = acquireOnboardingLock(home);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("reclaims a lock file that was truncated mid-write", () => {
    mkdirSync(resolve(home, ".failproofai"), { recursive: true });
    writeFileSync(onboardingLockPath(home), "{not json");
    const lock = acquireOnboardingLock(home);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("is re-entrant for the same process", () => {
    // Our own pid in the file must never deadlock a later call in the same
    // process.
    writeLock(process.pid);
    const lock = acquireOnboardingLock(home);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("removes the file on release, and tolerates a double release", () => {
    const lock = acquireOnboardingLock(home)!;
    lock.release();
    expect(existsSync(onboardingLockPath(home))).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  it("does not delete a lock that a different process has since taken", () => {
    // If this process were evicted as dead and another wizard took over,
    // releasing must not pull the rug out from under the new holder.
    const lock = acquireOnboardingLock(home)!;
    writeLock(DEAD_PID); // someone else's lock now occupies the path
    lock.release();
    expect(existsSync(onboardingLockPath(home))).toBe(true);
  });

  it("declines rather than throwing when the home is unwritable", () => {
    // Failure direction matters: an un-takeable lock must read as "held", so
    // the caller skips onboarding and still runs the user's command.
    const unwritable = resolve(home, "nope");
    mkdirSync(unwritable, { recursive: true });
    // A file where the .failproofai directory needs to be.
    writeFileSync(resolve(unwritable, ".failproofai"), "not a directory");
    expect(acquireOnboardingLock(unwritable)).toBeNull();
  });
});
