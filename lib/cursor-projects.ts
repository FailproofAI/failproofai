/**
 * Cursor Agent CLI project discovery.
 *
 * Cursor stores per-session state under `~/.cursor/` (configurable via
 * CURSOR_HOME). The exact subdirectory layout is not yet documented in
 * cursor.com/docs/hooks; we probe the candidates Cursor has historically
 * shipped (`agent-sessions/`, `conversations/`, `sessions/`) so this works
 * across installs without a hard-coded version pin. Every candidate is a
 * tolerant `safeReaddir` — a missing directory yields `[]`, never an
 * exception.
 *
 * Each session directory is expected to contain at minimum a metadata file
 * carrying the session's `cwd`. When a JSONL transcript is also present we
 * surface the session under `/projects` keyed by encoded cwd so multiple
 * stores naturally merge in `lib/projects.ts`.
 *
 * Refs: https://cursor.com/docs/hooks (env: CURSOR_PROJECT_DIR,
 * CURSOR_TRANSCRIPT_PATH; transcript format intentionally unspecified).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeFolderName, encodeFolderName } from "./paths";
import type { ProjectFolder, SessionFile } from "./projects";
import { runtimeCache } from "./runtime-cache";
import { batchAll } from "./concurrency";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Legacy subdirectories under `~/.cursor/` that may carry per-session state
 *  (cursor-agent ≤ 2026-04 ish — kept as a fallback). */
const LEGACY_SESSION_ROOT_CANDIDATES = ["agent-sessions", "conversations", "sessions"] as const;

/** Legacy filenames that may carry session-level metadata (cwd, model, …). */
const META_FILE_CANDIDATES = ["meta.json", "session.json", "workspace.json", "workspace.yaml"] as const;

/** Legacy filenames that may carry the JSONL transcript. */
const LEGACY_TRANSCRIPT_FILE_CANDIDATES = ["events.jsonl", "transcript.jsonl", "messages.jsonl"] as const;

/** New (2026-04+) layout: `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl`. */
const NEW_PROJECTS_DIR = "projects";
const NEW_AGENT_TRANSCRIPTS_DIR = "agent-transcripts";

function getCursorHome(): string {
  return process.env.CURSOR_HOME || join(homedir(), ".cursor");
}

interface CursorSessionMeta {
  metaPath: string;
  transcriptPath: string | null;
  sessionId: string;
  cwd: string;
  fileMtime: Date;
  hasTranscript: boolean;
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function statMtime(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}

/** Parse a flat scalar for `cwd` from JSON-or-YAML metadata. Tries `JSON.parse`
 *  first so escape sequences in JSON strings (e.g. Windows `C:\\Users\\...`) are
 *  decoded, then falls back to a permissive YAML-ish regex when the file isn't
 *  valid JSON. Tolerant on purpose: Cursor's metadata format is unspecified. */
function parseCwdFromMetaText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { cwd?: unknown };
    if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) return parsed.cwd;
  } catch {
    // Not JSON — fall through to the YAML-ish parser.
  }
  // YAML shape: `cwd: /path` (optionally quoted).
  const yaml = text.match(/^\s*cwd\s*:\s*(.+?)\s*$/m);
  if (yaml) {
    const stripped = yaml[1].replace(/^['"]|['"]$/g, "");
    if (stripped.length > 0) return stripped;
  }
  return undefined;
}

/** Try each candidate under `dir`; for metadata files we keep probing until one
 *  yields a usable `cwd` (a stale `meta.json` shouldn't shadow a valid
 *  `workspace.yaml`). Returns `{path, cwd}` for the first usable file, or null. */
async function findFirstUsableMeta(
  dir: string,
  candidates: readonly string[],
): Promise<{ path: string; cwd: string } | null> {
  for (const name of candidates) {
    const path = join(dir, name);
    if ((await statMtime(path)) === null) continue;
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const cwd = parseCwdFromMetaText(text);
    if (cwd) return { path, cwd };
  }
  return null;
}

/** First existing path from `candidates` under `dir`. Used for transcript files
 *  where existence is the only check we can perform without parsing JSONL. */
async function findFirstExistingPath(dir: string, candidates: readonly string[]): Promise<string | null> {
  for (const name of candidates) {
    const path = join(dir, name);
    if ((await statMtime(path)) !== null) return path;
  }
  return null;
}

async function scanCursorSessions(): Promise<CursorSessionMeta[]> {
  const home = getCursorHome();
  const newCandidates: { sessionId: string; dir: string; cwd: string }[] = [];
  const legacyCandidates: { sessionId: string; dir: string }[] = [];

  // New layout: ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
  // Cursor's project-folder encoding drops the leading slash (e.g.
  // `home-u-repo` decodes to `/home/u/repo`, not `home/u/repo`). Re-add the
  // leading slash for non-Windows-drive-letter results so the cwd is absolute.
  const projectsRoot = join(home, NEW_PROJECTS_DIR);
  const projectEntries = await safeReaddir(projectsRoot);
  if (projectEntries) {
    for (const proj of projectEntries) {
      if (!proj.isDirectory()) continue;
      const decoded = decodeFolderName(proj.name);
      const cwd = decoded.startsWith("/") || /^[A-Za-z]:\//.test(decoded) ? decoded : `/${decoded}`;
      const transcriptsRoot = join(projectsRoot, proj.name, NEW_AGENT_TRANSCRIPTS_DIR);
      const sessionDirs = await safeReaddir(transcriptsRoot);
      if (!sessionDirs) continue;
      for (const sd of sessionDirs) {
        if (!sd.isDirectory()) continue;
        newCandidates.push({
          sessionId: sd.name,
          dir: join(transcriptsRoot, sd.name),
          cwd,
        });
      }
    }
  }

  // Legacy layout: ~/.cursor/{agent-sessions,conversations,sessions}/<sessionId>/
  for (const sub of LEGACY_SESSION_ROOT_CANDIDATES) {
    const root = join(home, sub);
    const entries = await safeReaddir(root);
    if (!entries) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      legacyCandidates.push({ sessionId: e.name, dir: join(root, e.name) });
    }
  }

  if (newCandidates.length === 0 && legacyCandidates.length === 0) return [];

  const settled = await batchAll(
    [
      ...newCandidates.map((c) => async (): Promise<CursorSessionMeta | null> => {
        // Transcript file is `<sessionId>.jsonl` inside the dir.
        const transcriptPath = join(c.dir, `${c.sessionId}.jsonl`);
        const transcriptMtime = await statMtime(transcriptPath);
        if (!transcriptMtime) return null;
        return {
          metaPath: c.dir, // No separate meta file; cwd is decoded from the parent dir name.
          transcriptPath,
          sessionId: c.sessionId,
          cwd: c.cwd,
          fileMtime: transcriptMtime,
          hasTranscript: true,
        };
      }),
      ...legacyCandidates.map((c) => async (): Promise<CursorSessionMeta | null> => {
        const meta = await findFirstUsableMeta(c.dir, META_FILE_CANDIDATES);
        if (!meta) return null;
        const transcriptPath = await findFirstExistingPath(c.dir, LEGACY_TRANSCRIPT_FILE_CANDIDATES);
        const transcriptMtime = transcriptPath ? await statMtime(transcriptPath) : null;
        const metaMtime = await statMtime(meta.path);
        const fileMtime =
          transcriptMtime && metaMtime
            ? new Date(Math.max(transcriptMtime.getTime(), metaMtime.getTime()))
            : transcriptMtime ?? metaMtime ?? new Date(0);
        return {
          metaPath: meta.path,
          transcriptPath,
          sessionId: c.sessionId,
          cwd: meta.cwd,
          fileMtime,
          hasTranscript: transcriptPath !== null,
        };
      }),
    ],
    16,
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<CursorSessionMeta | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is CursorSessionMeta => v !== null);
}

const cachedScan = runtimeCache(scanCursorSessions, 30);

/** Returns one ProjectFolder per unique cwd discovered in Cursor transcripts. */
export async function getCursorProjects(): Promise<ProjectFolder[]> {
  let metas: CursorSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Cursor sessions:", error);
    return [];
  }

  // Skip metadata-only sessions whose `/projects` row would click through to an
  // empty session list (metasToSessionFiles also filters on hasTranscript).
  const byCwd = new Map<string, { latest: Date; cwd: string }>();
  for (const m of metas) {
    if (!m.hasTranscript) continue;
    const existing = byCwd.get(m.cwd);
    if (!existing || m.fileMtime.getTime() > existing.latest.getTime()) {
      byCwd.set(m.cwd, { latest: m.fileMtime, cwd: m.cwd });
    }
  }

  const folders: ProjectFolder[] = [];
  for (const { cwd, latest } of byCwd.values()) {
    folders.push({
      name: encodeFolderName(cwd),
      path: cwd,
      isDirectory: true,
      lastModified: latest,
      lastModifiedFormatted: formatDate(latest),
      cli: ["cursor"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

function metasToSessionFiles(metas: CursorSessionMeta[]): SessionFile[] {
  const files: SessionFile[] = metas
    .filter((m) => m.hasTranscript && m.transcriptPath)
    .map((m) => ({
      name: m.sessionId,
      path: m.transcriptPath!,
      lastModified: m.fileMtime,
      lastModifiedFormatted: formatDate(m.fileMtime),
      sessionId: m.sessionId,
      cli: "cursor",
    }));
  files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return files;
}

/** Returns SessionFile entries for every Cursor transcript whose cwd matches `cwd` exactly. */
export async function getCursorSessionsForCwd(cwd: string): Promise<SessionFile[]> {
  let metas: CursorSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Cursor sessions:", error);
    return [];
  }
  return metasToSessionFiles(metas.filter((m) => m.cwd === cwd));
}

export interface CursorProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Looks up Cursor sessions for a project URL slug. `decodeFolderName` is lossy,
 * so we re-encode each session's cwd and match in that direction. Returns both
 * the canonical cwd and the matching sessions.
 */
export async function getCursorSessionsByEncodedName(name: string): Promise<CursorProjectByName> {
  let metas: CursorSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Cursor sessions:", error);
    return { cwd: null, sessions: [] };
  }
  const matches = metas.filter((m) => m.hasTranscript && encodeFolderName(m.cwd) === name);
  return {
    cwd: matches[0]?.cwd ?? null,
    sessions: metasToSessionFiles(matches),
  };
}

export const getCachedCursorProjects = runtimeCache(getCursorProjects, 30);
export const getCachedCursorSessionsForCwd = runtimeCache(
  (cwd: string) => getCursorSessionsForCwd(cwd),
  30,
  { maxSize: 50 },
);
export const getCachedCursorSessionsByEncodedName = runtimeCache(
  (name: string) => getCursorSessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
