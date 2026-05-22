/**
 * Codex (OpenAI) session transcript discovery + JSONL parser.
 *
 * Codex stores transcripts at:
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/<file containing sessionId>.jsonl
 *
 * The schema is uniform `{ timestamp, type, payload }` records:
 *   - type: session_meta   — metadata (cwd, model, base instructions)
 *   - type: turn_context   — per-turn config (approval_policy, sandbox)
 *   - type: response_item  — message / function_call / function_call_output
 *   - type: event_msg      — task_started, user_message, agent_message,
 *                            exec_command_begin/end, token_count, …
 *
 * `parseCodexLog` maps these into the same `LogEntry` shapes the Claude
 * parser produces (`lib/log-entries.ts`) so the existing log viewer renders
 * Codex sessions without any UI-side branching.
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

// ── Transcript discovery ──

const CACHE_PATH = join(homedir(), ".failproofai", "cache", "codex-session-paths.json");

function readCache(): Record<string, string> {
  try {
    if (!existsSync(CACHE_PATH)) return {};
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCacheEntry(sessionId: string, path: string): void {
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const cache = readCache();
    cache[sessionId] = path;
    writeFileSync(tmpPath, JSON.stringify(cache), "utf-8");
    renameSync(tmpPath, CACHE_PATH);
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    // Cache is best-effort
  }
}

function dirSearch(dir: string, sessionId: string): string | null {
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && f.name.includes(sessionId) && f.name.endsWith(".jsonl")) {
        return join(dir, f.name);
      }
    }
  } catch {
    // dir doesn't exist or unreadable
  }
  return null;
}

/**
 * Locate a Codex transcript by sessionId. Tries the cache, then today/
 * yesterday's date directories, then a full tree scan as fallback.
 * Synchronous so the hook hot path can call it without awaits.
 */
export function findCodexTranscript(sessionId: string): string | null {
  const cache = readCache();
  const cached = cache[sessionId];
  if (cached && existsSync(cached)) return cached;

  const root = join(homedir(), ".codex", "sessions");

  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const datedDirs = [today, yesterday].map((d) => {
    const y = String(d.getUTCFullYear());
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return join(root, y, m, day);
  });
  for (const dir of datedDirs) {
    const hit = dirSearch(dir, sessionId);
    if (hit) {
      writeCacheEntry(sessionId, hit);
      return hit;
    }
  }

  try {
    for (const y of readdirSync(root, { withFileTypes: true })) {
      if (!y.isDirectory()) continue;
      for (const m of readdirSync(join(root, y.name), { withFileTypes: true })) {
        if (!m.isDirectory()) continue;
        for (const d of readdirSync(join(root, y.name, m.name), { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const hit = dirSearch(join(root, y.name, m.name, d.name), sessionId);
          if (hit) {
            writeCacheEntry(sessionId, hit);
            return hit;
          }
        }
      }
    }
  } catch {
    // Session may not have flushed yet, or the path doesn't exist
  }
  return null;
}

// ── Parser ──

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexParseResult {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  /** Working directory pulled from the first session_meta record, when present. */
  cwd?: string;
}

function safeJsonParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function joinTexts(blocks: CodexContentBlock[] | undefined, wantedType: "input_text" | "output_text"): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b?.type === wantedType && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Parse a Codex JSONL transcript into `LogEntry[]` plus the raw lines.
 * Yields to the event loop every 200 lines so big transcripts don't block.
 */
export async function parseCodexLog(
  fileContent: string,
  source: LogSource = "session",
): Promise<CodexParseResult> {
  const lines = fileContent.split("\n").filter((line) => line.trim() !== "");

  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  // call_id → tool_use block, so we can attach exec_command_end results back to the originating call.
  const toolUseById = new Map<string, ToolUseBlock>();
  // call_id → tool_use entry timestamp, used to compute durationMs from end records that lack a duration.
  const toolUseStartMs = new Map<string, number>();
  let cwd: string | undefined;
  let seenTaskStart = false;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 200 === 0) await new Promise<void>((r) => setImmediate(r));

    const line = lines[i];
    let raw: CodexRecord;
    try {
      raw = JSON.parse(line) as CodexRecord;
    } catch {
      continue;
    }

    const rawCopy = { ...(raw as Record<string, unknown>), _source: source };
    rawLines.push(rawCopy);

    const timestamp = raw.timestamp;
    if (!timestamp) continue;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) continue;

    const recType = raw.type;
    const payload = raw.payload ?? {};

    if (recType === "session_meta") {
      const c = payload.cwd;
      if (typeof c === "string" && !cwd) cwd = c;
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    if (recType === "response_item") {
      const subType = payload.type as string | undefined;

      if (subType === "message") {
        const role = payload.role as string | undefined;
        const content = payload.content as CodexContentBlock[] | undefined;

        if (role === "user" || role === "developer") {
          const text = joinTexts(content, "input_text");
          if (!text) continue;
          const message = role === "developer" ? `[developer] ${text}` : text;
          entries.push({
            type: "user",
            ...baseEntry(rawCopy, timestamp, date, source),
            message: { role: "user", content: message },
          } satisfies UserEntry);
          continue;
        }

        if (role === "assistant") {
          const text = joinTexts(content, "output_text");
          if (!text) continue;
          const blocks: ContentBlock[] = [{ type: "text", text }];
          entries.push({
            type: "assistant",
            ...baseEntry(rawCopy, timestamp, date, source),
            message: { role: "assistant", content: blocks },
          } satisfies AssistantEntry);
          continue;
        }

        // Unknown role — preserve as system so nothing is lost.
        entries.push({
          type: "system",
          ...baseEntry(rawCopy, timestamp, date, source),
          raw: rawCopy,
        } satisfies GenericEntry);
        continue;
      }

      if (subType === "function_call") {
        const callId = payload.call_id as string | undefined;
        const name = (payload.name as string | undefined) ?? "function_call";
        const input = safeJsonParse(payload.arguments as string | undefined);
        const toolUse: ToolUseBlock = {
          type: "tool_use",
          id: callId ?? `${timestamp}-${name}`,
          name,
          input,
        };
        const entry: AssistantEntry = {
          type: "assistant",
          ...baseEntry(rawCopy, timestamp, date, source),
          message: { role: "assistant", content: [toolUse] },
        };
        entries.push(entry);
        if (callId) {
          toolUseById.set(callId, toolUse);
          toolUseStartMs.set(callId, date.getTime());
        }
        continue;
      }

      if (subType === "function_call_output") {
        const callId = payload.call_id as string | undefined;
        const block = callId ? toolUseById.get(callId) : undefined;
        if (block) {
          const startMs = toolUseStartMs.get(callId!) ?? date.getTime();
          const duration = Math.max(0, date.getTime() - startMs);
          block.result = {
            timestamp,
            timestampFormatted: formatTimestamp(date),
            content: typeof payload.output === "string" ? (payload.output as string) : JSON.stringify(payload.output),
            durationMs: duration,
            durationFormatted: formatDuration(duration),
          };
          continue;
        }
        // Orphan output — preserve as system.
        entries.push({
          type: "system",
          ...baseEntry(rawCopy, timestamp, date, source),
          raw: rawCopy,
        } satisfies GenericEntry);
        continue;
      }

      // Unknown response_item subtype — preserve raw.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    if (recType === "event_msg") {
      const subType = payload.type as string | undefined;

      if (subType === "task_started") {
        const label: QueueOperationEntry["label"] = seenTaskStart ? "Session Resumed" : "Session Started";
        seenTaskStart = true;
        entries.push({
          type: "queue-operation",
          ...baseEntry(rawCopy, timestamp, date, source),
          label,
        } satisfies QueueOperationEntry);
        continue;
      }

      if (subType === "exec_command_end") {
        const callId = payload.call_id as string | undefined;
        const block = callId ? toolUseById.get(callId) : undefined;
        if (block) {
          const duration = payload.duration as { secs?: number; nanos?: number } | undefined;
          const durationMs = duration
            ? (duration.secs ?? 0) * 1000 + Math.round((duration.nanos ?? 0) / 1e6)
            : Math.max(0, date.getTime() - (toolUseStartMs.get(callId!) ?? date.getTime()));
          const aggregated = payload.aggregated_output;
          block.result = {
            timestamp,
            timestampFormatted: formatTimestamp(date),
            content: typeof aggregated === "string" ? aggregated : JSON.stringify(aggregated),
            durationMs,
            durationFormatted: formatDuration(durationMs),
          };
          continue;
        }
        // Orphan exec end — preserve as system.
        entries.push({
          type: "system",
          ...baseEntry(rawCopy, timestamp, date, source),
          raw: rawCopy,
        } satisfies GenericEntry);
        continue;
      }

      if (subType === "user_message" || subType === "agent_message") {
        // Already rendered via the corresponding response_item; skip to avoid duplicates.
        continue;
      }

      // Other event_msg subtypes (token_count, exec_command_begin, etc.) — preserve raw.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    // turn_context and any unrecognized type — preserve raw so nothing is silently dropped.
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

export interface CodexSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

export async function getCodexSessionLog(sessionId: string): Promise<CodexSessionLogData | null> {
  const filePath = findCodexTranscript(sessionId);
  if (!filePath) return null;
  const fileContent = await readFile(filePath, "utf-8");
  const { entries, rawLines, cwd } = await parseCodexLog(fileContent, "session");
  return { entries, rawLines, cwd, filePath };
}

export const getCachedCodexSessionLog = runtimeCache(
  (sessionId: string) => getCodexSessionLog(sessionId),
  60,
  { maxSize: 50 },
);

// ── Test helpers ──

/** For tests: inspect cache file path. */
export function _getCacheFilePath(): string {
  return CACHE_PATH;
}

/** For tests: confirm the file exists at a path. Wraps fs to keep tests minimal. */
export function _statFile(path: string): { isFile: boolean } | null {
  try {
    return { isFile: statSync(path).isFile() };
  } catch {
    return null;
  }
}
