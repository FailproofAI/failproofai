/**
 * Goose (codename goose, Block) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Goose (≥ v1.10.0) stores every session in one SQLite DB
 * at `~/.local/share/goose/sessions/sessions.db`. We read it DIRECTLY via the
 * bundled sql.js driver (lib/sqlite-reader.ts) — the same reusable path
 * Devin/Hermes/OpenClaw use. Like Devin (and unlike the cwd-less Hermes gateway),
 * each Goose `sessions` row carries a real `working_dir`, so Goose sessions group
 * by project cwd like Claude/Factory/Devin.
 *
 * Schema (verified live against goose v1.43.0, schema_version 15):
 *   sessions(id TEXT `YYYYMMDD_N`, name, description, session_type
 *            (user|hidden|subagent|scheduled|terminal|acp), working_dir,
 *            created_at TIMESTAMP, updated_at TIMESTAMP, total_tokens, …)
 *   messages(id INTEGER PK, session_id, role (user|assistant),
 *            content_json TEXT=JSON-array-of-blocks, created_timestamp INT, …)
 *
 * `content_json` is a Claude-style typed-block array (NOT OpenAI-style like
 * Devin): `{type:"text",text}`, `{type:"toolRequest",id,toolCall:{value:{name,
 * arguments}},_meta:{goose_extension}}`, and `{type:"toolResponse",id,toolResult:
 * {value:{content:[{type:"text",text}],isError}}}`. Tool RESULTS are stored in
 * `role:"user"` rows (Claude convention). `gooseRowsToLogEntries` pairs each
 * toolRequest with its later toolResponse by id and is a PURE function of the
 * parsed rows, so it is unit-testable without a DB.
 *
 * `session_type = 'hidden'` rows are `goose run --no-session` scratch runs — the
 * enumerator (lib/goose-projects.ts) filters them out.
 *
 * Home override: set `GOOSE_HOME` (the data dir that contains `sessions/`, used
 * by tests) or `GOOSE_DB_PATH` (points directly at a sessions.db).
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

/** Goose session IDs are date-prefixed counters, e.g. `20260714_3`. */
export const GOOSE_SESSION_ID_RE = /^\d{8}_\d+$/;

/** Absolute path to Goose's data home (override with GOOSE_HOME; respects
 *  XDG_DATA_HOME otherwise). */
export function gooseHome(): string {
  if (process.env.GOOSE_HOME) return process.env.GOOSE_HOME;
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share"), "goose");
}

/** Absolute path to Goose's SQLite DB (override with GOOSE_DB_PATH). */
export function gooseDbPath(): string {
  return process.env.GOOSE_DB_PATH || join(gooseHome(), "sessions", "sessions.db");
}

/** Coerce a Goose timestamp to epoch ms. `messages.created_timestamp` is an
 *  INTEGER epoch (seconds or ms); `sessions.created_at`/`updated_at` are SQLite
 *  `CURRENT_TIMESTAMP` strings ("YYYY-MM-DD HH:MM:SS", UTC). */
export function gooseTimestampToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value; // already ms
    if (value > 1e9) return value * 1000; // seconds
  }
  if (typeof value === "string" && value.length > 0) {
    // SQLite CURRENT_TIMESTAMP has no zone and is UTC — normalize to ISO-Z so
    // Date.parse doesn't treat it as local time.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
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
  const ms = typeof value === "number" || typeof value === "string" ? gooseTimestampToMs(value) : NaN;
  return Number.isNaN(ms) ? new Date(fallbackMs) : new Date(ms);
}

/** Pull `{ id, name, input }` from a Goose `toolRequest` block:
 *  `{id, toolCall:{status, value:{name, arguments}}}`. */
function extractToolRequest(
  block: Record<string, unknown>,
  idx: number,
): { id: string; name: string; input: Record<string, unknown> } {
  const id = typeof block.id === "string" && block.id ? block.id : `goose-tool-${idx}`;
  const toolCall = isPlainObject(block.toolCall) ? block.toolCall : {};
  const value = isPlainObject(toolCall.value) ? toolCall.value : {};
  const name = typeof value.name === "string" ? value.name : "tool";
  const input = isPlainObject(value.arguments) ? value.arguments : {};
  return { id, name, input };
}

/** Text of a Goose `toolResponse` block:
 *  `{id, toolResult:{status, value:{content:[{type:"text",text}], …}}}`. */
function extractToolResult(block: Record<string, unknown>): string {
  const toolResult = isPlainObject(block.toolResult) ? block.toolResult : {};
  const value = toolResult.value;
  if (isPlainObject(value) && Array.isArray(value.content)) return extractText(value.content);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractText(value);
  return "";
}

// ── Pure parser: message rows → LogEntry[] ──

export interface GooseMessageRow {
  role: string | null;
  content_json: string | null;
  created_timestamp: number | null;
}

/**
 * Convert Goose `messages` rows (in insertion order) into `LogEntry[]`. Each
 * row's `content_json` is a typed-block array; `toolRequest` blocks become
 * `tool_use` blocks on an assistant entry, and later `toolResponse` blocks
 * (which arrive in `role:"user"` rows) attach as the matching tool_use's result
 * by id. Pure — unit-testable with plain rows.
 */
export function gooseRowsToLogEntries(
  rows: GooseMessageRow[],
  source: LogSource = "session",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();
  const baseMs = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const parsed = safeJsonParse(r.content_json);
    if (!Array.isArray(parsed)) continue;

    const role = typeof r.role === "string" ? r.role : "system";
    const date = toDate(r.created_timestamp, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = { uuid: `goose-${i}`, parentUuid: null };
    const base = baseEntry(raw, timestamp, date, source);

    const textParts: string[] = [];
    const toolReqs: Record<string, unknown>[] = [];
    const toolResps: Record<string, unknown>[] = [];
    for (const b of parsed) {
      if (!isPlainObject(b)) continue;
      if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
      else if (b.type === "toolRequest") toolReqs.push(b);
      else if (b.type === "toolResponse") toolResps.push(b);
    }

    // Attach tool results to their earlier tool_use blocks (results arrive in
    // role:"user" rows, so this runs before we consider the row a user turn).
    for (const tr of toolResps) {
      const callId = typeof tr.id === "string" ? tr.id : undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (!block) continue;
      const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
      const durationMs = Math.max(0, date.getTime() - startMs);
      block.result = {
        timestamp,
        timestampFormatted: formatTimestamp(date),
        content: extractToolResult(tr),
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };
    }

    const text = textParts.join("\n").trim();

    if (toolReqs.length > 0 || (role === "assistant" && text)) {
      const blocks: ContentBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const req of toolReqs) {
        const { id, name, input } = extractToolRequest(req, blocks.length);
        const block: ToolUseBlock = { type: "tool_use", id, name, input };
        blocks.push(block);
        toolUseById.set(id, block);
        toolUseStartMs.set(id, date.getTime());
      }
      if (blocks.length === 0) continue;
      entries.push({
        type: "assistant",
        ...base,
        message: { role: "assistant", content: blocks },
      } satisfies AssistantEntry);
      continue;
    }

    if (role === "user" && text) {
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: text },
      } satisfies UserEntry);
      continue;
    }

    // Pure tool-result rows (no text, no requests) produced no new entry above.
    if (text) {
      entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
    }
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── DB loader ──

export interface GooseSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string; // synthetic — goose keeps sessions in a DB; we use goose-db://<id>
}

/**
 * Load one session by ID from `sessions.db`. Returns `null` when the DB is
 * unavailable or the session doesn't exist.
 */
export async function getGooseSessionLog(
  sessionId: string,
): Promise<GooseSessionLogData | null> {
  if (!sessionId || !GOOSE_SESSION_ID_RE.test(sessionId)) return null;
  const db = await openSqliteReadonly(gooseDbPath());
  if (!db) return null;
  try {
    const sessionRows = db.query<{ working_dir: string | null }>(
      "SELECT working_dir FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (sessionRows.length === 0) return null;
    const realCwd = sessionRows[0].working_dir;

    const msgRows = db.query<GooseMessageRow>(
      "SELECT role, content_json, created_timestamp FROM messages " +
        "WHERE session_id = ? ORDER BY id ASC",
      [sessionId],
    );
    const entries = gooseRowsToLogEntries(msgRows, "session");
    const cwd = realCwd && realCwd.length > 0 ? realCwd : undefined;
    return {
      entries,
      rawLines: msgRows as unknown as Record<string, unknown>[],
      cwd,
      filePath: `goose-db://${sessionId}`,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export const getCachedGooseSessionLog = runtimeCache(
  (sessionId: string) => getGooseSessionLog(sessionId),
  2,
  { maxSize: 50 },
);
