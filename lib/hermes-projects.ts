/**
 * Hermes (hermes-agent) session enumeration — AUDIT-ONLY.
 *
 * Reads the `sessions` table directly from `~/.hermes/state.db` via the bundled
 * sql.js reader. All gateway users' sessions live in the one DB → "audit
 * everyone from one place". Because we query the table (not a text `sessions
 * list`), we get `source`/`cwd`/`message_count` up front — enough to group by
 * channel and to build a real per-transcript cache key.
 */
import { openSqliteReadonly } from "./sqlite-reader";
import { hermesDbPath, epochToMs } from "./hermes-sessions";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface HermesSessionRef {
  sessionId: string;
  source?: string;
  cwd?: string;
  title?: string;
  /** Slack/Telegram user that drove the session. */
  userId?: string;
  /** Channel id + type (group/dm) the session ran in. */
  chatId?: string;
  chatType?: string;
  /** From `ended_at` (falls back to `started_at`) — epoch ms. */
  mtimeMs: number;
  /** `message_count` — a stable cache key for an ended session. Can lag (Hermes
   *  may write it lazily / only at session end), so don't use it alone to decide
   *  emptiness. */
  messageCount: number;
  /** True when the session has ≥1 real message row (`MAX(messages.timestamp)`
   *  non-null). Reliable "non-empty" signal even when `message_count` is a
   *  stale `0` for an in-progress session. */
  hasMessages: boolean;
}

interface SessionRow {
  id: string;
  source: string | null;
  cwd: string | null;
  title: string | null;
  user_id: string | null;
  chat_id: string | null;
  chat_type: string | null;
  started_at: number | null;
  ended_at: number | null;
  message_count: number | null;
  /** MAX(messages.timestamp) — the real last-activity time; advances on every
   *  new message even while the session is still open (ended_at is null). */
  last_activity: number | null;
}

/**
 * List every Hermes session (all users). Returns `[]` when the DB is missing or
 * unreadable (fail-open — the audit just skips Hermes).
 */
export async function getHermesSessions(): Promise<HermesSessionRef[]> {
  const db = await openSqliteReadonly(hermesDbPath());
  if (!db) return [];
  try {
    const rows = db.query<SessionRow>(
      "SELECT s.id, s.source, s.cwd, s.title, s.user_id, s.chat_id, s.chat_type, " +
        "s.started_at, s.ended_at, s.message_count, lm.last_activity " +
        "FROM sessions s " +
        "LEFT JOIN (SELECT session_id, MAX(timestamp) AS last_activity FROM messages GROUP BY session_id) lm " +
        "ON lm.session_id = s.id " +
        "ORDER BY lm.last_activity DESC",
    );
    return rows.map((r) => ({
      sessionId: r.id,
      source: r.source ?? undefined,
      cwd: r.cwd ?? undefined,
      title: r.title ?? undefined,
      userId: r.user_id ?? undefined,
      chatId: r.chat_id ?? undefined,
      chatType: r.chat_type ?? undefined,
      // Prefer the latest message time (advances live); fall back to ended/started.
      mtimeMs: epochToMs(r.last_activity ?? r.ended_at ?? r.started_at),
      messageCount: typeof r.message_count === "number" ? r.message_count : 0,
      hasMessages: r.last_activity != null,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const getCachedHermesSessions = runtimeCache(getHermesSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/**
 * Surface Hermes gateway sessions as synthetic "projects" grouped by `source`
 * (slack/telegram/cli/cron) — gateway sessions have no cwd to group by. One
 * ProjectFolder per source; its `name` is `hermes-<source>`, reversed in
 * `getHermesSessionsByEncodedName`.
 */
export async function getHermesProjects(): Promise<ProjectFolder[]> {
  const sessions = await getHermesSessions();
  const latestBySource = new Map<string, number>();
  for (const s of sessions) {
    if (s.messageCount <= 0 && !s.hasMessages) continue; // skip empty (message_count can lag; trust real messages)
    const src = s.source ?? "unknown";
    latestBySource.set(src, Math.max(latestBySource.get(src) ?? 0, s.mtimeMs));
  }
  const out: ProjectFolder[] = [];
  for (const [src, latest] of latestBySource) {
    const lastModified = new Date(latest);
    out.push({
      name: `hermes-${src}`,
      path: `hermes:${src}`,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["hermes"],
    });
  }
  out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return out;
}

export interface HermesProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Resolve the Hermes sessions for a synthetic project name (`hermes-<source>`),
 * for the project-detail page. Non-Hermes names resolve to empty.
 */
export async function getHermesSessionsByEncodedName(
  name: string,
): Promise<HermesProjectByName> {
  if (!name.startsWith("hermes-")) return { cwd: null, sessions: [] };
  const source = name.slice("hermes-".length);
  const sessions = await getHermesSessions();
  const matched = sessions.filter((s) => (s.messageCount > 0 || s.hasMessages) && (s.source ?? "unknown") === source);
  return {
    cwd: `hermes:${source}`,
    sessions: matched.map((s) => {
      const lastModified = new Date(s.mtimeMs);
      return {
        name: s.title ?? s.sessionId,
        path: `hermes://${s.sessionId}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "hermes" as const,
        userId: s.userId,
        channelId: s.chatId,
        channelType: s.chatType,
      };
    }),
  };
}

export const getCachedHermesProjects = runtimeCache(getHermesProjects, 2);
export const getCachedHermesSessionsByEncodedName = runtimeCache(
  (name: string) => getHermesSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
