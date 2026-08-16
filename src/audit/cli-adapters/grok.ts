/**
 * grok CLI transcript adapter — AUDIT (Pillar 2).
 *
 * grok writes one session DIRECTORY at
 * `~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/`, whose
 * `chat_history.jsonl` holds the turns (verified live against grok 1.0.3).
 * lib/grok-sessions.ts enumerates and parses them.
 *
 * `chat_history.jsonl` has no per-message timestamps, so the parser anchors a
 * synthesized timeline on the session's `created_at` (from summary.json) —
 * `listGrokTranscripts` already resolved that, so it is passed straight
 * through here rather than re-read.
 */
import { readFile } from "node:fs/promises";
import { listGrokTranscripts, grokLinesToLogEntries } from "../../../lib/grok-sessions";
import { parseRawLines } from "../../../lib/log-entries";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listGrokTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  for (const t of listGrokTranscripts()) {
    if (t.mtimeMs < sinceMs) continue;
    // `audit --project <cwd>` filters on the real cwd (summary.json's info.cwd
    // when present, else the percent-decoded folder name).
    if (projectFilter && !projectFilter.has(t.cwd)) continue;
    out.push({
      cli: "grok",
      projectName: t.projectName,
      sessionId: t.sessionId,
      transcriptPath: t.transcriptPath,
      mtimeMs: t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  return out;
}

export async function streamGrokEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return [];
  }

  // Recover this session's cwd + created_at from the enumeration (both come
  // from summary.json, which streamEvents is not otherwise given).
  const known = listGrokTranscripts().find((t) => t.sessionId === meta.sessionId);

  const rawLines = parseRawLines(content, "session");
  const entries = grokLinesToLogEntries(
    rawLines,
    known?.createdAtMs ?? meta.mtimeMs,
    "session",
  );

  return logEntriesToEvents(entries, {
    cli: "grok",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: known?.cwd ?? "",
  });
}
