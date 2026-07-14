/**
 * Goose (codename goose, Block) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Goose keeps every session in one SQLite DB at
 * `~/.local/share/goose/sessions/sessions.db`. We read it directly via the
 * bundled sql.js reader (lib/goose-projects.ts enumerates the `sessions` table;
 * lib/goose-sessions.ts parses each session's `messages`), producing the same
 * LogEntry[] shape the other adapters do — so `logEntriesToEvents` handles the
 * rest. Like Devin, each Goose session carries a real `working_dir`, so
 * `audit --project <cwd>` filters work (unlike the cwd-less Hermes gateway).
 */
import { getGooseSessions } from "../../../lib/goose-projects";
import { getGooseSessionLog } from "../../../lib/goose-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listGooseTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getGooseSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    // `audit --project <cwd>` filters on the session's working directory.
    if (projectFilter && (!s.cwd || !projectFilter.has(s.cwd))) continue;
    out.push({
      cli: "goose",
      projectName: s.projectName,
      sessionId: s.sessionId,
      transcriptPath: `goose-db://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // mtime advances on each message, so (mtime) forms a real cache key.
      sizeBytes: 0,
    });
  }
  return out;
}

export async function streamGooseEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getGooseSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "goose",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
