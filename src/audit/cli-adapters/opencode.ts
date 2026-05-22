/**
 * OpenCode (sst/opencode) transcript adapter.
 *
 * OpenCode is the outlier — sessions live in a SQLite database, not on disk
 * as JSONL files. The `transcriptPath` is therefore a virtual `opencode://<id>`
 * URI and `sizeBytes` is 0 (the file cache layer treats it as uncacheable).
 */
import { getOpenCodeProjects, getOpenCodeSessionsByEncodedName } from "../../../lib/opencode-projects";
import { getOpenCodeSessionLog } from "../../../lib/opencode-sessions";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";
import { logEntriesToEvents } from "./shared";

export async function listOpenCodeTranscriptMetadata(
  opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  const projectFilter = opts.projects ? new Set(opts.projects) : null;
  const sinceMs = opts.sinceMs ?? 0;
  const out: TranscriptMetadata[] = [];

  const projects = await getOpenCodeProjects();
  for (const project of projects) {
    const { cwd, sessions } = await getOpenCodeSessionsByEncodedName(project.name);
    const effectiveCwd = cwd ?? "";
    if (projectFilter && !projectFilter.has(effectiveCwd)) continue;
    for (const s of sessions) {
      const mtimeMs = s.lastModified.getTime();
      if (mtimeMs < sinceMs) continue;
      if (!s.sessionId) continue;
      out.push({
        cli: "opencode",
        projectName: project.name,
        sessionId: s.sessionId,
        transcriptPath: s.path,
        mtimeMs,
        sizeBytes: 0,
      });
    }
  }
  return out;
}

export async function streamOpenCodeEvents(meta: TranscriptMetadata): Promise<NormalizedToolEvent[]> {
  const log = await getOpenCodeSessionLog(meta.sessionId);
  if (!log) return [];
  return logEntriesToEvents(log.entries, {
    cli: "opencode",
    sessionId: meta.sessionId,
    transcriptPath: meta.transcriptPath,
    cwd: log.cwd ?? "",
  });
}
