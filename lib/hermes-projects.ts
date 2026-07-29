/**
 * Hermes (hermes-agent) session enumeration — AUDIT-ONLY.
 *
 * Reads the `sessions` table directly from every profile's `state.db` via the
 * bundled sql.js reader. All of a profile's gateway users live in its one DB →
 * "audit everyone from one place". Because we query the table (not a text
 * `sessions list`), we get `source`/`cwd`/`message_count` up front — enough to
 * group and to build a real per-transcript cache key.
 *
 * Sessions are grouped by (profile, source): a profile is a whole separate
 * Hermes home (see lib/hermes-profiles.ts), so it is the outer scope, and
 * `source` (slack/telegram/cli/cron) splits the channels within it.
 */
import { openSqliteReadonly } from "./sqlite-reader";
import { hermesDbPaths, epochToMs } from "./hermes-sessions";
import {
  HERMES_DEFAULT_PROFILE,
  hermesProjectName,
  hermesProjectPath,
  hermesProjectNameCandidates,
} from "./hermes-profiles";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface HermesSessionRef {
  sessionId: string;
  /** Which profile's state.db this row came from (`"default"` for `~/.hermes`). */
  profile: string;
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
 * List every Hermes session — every user, of every profile. A missing or
 * unreadable profile DB is skipped rather than failing the batch (fail-open:
 * the audit degrades to the profiles it can read instead of dropping Hermes).
 */
export async function getHermesSessions(): Promise<HermesSessionRef[]> {
  const out: HermesSessionRef[] = [];
  for (const { profile, dbPath } of hermesDbPaths()) {
    out.push(...(await readSessionsFromDb(dbPath, profile)));
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function readSessionsFromDb(
  dbPath: string,
  profile: string,
): Promise<HermesSessionRef[]> {
  const db = await openSqliteReadonly(dbPath);
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
      profile,
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
 * Surface Hermes gateway sessions as synthetic "projects" grouped by
 * (profile, source) — gateway sessions have no cwd to group by. One
 * ProjectFolder per pair, named by `hermesProjectName`.
 */
export async function getHermesProjects(): Promise<ProjectFolder[]> {
  const sessions = await getHermesSessions();
  // key → { profile, source, latest }; keeps profile/source intact for naming
  // (the key itself is not parseable back when a profile name contains "-").
  const groups = new Map<
    string,
    { profile: string; source: string; latest: number; count: number }
  >();
  for (const s of sessions) {
    if (s.messageCount <= 0 && !s.hasMessages) continue; // skip empty (message_count can lag; trust real messages)
    const profile = s.profile || HERMES_DEFAULT_PROFILE;
    const source = s.source ?? "unknown";
    const key = JSON.stringify([profile, source]);
    const prev = groups.get(key);
    if (prev) {
      prev.latest = Math.max(prev.latest, s.mtimeMs);
      // Sessions, not messages — `messageCount` counts messages within one
      // session and is documented as possibly lagging.
      prev.count += 1;
    } else {
      groups.set(key, { profile, source, latest: s.mtimeMs, count: 1 });
    }
  }
  const out: ProjectFolder[] = [];
  for (const { profile, source, latest, count } of groups.values()) {
    const lastModified = new Date(latest);
    out.push({
      name: hermesProjectName(profile, source),
      path: hermesProjectPath(profile, source),
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["hermes"],
      sessionCount: count,
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
 * Resolve the Hermes sessions for a synthetic project name
 * (`hermes-<profile>-<source>`), for the project-detail page. Non-Hermes names
 * resolve to empty.
 */
export async function getHermesSessionsByEncodedName(
  name: string,
): Promise<HermesProjectByName> {
  const candidates = hermesProjectNameCandidates(name);
  if (candidates.length === 0) return { cwd: null, sessions: [] };

  const sessions = await getHermesSessions();
  const matching = (split: { profile: string; source: string }) =>
    sessions.filter(
      (s) =>
        (s.messageCount > 0 || s.hasMessages) &&
        (s.profile || HERMES_DEFAULT_PROFILE) === split.profile &&
        (s.source ?? "unknown") === split.source,
    );

  // First split that actually owns sessions — longest-match alone picks the
  // wrong profile when one name is a hyphen-prefix of another. Falling back to
  // the best guess keeps the page labelled sensibly when nothing matches.
  let chosen = candidates[0];
  let matched = matching(chosen);
  if (matched.length === 0) {
    for (const candidate of candidates.slice(1)) {
      const hits = matching(candidate);
      if (hits.length > 0) {
        chosen = candidate;
        matched = hits;
        break;
      }
    }
  }
  const { profile, source } = chosen;
  return {
    cwd: hermesProjectPath(profile, source),
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
