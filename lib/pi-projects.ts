/**
 * Pi (pi-coding-agent) project discovery.
 *
 * Empirically verified against pi-coding-agent v0.72.1 (Phase 0.7 of plan):
 *
 *   • Session-state root: `~/.pi/agent/sessions/` (NOT `~/.pi/sessions/`).
 *   • Per-cwd subdirs are encoded with `/` → `-` and wrapped in `--…--`,
 *     e.g. `/home/u/repo` → `--home-u-repo--`. The encoding is LOSSY
 *     (literal `-` in the path is preserved as `-` and indistinguishable
 *     from a path separator), so we never use the dir name as the canonical
 *     cwd — we read the first JSONL record (`{type: "session", cwd, ...}`)
 *     to recover it exactly.
 *   • Per-session file: `<ISO-timestamp>_<UUID>.jsonl`, e.g.
 *     `2026-05-01T20-36-22-628Z_019de541-b7e3-7131-abac-d15df780042c.jsonl`.
 *   • File format: JSONL. First record always shape
 *     `{type: "session", version, id, timestamp, cwd}`.
 *
 * As with Cursor/Copilot, this module is intentionally permissive — a
 * missing `~/.pi/` returns `[]`, and a malformed JSONL falls open without
 * surfacing the session.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeFolderName } from "./paths";
import type { ProjectFolder, SessionFile } from "./projects";
import { runtimeCache } from "./runtime-cache";
import { batchAll } from "./concurrency";
import { formatDate } from "./format-date";
import { logWarn } from "./logger";

/** Filename pattern for a Pi session JSONL: `<iso-timestamp>_<uuid>.jsonl`. */
const SESSION_FILE_RE = /^[\d-]+T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function getPiSessionsRoot(): string {
  return process.env.PI_SESSIONS_DIR
    || join(homedir(), ".pi", "agent", "sessions");
}

interface PiSessionMeta {
  filePath: string;
  sessionId: string;
  cwd: string;
  fileMtime: Date;
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

/** Reads the first newline-terminated record of a Pi JSONL file and returns
 *  its `cwd` field. Returns null on read/parse failure or when the first
 *  record isn't `{type: "session"}`. */
async function readSessionCwd(filePath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const firstLine = text.indexOf("\n") >= 0 ? text.slice(0, text.indexOf("\n")) : text;
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    if (parsed.type !== "session") return null;
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) return null;
    return parsed.cwd;
  } catch {
    return null;
  }
}

async function scanPiSessions(): Promise<PiSessionMeta[]> {
  const root = getPiSessionsRoot();
  const cwdDirs = await safeReaddir(root);
  if (!cwdDirs) return [];

  const candidates: { sessionId: string; filePath: string }[] = [];
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const cwdPath = join(root, cwdDir.name);
    const sessionFiles = await safeReaddir(cwdPath);
    if (!sessionFiles) continue;
    for (const f of sessionFiles) {
      if (!f.isFile()) continue;
      const m = SESSION_FILE_RE.exec(f.name);
      if (!m) continue;
      candidates.push({ sessionId: m[1], filePath: join(cwdPath, f.name) });
    }
  }
  if (candidates.length === 0) return [];

  const settled = await batchAll(
    candidates.map((c) => async (): Promise<PiSessionMeta | null> => {
      const cwd = await readSessionCwd(c.filePath);
      if (!cwd) return null;
      const mtime = await statMtime(c.filePath);
      if (!mtime) return null;
      return {
        filePath: c.filePath,
        sessionId: c.sessionId,
        cwd,
        fileMtime: mtime,
      };
    }),
    16,
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<PiSessionMeta | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is PiSessionMeta => v !== null);
}

const cachedScan = runtimeCache(scanPiSessions, 30);

/** Returns one ProjectFolder per unique cwd discovered in Pi transcripts. */
export async function getPiProjects(): Promise<ProjectFolder[]> {
  let metas: PiSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Pi sessions:", error);
    return [];
  }

  const byCwd = new Map<string, { latest: Date; cwd: string }>();
  for (const m of metas) {
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
      cli: ["pi"],
    });
  }
  folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return folders;
}

function metasToSessionFiles(metas: PiSessionMeta[]): SessionFile[] {
  const files: SessionFile[] = metas.map((m) => ({
    name: m.sessionId,
    path: m.filePath,
    lastModified: m.fileMtime,
    lastModifiedFormatted: formatDate(m.fileMtime),
    sessionId: m.sessionId,
    cli: "pi",
  }));
  files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return files;
}

/** Returns SessionFile entries for every Pi transcript whose cwd matches `cwd` exactly. */
export async function getPiSessionsForCwd(cwd: string): Promise<SessionFile[]> {
  let metas: PiSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Pi sessions:", error);
    return [];
  }
  return metasToSessionFiles(metas.filter((m) => m.cwd === cwd));
}

export interface PiProjectByName {
  cwd: string | null;
  sessions: SessionFile[];
}

/**
 * Looks up Pi sessions for a project URL slug. `decodeFolderName` is lossy on
 * cwds containing `-`, so we re-encode each session's cwd via
 * `encodeFolderName` and match in that direction. Returns both the canonical
 * cwd and the matching sessions.
 */
export async function getPiSessionsByEncodedName(name: string): Promise<PiProjectByName> {
  let metas: PiSessionMeta[];
  try {
    metas = await cachedScan();
  } catch (error) {
    logWarn("Failed to scan Pi sessions:", error);
    return { cwd: null, sessions: [] };
  }
  const matches = metas.filter((m) => encodeFolderName(m.cwd) === name);
  // encodeFolderName is lossy — distinct cwd values can collapse to the same
  // encoded slug. Only return a canonical cwd when every match agrees;
  // otherwise drop the cwd and the (mixed) sessions to avoid surfacing the
  // wrong project label.
  const uniqueCwds = Array.from(new Set(matches.map((m) => m.cwd)));
  if (uniqueCwds.length !== 1) {
    return { cwd: null, sessions: [] };
  }
  return {
    cwd: uniqueCwds[0],
    sessions: metasToSessionFiles(matches),
  };
}

export const getCachedPiProjects = runtimeCache(getPiProjects, 30);
export const getCachedPiSessionsForCwd = runtimeCache(
  (cwd: string) => getPiSessionsForCwd(cwd),
  30,
  { maxSize: 50 },
);
export const getCachedPiSessionsByEncodedName = runtimeCache(
  (name: string) => getPiSessionsByEncodedName(name),
  30,
  { maxSize: 50 },
);
