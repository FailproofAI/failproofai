/**
 * Claude Code transcript adapter.
 *
 * Discovers ~/.claude/projects/<encoded>/<sessionId>.jsonl (and any subagent
 * transcripts under <sessionId>/subagents/) via lib/claude-sessions.ts, then
 * parses each via lib/log-entries.ts.
 */
import { readFile } from "node:fs/promises";
import {
  listClaudeProjects,
  listClaudeTranscripts,
  type ClaudeTranscriptFile,
} from "../../../lib/claude-sessions";
import { parseLogContent, type LogSource } from "../../../lib/log-entries";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import { logEntriesToEvents } from "./shared";

export interface ListOpts {
  /** Restrict to sessions whose decoded cwd matches one of these paths. */
  projects?: string[];
  /** Filter on transcript mtime — only return if mtimeMs >= sinceMs. */
  sinceMs?: number;
}

export async function listClaudeTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  for (const project of listClaudeProjects()) {
    if (projectFilter && !projectFilter.has(project.cwd)) continue;
    let transcripts: ClaudeTranscriptFile[];
    try {
      transcripts = listClaudeTranscripts(project);
    } catch {
      continue;
    }
    for (const t of transcripts) {
      if (t.mtimeMs < sinceMs) continue;
      out.push({
        cli: "claude",
        projectName: project.name,
        sessionId: t.sessionId,
        transcriptPath: t.transcriptPath,
        mtimeMs: t.mtimeMs,
        sizeBytes: t.sizeBytes,
      });
    }
  }

  return out;
}

export async function streamClaudeEvents(
  meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const source: LogSource = "session";
  let entries;
  try {
    entries = await parseLogContent(content, source);
  } catch {
    return [];
  }

  // Best-effort cwd resolution: the JSONL lines carry `cwd` directly on each
  // record (verified live — see plan exploration notes). Pull the first one
  // we find rather than re-decoding the folder name (which is lossy on POSIX).
  let cwd = "";
  for (const line of content.split("\n", 50)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) {
        cwd = parsed.cwd;
        break;
      }
    } catch {
      // skip malformed lines
    }
  }

  return logEntriesToEvents(entries, {
    cli: "claude",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd,
  });
}
