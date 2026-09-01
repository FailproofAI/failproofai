/**
 * Cline session enumeration — AUDIT-ONLY.
 *
 * One directory per session under `~/.cline/data/sessions/<epochMs>_<suffix>/`,
 * each with a `<id>.json` metadata sidecar carrying a real `cwd`. So cline
 * sessions group by project like Claude / Factory / Devin / Goose / ori rather
 * than landing in one cwd-less bucket the way the Hermes gateway does.
 *
 * Enumeration reads only the small metadata sidecar, never the transcript — a
 * project listing should not pay for parsing every message array on the box.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  clineSessionsDir,
  clineTimestampToMs,
  readClineSessionMeta,
  CLINE_SESSION_DIR_RE,
} from "./cline-sessions";
import { encodeFolderName } from "./paths";
import { runtimeCache } from "./runtime-cache";
import type { ProjectFolder, SessionFile } from "./projects";
import { formatDate } from "./format-date";

export interface ClineSessionRef {
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  provider?: string;
  /** Encoded-cwd folder slug (matches Claude's `-home-user-project` scheme). */
  projectName: string;
  mtimeMs: number;
}

/** Truncate a first prompt into a session title the way the other adapters do. */
function titleFrom(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  // cline wraps the first turn in <user_input mode="act">…</user_input>.
  const inner = /<user_input[^>]*>([\s\S]*?)<\/user_input>/.exec(prompt);
  const text = (inner ? inner[1]! : prompt).trim().replace(/\s+/g, " ");
  if (text.length === 0) return undefined;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * List every cline session. Returns `[]` when the directory is missing or
 * unreadable (fail-open — the audit just skips cline).
 */
export async function getClineSessions(): Promise<ClineSessionRef[]> {
  const root = clineSessionsDir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: ClineSessionRef[] = [];
  for (const name of names) {
    if (!CLINE_SESSION_DIR_RE.test(name)) continue;
    const dir = join(root, name);
    const meta = await readClineSessionMeta(dir, name);
    let mtimeMs =
      clineTimestampToMs(meta?.ended_at) ||
      clineTimestampToMs(meta?.started_at) ||
      Number(name.split("_")[0]) ||
      0;
    if (mtimeMs === 0) {
      try {
        mtimeMs = (await stat(dir)).mtimeMs;
      } catch {
        /* leave 0 */
      }
    }
    const cwd = meta?.cwd ?? meta?.workspace_root;
    out.push({
      sessionId: name,
      cwd,
      title: titleFrom(meta?.prompt),
      model: meta?.model,
      provider: meta?.provider,
      projectName: cwd ? encodeFolderName(cwd) : "cline",
      mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export const getCachedClineSessions = runtimeCache(getClineSessions, 2);

// ── Dashboard history browser (projects list + project-detail sessions) ──

/** One `ProjectFolder` per encoded-cwd discovered in cline's session store. */
export async function getClineProjects(): Promise<ProjectFolder[]> {
  const sessions = await getClineSessions();
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
      cli: ["cline"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface ClineProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/** Resolve the cline sessions for a project URL slug (the encoded-cwd folder). */
export async function getClineSessionsByEncodedName(name: string): Promise<ClineProjectByName> {
  const sessions = await getClineSessions();
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
        path: `cline-session://${s.sessionId}`,
        lastModified,
        lastModifiedFormatted: formatDate(lastModified),
        sessionId: s.sessionId,
        cli: "cline" as const,
      };
    }),
  };
}

export const getCachedClineProjects = runtimeCache(getClineProjects, 2);
export const getCachedClineSessionsByEncodedName = runtimeCache(
  (name: string) => getClineSessionsByEncodedName(name),
  2,
  { maxSize: 50 },
);
