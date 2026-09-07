/**
 * Claude Code session transcript discovery helpers.
 *
 * Claude stores transcripts at:
 *   <CLAUDE_PROJECTS_PATH>/<encoded-cwd>/<sessionId>.jsonl
 *
 * Subagent transcripts (when a session spawned subagents) live alongside, in two
 * shapes — a direct child, and one nested per workflow run:
 *   <CLAUDE_PROJECTS_PATH>/<encoded-cwd>/<sessionId>/subagents/<agentId>.jsonl
 *   <CLAUDE_PROJECTS_PATH>/<encoded-cwd>/<sessionId>/subagents/workflows/<runId>/<agentId>.jsonl
 *
 * Everything below `subagents/` is walked to a bounded depth rather than one
 * level, because the second shape arrived after this module was written and the
 * miss was most of the corpus. See `collectSubagentTranscripts`.
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
/**
 * Depth of nesting allowed below `subagents/`.
 *
 * The two shapes that exist today need 0 and 2 (`<agent>.jsonl` and
 * `workflows/<runId>/<agent>.jsonl`). The cap is here so an unexpected layout —
 * or a symlink cycle a future Claude build introduces — costs a bounded walk
 * rather than an audit that never returns, and it is deliberately loose enough
 * that a third shape lands inside it without another release.
 */
const MAX_SUBAGENT_DEPTH = 5;

/**
 * Collect every `.jsonl` beneath a session's `subagents/` directory.
 *
 * This used to read only the DIRECT children of `subagents/`, which was correct
 * for the layout Claude shipped when it was written and silently wrong the day
 * workflow runs started nesting their agents one level further down. On a
 * machine that uses them the miss is most of the corpus: 1,839 transcripts on
 * disk, 1,741 under `subagents/`, and 1,679 of those inside
 * `subagents/workflows/<runId>/` — so the audit was walking 160 files, 8.7% of
 * the evidence, and reporting the result as though it had read everything.
 *
 * ## Session ids come from the relative path, not the basename
 *
 * Every workflow run writes a `journal.jsonl` beside its agents, so basenames
 * are NOT unique below this directory — 1,741 files share 1,613 distinct names
 * on the machine this was found on. A basename id would collide those 128 files
 * onto ~one row each, and `sessionId` is what the cache, the per-session
 * detector state and the example attribution are keyed by, so the collision
 * would silently merge unrelated sessions rather than fail.
 *
 * Nor is the path below `subagents/` unique on its own. A workflow run id is
 * reused when its session is resumed, so `wf_3d609e92-a38/journal.jsonl` exists
 * under two different parent sessions in the same project — found by asserting
 * uniqueness over the real corpus, not by reasoning about it.
 *
 * The id is therefore the PARENT SESSION id followed by the path relative to
 * `subagents/`, minus the extension, joined with `__`:
 * `<parentUuid>__workflows__wf_123__agent-abc`. That is a filesystem path
 * within the project, so it is unique by construction rather than by argument,
 * and it names the session the subagent belongs to. `__` is safe as the joiner
 * because no id Claude generates contains one — verified against 1,741 real
 * files, zero hits. Top-level session ids are untouched.
 *
 * Symlinks are not followed. Nothing in the layout uses them, and following one
 * is how a directory walk turns into an infinite loop.
 */
function collectSubagentTranscripts(
  dir: string,
  relPrefix: string,
  project: ClaudeProjectFolder,
  out: ClaudeTranscriptFile[],
  depth: number,
): void {
  if (depth > MAX_SUBAGENT_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectSubagentTranscripts(
        join(dir, entry.name),
        relPrefix ? `${relPrefix}__${entry.name}` : entry.name,
        project,
        out,
        depth + 1,
      );
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stem = entry.name.slice(0, -".jsonl".length);
    const transcriptPath = join(dir, entry.name);
    try {
      const s = statSync(transcriptPath);
      out.push({
        projectName: project.name,
        cwd: project.cwd,
        sessionId: relPrefix ? `${relPrefix}__${stem}` : stem,
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
      const subDir = join(project.path, entry.name, "subagents");
      if (!existsSync(subDir)) continue;
      collectSubagentTranscripts(subDir, entry.name, project, out, 0);
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
