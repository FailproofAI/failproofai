/**
 * Hermes (hermes-agent) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Hermes stores every gateway user's sessions in one
 * SQLite DB (`~/.hermes/state.db`). We read it DIRECTLY via the bundled sql.js
 * driver (lib/sqlite-reader.ts) — a reusable path for SQLite-backed agents.
 * (opencode and the already-shipped CLIs keep their CLI shell-out unchanged.)
 *
 * Message shape is OpenAI Chat-Completions style (verified live): assistant tool
 * calls are `tool_calls[].function.{name, arguments}` (stored as a JSON string
 * column) and results are separate `role:"tool"` rows keyed by `tool_call_id`.
 * `hermesRowsToLogEntries` pairs them (mirrors `lib/codex-sessions.ts`) and is a
 * PURE function of the message rows, so it is unit-testable without a DB.
 *
 * DB path override: set `HERMES_DB_PATH` (used by tests and to point at a copied
 * or remote state.db).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openSqliteReadonly } from "./sqlite-reader";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type GenericEntry,
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

/** Absolute path to Hermes's SQLite DB (override with HERMES_DB_PATH). */
export function hermesDbPath(): string {
  return process.env.HERMES_DB_PATH || join(homedir(), ".hermes", "state.db");
}

/** Coerce a Hermes epoch value (seconds or ms) to epoch ms. Hermes stores
 *  `started_at`/`ended_at`/`timestamp` as REAL epoch seconds. */
export function epochToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value; // already ms
    if (value > 1e9) return value * 1000; // seconds
  }
  return Date.now();
}

// ── Parsing helpers ──

function safeJsonParse(s: unknown): unknown {
  if (typeof s !== "string" || s.length === 0) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Text from a `content` field that may be a string or an array of
 *  `{ type:"text", text }` blocks. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isPlainObject(c) && typeof c.text === "string" ? (c.text as string) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toDate(value: unknown, fallbackMs: number): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return new Date(value);
    if (value > 1e9) return new Date(value * 1000);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date(fallbackMs);
}

interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalize `tool_calls` (array, or the JSON-string column Hermes stores) into
 *  `{ id, name, input }[]`. OpenAI shape: `{ id|call_id, function:{ name,
 *  arguments } }` where `arguments` is itself a JSON string. */
function normalizeToolCalls(raw: unknown): NormalizedToolCall[] {
  const arr = Array.isArray(raw) ? raw : safeJsonParse(raw);
  if (!Array.isArray(arr)) return [];
  const out: NormalizedToolCall[] = [];
  for (const tc of arr) {
    if (!isPlainObject(tc)) continue;
    const fn = isPlainObject(tc.function) ? tc.function : {};
    const name =
      typeof fn.name === "string"
        ? fn.name
        : typeof tc.name === "string"
          ? (tc.name as string)
          : "tool";
    const id =
      (typeof tc.id === "string" && tc.id) ||
      (typeof tc.call_id === "string" && tc.call_id) ||
      `${name}-${out.length}`;
    const parsedArgs = isPlainObject(fn.arguments) ? fn.arguments : safeJsonParse(fn.arguments);
    out.push({ id, name, input: isPlainObject(parsedArgs) ? parsedArgs : {} });
  }
  return out;
}

// ── Pure parser: message rows → LogEntry[] ──

/**
 * Convert `messages`-table rows (ordered by timestamp) into `LogEntry[]`.
 * Pairs each assistant `tool_calls` entry with its later `role:"tool"` result
 * by `tool_call_id`. Roles other than user/assistant/tool (e.g. Hermes's
 * `session_meta`) become generic system entries so nothing is dropped. Pure —
 * unit-testable with plain row objects.
 */
export function hermesRowsToLogEntries(
  rows: Record<string, unknown>[],
  source: LogSource = "session",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();
  const baseMs = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (!isPlainObject(m)) continue;

    const role = typeof m.role === "string" ? m.role : "system";
    const date = toDate(m.timestamp ?? m.time_created, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: m.id != null ? String(m.id) : `hermes-${i}`,
      parentUuid: null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    if (role === "user") {
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: extractText(m.content) },
      } satisfies UserEntry);
      continue;
    }

    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      const text = extractText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of normalizeToolCalls(m.tool_calls)) {
        const block: ToolUseBlock = { type: "tool_use", id: tc.id, name: tc.name, input: tc.input };
        blocks.push(block);
        toolUseById.set(tc.id, block);
        toolUseStartMs.set(tc.id, date.getTime());
      }
      if (blocks.length === 0) continue; // empty assistant turn
      entries.push({
        type: "assistant",
        ...base,
        message: { role: "assistant", content: blocks },
      } satisfies AssistantEntry);
      continue;
    }

    if (role === "tool") {
      const callId = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (block) {
        const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
        const durationMs = Math.max(0, date.getTime() - startMs);
        block.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: extractText(m.content),
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
        continue;
      }
      // Orphan tool result — fall through to a system entry.
    }

    entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── DB loader ──

export interface HermesSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string; // synthetic — hermes keeps sessions in a DB; we use hermes://<id>
}

interface HermesMessageRow {
  id: number | null;
  role: string | null;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number | null;
}

/**
 * Load one session by ID from `state.db`. Returns `null` when the DB is
 * unavailable or the session doesn't exist.
 */
export async function getHermesSessionLog(
  sessionId: string,
): Promise<HermesSessionLogData | null> {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const db = await openSqliteReadonly(hermesDbPath());
  if (!db) return null;
  try {
    const sessionRows = db.query<{ source: string | null; cwd: string | null }>(
      "SELECT source, cwd FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (sessionRows.length === 0) return null;
    const { source, cwd: realCwd } = sessionRows[0];

    const msgRows = db.query<HermesMessageRow>(
      "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp " +
        "FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
      [sessionId],
    );

    const entries = hermesRowsToLogEntries(
      msgRows as unknown as Record<string, unknown>[],
      "session",
    );
    // Gateway sessions have no cwd → group by source (slack/telegram/cli/cron).
    const cwd =
      realCwd && realCwd.length > 0 ? realCwd : source ? `hermes:${source}` : undefined;
    return {
      entries,
      rawLines: msgRows as unknown as Record<string, unknown>[],
      cwd,
      filePath: `hermes://${sessionId}`,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export const getCachedHermesSessionLog = runtimeCache(
  (sessionId: string) => getHermesSessionLog(sessionId),
  2,
  { maxSize: 50 },
);
