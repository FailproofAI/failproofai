/**
 * OpenClaw (openclaw gateway) transcript adapter — AUDIT (Pillar 2).
 *
 * OpenClaw writes real JSONL transcripts at
 * `~/.openclaw/agents/<agentId>/sessions/<uuid>.jsonl` (verified live against
 * v2026.7.1). lib/openclaw-sessions.ts enumerates and parses them into the
 * shared LogEntry[] shape, so `logEntriesToEvents` handles the rest.
 *
 * Gateway sessions run in the container workspace, not a host repo, so they
 * group by agentId (`openclaw:<agentId>`) and contribute nothing to a
 * cwd-scoped audit.
 */
import {
  listOpenClawTranscripts,
  getOpenClawSessionLog,
} from "../../../lib/openclaw-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listOpenClawTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  // `audit --project <cwd>` filters on working directory; gateway sessions run
  // in the container workspace, not a host repo, so OpenClaw contributes
  // nothing to a cwd-scoped audit.
  if (opts.projects && opts.projects.length > 0) return [];

  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];
  for (const t of listOpenClawTranscripts()) {
    if (t.mtimeMs < sinceMs) continue;
    out.push({
      cli: "openclaw",
      projectName: `openclaw:${t.agentId}`,
      sessionId: t.sessionId,
      transcriptPath: t.transcriptPath,
      mtimeMs: t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  return out;
}

export async function streamOpenClawEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getOpenClawSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "openclaw",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
