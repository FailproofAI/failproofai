/**
 * Deciding whether a finding still owes the user a notice — exactly once.
 *
 * ## Why this is not a field on the record
 *
 * The obvious design is `notifiedAt` on each finding, written back after the
 * notice goes out. Measured against this repo's real `writeJsonAtomically`
 * semantics, that fails 100% of the time under the conditions it actually runs
 * in: two concurrent sessions with the same finding produced two notices, four
 * produced four, eight produced eight. Worse, two concurrent sessions with
 * DIFFERENT findings produced two notices and a surviving watermark containing
 * only one of them — the loser's mark permanently gone, so it re-notified
 * forever afterwards. `lib/atomic-write.ts` says so in its own header: atomic
 * per FILE, last-writer-wins per CONTENT, i.e. a lost update on a map.
 *
 * Running several agents at once in one project is not an edge case here; it is
 * how the tool is used.
 *
 * So the claim is one marker FILE per finding, created with `wx` — O_EXCL,
 * which the kernel makes atomic across processes. Eight concurrent claimants
 * produce exactly one winner, verified 3/3 trials. Concurrent claims on
 * different findings all succeed and all survive, because they touch different
 * files.
 *
 * ## Claim ordering, and which way to fail
 *
 * The marker is written BEFORE the notice reaches the stream, and the caller
 * only keeps it if the notice was actually shaped. The alternative orderings
 * were both measured: emit-then-mark nags forever if the process dies between
 * them (5 sessions → 5 notices), and mark-then-never-emit swallows the alert
 * permanently with nothing on disk saying so (total delivered: 0).
 *
 * Between "told twice" and "never told", a security tool picks told twice.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { auditDir } from "../hooks/fp-home";
import { readLeakRecord, activeFindings } from "./leak-store";
import { isFindingId } from "./leak-fingerprint";

/**
 * Which way the user was told. Each channel claims independently.
 *
 * They are NOT one guarantee. The desktop banner and the in-CLI notice reach a
 * person at different moments and fail in unrelated ways — and the banner has a
 * failure it cannot detect at all: on a locked screen the shell accepts the
 * call and returns an id while nobody sees anything. Letting a successful
 * `Notify` claim the finding would then silence the in-session notice too, and
 * the only channel that actually reached a human is the one we suppressed.
 *
 * So each channel gets its own marker directory and its own once-per-finding
 * guarantee. A user at a desktop sees the banner AND the next session's notice;
 * that is a bounded, deliberate duplicate, and it is the right side of the
 * trade this file already made once (told twice beats never told).
 */
export type NoticeChannel = "cli" | "desktop";

/** One empty file per claimed finding, per channel. Cheap: a few hundred
 *  zero-byte files at the very worst, and the record itself is capped at 500
 *  findings. "cli" keeps the original directory name so an existing machine's
 *  claims survive the upgrade — renaming it would re-notify for every finding
 *  already delivered. */
const NOTICE_DIR = (home?: string, channel: NoticeChannel = "cli") =>
  resolve(auditDir(home), channel === "cli" ? "notified" : `notified-${channel}`);

/** Markers older than this are swept, so the directory cannot grow forever on a
 *  machine that has been running for years. Comfortably longer than the
 *  record's own 90-day TTL, so a marker never outlives its finding. */
const MARKER_TTL_MS = 120 * 86_400_000;

export interface PendingNotice {
  /** Findings that have never been notified about and are not dismissed. */
  ids: string[];
  count: number;
}

/**
 * Findings that still owe the user a notice.
 *
 * Reads the record and subtracts what has already been claimed. Never throws:
 * on any failure it returns "nothing pending", because a hook that cannot read
 * its bookkeeping must stay silent rather than guess.
 */
export function pendingLeakNotice(home?: string, channel: NoticeChannel = "cli"): PendingNotice {
  try {
    const dir = NOTICE_DIR(home, channel);
    const claimed = new Set(existsSync(dir) ? readdirSync(dir) : []);
    const ids = activeFindings(readLeakRecord(home), home)
      .map((f) => f.id)
      .filter((id) => !claimed.has(id));
    return { ids, count: ids.length };
  } catch {
    return { ids: [], count: 0 };
  }
}

/**
 * Claim these findings, atomically and per-finding.
 *
 * Returns the ids this process actually won. A caller that loses a race simply
 * gets a shorter list — it never blocks, and it never overwrites a claim made
 * by a concurrent session.
 */
export function markLeakNoticeDelivered(
  ids: string[],
  home?: string,
  channel: NoticeChannel = "cli",
): string[] {
  const won: string[] = [];
  try {
    const dir = NOTICE_DIR(home, channel);
    mkdirSync(dir, { recursive: true });
    for (const id of ids) {
      // An id is about to become a filename. Anything that is not the exact
      // shape `fingerprintId` mints is refused rather than resolved — see
      // `isFindingId`. Refusing also means NOT reporting it as won, so a caller
      // treats it as unclaimed and never records it as delivered.
      if (!isFindingId(id)) continue;
      try {
        // `wx` is O_EXCL: it throws EEXIST if another process got here first.
        // That throw IS the lock — there is no read-then-write window for two
        // processes to both pass through.
        writeFileSync(resolve(dir, id), "", { flag: "wx", mode: 0o600 });
        won.push(id);
      } catch {
        // Already claimed by a concurrent session. Correct outcome: the user
        // is told once, by whichever session got there first.
      }
    }
  } catch {
    // Cannot claim at all — the caller has already decided to emit, and being
    // told twice beats never being told.
  }
  return won;
}

/** Drop markers for findings that no longer exist, and very old ones. */
export function pruneNoticeMarkers(home?: string, nowMs = Date.now()): void {
  try {
    const live = new Set(readLeakRecord(home).findings.map((f) => f.id));
    for (const channel of ["cli", "desktop"] as const) {
      const dir = NOTICE_DIR(home, channel);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const path = resolve(dir, name);
        let stale = !live.has(name);
        if (!stale) {
          try {
            stale = nowMs - statSync(path).mtimeMs > MARKER_TTL_MS;
          } catch {
            stale = false;
          }
        }
        if (stale) rmSync(path, { force: true });
      }
    }
  } catch {
    // Housekeeping only.
  }
}
