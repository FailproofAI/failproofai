/**
 * OpenCode (sst/opencode) project discovery.
 *
 * Unlike the other agent CLIs that store sessions as filesystem JSONL trees,
 * OpenCode stores everything in a single SQLite database (managed by
 * Drizzle ORM) at `~/.local/share/opencode/opencode.db`, read directly
 * through `lib/opencode-db.ts`.
 *
 * This used to shell out to `opencode db --format json "<sql>"`, to avoid
 * coupling to opencode's internal schema. That reasoning did not survive
 * contact with the SQL: the queries name opencode's own tables and columns
 * either way, so the coupling was identical and the subprocess bought only
 * its own cost — see `lib/opencode-db.ts` for what that cost turned out to
 * be.
 *
 * Verified live against opencode v1.14.31:
 *   • `session` columns: id, project_id, parent_id, slug, directory, title,
 *     time_created, time_updated, …
 *   • `project` columns: id, worktree, vcs, name, time_created, time_updated, …
 *   • Session ID format: `ses_*`. Project ID is a content-addressable hash
 *     of the worktree path.
 *
 * If the `opencode` binary is absent on PATH, every operation degrades to
 * an empty result — same fail-open contract as the other per-CLI providers.
 *
 * Refs: https://opencode.ai/docs/   (CLI reference)
 *       https://opencode.ai/docs/plugins/  (plugin model context)
 */
import { queryOpenCodeDb, withOpenCodeDb } from "./opencode-db";
import { encodeFolderName } from "./paths";
import type { ProjectFolder, SessionFile } from "./projects";
import { runtimeCache } from "./runtime-cache";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Approximate cap on rows pulled per query — enough for hundreds of projects. */
const SESSION_LIMIT = 1000;

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  slug: string | null;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
}

interface OpenCodeProjectRow {
  id: string;
  worktree: string | null;
  vcs: string | null;
  name: string | null;
  time_created: number;
  time_updated: number;
}

/**
 * Session rows the dashboard needs, newest first.
 *
 * One caller needs sessions alone; the other two need sessions and projects
 * together and take `readBothRows`, which serves both from a single open
 * rather than two.
 */
async function readSessionRows(): Promise<OpenCodeSessionRow[] | null> {
  return queryOpenCodeDb<OpenCodeSessionRow>(
    "SELECT id, project_id, slug, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?",
    [SESSION_LIMIT],
  );
}

/** Both tables from one open, for the callers that use them together. */
async function readBothRows(): Promise<{
  sessions: OpenCodeSessionRow[] | null;
  projects: OpenCodeProjectRow[] | null;
}> {
  const rows = await withOpenCodeDb((db) => ({
    sessions: db.query<OpenCodeSessionRow>(
      "SELECT id, project_id, slug, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?",
      [SESSION_LIMIT],
    ),
    projects: db.query<OpenCodeProjectRow>(
      "SELECT id, worktree, vcs, name, time_created, time_updated FROM project",
    ),
  }));
  return { sessions: rows?.sessions ?? null, projects: rows?.projects ?? null };
}

/**
 * Group sessions by `project_id` and produce one ProjectFolder per project.
 * The folder name is `encodeFolderName(worktree)` (matches every other CLI's
 * URL-slug encoding so the dashboard's `/project/[name]` route resolves), or
 * the project_id when no worktree is recorded. `lastModified` is the max
 * session `time_updated` for that project (or the project's own time_updated
 * if no sessions exist yet).
 */
export async function getOpenCodeProjects(): Promise<ProjectFolder[]> {
  const { sessions, projects } = await readBothRows();
  if (sessions === null && projects === null) {
    // Binary missing or query failed — silent degrade (no log spam).
    return [];
  }

  const projectMap = new Map<string, OpenCodeProjectRow>();
  for (const p of projects ?? []) projectMap.set(p.id, p);

  // Group sessions by project_id; track the latest update time per group.
  const groups = new Map<string, { rows: OpenCodeSessionRow[]; latest: number }>();
  for (const s of sessions ?? []) {
    if (!s.project_id) continue;
    let g = groups.get(s.project_id);
    if (!g) {
      g = { rows: [], latest: 0 };
      groups.set(s.project_id, g);
    }
    g.rows.push(s);
    if (s.time_updated > g.latest) g.latest = s.time_updated;
  }

  // Emit one ProjectFolder per project that has at least one session OR a
  // project row (covers projects opencode knows about but hasn't run yet).
  // `name` is the dashboard's URL slug — must be `encodeFolderName(cwd)` to
  // match every other CLI (and the resolver in `getOpenCodeSessionsByEncodedName`).
  const seen = new Set<string>();
  const out: ProjectFolder[] = [];
  for (const [projectId, group] of groups) {
    seen.add(projectId);
    const proj = projectMap.get(projectId);
    const worktree = proj?.worktree ?? group.rows[0]?.directory ?? null;
    const name = worktree ? encodeFolderName(worktree) : projectId;
    const path = worktree ?? "";
    const lastModified = new Date(Math.max(group.latest, proj?.time_updated ?? 0));
    out.push({
      name,
      path,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["opencode"],
    });
  }
  for (const p of projects ?? []) {
    if (seen.has(p.id)) continue;
    const worktree = p.worktree ?? "";
    const name = worktree ? encodeFolderName(worktree) : p.id;
    const lastModified = new Date(p.time_updated);
    out.push({
      name,
      path: worktree,
      isDirectory: true,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      cli: ["opencode"],
    });
  }

  out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return out;
}

/** Sessions under a given absolute cwd. Used by the project detail page. */
export async function getOpenCodeSessionsForCwd(cwd: string): Promise<SessionFile[]> {
  const sessions = await readSessionRows();
  if (!sessions) return [];
  const matches = sessions.filter((s) => s.directory === cwd);
  return matches.map((s) => {
    const lastModified = new Date(s.time_updated);
    return {
      name: s.title ?? s.slug ?? s.id,
      path: `opencode://${s.id}`, // synthetic — opencode keeps transcripts in the DB
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      sessionId: s.id,
      cli: "opencode" as const,
    };
  });
}

export interface OpenCodeProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Resolve sessions by the dashboard's encoded folder name (e.g.
 * `-home-nivedit-prs-failproofai-266`). We scan all project worktrees and
 * pick the one whose encoded form matches.
 */
export async function getOpenCodeSessionsByEncodedName(name: string): Promise<OpenCodeProjectByName> {
  let projects: OpenCodeProjectRow[] | null;
  let sessions: OpenCodeSessionRow[] | null;
  try {
    ({ projects, sessions } = await readBothRows());
  } catch (error) {
    logWarn("Failed to read OpenCode DB:", error);
    return { cwd: null, sessions: [] };
  }
  if (!projects || !sessions) return { cwd: null, sessions: [] };

  const matchingProject = projects.find((p) => p.worktree && encodeFolderName(p.worktree) === name);
  if (!matchingProject || !matchingProject.worktree) return { cwd: null, sessions: [] };

  const matched = sessions.filter((s) => s.project_id === matchingProject.id);
  return {
    cwd: matchingProject.worktree,
    sessions: matched.map((s) => {
      const lastModified = new Date(s.time_updated);
      return {
        name: s.title ?? s.slug ?? s.id,
        path: `opencode://${s.id}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.id,
        cli: "opencode" as const,
      };
    }),
  };
}

export const getCachedOpenCodeProjects = runtimeCache(getOpenCodeProjects, 30);
export const getCachedOpenCodeSessionsForCwd = runtimeCache(
  (cwd: string) => getOpenCodeSessionsForCwd(cwd),
  30,
  { maxSize: 50 },
);
export const getCachedOpenCodeSessionsByEncodedName = runtimeCache(
  (name: string) => getOpenCodeSessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
