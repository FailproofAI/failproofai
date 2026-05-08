/**
 * OpenCode (sst/opencode) session transcript loader.
 *
 * Sessions live in opencode's SQLite DB (`~/.local/share/opencode/opencode.db`),
 * not on disk as JSONL like the other CLIs. We read them by shelling out to
 * `opencode db --format json "<sql>"` — same surface as `lib/opencode-projects.ts`
 * and the same fail-open contract (binary missing → return null).
 *
 * Schema verified live on opencode v1.14.31:
 *   • `session(id, project_id, parent_id, slug, directory, title, time_*, …)`
 *   • `message(id, session_id, time_created, time_updated, data: JSON)`
 *   • `part(id, message_id, session_id, time_created, time_updated, data: JSON)`
 *
 * The `data` column on message/part is an opaque JSON blob; we parse it
 * defensively (degrade unknown types to system entries) so a future opencode
 * release that adds new shapes doesn't break the dashboard.
 *
 * Refs: https://opencode.ai/docs/   (CLI reference)
 */
import { execFileSync } from "node:child_process";
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

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  slug: string | null;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
}

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string; // JSON-encoded
}

interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string; // JSON-encoded
}

/** Run a parameter-free SELECT against opencode's DB. Returns `null` on any
 *  failure (binary missing, query error, malformed output). */
function runOpenCodeDb<T>(sql: string): T[] | null {
  try {
    const stdout = execFileSync("opencode", ["db", "--format", "json", sql], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as T[];
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Safely JSON.parse a string column from a DB row. */
function parseDataColumn(raw: string | undefined | null): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read content text safely — opencode parts may carry text under `text` or
 *  `content` (depending on part type). Anything non-string degrades to "". */
function readContentText(data: Record<string, unknown>): string {
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  return "";
}

/** Translate a (message, parts[]) tuple into a single LogEntry. */
function translateMessage(
  msgRow: OpenCodeMessageRow,
  partRows: OpenCodePartRow[],
  source: LogSource,
): LogEntry {
  const msgData = parseDataColumn(msgRow.data) ?? {};
  const role = typeof msgData.role === "string" ? msgData.role : "system";
  const date = new Date(msgRow.time_created);
  const timestamp = date.toISOString();
  const raw: Record<string, unknown> = { uuid: msgRow.id, parentUuid: null };
  const base = baseEntry(raw, timestamp, date, source);

  // Build content blocks from parts. opencode part types we recognize:
  //   • text  → text block
  //   • tool  → tool_use envelope (tool name + input args)
  //   • everything else → preserve as a text block with a debug tag
  const content: ContentBlock[] = [];
  let userText = "";
  for (const p of partRows) {
    const data = parseDataColumn(p.data);
    if (!data) continue;
    const type = typeof data.type === "string" ? data.type : "unknown";
    if (type === "text") {
      const text = readContentText(data);
      if (text) {
        content.push({ type: "text", text });
        userText += (userText ? "\n" : "") + text;
      }
      continue;
    }
    if (type === "tool") {
      // Real opencode (verified v1.14.41) wraps everything under `state`:
      //   { type:"tool", tool:"read", callID, state:{ status, input, output, time:{start,end}, error? } }
      // We keep top-level `input`/`args` as legacy fallbacks so any historical
      // session written by an older opencode still renders.
      const toolName = typeof data.tool === "string" ? data.tool : (typeof data.name === "string" ? data.name : "tool");
      const state = isPlainObject(data.state) ? data.state : null;
      const input =
        state && isPlainObject(state.input) ? state.input :
        isPlainObject(data.input) ? data.input :
        isPlainObject(data.args) ? data.args :
        {};
      const block: ToolUseBlock = {
        type: "tool_use",
        id: p.id,
        name: toolName,
        input: input as Record<string, unknown>,
      };
      const status = state && typeof state.status === "string" ? state.status : "";
      if (state && (status === "completed" || status === "error")) {
        const errorText = status === "error" && typeof state.error === "string" ? state.error : null;
        const rawOutput = errorText ?? state.output;
        const contentText = typeof rawOutput === "string"
          ? rawOutput
          : rawOutput != null ? JSON.stringify(rawOutput) : "";
        const time = isPlainObject(state.time) ? state.time : {};
        const startMs = typeof time.start === "number" ? time.start : p.time_created;
        const endMs = typeof time.end === "number" ? time.end : p.time_updated;
        const durationMs = Math.max(0, endMs - startMs);
        const date = new Date(endMs);
        block.result = {
          timestamp: date.toISOString(),
          timestampFormatted: formatTimestamp(date),
          content: contentText,
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
      }
      content.push(block);
      continue;
    }
    // Unknown part type — preserve as a text annotation rather than drop silently.
    content.push({ type: "text", text: `[opencode ${type}]` });
  }

  if (role === "user") {
    const entry: UserEntry = {
      ...base,
      type: "user",
      message: { role: "user", content: userText },
    };
    return entry;
  }
  if (role === "assistant") {
    const modelInfo = isPlainObject(msgData.model) ? msgData.model : null;
    const modelStr = modelInfo && typeof modelInfo.modelID === "string" ? modelInfo.modelID : undefined;
    const entry: AssistantEntry = {
      ...base,
      type: "assistant",
      message: { role: "assistant", content, model: modelStr },
    };
    return entry;
  }
  // Fallback — system / unknown roles surface as generic entries so nothing is lost.
  const entry: GenericEntry = {
    ...base,
    type: "system",
    raw: { id: msgRow.id, role, parts: content },
  };
  return entry;
}

export interface OpenCodeSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string; // synthetic — opencode doesn't have a file path; we use opencode://<id>
}

/**
 * Load a single session by ID. Returns null when the session doesn't exist
 * or the binary is unavailable.
 */
export async function getOpenCodeSessionLog(sessionId: string): Promise<OpenCodeSessionLogData | null> {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null; // SQL-injection guard
  const sessions = runOpenCodeDb<OpenCodeSessionRow>(
    `SELECT id, project_id, slug, directory, title, time_created, time_updated FROM session WHERE id = '${sessionId}'`,
  );
  if (!sessions || sessions.length === 0) return null;
  const session = sessions[0];

  const messages = runOpenCodeDb<OpenCodeMessageRow>(
    `SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created ASC`,
  );
  const parts = runOpenCodeDb<OpenCodePartRow>(
    `SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = '${sessionId}' ORDER BY time_created ASC`,
  );
  if (!messages) return { entries: [], rawLines: [], cwd: session.directory ?? undefined, filePath: `opencode://${sessionId}` };

  // Group parts by message_id for O(1) lookup.
  const partsByMessage = new Map<string, OpenCodePartRow[]>();
  for (const p of parts ?? []) {
    let bucket = partsByMessage.get(p.message_id);
    if (!bucket) {
      bucket = [];
      partsByMessage.set(p.message_id, bucket);
    }
    bucket.push(p);
  }

  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  for (const msg of messages) {
    const partRows = partsByMessage.get(msg.id) ?? [];
    entries.push(translateMessage(msg, partRows, "session"));
    const data = parseDataColumn(msg.data);
    rawLines.push({
      id: msg.id,
      session_id: msg.session_id,
      time_created: msg.time_created,
      data: data ?? msg.data,
    });
  }

  return {
    entries,
    rawLines,
    cwd: session.directory ?? undefined,
    filePath: `opencode://${sessionId}`,
  };
}

export const getCachedOpenCodeSessionLog = runtimeCache(
  (sessionId: string) => getOpenCodeSessionLog(sessionId),
  30,
  { maxSize: 50 },
);

// ── Export shape ──

/**
 * Snapshot of an OpenCode session as it lives in the SQLite store: one
 * `session` row, all of its `message` rows, all of its `part` rows. The JSON
 * `data` column on each message/part is parsed (when valid) so consumers
 * don't have to double-parse; malformed JSON survives as the raw string.
 *
 * Used by the dashboard's Download Logs feature so the export mirrors the
 * underlying schema rather than collapsing parts into a single per-message
 * record (which is what the viewer-facing `getOpenCodeSessionLog` does).
 */
export interface OpenCodeSessionExportData {
  session: OpenCodeSessionRow;
  messages: Array<Omit<OpenCodeMessageRow, "data"> & { data: Record<string, unknown> | string | null }>;
  parts: Array<Omit<OpenCodePartRow, "data"> & { data: Record<string, unknown> | string | null }>;
}

export async function getOpenCodeSessionExport(sessionId: string): Promise<OpenCodeSessionExportData | null> {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const sessions = runOpenCodeDb<OpenCodeSessionRow>(
    `SELECT id, project_id, slug, directory, title, time_created, time_updated FROM session WHERE id = '${sessionId}'`,
  );
  if (!sessions || sessions.length === 0) return null;
  // Don't coalesce a `null` return (query failure) into `[]` — that would
  // silently serve an "empty session" export. A genuinely empty session has
  // an `[]` from the DB; a query failure has `null`. Treat the latter as
  // not-found so the route returns 404 rather than a misleading 200.
  const messages = runOpenCodeDb<OpenCodeMessageRow>(
    `SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created ASC`,
  );
  const parts = runOpenCodeDb<OpenCodePartRow>(
    `SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = '${sessionId}' ORDER BY time_created ASC`,
  );
  if (messages === null || parts === null) return null;
  return {
    session: sessions[0],
    messages: messages.map((m) => ({ ...m, data: parseDataColumn(m.data) ?? m.data })),
    parts: parts.map((p) => ({ ...p, data: parseDataColumn(p.data) ?? p.data })),
  };
}
