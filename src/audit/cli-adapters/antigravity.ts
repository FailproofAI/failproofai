/**
 * Antigravity (agy) transcript adapter — AUDIT (Pillar 2).
 *
 * Antigravity writes plain-JSONL transcripts at
 * `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 * (one step per line), with a SQLite conversation index at
 * `conversation_summaries.db`. Verified live against agy v1.1.2.
 * lib/antigravity-sessions.ts enumerates + parses the transcripts into the
 * shared LogEntry[] shape; lib/antigravity-projects.ts reads the SQLite index
 * for cwd/title enrichment. `logEntriesToEvents` handles the rest (tool-name +
 * tool-input canonicalization via the ANTIGRAVITY_* maps).
 */
import { readFile } from "node:fs/promises";
import {
  listAntigravityTranscripts,
  antigravityLinesToLogEntries,
} from "../../../lib/antigravity-sessions";
import { getAntigravityIndex } from "../../../lib/antigravity-projects";
import { parseRawLines } from "../../../lib/log-entries";
import { encodeFolderName } from "../../../lib/paths";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listAntigravityTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  const index = await getAntigravityIndex();

  for (const t of listAntigravityTranscripts()) {
    if (t.mtimeMs < sinceMs) continue;
    const cwd = index.get(t.conversationId)?.cwd;
    // `audit --project <cwd>` filters on the conversation's workspace cwd.
    if (projectFilter && (!cwd || !projectFilter.has(cwd))) continue;
    out.push({
      cli: "antigravity",
      projectName: cwd ? encodeFolderName(cwd) : "antigravity",
      sessionId: t.conversationId,
      transcriptPath: t.transcriptPath,
      mtimeMs: t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  return out;
}

export async function streamAntigravityEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const rawLines = parseRawLines(content, "session");
  const entries = antigravityLinesToLogEntries(rawLines, "session");

  // Recover cwd from the transcript's first run_command Cwd (falls back to "").
  let cwd = "";
  for (const line of rawLines) {
    if (!line || typeof line !== "object") continue;
    const calls = (line as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const args = call && typeof call === "object" ? (call as Record<string, unknown>).args : undefined;
      const c = args && typeof args === "object" ? (args as Record<string, unknown>).Cwd : undefined;
      if (typeof c === "string" && c.length > 0) {
        cwd = c;
        break;
      }
    }
    if (cwd) break;
  }

  return logEntriesToEvents(entries, {
    cli: "antigravity",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd,
  });
}
