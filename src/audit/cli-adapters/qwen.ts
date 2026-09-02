/**
 * Qwen Code transcript adapter — AUDIT (Pillar 2).
 *
 * qwen writes real JSONL transcripts at
 * `~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl` (Claude-style
 * encoded-cwd folders, one level deeper than Claude's; verified live against
 * qwen-code 0.21.12). lib/qwen-sessions.ts enumerates and parses them — the
 * message bodies are Gemini-shaped `parts[]`, not Claude content blocks — into
 * the shared LogEntry[] shape, so `logEntriesToEvents` handles the rest.
 */
import { readFile } from "node:fs/promises";
import { listQwenTranscripts, qwenLinesToLogEntries } from "../../../lib/qwen-sessions";
import { parseRawLines } from "../../../lib/log-entries";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listQwenTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  for (const t of listQwenTranscripts()) {
    if (t.mtimeMs < sinceMs) continue;
    // `audit --project <cwd>` filters on the decoded working directory.
    if (projectFilter && !projectFilter.has(t.cwd)) continue;
    out.push({
      cli: "qwen",
      projectName: t.projectName,
      sessionId: t.sessionId,
      transcriptPath: t.transcriptPath,
      mtimeMs: t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  return out;
}

export async function streamQwenEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const rawLines = parseRawLines(content, "session");
  const entries = qwenLinesToLogEntries(rawLines, "session");

  // Every qwen line carries the real cwd — take the first rather than
  // re-decoding the (lossy) folder name.
  let cwd = "";
  for (const line of rawLines) {
    if (line && typeof line === "object") {
      const c = (line as Record<string, unknown>).cwd;
      if (typeof c === "string" && c.length > 0) {
        cwd = c;
        break;
      }
    }
  }

  return logEntriesToEvents(entries, {
    cli: "qwen",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd,
  });
}
