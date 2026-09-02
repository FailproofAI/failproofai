/**
 * Qwen Code project discovery.
 *
 * qwen stores transcripts at
 * `~/.qwen/projects/<encoded-cwd>/chats/<uuid>.jsonl`, using the same
 * Claude-style encoded-cwd folder names (`-home-user-project`) as Claude Code.
 * The encoded folder doubles as the URL slug for `/project/[name]`, so a cwd
 * present in both stores naturally produces the same `name` and merges on the
 * Claude side (see `mergeProjectFolders` in lib/projects.ts).
 */
import { decodeFolderName } from "./paths";
import { listQwenTranscripts, getQwenSessionLog } from "./qwen-sessions";
import type { ProjectFolder, SessionFile } from "./projects";
import { runtimeCache } from "./runtime-cache";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Returns one ProjectFolder per encoded-cwd folder discovered under
 *  ~/.qwen/projects/. */
export async function getQwenProjects(): Promise<ProjectFolder[]> {
  let transcripts;
  try {
    transcripts = listQwenTranscripts();
  } catch (error) {
    logWarn("Failed to scan Qwen sessions:", error);
    return [];
  }

  const byName = new Map<string, { latest: number; cwd: string; name: string }>();
  for (const t of transcripts) {
    const existing = byName.get(t.projectName);
    if (!existing || t.mtimeMs > existing.latest) {
      byName.set(t.projectName, { latest: t.mtimeMs, cwd: t.cwd, name: t.projectName });
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
      cli: ["qwen"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface QwenProjectByName {
  /** Canonical cwd recovered from a session line (the folder decode is lossy).
   *  Null when no session could be read. */
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Look up Qwen sessions for a project URL slug (the encoded-cwd folder name).
 * qwen names its folders with the same encoding Claude uses, so the slug
 * matches the folder directly. The canonical cwd is recovered from the newest
 * session's own `cwd` field (folder decode is lossy for cwds containing `-`).
 */
export async function getQwenSessionsByEncodedName(name: string): Promise<QwenProjectByName> {
  let transcripts;
  try {
    transcripts = listQwenTranscripts().filter((t) => t.projectName === name);
  } catch (error) {
    logWarn("Failed to scan Qwen sessions:", error);
    return { cwd: null, sessions: [] };
  }
  if (transcripts.length === 0) return { cwd: null, sessions: [] };

  const sorted = [...transcripts].sort((a, b) => b.mtimeMs - a.mtimeMs);

  let cwd: string | null = null;
  try {
    const log = await getQwenSessionLog(sorted[0].sessionId);
    cwd = log?.cwd ?? null;
  } catch {
    // best-effort — fall back to the lossy decode below
  }
  if (!cwd) cwd = decodeFolderName(name);

  const sessions: SessionFile[] = sorted.map((t) => {
    const lastModified = new Date(t.mtimeMs);
    return {
      name: t.sessionId,
      path: t.transcriptPath,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      sessionId: t.sessionId,
      cli: "qwen" as const,
    };
  });
  return { cwd, sessions };
}

export const getCachedQwenProjects = runtimeCache(getQwenProjects, 30);
export const getCachedQwenSessionsByEncodedName = runtimeCache(
  (name: string) => getQwenSessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
