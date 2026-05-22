/**
 * Codex (OpenAI) transcript adapter.
 *
 * Codex stores transcripts at ~/.codex/sessions/YYYY/MM/DD/<*sessionId*>.jsonl
 * with a different layout per project. We enumerate via lib/codex-projects.ts
 * and parse via lib/codex-sessions.ts which produces the same LogEntry[] shape
 * the Claude parser uses, so the shared converter handles the rest.
 */
import { statSync } from "node:fs";
import { getCodexProjects, getCodexSessionsByEncodedName } from "../../../lib/codex-projects";
import { getCodexSessionLog } from "../../../lib/codex-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listCodexTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  const projects = await getCodexProjects();
  for (const project of projects) {
    const { cwd, sessions } = await getCodexSessionsByEncodedName(project.name);
    const effectiveCwd = cwd ?? "";
    if (projectFilter && !projectFilter.has(effectiveCwd)) continue;
    for (const s of sessions) {
      const mtimeMs = s.lastModified.getTime();
      if (mtimeMs < sinceMs) continue;
      let sizeBytes = 0;
      try { sizeBytes = statSync(s.path).size; } catch { /* unreadable */ }
      if (!s.sessionId) continue;
      out.push({
        cli: "codex",
        projectName: project.name,
        sessionId: s.sessionId,
        transcriptPath: s.path,
        mtimeMs,
        sizeBytes,
      });
    }
  }
  return out;
}

export async function streamCodexEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  const log = await getCodexSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "codex",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
