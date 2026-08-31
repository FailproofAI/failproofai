/**
 * Ori (OpenRouter's ori) session enumeration — AUDIT-ONLY.
 *
 * Reads `ori_agent_loop_sessions` from ori's global state DB (see
 * lib/ori-sessions.ts for why that is the only real transcript store). Each row
 * carries a real `cwd`, so ori sessions group by project like Claude / Factory /
 * Devin / Goose rather than landing in one cwd-less bucket the way the Hermes
 * gateway does.
 *
 * `archived = 1` rows are excluded: ori's own `history` command hides them
 * behind `--archived`, so surfacing them by default would show a user sessions
 * their agent CLI considers put away. `parent_session_id` marks a forked child
 * session; it is kept (not filtered) so subagent work still appears.
 */
import { openSqliteReadonly } from "./sqlite-reader";
import { oriDbPath, oriTimestampToMs } from "./ori-sessions";
import { encodeFolderName } from "./paths";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface OriSessionRef {
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  /** Encoded-cwd folder slug (matches Claude's `-home-user-project` scheme). */
  projectName: string;
  /** From `updated_at` — epoch ms. */
  mtimeMs: number;
}

interface OriSessionRow {
  session_id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  first_prompt: string | null;
  archived: number | null;
  updated_at: string | null;
}

/**
 * List every ori session. Returns `[]` when the DB is missing or unreadable
 * (fail-open — the audit just skips ori).
 */
export async function getOriSessions(): Promise<OriSessionRef[]> {
  const db = await openSqliteReadonly(oriDbPath());
  if (!db) return [];
  try {
    const rows = db.query<OriSessionRow>(
      "SELECT session_id, title, cwd, model, first_prompt, archived, updated_at " +
        "FROM ori_agent_loop_sessions ORDER BY updated_at DESC",
    );
    return rows
      .filter((r) => r.archived !== 1)
      .map((r) => {
        const cwd = r.cwd ?? undefined;
        const title = (r.title && r.title.length > 0 ? r.title : r.first_prompt) ?? undefined;
        return {
          sessionId: r.session_id,
          cwd,
          title: title && title.length > 0 ? title : undefined,
          model: r.model ?? undefined,
          projectName: cwd ? encodeFolderName(cwd) : "ori",
          mtimeMs: oriTimestampToMs(r.updated_at),
        };
      });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const getCachedOriSessions = runtimeCache(getOriSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/** One `ProjectFolder` per encoded-cwd discovered in the ori DB. */
export async function getOriProjects(): Promise<ProjectFolder[]> {
  const sessions = await getOriSessions();
  const byName = new Map<string, { latest: number; cwd: string; name: string }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const existing = byName.get(s.projectName);
    if (!existing || s.mtimeMs > existing.latest) {
      byName.set(s.projectName, { latest: s.mtimeMs, cwd: s.cwd, name: s.projectName });
    }
  }
  const folders: ProjectFolder[] = [];
  for (const { name, cwd, latest } of byName.values()) {
    const lastModified = new Date(latest);
    folders.push({
      name,
      path: cwd,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["ori"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface OriProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/** Resolve the ori sessions for a project URL slug (the encoded-cwd folder). */
export async function getOriSessionsByEncodedName(name: string): Promise<OriProjectByName> {
  const sessions = await getOriSessions();
  const matched = sessions.filter((s) => s.cwd && s.projectName === name);
  if (matched.length === 0) return { cwd: null, sessions: [] };

  const sorted = [...matched].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cwd = sorted[0].cwd ?? null;
  return {
    cwd,
    sessions: sorted.map((s) => {
      const lastModified = new Date(s.mtimeMs);
      return {
        name: s.title ?? s.sessionId,
        path: `ori-db://${s.sessionId}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "ori" as const,
      };
    }),
  };
}

export const getCachedOriProjects = runtimeCache(getOriProjects, 2);
export const getCachedOriSessionsByEncodedName = runtimeCache(
  (name: string) => getOriSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
