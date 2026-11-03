/**
 * Read OpenClaw 2026.9.2+ transcripts from the per-agent SQLite databases at
 * `agents/<agentId>/agent/openclaw-agent.sqlite`.
 *
 * `event_json` is the exact logical JSONL record, so the dashboard can feed it
 * through the same parser and download format used by archived JSONL files.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openSqliteReadonly, type SqliteReader } from "./sqlite-reader";

const DB_NAME = "openclaw-agent.sqlite";

export interface OpenClawSqliteSession {
  sessionId: string;
  agentId: string;
  dbPath: string;
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
  channel: string;
  label?: string;
  chatId?: string;
  chatType?: string;
}

export interface OpenClawSqliteTranscript {
  agentId: string;
  dbPath: string;
  filePath: string;
  rawLines: Record<string, unknown>[];
  eventJsonLines: string[];
}

interface WindowRow {
  session_id: string;
  session_key: string;
  updated_at: number;
  transcript_updated_at: number | null;
  ended_at: number | null;
  channel: string | null;
  chat_type: string | null;
  display_name: string | null;
  event_updated_at: number;
  size_bytes: number;
}

interface NodeRow {
  current_session_id: string;
  entry_json: string;
  label: string | null;
  display_name: string | null;
}

interface ConversationRow {
  session_id: string;
  channel: string;
  kind: string;
  peer_id: string;
  delivery_target: string;
  label: string | null;
}

interface EventRow {
  event_json: string;
}

interface SessionMeta {
  channel?: string;
  label?: string;
  chatId?: string;
  chatType?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function syntheticPath(agentId: string, sessionId: string): string {
  return `openclaw-sqlite://${encodeURIComponent(agentId)}/${sessionId}`;
}

/** Existing per-agent SQLite databases, derived from the configured agents. */
export function listOpenClawDatabases(
  home: string,
  agentIds: string[],
): Array<{ agentId: string; dbPath: string }> {
  const out: Array<{ agentId: string; dbPath: string }> = [];
  for (const agentId of agentIds) {
    const dbPath = join(home, "agents", agentId, "agent", DB_NAME);
    if (existsSync(dbPath)) out.push({ agentId, dbPath });
  }
  return out;
}

function readNodeMetadata(db: SqliteReader): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  let rows: NodeRow[];
  try {
    rows = db.query<NodeRow>(
      `SELECT current_session_id, entry_json, label, display_name
         FROM session_nodes`,
    );
  } catch {
    return out;
  }
  for (const row of rows) {
    const entry = parseObject(row.entry_json) ?? {};
    const origin =
      entry.origin &&
      typeof entry.origin === "object" &&
      !Array.isArray(entry.origin)
        ? (entry.origin as Record<string, unknown>)
        : {};
    out.set(row.current_session_id, {
      channel:
        str(entry.lastChannel) ?? str(origin.provider) ?? str(origin.surface),
      label:
        str(row.label) ??
        str(row.display_name) ??
        str(entry.displayName) ??
        str(origin.label),
      chatId: str(entry.lastTo) ?? str(origin.from),
      chatType: str(entry.chatType) ?? str(origin.chatType),
    });
  }
  return out;
}

function readConversationMetadata(db: SqliteReader): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  let rows: ConversationRow[];
  try {
    rows = db.query<ConversationRow>(
      `SELECT sc.session_id, c.channel, c.kind, c.peer_id,
              c.delivery_target, c.label
         FROM session_conversations sc
         JOIN conversations c ON c.conversation_id = sc.conversation_id
        ORDER BY CASE sc.role WHEN 'primary' THEN 0 ELSE 1 END, sc.last_seen_at DESC`,
    );
  } catch {
    return out;
  }
  for (const row of rows) {
    if (out.has(row.session_id)) continue;
    out.set(row.session_id, {
      channel: str(row.channel),
      label: str(row.label),
      chatId: str(row.delivery_target) ?? str(row.peer_id),
      chatType: str(row.kind),
    });
  }
  return out;
}

/** List every transcript-bearing session in all per-agent databases. */
export async function listOpenClawSqliteSessions(
  home: string,
  agentIds: string[],
): Promise<OpenClawSqliteSession[]> {
  const sessions: OpenClawSqliteSession[] = [];
  for (const { agentId, dbPath } of listOpenClawDatabases(home, agentIds)) {
    const db = await openSqliteReadonly(dbPath);
    if (!db) continue;
    try {
      let rows: WindowRow[];
      try {
        rows = db.query<WindowRow>(
          `SELECT w.session_id, w.session_key, w.updated_at,
                  w.transcript_updated_at, w.ended_at, w.channel,
                  w.chat_type, w.display_name,
                  COALESCE((SELECT MAX(e.created_at)
                              FROM transcript_events e
                             WHERE e.session_id = w.session_id), 0) AS event_updated_at,
                  COALESCE((SELECT SUM(length(e.event_json) + 1)
                              FROM transcript_events e
                             WHERE e.session_id = w.session_id), 0) AS size_bytes
             FROM session_windows w
            WHERE EXISTS (SELECT 1 FROM transcript_events e
                           WHERE e.session_id = w.session_id)`,
        );
      } catch {
        continue;
      }

      const nodes = readNodeMetadata(db);
      const conversations = readConversationMetadata(db);
      for (const row of rows) {
        const node = nodes.get(row.session_id);
        const conversation = conversations.get(row.session_id);
        sessions.push({
          sessionId: row.session_id,
          agentId,
          dbPath,
          transcriptPath: syntheticPath(agentId, row.session_id),
          mtimeMs: Math.max(
            Number(row.updated_at) || 0,
            Number(row.transcript_updated_at) || 0,
            Number(row.ended_at) || 0,
            Number(row.event_updated_at) || 0,
          ),
          sizeBytes: Number(row.size_bytes) || 0,
          channel:
            str(row.channel) ??
            conversation?.channel ??
            node?.channel ??
            "local",
          label: str(row.display_name) ?? conversation?.label ?? node?.label,
          chatId: conversation?.chatId ?? node?.chatId,
          chatType:
            str(row.chat_type) ?? conversation?.chatType ?? node?.chatType,
        });
      }
    } finally {
      db.close();
    }
  }
  return sessions;
}

/** Read one SQLite transcript by UUID. The first matching agent wins. */
export async function readOpenClawSqliteTranscript(
  home: string,
  agentIds: string[],
  sessionId: string,
): Promise<OpenClawSqliteTranscript | null> {
  for (const { agentId, dbPath } of listOpenClawDatabases(home, agentIds)) {
    const db = await openSqliteReadonly(dbPath);
    if (!db) continue;
    try {
      let rows: EventRow[];
      try {
        rows = db.query<EventRow>(
          `SELECT event_json
             FROM transcript_events
            WHERE session_id = ?
            ORDER BY seq ASC`,
          [sessionId],
        );
      } catch {
        continue;
      }
      if (rows.length === 0) continue;
      const eventJsonLines = rows.map((row) => row.event_json);
      const rawLines = eventJsonLines
        .map(parseObject)
        .filter((line): line is Record<string, unknown> => line !== undefined);
      return {
        agentId,
        dbPath,
        filePath: syntheticPath(agentId, sessionId),
        rawLines,
        eventJsonLines,
      };
    } finally {
      db.close();
    }
  }
  return null;
}
