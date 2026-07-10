/**
 * Hermes (hermes-agent) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Hermes keeps every gateway user's sessions in one SQLite DB. We read it
 * directly via the bundled sql.js reader (lib/hermes-projects.ts enumerates the
 * `sessions` table; lib/hermes-sessions.ts parses each session's `messages`),
 * producing the same LogEntry[] shape the other adapters do — so
 * `logEntriesToEvents` handles the rest.
 *
 * Gateway sessions have no `cwd` (Slack/Telegram runs aren't in a repo), so they
 * group by `source` (slack/telegram/cli/cron) instead of working directory.
 */
import { getHermesSessions } from "../../../lib/hermes-projects";
import { getHermesSessionLog } from "../../../lib/hermes-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listHermesTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  // `audit --project <cwd>` filters on working directory; gateway sessions have
  // none, so Hermes contributes nothing to a cwd-scoped audit.
  if (opts.projects && opts.projects.length > 0) return [];

  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getHermesSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    if (s.messageCount <= 0 && !s.hasMessages) continue; // empty → no events (message_count can lag; trust real messages)
    out.push({
      cli: "hermes",
      // Group by channel; gateway sessions are cwd-less.
      projectName: s.source ? `hermes:${s.source}` : "hermes",
      sessionId: s.sessionId,
      transcriptPath: `hermes://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // message_count is stable for an ended session, so (mtime, size) forms a
      // real per-transcript cache key — an ended session is parsed once.
      sizeBytes: s.messageCount,
    });
  }
  return out;
}

export async function streamHermesEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  const log = await getHermesSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "hermes",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
