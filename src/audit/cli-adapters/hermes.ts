/**
 * Hermes (hermes-agent) transcript adapter — AUDIT-ONLY (Pillar 2).
 *
 * Hermes keeps every gateway user's sessions in one SQLite DB. We enumerate via
 * lib/hermes-projects.ts (`hermes sessions list`) and parse each session via
 * lib/hermes-sessions.ts (`hermes sessions export`), which produces the same
 * LogEntry[] shape the Codex parser does — so `logEntriesToEvents` handles the
 * rest. Shell-out (no bundled SQLite driver), mirroring the OpenCode adapter.
 *
 * Gateway sessions have no `cwd` (Slack/Telegram runs aren't in a repo), so they
 * all group under a single "hermes" project bucket rather than by working dir.
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
  // none, so Hermes contributes nothing to a cwd-scoped audit (return empty
  // rather than every session).
  if (opts.projects && opts.projects.length > 0) return [];

  const sinceMs = opts.sinceMs ?? 0;
  const sessions = await getHermesSessions();
  const out: TranscriptMetadata[] = [];
  for (const s of sessions) {
    if (s.mtimeMs < sinceMs) continue;
    out.push({
      cli: "hermes",
      projectName: "hermes", // single bucket — gateway sessions are cwd-less
      sessionId: s.sessionId,
      transcriptPath: `hermes://${s.sessionId}`,
      mtimeMs: s.mtimeMs,
      // DB-backed source → sizeBytes 0 disables the per-transcript cache
      // (src/audit/cache.ts), so sessions are re-parsed each run — identical to
      // the OpenCode adapter's behavior today.
      sizeBytes: 0,
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
