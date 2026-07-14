/**
 * Devin CLI (Cognition) session enumeration — AUDIT-ONLY.
 *
 * Reads the `sessions` table directly from `~/.local/share/devin/cli/sessions.db`
 * via the bundled sql.js reader. Unlike Hermes (cwd-less, grouped by channel),
 * each Devin session carries a real `working_directory`, so Devin sessions group
 * by project cwd like Claude/Factory — one `ProjectFolder` per encoded cwd, and
 * a cwd present in both Claude and Devin stores merges on the shared encoded
 * slug (see `mergeProjectFolders` in lib/projects.ts).
 */
import { openSqliteReadonly } from "./sqlite-reader";
import { devinDbPath, devinEpochToMs } from "./devin-sessions";
import { encodeFolderName } from "./paths";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface DevinSessionRef {
  sessionId: string;
  cwd?: string;
  title?: string;
  /** Encoded-cwd folder slug (matches Claude's `-home-user-project` scheme). */
  projectName: string;
  /** From `last_activity_at` (falls back to `created_at`) — epoch ms. */
  mtimeMs: number;
}

interface SessionRow {
  id: string;
  working_directory: string | null;
  title: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  hidden: number | null;
}

/**
 * List every Devin session. Returns `[]` when the DB is missing or unreadable
 * (fail-open — the audit just skips Devin). Hidden sessions are excluded.
 */
export async function getDevinSessions(): Promise<DevinSessionRef[]> {
  const db = await openSqliteReadonly(devinDbPath());
  if (!db) return [];
  try {
    const rows = db.query<SessionRow>(
      "SELECT id, working_directory, title, created_at, last_activity_at, hidden " +
        "FROM sessions ORDER BY last_activity_at DESC",
    );
    return rows
      .filter((r) => !r.hidden)
      .map((r) => {
        const cwd = r.working_directory ?? undefined;
        return {
          sessionId: r.id,
          cwd,
          title: r.title ?? undefined,
          projectName: cwd ? encodeFolderName(cwd) : "devin",
          mtimeMs: devinEpochToMs(r.last_activity_at ?? r.created_at),
        };
      });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export const getCachedDevinSessions = runtimeCache(getDevinSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/** One `ProjectFolder` per encoded-cwd discovered in the Devin DB. */
export async function getDevinProjects(): Promise<ProjectFolder[]> {
  const sessions = await getDevinSessions();
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
      cli: ["devin"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface DevinProjectByName {
  /** Canonical cwd recovered from the session's `working_directory`. */
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Resolve the Devin sessions for a project URL slug (the encoded-cwd folder
 * name). Because Devin's `working_directory` re-encodes to the same slug Claude
 * uses, the slug matches directly and the canonical cwd is the session's real
 * `working_directory` (no lossy folder-decode needed).
 */
export async function getDevinSessionsByEncodedName(
  name: string,
): Promise<DevinProjectByName> {
  const sessions = await getDevinSessions();
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
        path: `devin-db://${s.sessionId}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "devin" as const,
      };
    }),
  };
}

export const getCachedDevinProjects = runtimeCache(getDevinProjects, 2);
export const getCachedDevinSessionsByEncodedName = runtimeCache(
  (name: string) => getDevinSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
