/**
 * GitHub Copilot CLI transcript adapter.
 */
import { statSync } from "node:fs";
import { getCopilotProjects, getCopilotSessionsByEncodedName } from "../../../lib/copilot-projects";
import { getCopilotSessionLog } from "../../../lib/copilot-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listCopilotTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  const projects = await getCopilotProjects();
  for (const project of projects) {
    const { cwd, sessions } = await getCopilotSessionsByEncodedName(project.name);
    const effectiveCwd = cwd ?? "";
    if (projectFilter && !projectFilter.has(effectiveCwd)) continue;
    for (const s of sessions) {
      const mtimeMs = s.lastModified.getTime();
      if (mtimeMs < sinceMs) continue;
      let sizeBytes = 0;
      try { sizeBytes = statSync(s.path).size; } catch { /* unreadable */ }
      if (!s.sessionId) continue;
      out.push({
        cli: "copilot",
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

export async function streamCopilotEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  const log = await getCopilotSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "copilot",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
