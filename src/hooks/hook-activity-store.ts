/**
 * Disk persistence for hook activity entries using page-sized JSONL files.
 *
 * Storage location: ~/.failproofai/cache/hook-activity/
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
import { homedir } from "node:os";
import type { IntegrationType } from "./types";

export const PAGE_SIZE = 25;

const DEFAULT_STORE_DIR = join(homedir(), ".failproofai", "cache", "hook-activity");
const CURRENT_FILE = "current.jsonl";
const COUNT_FILE = "current.count"; // tracks line count; O(1) read/write vs rereading current.jsonl
const STATS_FILE = "stats.json";
const LOCK_FILE = "current.lock";  // advisory lock for concurrent hook processes
const LOCK_STALE_MS = 2000;        // steal lock if older than 2 s (covers crashed processes)

let storeDir = DEFAULT_STORE_DIR;
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
}

export interface HookActivityFilters {
  decision?: "allow" | "deny" | "instruct";
  eventType?: string;
  policyName?: string;
  sessionId?: string;
  integration?: IntegrationType;
}

export interface HookActivityStats {
  totalEvents: number;
  denyCount: number;
  topPolicy: string | null;
  topPolicyCount: number;
}

// ── Directory setup ──

function ensureDir(): void {
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }
}

// ── Advisory lock (protects count + stats read-modify-write cycles) ──

function acquireLock(): void {
  ensureDir();
  const lockPath = join(storeDir, LOCK_FILE);
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
  try { unlinkSync(join(storeDir, LOCK_FILE)); } catch { /* ignore */ }
}

// ── Writing (synchronous — hook handler is short-lived) ──

export function persistHookActivity(entry: HookActivityEntry): void {
  ensureDir();
  acquireLock();
  try {
    const currentPath = join(storeDir, CURRENT_FILE);
    const countPath = join(storeDir, COUNT_FILE);

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
  const archivePath = join(storeDir, archiveName);
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
    return JSON.parse(readFileSync(join(storeDir, STATS_FILE), "utf-8")) as StoredStats;
  } catch {
    return { totalEvents: 0, denyCount: 0, policyMap: {} };
  }
}

function updateStats(entry: HookActivityEntry): void {
  const s = readStoredStats();
  s.totalEvents += 1;
  if (entry.decision === "deny") s.denyCount += 1;
  if (entry.policyNames && entry.policyNames.length > 0) {
    for (const name of entry.policyNames) {
      s.policyMap[name] = (s.policyMap[name] ?? 0) + 1;
    }
  } else if (entry.policyName) {
    s.policyMap[entry.policyName] = (s.policyMap[entry.policyName] ?? 0) + 1;
  }
  // Write atomically: write to a PID-unique temp file then rename — prevents partial reads.
  const tmpPath = join(storeDir, `stats.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(s), "utf-8");
    renameSync(tmpPath, join(storeDir, STATS_FILE));
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    // Non-fatal: stats file write failure doesn't block the hook
  }
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
    const currentPath = join(storeDir, CURRENT_FILE);
    return readJsonlFile(currentPath).reverse();
  }

  const archives = getArchiveFiles();
  const archiveIndex = page - 2;
  if (archiveIndex >= archives.length) return [];

  return readJsonlFile(join(storeDir, archives[archiveIndex])).reverse();
}

export function getHookActivityPageCount(): number {
  ensureDir();
  return 1 + getArchiveFiles().length;
}

export function getAllHookActivityEntries(): HookActivityEntry[] {
  ensureDir();

  const currentPath = join(storeDir, CURRENT_FILE);
  const currentEntries = readJsonlFile(currentPath).reverse();

  const archives = getArchiveFiles();
  const archiveEntries: HookActivityEntry[] = [];
  for (const file of archives) {
    const entries = readJsonlFile(join(storeDir, file));
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

function readJsonlFile(filePath: string): HookActivityEntry[] {
  const content = readFileSafe(filePath);
  if (!content.trim()) return [];

  const entries: HookActivityEntry[] = [];
  for (const line of content.trim().split("\n")) {
    try {
      entries.push(JSON.parse(line) as HookActivityEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

function getArchiveFiles(): string[] {
  try {
    const files = readdirSync(storeDir);
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
  storeDir = testDir ?? DEFAULT_STORE_DIR;
}
