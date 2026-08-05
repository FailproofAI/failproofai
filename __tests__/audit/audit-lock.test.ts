// @vitest-environment node
/**
 * The cross-process audit lock.
 *
 * What it is guarding: a scheduled run, `failproofai audit` and the dashboard's
 * re-run are three separate processes that all write the same sha1-keyed
 * per-transcript cache files and the same single-slot dashboard cache. The only
 * lock before this lived inside the Next.js server and was invisible to the
 * other two.
 *
 * The two stale rules get their own tests because they fail in opposite
 * directions: too eager and it steals from a live 104-second scan, too shy and
 * one Ctrl+C wedges every audit on the machine for an hour.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { auditLockFile, runDir } from "../../src/hooks/fp-home";
import {
  AUDIT_LOCK_MAX_AGE_MS,
  acquireAuditLock,
  readAuditLock,
  type AuditLockInfo,
} from "../../src/audit/audit-lock";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-auditlock-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** A pid that definitely belonged to a process and definitely does not now. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (!pid) throw new Error("could not spawn a throwaway process");
  return pid;
}

/** Plant a lock as if another process had left it there. */
function writeRawLock(info: Partial<AuditLockInfo> | string): void {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  writeFileSync(auditLockFile(), typeof info === "string" ? info : JSON.stringify(info));
}

describe("acquireAuditLock", () => {
  it("creates the lockfile naming this process", () => {
    const attempt = acquireAuditLock("cli");
    expect(attempt.ok).toBe(true);
    expect(readAuditLock()).toMatchObject({ pid: process.pid, source: "cli" });
    expect(existsSync(auditLockFile())).toBe(true);
  });

  it("creates run/ at 0700 so the daemon can still start", () => {
    // failproofaid's ensure_run_dir() REFUSES to start when run/ exists with any
    // other mode, and a daemon-configured machine that cannot start its daemon
    // denies every tool call across all 12 CLIs.
    acquireAuditLock("cli");
    expect(statSync(runDir()).mode & 0o777).toBe(0o700);
  });

  it("refuses a second acquire and names the holder", () => {
    const first = acquireAuditLock("scheduled");
    expect(first.ok).toBe(true);

    const second = acquireAuditLock("cli");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.heldBy).toMatchObject({ pid: process.pid, source: "scheduled" });
    }
  });

  it("does NOT steal a lock held by a live process inside the age ceiling", () => {
    // Our own pid is alive by construction, so only the age rule could apply.
    writeRawLock({ pid: process.pid, startedAt: Date.now() - AUDIT_LOCK_MAX_AGE_MS + 60_000, source: "cli" });
    expect(acquireAuditLock("scheduled").ok).toBe(false);
  });

  it("steals a lock whose pid is gone", () => {
    // Ctrl+C, SIGKILL, a closed lid: the file is on disk and the process is not.
    // The exit hook cannot cover the signal case, so this rule has to.
    writeRawLock({ pid: deadPid(), startedAt: Date.now(), source: "cli" });

    const attempt = acquireAuditLock("scheduled");
    expect(attempt.ok).toBe(true);
    expect(readAuditLock()).toMatchObject({ pid: process.pid, source: "scheduled" });
  });

  it("steals a lock older than the ceiling even when its pid is alive", () => {
    // The backstop for what a pid check cannot see: a recycled pid, or a lock
    // written by another machine sharing this home.
    writeRawLock({ pid: process.pid, startedAt: Date.now() - AUDIT_LOCK_MAX_AGE_MS - 1_000, source: "dashboard" });

    const attempt = acquireAuditLock("cli");
    expect(attempt.ok).toBe(true);
    expect(readAuditLock()).toMatchObject({ pid: process.pid, source: "cli" });
  });

  it("steals an unreadable lock", () => {
    // A truncated write or a shape from another version names no holder we
    // could ever wait for.
    writeRawLock("{ not json");
    expect(acquireAuditLock("cli").ok).toBe(true);
    expect(readAuditLock()).toMatchObject({ pid: process.pid });
  });

  it("treats a startedAt in the future as fresh, not as stale", () => {
    // Clock skew must not become a licence to steal from a running scan.
    writeRawLock({ pid: process.pid, startedAt: Date.now() + 86_400_000, source: "cli" });
    expect(acquireAuditLock("scheduled").ok).toBe(false);
  });

  it("never throws when the lock directory cannot be created", () => {
    // A file where run/ should be. The answer has to be "someone else has it",
    // never an exception out of the thing that decides whether to run.
    process.env.FAILPROOFAI_HOME = resolve(home, "blocked");
    writeFileSync(resolve(home, "blocked"), "");
    const attempt = acquireAuditLock("cli");
    expect(attempt.ok).toBe(false);
  });
});

describe("release", () => {
  it("frees the lock for the next process", () => {
    const first = acquireAuditLock("cli");
    if (!first.ok) throw new Error("expected the lock");
    first.lock.release();

    expect(existsSync(auditLockFile())).toBe(false);
    expect(acquireAuditLock("scheduled").ok).toBe(true);
  });

  it("is idempotent", () => {
    const first = acquireAuditLock("cli");
    if (!first.ok) throw new Error("expected the lock");
    first.lock.release();
    const second = acquireAuditLock("scheduled");
    first.lock.release(); // second call must be a no-op, not a steal

    expect(second.ok).toBe(true);
    expect(readAuditLock()).toMatchObject({ source: "scheduled" });
  });

  it("also fires on process exit, which a `finally` would miss", () => {
    // `failproofai audit` calls process.exit() directly on both its failure and
    // its empty-history path, and process.exit does not unwind — so the exit
    // hook is the only thing standing between those paths and a lock nobody
    // frees for an hour.
    const attempt = acquireAuditLock("cli");
    expect(attempt.ok).toBe(true);

    process.emit("exit", 0);

    expect(existsSync(auditLockFile())).toBe(false);
  });

  it("never removes a lock another process now owns", () => {
    // The window after a steal: the file on disk can already belong to a third
    // process, and deleting it would hand a live audit the co-writer this
    // module exists to prevent.
    const first = acquireAuditLock("cli");
    if (!first.ok) throw new Error("expected the lock");
    writeRawLock({ pid: process.pid + 1, startedAt: Date.now(), source: "dashboard" });

    first.lock.release();

    expect(existsSync(auditLockFile())).toBe(true);
    expect(JSON.parse(readFileSync(auditLockFile(), "utf8")).source).toBe("dashboard");
  });
});
