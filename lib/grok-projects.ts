/**
 * grok CLI project discovery.
 *
 * grok stores transcripts at
 * `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/chat_history.jsonl`.
 *
 * NOTE the folder encoding differs from every other JSONL store we read: grok
 * percent-encodes the cwd (`%2Fhome%2Fuser%2Frepo`) where Claude, Factory and
 * Qwen dash-encode it (`-home-user-repo`).
 *
 * So the on-disk folder name is deliberately NOT used as the project `name`.
 * Two reasons, and the first is a hard bug: `name` becomes the URL slug for
 * `/project/[name]`, and a percent-encoded name re-encodes to `%252F…` in the
 * link, which the route cannot resolve — every grok project 404'd. Second, a
 * name no other CLI can produce merges with nothing, so a cwd driven by both
 * grok and Claude showed up as two unrelated rows.
 *
 * Re-encoding the decoded cwd with `encodeFolderName` fixes both at once: the
 * slug is URL-safe, and it is byte-identical to the one Claude/Factory/Qwen
 * derive for the same cwd, so those rows merge as they should.
 */
import { encodeFolderName, decodeFolderName } from "./paths";
import { listGrokTranscripts, getGrokSessionLog } from "./grok-sessions";
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
    // The URL slug is derived from the real cwd, never from grok's
    // percent-encoded folder — see the module header.
    const name = encodeFolderName(t.cwd);
    const existing = byName.get(name);
    if (!existing || t.mtimeMs > existing.latest) {
      byName.set(name, { latest: t.mtimeMs, cwd: t.cwd, name });
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
    // Match on the derived slug, since that is what the link carried.
    transcripts = listGrokTranscripts().filter((t) => encodeFolderName(t.cwd) === name);
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
  // `name` is a dash-encoded cwd here, so the shared decoder is the right one.
  if (!cwd) cwd = decodeFolderName(name);

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
