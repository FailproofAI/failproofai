/**
 * Server-side helpers for reading Claude Agent SDK project folders and
 * session log files from the local filesystem.
 *
 * All functions return sorted arrays (newest-first) and pre-format dates
 * so that client components can display them without hydration mismatches.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getClaudeProjectsPath } from "./paths";
import { runtimeCache } from "./runtime-cache";
import { batchAll } from "./concurrency";
import { logWarn, logError } from "./logger";
import { formatDate } from "./format-date";

export const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const PATH_TRAVERSAL_RE = /(^|[\\/])\.\.($|[\\/])/;

export type ProjectCli = "claude" | "codex" | "copilot" | "cursor" | "opencode" | "pi" | "gemini" | "hermes";

export interface ProjectFolder {
  name: string;
  path: string;
  isDirectory: boolean;
  lastModified: Date;
  lastModifiedFormatted?: string; // Pre-formatted date string to avoid hydration issues
  /**
   * Which agent CLIs this project's data was found in. Multiple entries when
   * the same cwd has transcripts from more than one CLI; rendered as badges.
   */
  cli: ProjectCli[];
}

export interface SessionFile {
  name: string;
  path: string;
  lastModified: Date;
  lastModifiedFormatted?: string;
  sessionId?: string;
  /** Originating agent CLI. Set when the session list mixes sources from more
   *  than one CLI, so the table can render a per-row CLI badge. */
  cli?: ProjectCli;
  /** Gateway session metadata (Hermes only today): who drove it and where.
   *  Other CLIs leave these undefined; the list renders them only when present. */
  userId?: string;
  channelId?: string;
  channelType?: string; // e.g. "group" | "dm"
}

/** Stats a path and returns mtime. Falls back to epoch (1970-01-01) on error
 *  so that callers always get a valid Date for sorting without try/catch. */
async function getMtime(path: string, label: string): Promise<Date> {
  try {
    return (await stat(path)).mtime;
  } catch (error) {
    logWarn(`Failed to stat ${label}:`, error);
    return new Date(0);
  }
}

/** Reads a directory safely, returning [] if it doesn't exist. */
async function safeReaddir(dirPath: string) {
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) return null;
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function getClaudeProjectFolders(): Promise<ProjectFolder[]> {
  try {
    const projectsPath = getClaudeProjectsPath();
    const entries = await safeReaddir(projectsPath);
    if (!entries) return [];

    const settled = await batchAll(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => async () => {
          const folderPath = join(projectsPath, entry.name);
          const mtime = await getMtime(folderPath, entry.name);
          return {
            name: entry.name,
            path: folderPath,
            isDirectory: true,
            lastModified: mtime,
            lastModifiedFormatted: formatDate(mtime),
            cli: ["claude"],
          } as ProjectFolder;
        }),
      16,
    );
    const folders = settled
      .filter((r): r is PromiseFulfilledResult<ProjectFolder> => r.status === "fulfilled")
      .map((r) => r.value);

    folders.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return folders;
  } catch (error) {
    logError("Error reading Claude project folders:", error);
    return [];
  }
}

/** Merges any number of per-CLI project lists by encoded folder name. When
 *  multiple sources share a name, the first source's `path` wins (so the Path
 *  column still points at the primary store), the `cli` arrays are unioned in
 *  source order, and `lastModified` takes the newest value. The first source
 *  is treated as the "base" — pass Claude first to keep Claude paths primary. */
function mergeProjectFolders(...sources: ProjectFolder[][]): ProjectFolder[] {
  const byName = new Map<string, ProjectFolder>();
  for (const list of sources) {
    for (const f of list) {
      const existing = byName.get(f.name);
      if (!existing) {
        byName.set(f.name, { ...f, cli: [...f.cli] });
        continue;
      }
      const mergedCli: ProjectCli[] = [...existing.cli];
      for (const c of f.cli) if (!mergedCli.includes(c)) mergedCli.push(c);
      const newer = f.lastModified.getTime() > existing.lastModified.getTime() ? f : existing;
      byName.set(f.name, {
        ...existing,
        cli: mergedCli,
        lastModified: newer.lastModified,
        lastModifiedFormatted: newer.lastModifiedFormatted,
      });
    }
  }
  const merged = Array.from(byName.values());
  merged.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return merged;
}

export async function getProjectFolders(): Promise<ProjectFolder[]> {
  // Lazy imports keep the per-CLI project providers out of the dep graph for
  // callers that only need Claude helpers (e.g. CLI codepaths).
  const [
    { getCodexProjects },
    { getCopilotProjects },
    { getCursorProjects },
    { getOpenCodeProjects },
    { getPiProjects },
    { getGeminiProjects },
    { getHermesProjects },
  ] = await Promise.all([
    import("./codex-projects"),
    import("./copilot-projects"),
    import("./cursor-projects"),
    import("./opencode-projects"),
    import("./pi-projects"),
    import("./gemini-projects"),
    import("./hermes-projects"),
  ]);
  const [claude, codex, copilot, cursor, opencode, pi, gemini, hermes] = await Promise.all([
    getClaudeProjectFolders(),
    getCodexProjects().catch((error) => {
      logError("Error reading Codex projects:", error);
      return [] as ProjectFolder[];
    }),
    getCopilotProjects().catch((error) => {
      logError("Error reading Copilot projects:", error);
      return [] as ProjectFolder[];
    }),
    getCursorProjects().catch((error) => {
      logError("Error reading Cursor projects:", error);
      return [] as ProjectFolder[];
    }),
    getOpenCodeProjects().catch((error) => {
      logError("Error reading OpenCode projects:", error);
      return [] as ProjectFolder[];
    }),
    getPiProjects().catch((error) => {
      logError("Error reading Pi projects:", error);
      return [] as ProjectFolder[];
    }),
    getGeminiProjects().catch((error) => {
      logError("Error reading Gemini projects:", error);
      return [] as ProjectFolder[];
    }),
    getHermesProjects().catch((error) => {
      logError("Error reading Hermes projects:", error);
      return [] as ProjectFolder[];
    }),
  ]);
  return mergeProjectFolders(claude, codex, copilot, cursor, opencode, pi, gemini, hermes);
}

/**
 * Gets the full path to a specific project folder
 * @param projectName - Name of the project folder
 * @returns Full path to the project folder
 */
export function getProjectPath(projectName: string): string {
  const projectsPath = getClaudeProjectsPath();
  return join(projectsPath, projectName);
}

/**
 * Resolves a project name to its absolute path, verifying it stays under
 * the Claude projects root. Throws RangeError for any invalid or escaping input.
 * Callers should catch RangeError and return 400/404 as appropriate.
 */
export function resolveProjectPath(projectName: string): string {
  if (!projectName) throw new RangeError("Empty project name");
  // Reject absolute paths before joining (catches /etc, \Windows, etc.)
  if (/^[/\\]/.test(projectName)) throw new RangeError("Absolute project name");
  const projectsPath = resolve(getClaudeProjectsPath());
  const candidate = resolve(join(projectsPath, projectName));
  // Must be strictly under the root (not equal — projects are subdirs)
  if (!candidate.startsWith(projectsPath + sep)) {
    throw new RangeError("Project path escapes root");
  }
  return candidate;
}

/**
 * Resolves a session file path, validating both project name and session ID.
 * Throws RangeError for invalid inputs (caught by callers for 400/404).
 */
export function resolveSessionFilePath(projectName: string, sessionId: string): string {
  if (!UUID_RE.test(sessionId)) throw new RangeError("Invalid session ID");
  const projectDir = resolveProjectPath(projectName);
  return join(projectDir, `${sessionId}.jsonl`);
}

/**
 * Extracts session ID (UUID) from a filename
 * @param filename - File name to extract session ID from
 * @returns Extracted session ID or undefined if not found
 */
export function extractSessionId(filename: string): string | undefined {
  // Claude session files are named <uuid>.jsonl — extract the UUID portion
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = filename.match(uuidPattern);
  return match ? match[0] : undefined;
}

export async function getSessionFiles(projectPath: string): Promise<SessionFile[]> {
  try {
    const entries = await safeReaddir(projectPath);
    if (!entries) return [];

    const jsonlEntries = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl") && extractSessionId(entry.name)
    );

    const settled = await batchAll(
      jsonlEntries.map((entry) => async () => {
        const filePath = join(projectPath, entry.name);
        const mtime = await getMtime(filePath, entry.name);
        return {
          name: entry.name,
          path: filePath,
          lastModified: mtime,
          lastModifiedFormatted: formatDate(mtime),
          sessionId: extractSessionId(entry.name),
          cli: "claude",
        } as SessionFile;
      }),
      16,
    );
    const files = settled
      .filter((r): r is PromiseFulfilledResult<SessionFile> => r.status === "fulfilled")
      .map((r) => r.value);

    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return files;
  } catch (error) {
    logError("Error reading session files:", error);
    return [];
  }
}

export const getCachedProjectFolders = runtimeCache(getProjectFolders, 30);

export const getCachedSessionFiles = runtimeCache(
  (projectPath: string) => getSessionFiles(projectPath),
  30
);
