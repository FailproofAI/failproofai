/**
 * Gemini CLI transcript adapter.
 */
import { statSync } from "node:fs";
import { getGeminiProjects, getGeminiSessionsByEncodedName } from "../../../lib/gemini-projects";
import { getGeminiSessionLog } from "../../../lib/gemini-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listGeminiTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  const projects = await getGeminiProjects();
  for (const project of projects) {
    const { cwd, sessions } = await getGeminiSessionsByEncodedName(project.name);
    const effectiveCwd = cwd ?? "";
    if (projectFilter && !projectFilter.has(effectiveCwd)) continue;
    for (const s of sessions) {
      const mtimeMs = s.lastModified.getTime();
      if (mtimeMs < sinceMs) continue;
      let sizeBytes = 0;
      try { sizeBytes = statSync(s.path).size; } catch { /* unreadable */ }
      if (!s.sessionId) continue;
      out.push({
        cli: "gemini",
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

export async function streamGeminiEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  const log = await getGeminiSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "gemini",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
