/**
 * Ori (OpenRouter's ori) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Where ori keeps a transcript is not obvious, and three
 * plausible places are dead ends worth naming so nobody re-derives them:
 *
 *   • `<cwd>/.ori/logs/sessions/<uuid>/metadata.json` holds ONLY a summary —
 *     harness, `runIds[{cwd, model, prompt, runId}]`, token `usage`, turn
 *     counts, timestamps. Verified on a successful tool-using session: no
 *     messages, no tool calls.
 *   • `<cwd>/.ori/logs/code-<ISO>.jsonl` is runtime LIFECYCLE logging —
 *     formatted log lines, zero tool records (grepped a full session: 0 hits).
 *   • The rich `AgentRuntimeEvent` stream exists only transiently on
 *     `ori code --output jsonl` stdout; nothing persists it.
 *
 * The real transcript is SQLite, in ori's GLOBAL workspace at
 * `~/.ori/global/.ori/state.sqlite` (bare `ori` boots the global workspace, not
 * the project's, so one DB holds every project's sessions):
 *
 *   ori_agent_loop_sessions(session_id TEXT PK, title, cwd, model, turns,
 *                           cost_usd REAL, cost_known INT, archived INT,
 *                           first_prompt, parent_session_id, updated_at TEXT ISO)
 *   ori_agent_loop_history(session_id TEXT PK, prompt TEXT = the whole
 *                          serialized conversation as JSON, revision, updated_at)
 *
 * `ori_agent_loop_history.prompt` is misnamed — it is not the prompt, it is the
 * full conversation: `{"content":[{role, content}, …]}` with Claude-style typed
 * blocks on the assistant side (`{type:"reasoning"|"text"}`,
 * `{type:"tool-call", id, name, params}`) and results in `role:"tool"` messages
 * (`{type:"tool-result", id, name, isFailure, result:[{type:"input_text",text}]}`).
 * `oriMessagesToLogEntries` pairs each tool-call with its tool-result by id and
 * is a PURE function of the parsed JSON, so it is unit-testable without a DB.
 *
 * LIMITATION, and it is inherent rather than a shortcut: ori stores NO
 * per-message timestamp. Every entry in a session therefore carries the
 * session's own `updated_at`, so relative ordering within a session is the
 * array order and per-message timing is not recoverable.
 *
 * Home override: `ORI_HOME` (the dir containing `global/`), or `ORI_DB_PATH` to
 * point straight at a state.sqlite.
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
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

/** Absolute path to ori's home (override with ORI_HOME). */
export function oriHome(): string {
  return process.env.ORI_HOME || join(homedir(), ".ori");
}

/** Absolute path to ori's state DB (override with ORI_DB_PATH). */
export function oriDbPath(): string {
  return process.env.ORI_DB_PATH || join(oriHome(), "global", ".ori", "state.sqlite");
}

/** ori writes ISO-8601 strings; return epoch ms, 0 when absent or unparseable. */
export function oriTimestampToMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

interface OriBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  params?: Record<string, unknown>;
  isFailure?: boolean;
  result?: Array<{ type?: string; text?: string }>;
}

interface OriMessage {
  role?: string;
  content?: string | OriBlock[];
}

/** Flatten a tool-result's `result` array into display text. */
function toolResultText(block: OriBlock): string {
  if (!Array.isArray(block.result)) return "";
  return block.result
    .map((r) => (typeof r.text === "string" ? r.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * Parse ori's serialized conversation into the shared LogEntry[] shape.
 *
 * PURE — takes already-parsed JSON so tests need no SQLite. `system` messages
 * are dropped: ori's is a static multi-kilobyte agent prompt, identical in
 * every session, and carrying it would swamp the audit with boilerplate.
 */
export function oriMessagesToLogEntries(
  messages: OriMessage[],
  sessionId: string,
  timestampMs: number,
  source: LogSource = "session",
): LogEntry[] {
  const date = new Date(timestampMs);
  const timestamp = date.toISOString();
  const entries: LogEntry[] = [];
  // tool-call id → the block awaiting its result, so a later `role:"tool"`
  // message can attach onto the assistant turn that made the call.
  const pending = new Map<string, ToolUseBlock>();

  messages.forEach((msg, i) => {
    const role = msg.role;
    if (role === "system") return;

    const raw = { uuid: `${sessionId}:${i}`, parentUuid: null } as Record<string, unknown>;
    const base = baseEntry(raw, timestamp, date, source);

    if (role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? []).map((b) => b.text ?? "").join("");
      entries.push({ ...base, type: "user", message: { role: "user", content: text } } as UserEntry);
      return;
    }

    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === "reasoning" && typeof b.text === "string") {
          blocks.push({ type: "thinking", thinking: b.text });
        } else if (b.type === "text" && typeof b.text === "string") {
          blocks.push({ type: "text", text: b.text });
        } else if (b.type === "tool-call" && typeof b.id === "string") {
          const block: ToolUseBlock = {
            type: "tool_use",
            id: b.id,
            name: b.name ?? "",
            input: b.params ?? {},
          };
          pending.set(b.id, block);
          blocks.push(block);
        }
      }
      if (blocks.length > 0) {
        entries.push({ ...base, type: "assistant", message: { role: "assistant", content: blocks } } as AssistantEntry);
      }
      return;
    }

    if (role === "tool") {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type !== "tool-result" || typeof b.id !== "string") continue;
        const target = pending.get(b.id);
        if (!target) continue;
        // No per-message timestamp exists, so duration is unknowable — 0 rather
        // than a fabricated span.
        target.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: toolResultText(b),
          durationMs: 0,
          durationFormatted: formatDuration(0),
        };
        pending.delete(b.id);
      }
      return;
    }
  });

  return entries;
}

export interface OriSessionLog {
  entries: LogEntry[];
  cwd?: string;
}

/** Load and parse one ori session. Returns null when absent or unreadable. */
export async function getOriSessionLog(sessionId: string): Promise<OriSessionLog | null> {
  const db = await openSqliteReadonly(oriDbPath());
  if (!db) return null;
  try {
    const rows = db.query<{ prompt: string | null; updated_at: string | null; cwd: string | null }>(
      "SELECT h.prompt AS prompt, h.updated_at AS updated_at, s.cwd AS cwd " +
        "FROM ori_agent_loop_history h " +
        "LEFT JOIN ori_agent_loop_sessions s ON s.session_id = h.session_id " +
        "WHERE h.session_id = ?",
      [sessionId],
    );
    const row = rows[0];
    if (!row || !row.prompt) return null;
    let parsed: { content?: OriMessage[] };
    try {
      parsed = JSON.parse(row.prompt) as { content?: OriMessage[] };
    } catch {
      return null;
    }
    return {
      entries: oriMessagesToLogEntries(
        parsed.content ?? [],
        sessionId,
        oriTimestampToMs(row.updated_at),
      ),
      cwd: row.cwd ?? undefined,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export const getCachedOriSessionLog = runtimeCache(getOriSessionLog, 2);
