/**
 * Ori (OpenRouter's ori) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Covers ori's OWN agent (bare `ori` / `ori code`). Sessions launched through
 * ori's LAUNCHER (`ori claude`, `ori codex`, …) are recorded by the launched
 * CLI in its own store and are picked up by that CLI's adapter, not this one.
 *
 * ori keeps the whole conversation in one SQLite DB in its global workspace —
 * lib/ori-projects.ts enumerates `ori_agent_loop_sessions`, lib/ori-sessions.ts
 * parses each session's serialized message array — producing the same
 * LogEntry[] shape the other adapters do, so `logEntriesToEvents` handles the
 * rest. Each session carries a real `cwd`, so `audit --project <cwd>` filters
 * work as they do for Devin and Goose.
 */
import { getOriSessions } from "../../../lib/ori-projects";
import { getOriSessionLog } from "../../../lib/ori-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listOriTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getOriSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    if (projectFilter && (!s.cwd || !projectFilter.has(s.cwd))) continue;
    out.push({
      cli: "ori",
      projectName: s.projectName,
      sessionId: s.sessionId,
      transcriptPath: `ori-db://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // updated_at advances on each turn, so (mtime) forms a real cache key.
      sizeBytes: 0,
    });
  }
  return out;
}

export async function streamOriEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getOriSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "ori",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
