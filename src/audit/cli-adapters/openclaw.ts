/**
 * OpenClaw (openclaw gateway) transcript adapter — AUDIT (Pillar 2).
 *
 * OpenClaw writes real JSONL transcripts at
 * `~/.openclaw/agents/<agentId>/sessions/<uuid>.jsonl` (verified live against
 * v2026.7.1). lib/openclaw-sessions.ts enumerates and parses them into the
 * shared LogEntry[] shape, so `logEntriesToEvents` handles the rest.
 *
 * Gateway sessions run in the container workspace, not a host repo, so they
 * group by (agentId, channel) — `openclaw:<agentId>:<channel>` — and contribute
 * nothing to a cwd-scoped audit. That is the SAME key the dashboard groups by;
 * the two used to disagree (adapter by agent, panel by channel), so a report and
 * the projects panel sliced identical data on different axes.
 */
import { getOpenClawSessions, openClawProjectPath } from "../../../lib/openclaw-projects";
import { getOpenClawSessionLog } from "../../../lib/openclaw-sessions";
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
  // getOpenClawSessions layers the per-agent sessions.json index over the same
  // transcript walk, which is what carries `channel`. It reads one small index
  // file per AGENT (not per session) and is memoized, so grouping by channel
  // costs no meaningful extra IO on the audit path.
  for (const s of await getOpenClawSessions()) {
    if (s.mtimeMs < sinceMs) continue;
    out.push({
      cli: "openclaw",
      projectName: openClawProjectPath(s.agentId, s.channel),
      sessionId: s.sessionId,
      transcriptPath: s.transcriptPath,
      mtimeMs: s.mtimeMs,
      sizeBytes: s.sizeBytes,
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
