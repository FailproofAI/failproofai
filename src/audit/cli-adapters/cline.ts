/**
 * Cline transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * The thinnest adapter we have, because cline already stores Claude's own
 * content blocks: lib/cline-projects.ts enumerates the per-session directories
 * (each carrying a real `cwd`, so `audit --project <cwd>` filters work as they
 * do for Devin, Goose and ori), lib/cline-sessions.ts pairs tool_result back
 * onto tool_use, and `logEntriesToEvents` does the rest unchanged.
 */
import { getClineSessions } from "../../../lib/cline-projects";
import { getClineSessionLog } from "../../../lib/cline-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listClineTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getClineSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    if (projectFilter && (!s.cwd || !projectFilter.has(s.cwd))) continue;
    out.push({
      cli: "cline",
      projectName: s.projectName,
      sessionId: s.sessionId,
      transcriptPath: `cline-session://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // ended_at/started_at advance per session, so (mtime) is a real cache key.
      sizeBytes: 0,
    });
  }
  return out;
}

export async function streamClineEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getClineSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "cline",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
