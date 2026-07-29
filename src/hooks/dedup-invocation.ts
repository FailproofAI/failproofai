import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEDUP_CACHE_DIR = join(homedir(), ".failproofai", "cache");
const DEDUP_CACHE_FILE = join(DEDUP_CACHE_DIR, "dedup-invocations.json");
const DEDUP_WINDOW_MS = 2000;

interface DedupRecord {
  key: string;
  timestamp: number;
  exitCode: number;
}

export function isDuplicateInvocation(
  cli: string,
  eventType: string,
  parsed: Record<string, unknown>,
): { isDuplicate: boolean; exitCode: number } {
  try {
    const session = (parsed.session_id as string) ?? "";
    const tool = (parsed.tool_name as string) ?? "";
    const toolInput = parsed.tool_input ? JSON.stringify(parsed.tool_input) : "";
    const key = `${cli}:${eventType}:${session}:${tool}:${toolInput}`;

    const now = Date.now();
    let records: Record<string, DedupRecord> = {};

    if (existsSync(DEDUP_CACHE_FILE)) {
      try {
        const raw = readFileSync(DEDUP_CACHE_FILE, "utf8");
        records = JSON.parse(raw) as Record<string, DedupRecord>;
      } catch {
        records = {};
      }
    }

    const existing = records[key];
    if (existing && now - existing.timestamp < DEDUP_WINDOW_MS) {
      return { isDuplicate: true, exitCode: existing.exitCode };
    }
  } catch {
    // Fail-open: if dedup check fails, treat as not duplicate
  }
  return { isDuplicate: false, exitCode: 0 };
}

export function recordInvocation(
  cli: string,
  eventType: string,
  parsed: Record<string, unknown>,
  exitCode: number,
): void {
  try {
    const session = (parsed.session_id as string) ?? "";
    const tool = (parsed.tool_name as string) ?? "";
    const toolInput = parsed.tool_input ? JSON.stringify(parsed.tool_input) : "";
    const key = `${cli}:${eventType}:${session}:${tool}:${toolInput}`;

    const now = Date.now();
    let records: Record<string, DedupRecord> = {};

    mkdirSync(DEDUP_CACHE_DIR, { recursive: true });

    if (existsSync(DEDUP_CACHE_FILE)) {
      try {
        const raw = readFileSync(DEDUP_CACHE_FILE, "utf8");
        records = JSON.parse(raw) as Record<string, DedupRecord>;
      } catch {
        records = {};
      }
    }

    // Clean up stale records older than 10 seconds to keep cache small
    const cleaned: Record<string, DedupRecord> = {};
    for (const [k, v] of Object.entries(records)) {
      if (now - v.timestamp < 10_000) {
        cleaned[k] = v;
      }
    }

    cleaned[key] = { key, timestamp: now, exitCode };
    writeFileSync(DEDUP_CACHE_FILE, JSON.stringify(cleaned), "utf8");
  } catch {
    // Non-blocking write
  }
}
