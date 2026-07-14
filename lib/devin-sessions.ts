/**
 * Devin CLI (Cognition) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Devin stores every session in one SQLite DB at
 * `~/.local/share/devin/cli/sessions.db`. We read it DIRECTLY via the bundled
 * sql.js driver (lib/sqlite-reader.ts) — the same reusable path Hermes/OpenClaw
 * use. Unlike Hermes (which is cwd-less), each Devin `sessions` row carries a
 * real `working_directory`, so Devin sessions group by project cwd like Claude.
 *
 * Schema (verified live against devin v3000.1.27):
 *   sessions(id, working_directory, backend_type, model, agent_mode,
 *            created_at INT, last_activity_at INT, title, workspace_dirs, metadata)
 *   message_nodes(row_id, session_id, node_id, parent_node_id,
 *            chat_message TEXT=JSON, created_at INT, metadata)
 *
 * `chat_message` is OpenAI-style JSON: `{role, content, tool_calls?,
 * tool_call_id?, thinking?, metadata?}`. Assistant tool calls are flat
 * `tool_calls[].{id, name, arguments}` (arguments is already an object, NOT a
 * JSON string as in the OpenAI wire format), and results are separate
 * `role:"tool"` rows keyed by `tool_call_id`. `devinRowsToLogEntries` pairs them
 * (mirrors lib/hermes-sessions.ts) and is a PURE function of the parsed message
 * objects, so it is unit-testable without a DB.
 *
 * Home override: set `DEVIN_HOME` (used by tests / to point at a copied Devin
 * data dir) or `DEVIN_DB_PATH` (points directly at a sessions.db).
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

/** Devin session IDs are word-slug style (e.g. `estimated-seeker`). */
export const DEVIN_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Absolute path to Devin's data home (override with DEVIN_HOME). */
export function devinHome(): string {
  return process.env.DEVIN_HOME || join(homedir(), ".local", "share", "devin");
}

/** Absolute path to Devin's SQLite DB (override with DEVIN_DB_PATH). */
export function devinDbPath(): string {
  return process.env.DEVIN_DB_PATH || join(devinHome(), "cli", "sessions.db");
}

/** Coerce a Devin epoch value (seconds or ms) to epoch ms. Devin stores
 *  `created_at`/`last_activity_at` as INTEGER epoch seconds. */
export function devinEpochToMs(value: unknown): number {
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

/** Normalize Devin `tool_calls` into `{ id, name, input }[]`. Devin's shape is
 *  flat: `{ id, name, arguments }` where `arguments` is already an object. Also
 *  tolerates the OpenAI wire shape `{ id|call_id, function:{ name, arguments }}`
 *  (arguments as a JSON string) for forward-compat. */
function normalizeDevinToolCalls(raw: unknown): NormalizedToolCall[] {
  const arr = Array.isArray(raw) ? raw : safeJsonParse(raw);
  if (!Array.isArray(arr)) return [];
  const out: NormalizedToolCall[] = [];
  for (const tc of arr) {
    if (!isPlainObject(tc)) continue;
    const fn = isPlainObject(tc.function) ? tc.function : {};
    const name =
      typeof tc.name === "string"
        ? tc.name
        : typeof fn.name === "string"
          ? (fn.name as string)
          : "tool";
    const id =
      (typeof tc.id === "string" && tc.id) ||
      (typeof tc.call_id === "string" && tc.call_id) ||
      `${name}-${out.length}`;
    const rawArgs = tc.arguments ?? fn.arguments;
    const parsedArgs = isPlainObject(rawArgs) ? rawArgs : safeJsonParse(rawArgs);
    out.push({ id, name, input: isPlainObject(parsedArgs) ? parsedArgs : {} });
  }
  return out;
}

/** Epoch ms for a parsed chat_message: prefer its high-precision
 *  `metadata.created_at` ISO string, else the DB row's injected `_created_at`
 *  (epoch seconds), else the fallback. */
function messageDate(m: Record<string, unknown>, fallbackMs: number): Date {
  const meta = isPlainObject(m.metadata) ? m.metadata : undefined;
  if (meta && meta.created_at != null) return toDate(meta.created_at, fallbackMs);
  if (m._created_at != null) return toDate(m._created_at, fallbackMs);
  return new Date(fallbackMs);
}

// ── Pure parser: parsed chat_message objects → LogEntry[] ──

/**
 * Convert parsed `chat_message` objects (in node order) into `LogEntry[]`.
 * Pairs each assistant `tool_calls` entry with its later `role:"tool"` result
 * by `tool_call_id`. Roles other than user/assistant/tool (e.g. `system`)
 * become generic system entries so nothing is dropped. Pure — unit-testable
 * with plain message objects. Each object may carry an injected `_created_at`
 * (the DB row's epoch-seconds timestamp) used when `metadata.created_at` is
 * absent.
 */
export function devinRowsToLogEntries(
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
    const date = messageDate(m, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: m.message_id != null ? String(m.message_id) : `devin-${i}`,
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
      for (const tc of normalizeDevinToolCalls(m.tool_calls)) {
        const block: ToolUseBlock = { type: "tool_use", id: tc.id, name: tc.name, input: tc.input };
        blocks.push(block);
        toolUseById.set(tc.id, block);
        toolUseStartMs.set(tc.id, date.getTime());
      }
      if (blocks.length === 0) continue; // empty assistant turn
      entries.push({
        type: "assistant",
        ...base,
        message: {
          role: "assistant",
          content: blocks,
          model: typeof m.model === "string" ? m.model : undefined,
        },
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

export interface DevinSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string; // synthetic — devin keeps sessions in a DB; we use devin-db://<id>
}

interface DevinMessageNodeRow {
  node_id: number | null;
  parent_node_id: number | null;
  chat_message: string | null;
  created_at: number | null;
}

/**
 * Devin stores a session's messages as a FOREST, not a flat list: each turn is a
 * node (`node_id`) linked to its `parent_node_id`, and Devin replays earlier
 * context under fresh roots on later turns — so the table holds many branches
 * that repeat the same messages (verified live: 29 nodes / 11 distinct messages
 * for a 10-message conversation). Reading every node duplicates each message
 * 2-4×. The real conversation is the single path from the NEWEST leaf back to its
 * root. Because Devin appends nodes in order (a child's `node_id` always exceeds
 * its parent's), the newest leaf is simply the max `node_id`; walk its
 * `parent_node_id` chain to the root and reverse to get root→leaf order.
 */
export function devinActiveConversationPath(rows: DevinMessageNodeRow[]): DevinMessageNodeRow[] {
  if (rows.length === 0) return rows;
  const byId = new Map<number, DevinMessageNodeRow>();
  for (const r of rows) if (typeof r.node_id === "number") byId.set(r.node_id, r);
  // Newest leaf = highest node_id (a leaf, since children always have a higher id).
  let cur: DevinMessageNodeRow | undefined = rows.reduce((a, b) =>
    (a.node_id ?? -1) > (b.node_id ?? -1) ? a : b,
  );
  const path: DevinMessageNodeRow[] = [];
  const seen = new Set<number>();
  while (cur && typeof cur.node_id === "number" && !seen.has(cur.node_id)) {
    seen.add(cur.node_id);
    path.push(cur);
    cur = cur.parent_node_id != null ? byId.get(cur.parent_node_id) : undefined;
  }
  return path.reverse(); // root → leaf = conversation order
}

/** Parse a session's `message_nodes` rows into the message objects the pure
 *  parser consumes, injecting each row's `created_at` as `_created_at`. */
function parseNodeRows(rows: DevinMessageNodeRow[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const parsed = safeJsonParse(r.chat_message);
    if (!isPlainObject(parsed)) continue;
    if (r.created_at != null && parsed._created_at == null) parsed._created_at = r.created_at;
    out.push(parsed);
  }
  return out;
}

/**
 * Load one session by ID from `sessions.db`. Returns `null` when the DB is
 * unavailable or the session doesn't exist.
 */
export async function getDevinSessionLog(
  sessionId: string,
): Promise<DevinSessionLogData | null> {
  if (!sessionId || !DEVIN_SESSION_ID_RE.test(sessionId)) return null;
  const db = await openSqliteReadonly(devinDbPath());
  if (!db) return null;
  try {
    const sessionRows = db.query<{ working_directory: string | null }>(
      "SELECT working_directory FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (sessionRows.length === 0) return null;
    const realCwd = sessionRows[0].working_directory;

    const nodeRows = db.query<DevinMessageNodeRow>(
      "SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes " +
        "WHERE session_id = ? ORDER BY node_id ASC",
      [sessionId],
    );
    // Reconstruct the active conversation path (drop replayed branch duplicates).
    const rawLines = parseNodeRows(devinActiveConversationPath(nodeRows));
    const entries = devinRowsToLogEntries(rawLines, "session");
    const cwd = realCwd && realCwd.length > 0 ? realCwd : undefined;
    return {
      entries,
      rawLines,
      cwd,
      filePath: `devin-db://${sessionId}`,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export const getCachedDevinSessionLog = runtimeCache(
  (sessionId: string) => getDevinSessionLog(sessionId),
  2,
  { maxSize: 50 },
);
