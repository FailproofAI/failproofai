/**
 * Goose (codename goose, Block) session enumeration — AUDIT-ONLY.
 *
 * Reads the `sessions` table directly from
 * `~/.local/share/goose/sessions/sessions.db` via the bundled sql.js reader.
 * Like Devin (and unlike the cwd-less Hermes gateway), each Goose session
 * carries a real `working_dir`, so Goose sessions group by project cwd like
 * Claude/Factory/Devin — one `ProjectFolder` per encoded cwd, and a cwd present
 * in multiple stores merges on the shared encoded slug (see `mergeProjectFolders`
 * in lib/projects.ts).
 *
 * `session_type = 'hidden'` rows are `goose run --no-session` scratch runs and
 * are excluded (mirrors Devin's `hidden` filter).
 */
import { openSqliteReadonly } from "./sqlite-reader";
import { gooseDbPath, gooseTimestampToMs } from "./goose-sessions";
import { encodeFolderName } from "./paths";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface GooseSessionRef {
  sessionId: string;
  cwd?: string;
  title?: string;
  /** Encoded-cwd folder slug (matches Claude's `-home-user-project` scheme). */
  projectName: string;
  /** From `updated_at` (falls back to `created_at`) — epoch ms. */
  mtimeMs: number;
}

interface SessionRow {
  id: string;
  working_dir: string | null;
  description: string | null;
  name: string | null;
  session_type: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * List every Goose session. Returns `[]` when the DB is missing or unreadable
 * (fail-open — the audit just skips Goose). `hidden` (no-session) rows are
 * excluded.
 */
export async function getGooseSessions(): Promise<GooseSessionRef[]> {
  const db = await openSqliteReadonly(gooseDbPath());
  if (!db) return [];
  try {
    const rows = db.query<SessionRow>(
      "SELECT id, working_dir, description, name, session_type, created_at, updated_at " +
        "FROM sessions ORDER BY updated_at DESC",
    );
    return rows
      .filter((r) => r.session_type !== "hidden")
      .map((r) => {
        const cwd = r.working_dir ?? undefined;
        const title = (r.description && r.description.length > 0 ? r.description : r.name) ?? undefined;
        return {
          sessionId: r.id,
          cwd,
          title: title && title.length > 0 ? title : undefined,
          projectName: cwd ? encodeFolderName(cwd) : "goose",
          mtimeMs: gooseTimestampToMs(r.updated_at ?? r.created_at),
        };
      });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const getCachedGooseSessions = runtimeCache(getGooseSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/** One `ProjectFolder` per encoded-cwd discovered in the Goose DB. */
export async function getGooseProjects(): Promise<ProjectFolder[]> {
  const sessions = await getGooseSessions();
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
      cli: ["goose"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface GooseProjectByName {
  /** Canonical cwd recovered from the session's `working_dir`. */
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Resolve the Goose sessions for a project URL slug (the encoded-cwd folder
 * name). Goose's `working_dir` re-encodes to the same slug Claude uses, so the
 * slug matches directly and the canonical cwd is the session's real
 * `working_dir`.
 */
export async function getGooseSessionsByEncodedName(
  name: string,
): Promise<GooseProjectByName> {
  const sessions = await getGooseSessions();
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
        path: `goose-db://${s.sessionId}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "goose" as const,
      };
    }),
  };
}

export const getCachedGooseProjects = runtimeCache(getGooseProjects, 2);
export const getCachedGooseSessionsByEncodedName = runtimeCache(
  (name: string) => getGooseSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
