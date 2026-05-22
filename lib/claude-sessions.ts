/**
 * Claude Code session transcript discovery helpers.
 *
 * Claude stores transcripts at:
 *   <CLAUDE_PROJECTS_PATH>/<encoded-cwd>/<sessionId>.jsonl
 *
 * Subagent transcripts (when a session spawned subagents) live alongside:
 *   <CLAUDE_PROJECTS_PATH>/<encoded-cwd>/<sessionId>/subagents/<agentId>.jsonl
 *
 * The parser for these files lives in `lib/log-entries.ts` (`parseLogContent`,
 * `parseSessionLog`). This module exposes discovery only — the audit pipeline
 * and any future Claude-specific tool walk the directory layout via these
 * helpers instead of re-implementing the path conventions.
 *
 * Mirrors the shape of `lib/cursor-sessions.ts` for parity across CLIs.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { getClaudeProjectsPath, decodeFolderName } from "./paths";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ClaudeProjectFolder {
  /** Encoded folder name on disk (e.g. "-home-user-project"). */
  name: string;
  /** Decoded filesystem path (e.g. "/home/user/project"). */
  cwd: string;
  /** Absolute path of the encoded folder. */
  path: string;
}

export interface ClaudeTranscriptFile {
  projectName: string;
  /** Decoded cwd of the project. */
  cwd: string;
  sessionId: string;
  /** Absolute path of `<sessionId>.jsonl`. */
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** True when this is a subagent transcript spawned from a parent session. */
  isSubagent: boolean;
}

/** Returns the Claude projects root, honoring the CLAUDE_PROJECTS_PATH env var. */
export function getClaudeProjectsRoot(): string {
  return getClaudeProjectsPath();
}

/** Lists all Claude project folders (one per encoded cwd). Returns [] if the
 *  projects root doesn't exist. Filenames that don't look like Claude project
 *  encodings are still included — encoding is permissive. */
export function listClaudeProjects(): ClaudeProjectFolder[] {
  const root = getClaudeProjectsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      cwd: decodeFolderName(e.name),
      path: join(root, e.name),
    }));
}

/** Lists every JSONL transcript under one Claude project folder, including
 *  subagent transcripts under `<sessionId>/subagents/`. Returns [] on missing
 *  or unreadable paths. */
export function listClaudeTranscripts(project: ClaudeProjectFolder): ClaudeTranscriptFile[] {
  const out: ClaudeTranscriptFile[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(project.path, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!UUID_RE.test(sessionId)) continue;
      const transcriptPath = join(project.path, entry.name);
      try {
        const s = statSync(transcriptPath);
        out.push({
          projectName: project.name,
          cwd: project.cwd,
          sessionId,
          transcriptPath,
          mtimeMs: s.mtimeMs,
          sizeBytes: s.size,
          isSubagent: false,
        });
      } catch {
        // unreadable — skip
      }
    } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
      // Subagent transcripts at <sessionId>/subagents/<agentId>.jsonl
      const subDir = join(project.path, entry.name, "subagents");
      if (!existsSync(subDir)) continue;
      let subEntries: import("node:fs").Dirent[];
      try {
        subEntries = readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isFile() || !sub.name.endsWith(".jsonl")) continue;
        const agentId = sub.name.slice(0, -".jsonl".length);
        const transcriptPath = join(subDir, sub.name);
        try {
          const s = statSync(transcriptPath);
          out.push({
            projectName: project.name,
            cwd: project.cwd,
            sessionId: agentId,
            transcriptPath,
            mtimeMs: s.mtimeMs,
            sizeBytes: s.size,
            isSubagent: true,
          });
        } catch {
          // unreadable — skip
        }
      }
    }
  }

  return out;
}

/** Convenience: locate one Claude transcript file by session ID across all
 *  project folders. Returns null if not found. */
export function findClaudeTranscript(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  for (const project of listClaudeProjects()) {
    const candidate = join(project.path, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
    // Subagent fallback
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(project.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const subCandidate = join(project.path, entry.name, "subagents", `${sessionId}.jsonl`);
      if (existsSync(subCandidate)) return subCandidate;
    }
  }
  return null;
}

/** For tests: list all session IDs across all projects. */
export function _listAllSessionIds(): string[] {
  const ids: string[] = [];
  for (const project of listClaudeProjects()) {
    for (const t of listClaudeTranscripts(project)) {
      ids.push(t.sessionId);
    }
  }
  return ids;
}

/** For tests: stat one transcript file. */
export function _statTranscript(path: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch {
    return null;
  }
}

/** Re-export for callers that want to construct paths from a basename. */
export { basename };
