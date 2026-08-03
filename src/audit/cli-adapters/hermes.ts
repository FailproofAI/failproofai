/**
 * Hermes (hermes-agent) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Hermes keeps every gateway user's sessions in one SQLite DB. We read it
 * directly via the bundled sql.js reader (lib/hermes-projects.ts enumerates the
 * `sessions` table; lib/hermes-sessions.ts parses each session's `messages`),
 * producing the same LogEntry[] shape the other adapters do — so
 * `logEntriesToEvents` handles the rest.
 *
 * Hermes sessions are NOT uniformly cwd-less. This file used to assert they were
 * and returned nothing at all for `audit --project <cwd>`, so a Hermes session
 * driven in a repo silently contributed zero findings to that project's audit.
 * Verified against hermes-agent 0.19.0: `sessions` carries real `cwd`,
 * `git_branch` and `git_repo_root` columns, and every `source='cli'` session
 * populated them.
 *
 * Both shapes are real, so both are handled:
 *   • a session WITH a cwd groups by working directory like Claude/Goose/Devin,
 *     and takes part in cwd-scoped audits;
 *   • a session WITHOUT one — a Slack/Telegram gateway run, which genuinely
 *     isn't in a repo — keeps grouping by (profile, `source`), since a Hermes
 *     profile is a whole separate home dir with its own state.db
 *     (lib/hermes-profiles.ts), and is correctly excluded from a cwd filter.
 */
import { getHermesSessions } from "../../../lib/hermes-projects";
import { hermesProjectPath } from "../../../lib/hermes-profiles";
import { getHermesSessionLog } from "../../../lib/hermes-sessions";
import { encodeFolderName } from "../../../lib/paths";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

/** Grouping label for one session: its working directory when it has one,
 *  else the (profile, source) bucket gateway sessions have always used. */
function hermesProjectName(s: { profile: string; source?: string; cwd?: string }): string {
  if (s.cwd) return encodeFolderName(s.cwd);
  return s.source ? hermesProjectPath(s.profile, s.source) : `hermes:${s.profile}`;
}

export async function listHermesTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getHermesSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    if (s.messageCount <= 0 && !s.hasMessages) continue; // empty → no events (message_count can lag; trust real messages)
    // `audit --project <cwd>` filters on the session's working directory, the
    // same comparison Claude and Goose make. A session with no cwd is not in
    // any project, so it drops out here rather than at the top of the function.
    if (projectFilter && (!s.cwd || !projectFilter.has(s.cwd))) continue;
    out.push({
      cli: "hermes",
      projectName: hermesProjectName(s),
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
