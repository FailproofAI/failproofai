/**
 * Devin CLI (Cognition) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Devin keeps every session in one SQLite DB at
 * `~/.local/share/devin/cli/sessions.db`. We read it directly via the bundled
 * sql.js reader (lib/devin-projects.ts enumerates the `sessions` table;
 * lib/devin-sessions.ts parses each session's `message_nodes`), producing the
 * same LogEntry[] shape the other adapters do — so `logEntriesToEvents` handles
 * the rest. Unlike Hermes, each Devin session carries a real
 * `working_directory`, so `audit --project <cwd>` filters work.
 */
import { getDevinSessions } from "../../../lib/devin-projects";
import { getDevinSessionLog } from "../../../lib/devin-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listDevinTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getDevinSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    // `audit --project <cwd>` filters on the session's working directory.
    if (projectFilter && (!s.cwd || !projectFilter.has(s.cwd))) continue;
    out.push({
      cli: "devin",
      projectName: s.projectName,
      sessionId: s.sessionId,
      transcriptPath: `devin-db://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // mtime advances on each message, so (mtime) forms a real cache key.
      sizeBytes: 0,
    });
  }
  return out;
}

export async function streamDevinEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getDevinSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "devin",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
