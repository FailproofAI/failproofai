/**
 * Lightweight logger for hook processes.
 *
 * ALL output goes to stderr (stdout is reserved for the hook JSON response
 * that Claude Code reads).
 *
 * Optionally writes to a log file with size-based rotation.
 *
 * Env vars:
 *   FAILPROOFAI_LOG_LEVEL      — info | warn | error (default: warn)
 *   FAILPROOFAI_HOOK_LOG_FILE  — enable file logging:
 *       unset / ""   → disabled (stderr only)
 *       "1" / "true" → enabled, writes to ~/.failproofai/logs/
 *       <path>       → enabled, writes to that directory
 */
import {
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { logsDir } from "./fp-home";

export type LogLevel = "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const MAX_FILE_SIZE = 512 * 1024; // 500 KB
const LOG_FILENAME = "hooks.log";
const DEFAULT_LOG_DIR = logsDir();

// ── State (lazy-initialized) ──

let resolved = false;
let currentLevel: LogLevel = "warn";
let fileLoggingEnabled = false;
let logDir = DEFAULT_LOG_DIR;

function ensureResolved(): void {
  if (resolved) return;
  resolved = true;

  // Log level
  const rawLevel = (process.env.FAILPROOFAI_LOG_LEVEL ?? "").toLowerCase();
  if (rawLevel === "info" || rawLevel === "warn" || rawLevel === "error") {
    currentLevel = rawLevel;
  }

  // File logging
  const rawFile = (process.env.FAILPROOFAI_HOOK_LOG_FILE ?? "").trim();
  if (rawFile) {
    fileLoggingEnabled = true;
    if (rawFile !== "1" && rawFile !== "true") {
      logDir = rawFile;
    }
  }
}

function shouldEmit(level: LogLevel): boolean {
  ensureResolved();
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

// ── Stderr output ──

function emitStderr(label: string, msg: string): void {
  process.stderr.write(`[failproofai:hook] ${label} ${msg}\n`);
}

// ── File output (synchronous — hook processes are short-lived) ──

function ensureLogDir(): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stats = statSync(filePath);
    if (stats.size >= MAX_FILE_SIZE) {
      const archiveName = `hooks-${Date.now()}.log`;
      renameSync(filePath, join(logDir, archiveName));
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

function appendToFile(label: string, msg: string): void {
  if (!fileLoggingEnabled) return;

  try {
    ensureLogDir();
    const filePath = join(logDir, LOG_FILENAME);
    rotateIfNeeded(filePath);

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${label} ${msg}\n`;
    appendFileSync(filePath, line, "utf-8");
  } catch {
    // File logging is best-effort — never fail the hook
  }
}

// ── Public API ──

export function hookLogInfo(msg: string): void {
  if (!shouldEmit("info")) return;
  emitStderr("INFO", msg);
  appendToFile("INFO", msg);
}

export function hookLogWarn(msg: string): void {
  if (!shouldEmit("warn")) return;
  emitStderr("WARN", msg);
  appendToFile("WARN", msg);
}

export function hookLogError(msg: string): void {
  if (!shouldEmit("error")) return;
  emitStderr("ERROR", msg);
  appendToFile("ERROR", msg);
}

/** Reset internal state (for testing only). */
export function _resetHookLogger(): void {
  resolved = false;
  currentLevel = "warn";
  fileLoggingEnabled = false;
  logDir = DEFAULT_LOG_DIR;
}
