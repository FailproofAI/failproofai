/**
 * Factory (droid) transcript adapter — AUDIT (Pillar 2).
 *
 * droid writes real JSONL transcripts at
 * `~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl` (Claude-style
 * encoded-cwd folders; verified live against droid v0.171.0).
 * lib/factory-sessions.ts enumerates and parses them into the shared
 * LogEntry[] shape, so `logEntriesToEvents` handles the rest.
 */
import { readFile } from "node:fs/promises";
import {
  listFactoryTranscripts,
  factoryLinesToLogEntries,
} from "../../../lib/factory-sessions";
import { parseRawLines } from "../../../lib/log-entries";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listFactoryTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  for (const t of listFactoryTranscripts()) {
    if (t.mtimeMs < sinceMs) continue;
    // `audit --project <cwd>` filters on the decoded working directory.
    if (projectFilter && !projectFilter.has(t.cwd)) continue;
    out.push({
      cli: "factory",
      projectName: t.projectName,
      sessionId: t.sessionId,
      transcriptPath: t.transcriptPath,
      mtimeMs: t.mtimeMs,
      sizeBytes: t.sizeBytes,
    });
  }
  return out;
}

export async function streamFactoryEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const rawLines = parseRawLines(content, "session");
  const entries = factoryLinesToLogEntries(rawLines, "session");

  // cwd lives on the `type:"session_start"` header line — recover the canonical
  // value rather than re-decoding the (lossy) folder name.
  let cwd = "";
  for (const line of rawLines) {
    if (line && typeof line === "object" && (line as Record<string, unknown>).type === "session_start") {
      const c = (line as Record<string, unknown>).cwd;
      if (typeof c === "string" && c.length > 0) {
        cwd = c;
        break;
      }
    }
  }

  return logEntriesToEvents(entries, {
    cli: "factory",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd,
  });
}
