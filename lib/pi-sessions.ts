/**
 * Pi (pi-coding-agent) session transcript discovery + JSONL parser.
 *
 * Empirically verified against pi-coding-agent v0.72.1 (Phase 0.7 of plan):
 *
 * Session files live at
 *   `~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<UUID>.jsonl`
 * where `<encoded-cwd>` wraps `--`-prefixed-and-suffixed `/`-separated paths
 * (e.g. `/home/user/repo` → `--home-user-repo--`). The encoding is lossy
 * (literal `-` is preserved); we use the `cwd` field of the first JSONL
 * record (`{type: "session", cwd, …}`) as the canonical cwd.
 *
 * Record schema (observed):
 *   {type: "session",                version, id, timestamp, cwd}
 *   {type: "model_change",           id, parentId, timestamp, provider, modelId}
 *   {type: "thinking_level_change",  id, parentId, timestamp, thinkingLevel}
 *   {type: "message",                id, parentId, timestamp,
 *                                    message: {role, content[], timestamp}}
 *
 * `message.content[]` items can be `{type: "text", text}` or
 * `{type: "thinking", thinking, thinkingSignature}`. Tool-call blocks are not
 * yet observed in this codebase (no tool-using runs were captured during
 * Phase 0); when Pi does emit them, this parser preserves them as-is via the
 * fallback "system" branch and the test suite asserts at least the
 * round-trip rather than a specific shape.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type GenericEntry,
  type QueueOperationEntry,
  type ContentBlock,
  type LogSource,
} from "./log-entries";

// ── Paths ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_RE = /^[\d-]+T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Root directory for Pi session state, honoring PI_SESSIONS_DIR. */
export function getPiSessionStateRoot(): string {
  return process.env.PI_SESSIONS_DIR
    || join(homedir(), ".pi", "agent", "sessions");
}

/** Reject a sessionId that isn't a UUID — defends against path traversal. */
function isSafeSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

/** Find the JSONL transcript for `sessionId` by walking each per-cwd subdir
 *  of the session-state root. Rejects path-traversal sessionIds and verifies
 *  the resolved path stays under the root. Returns null on miss. */
export function findPiTranscript(sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const root = resolve(getPiSessionStateRoot());

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(root);
  } catch {
    return null;
  }

  for (const cwdDir of cwdDirs) {
    const cwdPath = resolve(root, cwdDir);
    if (!cwdPath.startsWith(`${root}${sep}`)) continue;
    let files: string[];
    try {
      files = readdirSync(cwdPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = SESSION_FILE_RE.exec(f);
      if (!m || m[1].toLowerCase() !== sessionId.toLowerCase()) continue;
      const candidate = resolve(cwdPath, f);
      if (!candidate.startsWith(`${cwdPath}${sep}`)) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── Parser ──

interface PiSessionRecord {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  version?: number;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    timestamp?: number;
  };
}

interface PiParseResult {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  /** Working directory pulled from the first session record, when available. */
  cwd?: string;
}

/** Extract a plain-text summary of a Pi message content block. Concatenates
 *  every `"text"` block (joined by blank lines) so multi-part user messages
 *  aren't truncated to just the first text segment. */
function extractMessageText(content: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

/** Build a list of ContentBlocks for the assistant entry, preserving text and
 *  thinking blocks. Skips blocks with non-string payloads (typeof guards). */
function buildAssistantContent(content: Array<Record<string, unknown>> | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      blocks.push({ type: "text", text: block.text });
    }
    // Pi's "thinking" blocks aren't a first-class entry type in our LogEntry
    // hierarchy; embed as a text block prefixed for clarity.
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      blocks.push({ type: "text", text: `[thinking] ${block.thinking}` });
    }
  }
  return blocks;
}

/**
 * Parse a Pi JSONL transcript into `LogEntry[]` plus the raw lines.
 * Yields to the event loop every 200 lines so big transcripts don't block
 * the request.
 */
export async function parsePiLog(
  fileContent: string,
  source: LogSource = "session",
): Promise<PiParseResult> {
  const lines = fileContent.split("\n").filter((line) => line.trim() !== "");
  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  let cwd: string | undefined;
  let seenSessionStart = false;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 200 === 0) await new Promise<void>((r) => setImmediate(r));

    const line = lines[i];
    let raw: PiSessionRecord;
    try {
      raw = JSON.parse(line) as PiSessionRecord;
    } catch {
      continue;
    }

    const rawCopy = { ...(raw as Record<string, unknown>), _source: source };
    rawLines.push(rawCopy);

    const timestampStr = raw.timestamp;
    if (!timestampStr) continue;
    const date = new Date(timestampStr);
    if (Number.isNaN(date.getTime())) continue;
    const timestamp = date.toISOString();

    const recType = raw.type;

    // Pi's first record per session is `{type: "session", cwd, ...}`.
    if (recType === "session") {
      if (typeof raw.cwd === "string" && !cwd) cwd = raw.cwd;
      const label: QueueOperationEntry["label"] = seenSessionStart ? "Session Resumed" : "Session Started";
      seenSessionStart = true;
      entries.push({
        type: "queue-operation",
        ...baseEntry(rawCopy, timestamp, date, source),
        label,
      } satisfies QueueOperationEntry);
      continue;
    }

    // Pi messages are `{type: "message", message: {role, content[]}}`. Branch
    // on role; render text/thinking content. Validate types defensively.
    if (recType === "message" && raw.message && typeof raw.message === "object") {
      const role = raw.message.role;
      const content = raw.message.content;

      if (role === "user") {
        const text = extractMessageText(content);
        if (!text) continue;
        entries.push({
          type: "user",
          ...baseEntry(rawCopy, timestamp, date, source),
          message: { role: "user", content: text },
        } satisfies UserEntry);
        continue;
      }

      if (role === "assistant") {
        const blocks = buildAssistantContent(content);
        if (blocks.length === 0) {
          entries.push({
            type: "system",
            ...baseEntry(rawCopy, timestamp, date, source),
            raw: rawCopy,
          } satisfies GenericEntry);
          continue;
        }
        entries.push({
          type: "assistant",
          ...baseEntry(rawCopy, timestamp, date, source),
          message: { role: "assistant", content: blocks },
        } satisfies AssistantEntry);
        continue;
      }

      // Unknown role — preserve raw so nothing is dropped.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    // model_change / thinking_level_change / unknown — preserve raw as system
    // so the dashboard can surface them without ad-hoc renderers.
    entries.push({
      type: "system",
      ...baseEntry(rawCopy, timestamp, date, source),
      raw: rawCopy,
    } satisfies GenericEntry);
  }

  if (entries.length > 500) await new Promise<void>((r) => setImmediate(r));
  entries.sort((a, b) => a.timestampMs - b.timestampMs);

  return { entries, rawLines, cwd };
}

// ── Public loader ──

export interface PiSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

export async function getPiSessionLog(sessionId: string): Promise<PiSessionLogData | null> {
  const filePath = findPiTranscript(sessionId);
  if (!filePath) return null;
  let fileContent: string;
  try {
    fileContent = await readFile(filePath, "utf-8");
  } catch {
    // The file vanished between findPiTranscript and read — fall open.
    return null;
  }
  let parsed: PiParseResult;
  try {
    parsed = await parsePiLog(fileContent, "session");
  } catch {
    return null;
  }
  return {
    entries: parsed.entries,
    rawLines: parsed.rawLines,
    cwd: parsed.cwd,
    filePath,
  };
}

export const getCachedPiSessionLog = runtimeCache(
  (sessionId: string) => getPiSessionLog(sessionId),
  60,
  { maxSize: 50 },
);

// ── Test helpers ──

/** For tests: read raw stat of the transcript path, returning null on miss. */
export function _statPiTranscript(sessionId: string): { mtimeMs: number } | null {
  const path = findPiTranscript(sessionId);
  if (!path) return null;
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** For tests: read transcript synchronously. Returns null on missing/error. */
export function readPiTranscriptSync(sessionId: string): string | null {
  const path = findPiTranscript(sessionId);
  if (!path) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Suppress unused-import warning for formatTimestamp; reserved for tool-call
 *  rendering once Pi emits it (see header comment). */
void formatTimestamp;
