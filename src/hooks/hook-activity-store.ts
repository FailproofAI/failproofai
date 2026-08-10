/**
 * Disk persistence for hook activity entries using page-sized JSONL files.
 *
 * Storage location: ~/.failproofai/hook-activity/ (see fp-home.ts)
 *
 * File structure:
 * - current.jsonl — actively written to, 0–PAGE_SIZE entries
 * - page-{timestamp}-{seq}.jsonl — rotated archive files, exactly PAGE_SIZE entries each
 *
 * The hook handler is a short-lived process so writes are synchronous (no buffer).
 * Dashboard reads are async and lazy (per-page).
 */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { IntegrationType } from "./types";
import { hookActivityDir } from "./fp-home";

export const PAGE_SIZE = 25;

/**
 * Layout 2 promoted this out of `cache/`. It was never a cache — nothing
 * regenerates it, and deleting it loses the decision history the dashboard's
 * activity tab is built on. Resolved lazily (not at module load) so
 * FAILPROOFAI_HOME is honoured by tests and containers that set it after
 * import.
 */
const defaultStoreDir = () => hookActivityDir();
const CURRENT_FILE = "current.jsonl";
const COUNT_FILE = "current.count"; // tracks line count; O(1) read/write vs rereading current.jsonl
const STATS_FILE = "stats.json";
const LOCK_FILE = "current.lock";  // advisory lock for concurrent hook processes
const LOCK_STALE_MS = 2000;        // steal lock if older than 2 s (covers crashed processes)

let storeDirOverride: string | null = null;
/**
 * A getter, not a module-load constant: `FAILPROOFAI_HOME` is routinely set by
 * a test or a container AFTER this module is imported, and a value captured at
 * import time would silently point every write at the real home.
 */
const storeDirValue = () => storeDirOverride ?? defaultStoreDir();
let rotateSeq = 0;

// ── Types ──

export interface HookActivityEntry {
  timestamp: number;
  eventType: string;
  /** Which agent CLI fired the hook (claude | codex). */
  integration?: string;
  toolName: string | null;
  policyName: string | null;
  policyNames?: string[];
  /**
   * Every policy that MATCHED this event and ran, whichever way it decided.
   *
   * `policyName` only ever names the policy that *decided* — on a plain
   * `allow()` it is null, so a row could not distinguish "no policy applies
   * here" from "your policy ran and allowed". That is the whole reason a user
   * cannot tell whether a policy fired, and why an observation-only event looks
   * identical to an uncovered one.
   *
   * Optional because rows written before this existed have no such field; every
   * consumer must tolerate `undefined` rather than render an empty list as
   * "nothing ran".
   */
  matchedPolicies?: string[];
  decision: "allow" | "deny" | "instruct";
  reason: string | null;
  durationMs: number;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
  hookEventName?: string;
  /**
   * Set only on events evaluated while a session pause was active. Absent on
   * every ordinary row and on every row written before pausing existed, so —
   * like `matchedPolicies` — consumers must treat `undefined` as "not paused"
   * rather than rendering it as unknown.
   */
  pausedBy?: string;
  /** Epoch ms the pause lifts. Present iff `pausedBy` is. */
  pauseExpiresAt?: number;
  /**
   * Where the policy that DECIDED came from. Absent when nothing decided (a
   * plain allow) and on rows written before this existed — so, like
   * `matchedPolicies`, `undefined` means "unknown", not "builtin".
   */
  policySource?: "builtin" | "custom" | "convention" | "cloud";
  /** Cloud policy id of the decider. Present only when `policySource` is "cloud". */
  cloudPolicyId?: string;
  /** Immutable version of that policy — the half of attribution that identifies WHICH version ran. */
  cloudVersion?: number;
  /**
   * The cloud deployment active when this event was evaluated, recorded on
   * every row of a managed machine regardless of what decided. "What was
   * deployed here" is a different question from "what decided", and only this
   * distinguishes a rollout that changed no outcomes from one that never
   * arrived.
   */
  cloudDeployment?: number;
  /**
   * What observe-mode policies WOULD have done, had they been enforcing. This
   * record is the entire point of observe mode: without it the row is
   * indistinguishable from one where the policy never matched, and the rollout
   * being trialled is unmeasurable.
   */
  observed?: Array<{
    policyId: string;
    version: number;
    decision: "deny" | "instruct";
    reason: string | null;
  }>;
}

export interface HookActivityFilters {
  decision?: "allow" | "deny" | "instruct";
  eventType?: string;
  policyName?: string;
  sessionId?: string;
  integration?: IntegrationType;
  /**
   * Filter by where the deciding policy came from. "Show me everything my
   * organization's policies decided" is the question cloud rollout reporting
   * is built on, and it is unanswerable without this.
   */
  source?: "builtin" | "custom" | "convention" | "cloud";
}

export interface HookActivityStats {
  totalEvents: number;
  denyCount: number;
  topPolicy: string | null;
  topPolicyCount: number;
}

// ── Directory setup ──

function ensureDir(): void {
  if (!existsSync(storeDirValue())) {
    mkdirSync(storeDirValue(), { recursive: true });
  }
}

// ── Advisory lock (protects count + stats read-modify-write cycles) ──

function acquireLock(): void {
  ensureDir();
  const lockPath = join(storeDirValue(), LOCK_FILE);
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try {
      // Exclusive create — fails with EEXIST if another process holds the lock
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return; // unexpected — proceed unlocked
      // Check if the lock is stale (process may have crashed)
      try {
        const s = statSync(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          writeFileSync(lockPath, String(process.pid), "utf-8"); // steal stale lock
          return;
        }
      } catch { /* lock file disappeared — retry */ }
    }
  }
  // Timed out — proceed without lock (best-effort, extremely rare)
}

function releaseLock(): void {
  try { unlinkSync(join(storeDirValue(), LOCK_FILE)); } catch { /* ignore */ }
}

// ── Writing (synchronous — hook handler is short-lived) ──

export function persistHookActivity(entry: HookActivityEntry): void {
  ensureDir();
  acquireLock();
  try {
    const currentPath = join(storeDirValue(), CURRENT_FILE);
    const countPath = join(storeDirValue(), COUNT_FILE);

    const lineCount = readCount(countPath);
    if (lineCount >= PAGE_SIZE) {
      try {
        rotate(currentPath, countPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // Another process rotated concurrently — proceed to append to fresh file.
      }
    }

    appendFileSync(currentPath, JSON.stringify(entry) + "\n", "utf-8");
    writeCount(countPath, lineCount >= PAGE_SIZE ? 1 : lineCount + 1);
    updateStats(entry);
  } finally {
    releaseLock();
  }
}

function rotate(currentPath: string, countPath: string): void {
  const archiveName = `page-${Date.now()}-${rotateSeq++}.jsonl`;
  const archivePath = join(storeDirValue(), archiveName);
  renameSync(currentPath, archivePath);
  // Reset count for the fresh file (write 0 — next append will set it to 1)
  writeCount(countPath, 0);
}

// O(1) line count via a tiny sidecar file; avoids rereading current.jsonl.
function readCount(countPath: string): number {
  try {
    const n = parseInt(readFileSync(countPath, "utf-8"), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function writeCount(countPath: string, n: number): void {
  try {
    writeFileSync(countPath, String(n), "utf-8");
  } catch {
    // Non-fatal: worst case we recount from 0 next time
  }
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// ── Incremental stats (O(1) reads/writes) ──

interface StoredStats {
  totalEvents: number;
  denyCount: number;
  policyMap: Record<string, number>;
}

function readStoredStats(): StoredStats {
  try {
    return JSON.parse(readFileSync(join(storeDirValue(), STATS_FILE), "utf-8")) as StoredStats;
  } catch {
    return { totalEvents: 0, denyCount: 0, policyMap: {} };
  }
}

/**
 * Fold one entry into a running total, in place.
 *
 * Extracted so the incremental path and {@link rebuildHookActivityStats} cannot
 * disagree: a rebuild that counted differently from the appends would produce
 * numbers that silently drift from the log they claim to summarise, and nothing
 * would catch it because both sides look plausible on their own.
 */
function foldEntry(s: StoredStats, entry: HookActivityEntry): void {
  s.totalEvents += 1;
  if (entry.decision === "deny") s.denyCount += 1;
  if (entry.policyNames && entry.policyNames.length > 0) {
    for (const name of entry.policyNames) {
      s.policyMap[name] = (s.policyMap[name] ?? 0) + 1;
    }
  } else if (entry.policyName) {
    s.policyMap[entry.policyName] = (s.policyMap[entry.policyName] ?? 0) + 1;
  }
}

/** Write stats atomically: PID-unique temp then rename, so no reader sees a partial file. */
function writeStoredStats(s: StoredStats): boolean {
  const tmpPath = join(storeDirValue(), `stats.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(s), "utf-8");
    renameSync(tmpPath, join(storeDirValue(), STATS_FILE));
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    // Non-fatal: stats file write failure doesn't block the hook
    return false;
  }
}

function updateStats(entry: HookActivityEntry): void {
  const s = readStoredStats();
  foldEntry(s, entry);
  writeStoredStats(s);
}

/**
 * Recompute `stats.json` from every page on disk.
 *
 * WHY THIS EXISTS. `stats.json` is INCREMENTAL — `updateStats` adds one entry per
 * append and nothing ever rescans — so it is the only part of the decision log
 * that cannot survive being lost. The layout migration carries the pages (real
 * records) and deliberately drops `stats.json` and `current.count` as derived
 * state, on the stated grounds that "the store rebuilds them". It did not: there
 * was no rebuild anywhere in the store, so `readStoredStats()` fell through its
 * catch to zeroes and began re-accumulating from the next event. A user upgrading
 * from a pre-daemon home kept every record and lost every total — the dashboard
 * listed their history while reporting 0 events, 0 denies and no top policy.
 *
 * It is exactly recomputable, which is what makes dropping it the right call and
 * this function the missing half: pages are never pruned (there is no retention
 * anywhere in this module), so the files on disk ARE the whole history.
 *
 * Returns the totals it wrote, or null if there was nothing to read.
 */
export function rebuildHookActivityStats(): StoredStats | null {
  ensureDir();
  const files = [CURRENT_FILE, ...getArchiveFiles()];
  const s: StoredStats = { totalEvents: 0, denyCount: 0, policyMap: {} };
  let sawAny = false;
  for (const file of files) {
    const path = join(storeDirValue(), file);
    if (!existsSync(path)) continue;
    sawAny = true;
    // `readJsonlFile` already skips malformed lines, so a truncated tail costs
    // that line rather than the whole rebuild.
    for (const entry of readJsonlFile(path)) foldEntry(s, entry);
  }
  if (!sawAny) return null;
  return writeStoredStats(s) ? s : null;
}

function readStats(): HookActivityStats {
  const s = readStoredStats();
  let topPolicy: string | null = null;
  let topPolicyCount = 0;
  for (const [name, count] of Object.entries(s.policyMap)) {
    if (count > topPolicyCount) {
      topPolicy = name;
      topPolicyCount = count;
    }
  }
  return { totalEvents: s.totalEvents, denyCount: s.denyCount, topPolicy, topPolicyCount };
}

// ── Reading (lazy, per-page) ──

export function getHookActivityPage(page: number): HookActivityEntry[] {
  ensureDir();
  if (page < 1) return [];

  if (page === 1) {
    const currentPath = join(storeDirValue(), CURRENT_FILE);
    return readJsonlFile(currentPath).reverse();
  }

  const archives = getArchiveFiles();
  const archiveIndex = page - 2;
  if (archiveIndex >= archives.length) return [];

  return readJsonlFile(join(storeDirValue(), archives[archiveIndex])).reverse();
}

export function getHookActivityPageCount(): number {
  ensureDir();
  return 1 + getArchiveFiles().length;
}

export function getAllHookActivityEntries(): HookActivityEntry[] {
  ensureDir();

  const currentPath = join(storeDirValue(), CURRENT_FILE);
  const currentEntries = readJsonlFile(currentPath).reverse();

  const archives = getArchiveFiles();
  const archiveEntries: HookActivityEntry[] = [];
  for (const file of archives) {
    const entries = readJsonlFile(join(storeDirValue(), file));
    archiveEntries.push(...entries.reverse());
  }

  return [...currentEntries, ...archiveEntries];
}


export function searchHookActivity(
  filters: HookActivityFilters,
  page: number,
): { entries: HookActivityEntry[]; totalPages: number; page: number; stats: HookActivityStats } {
  const all = getAllHookActivityEntries();

  const filtered = all.filter((entry) => {
    if (filters.decision && entry.decision !== filters.decision) return false;
    if (filters.eventType && entry.eventType !== filters.eventType) return false;
    if (
      filters.policyName &&
      (!entry.policyName || !entry.policyName.toLowerCase().includes(filters.policyName.toLowerCase()))
    ) {
      return false;
    }
    if (
      filters.sessionId &&
      (!entry.sessionId || !entry.sessionId.toLowerCase().includes(filters.sessionId.toLowerCase()))
    ) {
      return false;
    }
    if (filters.integration && entry.integration !== filters.integration) return false;
    // Rows written before attribution existed have no policySource. They are
    // excluded from every source filter rather than guessed at — a wrong
    // attribution is worse than a missing one when the point is proving which
    // rollout decided something.
    if (filters.source && entry.policySource !== filters.source) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const entries = filtered.slice(start, start + PAGE_SIZE);
  // Stats come from the O(1) incremental stats file rather than a full rescan.
  const stats = readStats();

  return { entries, totalPages, page, stats };
}

export function getHookActivityHistory(page: number): {
  entries: HookActivityEntry[];
  totalPages: number;
  page: number;
  stats: HookActivityStats;
} {
  const entries = getHookActivityPage(page);
  const totalPages = getHookActivityPageCount();
  // Stats come from the O(1) incremental stats file rather than a full rescan.
  const stats = readStats();
  return { entries, totalPages, page, stats };
}

// ── Internal helpers ──

/**
 * Accept the pre-rename spelling of the two cloud-attribution fields.
 *
 * These pages are written by the DAEMON, so a machine that was cloud-connected
 * before `cloudRevision`→`cloudVersion` / `cloudGeneration`→`cloudDeployment` has
 * real rows on disk naming the old keys. Nothing here validates the shape — the
 * line is `JSON.parse`d and cast — so those rows do not error, they simply carry
 * keys nothing reads: every pre-upgrade cloud-decided decision renders as
 * unattributed, which is the exact question these fields were added to answer.
 *
 * The Rust writer takes the same two aliases (`transform.rs`). Renaming a symbol
 * is safe; renaming the name of data an older build already wrote is not.
 *
 * One-directional and non-destructive: the new key wins if both somehow appear,
 * and the old key is left in place rather than deleted, since nothing reads it and
 * removing it would rewrite history to look like it was always current.
 */
function withRenamedCloudFields(raw: Record<string, unknown>): HookActivityEntry {
  const entry = raw as HookActivityEntry & Record<string, unknown>;
  if (entry.cloudVersion === undefined && typeof raw.cloudRevision === "number") {
    entry.cloudVersion = raw.cloudRevision;
  }
  if (entry.cloudDeployment === undefined && typeof raw.cloudGeneration === "number") {
    entry.cloudDeployment = raw.cloudGeneration;
  }
  return entry;
}

function readJsonlFile(filePath: string): HookActivityEntry[] {
  const content = readFileSafe(filePath);
  if (!content.trim()) return [];

  const entries: HookActivityEntry[] = [];
  for (const line of content.trim().split("\n")) {
    try {
      entries.push(withRenamedCloudFields(JSON.parse(line) as Record<string, unknown>));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

function getArchiveFiles(): string[] {
  try {
    const files = readdirSync(storeDirValue());
    return files
      .filter((f) => f.startsWith("page-") && f.endsWith(".jsonl"))
      .sort((a, b) => {
        const partsA = a.slice(5, -6).split("-");
        const partsB = b.slice(5, -6).split("-");
        const tsA = parseInt(partsA[0], 10);
        const tsB = parseInt(partsB[0], 10);
        if (tsA !== tsB) return tsB - tsA;
        const seqA = partsA.length > 1 ? parseInt(partsA[1], 10) : 0;
        const seqB = partsB.length > 1 ? parseInt(partsB[1], 10) : 0;
        return seqB - seqA;
      });
  } catch {
    return [];
  }
}

// ── Test helpers ──

export function _resetForTest(testDir?: string): void {
  rotateSeq = 0;
  // null, not the default path: clearing the override lets the getter re-read
  // FAILPROOFAI_HOME, which a test may have changed since this module loaded.
  storeDirOverride = testDir ?? null;
}
