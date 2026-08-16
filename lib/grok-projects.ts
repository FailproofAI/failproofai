/**
 * grok CLI project discovery.
 *
 * grok stores transcripts at
 * `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/chat_history.jsonl`.
 *
 * NOTE the folder encoding differs from every other JSONL store we read:
 * grok percent-encodes the cwd (`%2Fhome%2Fuser%2Frepo`) where Claude, Factory
 * and Qwen dash-encode it (`-home-user-repo`). That means a grok project folder
 * name is NOT interchangeable with the Claude-side slug, so these folders will
 * not merge with a Claude project for the same cwd the way Factory's do
 * (`mergeProjectFolders` in lib/projects.ts matches on `name`). The `path` is
 * still the real decoded cwd, so cwd-based filtering (`audit --project <cwd>`)
 * works correctly — it is only the URL slug that differs.
 */
import { listGrokTranscripts, getGrokSessionLog, decodeGrokProjectDir } from "./grok-sessions";
import type { ProjectFolder, SessionFile } from "./projects";
import { runtimeCache } from "./runtime-cache";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Returns one ProjectFolder per percent-encoded cwd folder discovered under
 *  ~/.grok/sessions/. */
export async function getGrokProjects(): Promise<ProjectFolder[]> {
  let transcripts;
  try {
    transcripts = listGrokTranscripts();
  } catch (error) {
    logWarn("Failed to scan grok sessions:", error);
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
      cli: ["grok"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

export interface GrokProjectByName {
  /** Canonical cwd, taken from a session's summary.json `info.cwd`. Null when
   *  no session could be read. */
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Look up grok sessions for a project URL slug (the percent-encoded cwd folder
 * name). The canonical cwd comes from summary.json; the percent-decode is the
 * fallback.
 */
export async function getGrokSessionsByEncodedName(name: string): Promise<GrokProjectByName> {
  let transcripts;
  try {
    transcripts = listGrokTranscripts().filter((t) => t.projectName === name);
  } catch (error) {
    logWarn("Failed to scan grok sessions:", error);
    return { cwd: null, sessions: [] };
  }
  if (transcripts.length === 0) return { cwd: null, sessions: [] };

  const sorted = [...transcripts].sort((a, b) => b.mtimeMs - a.mtimeMs);

  let cwd: string | null = sorted[0].cwd || null;
  if (!cwd) {
    try {
      const log = await getGrokSessionLog(sorted[0].sessionId);
      cwd = log?.cwd ?? null;
    } catch {
      // best-effort — fall back to the decode below
    }
  }
  if (!cwd) cwd = decodeGrokProjectDir(name);

  const sessions: SessionFile[] = sorted.map((t) => {
    const lastModified = new Date(t.mtimeMs);
    return {
      name: t.sessionId,
      path: t.transcriptPath,
      lastModified,
      lastModifiedFormatted: formatDate(lastModified),
      sessionId: t.sessionId,
      cli: "grok" as const,
    };
  });
  return { cwd, sessions };
}

export const getCachedGrokProjects = runtimeCache(getGrokProjects, 30);
export const getCachedGrokSessionsByEncodedName = runtimeCache(
  (name: string) => getGrokSessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
