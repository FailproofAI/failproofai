/**
 * Claude Code transcript adapter.
 *
 * Discovers ~/.claude/projects/<encoded>/<sessionId>.jsonl (and any subagent
 * transcripts under <sessionId>/subagents/) via lib/claude-sessions.ts, then
 * parses each via lib/log-entries.ts.
 */
import { readFile, open, type FileHandle } from "node:fs/promises";
import {
  listClaudeProjects,
  listClaudeTranscripts,
  type ClaudeTranscriptFile,
} from "../../../lib/claude-sessions";
import { parseLogContent, type LogSource } from "../../../lib/log-entries";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import { logEntriesToEvents } from "./shared";
import type { IncrementalEvents } from "./index";

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

/**
 * The events after `fromByte`, and nothing before it.
 *
 * Claude writes session transcripts as append-only JSONL, which is what makes
 * this sound: the bytes before `fromByte` were parsed on an earlier run and
 * have not moved. The caller has already established that — see
 * `anchorHashFor` in the audit cache — so this reads from the offset and does
 * not re-verify it.
 *
 * Two details carry the correctness:
 *
 *  - The read starts at `fromByte`, which the caller only ever sets to a
 *    position it previously reported through `bytesConsumed`, so it always
 *    lands at the start of a line.
 *  - It stops at the last NEWLINE, not at end-of-file. A transcript is
 *    frequently being written while the audit reads it, so the tail is often
 *    half a line; parsing it would drop or mangle that event, and reporting
 *    the file size as consumed would mean the next run started after it and
 *    lost it for good.
 */
export async function streamClaudeEventsFrom(
  meta: TranscriptMetadata,
  fromByte: number,
): Promise<IncrementalEvents | null> {
  if (!Number.isFinite(fromByte) || fromByte < 0) return null;
  let handle: FileHandle | null = null;
  let chunk: string;
  try {
    handle = await open(meta.transcriptPath, "r");
    const { size } = await handle.stat();
    if (fromByte > size) return null; // truncated under us; caller re-scans
    if (fromByte === size) {
      return { events: [], bytesConsumed: fromByte };
    }
    const buf = Buffer.alloc(size - fromByte);
    await handle.read(buf, 0, buf.length, fromByte);
    chunk = buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* nothing useful to do */ }
    }
  }

  // Everything up to the last newline is unambiguously complete. What follows
  // it is either a line still being written, or the last line of a file that
  // simply does not end in a newline — and those need opposite treatment:
  // dropping the first is required, dropping the second loses the final event
  // of every completed transcript.
  //
  // The only signal available in the bytes is whether the remainder PARSES. A
  // half-written JSONL record does not (its braces are unclosed); a whole one
  // missing only its newline does. So a parseable tail is taken and counted,
  // and an unparseable one is left for the next run to pick up whole — which
  // is also what stops it being counted twice when it arrives.
  const lastNewline = chunk.lastIndexOf("\n");
  const head = lastNewline === -1 ? "" : chunk.slice(0, lastNewline + 1);
  const tail = chunk.slice(lastNewline + 1);
  const tailIsWholeLine = tail.trim().length > 0 && (() => {
    try {
      JSON.parse(tail);
      return true;
    } catch {
      return false;
    }
  })();
  const complete = tailIsWholeLine ? head + tail : head;
  if (complete.length === 0) {
    // Nothing whole to parse, and the offset does not move.
    return { events: [], bytesConsumed: fromByte };
  }
  // Byte length, not string length — a multi-byte character in the tail would
  // otherwise put the next resume offset mid-character.
  const bytesConsumed = fromByte + Buffer.byteLength(complete, "utf-8");

  let entries;
  try {
    entries = await parseLogContent(complete, "session" as LogSource);
  } catch {
    return null;
  }

  let cwd = "";
  for (const line of complete.split("\n", 50)) {
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

  return {
    events: logEntriesToEvents(entries, {
      cli: "claude",
      sessionId: meta.sessionId,
      transcriptPath: meta.transcriptPath,
      cwd,
    }),
    bytesConsumed,
    cwd: cwd || undefined,
  };
}
