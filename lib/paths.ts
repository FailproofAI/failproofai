/**
 * OS-aware path resolution for the `.claude/projects` directory.
 *
 * Supports an optional `CLAUDE_PROJECTS_PATH` environment variable
 * override; otherwise defaults to `~/.claude/projects` on all platforms.
 */
import { homedir } from "os";
import { join } from "path";

export function getDefaultClaudeProjectsPath(): string {
  // ~/.claude/projects on all platforms (including Windows)
  return join(homedir(), ".claude", "projects");
}

/**
 * Decodes a Claude project folder name back to its original filesystem path.
 *
 * Claude encodes project paths by replacing path separators with `-`.
 * On Windows, `C:/code/project` becomes `C--code-project` (`:` → `-`, `/` → `-`).
 * On Linux/macOS, `/home/user/project` becomes `-home-user-project`.
 *
 * This function reverses that encoding.
 */
export function decodeFolderName(name: string): string {
  // Windows drive-letter pattern: "C--rest-of-path"
  if (/^[A-Za-z]--/.test(name)) {
    return name[0] + ":/" + name.slice(3).replace(/-/g, "/");
  }
  return name.replace(/-/g, "/");
}

/**
 * Synthetic project path for gateway CLIs with no working directory —
 * `hermes:<profile>:<source>`, `openclaw:<channel>`. Two or more leading letters
 * so a Windows drive letter (`c:/code`) can never match.
 */
const SYNTHETIC_PROJECT_PATH = /^[a-z]{2,}:/;

/**
 * Whether a project `path` is a synthetic gateway path rather than a real
 * filesystem path — `hermes:<profile>:<source>`, `openclaw:<agent>:<channel>`.
 *
 * These are the only projects with a meaningful segment hierarchy, so this is
 * also what decides which rows the projects panel renders as a folder tree.
 */
export function isSyntheticProjectPath(path?: string): boolean {
  return !!path && SYNTHETIC_PROJECT_PATH.test(path);
}

/** Segments of a synthetic gateway path, outermost first. `[]` for real paths. */
export function syntheticPathSegments(path?: string): string[] {
  return isSyntheticProjectPath(path) ? path!.split(":") : [];
}

/**
 * Label to display for a project card.
 *
 * Filesystem-backed projects decode their folder name. Gateway projects must
 * NOT: `decodeFolderName` turns every `-` into `/`, which splits a Hermes
 * profile named `my-bot` into `my/bot`. Their `path` already carries the
 * segments explicitly, so use it.
 */
export function projectDisplayName(name: string, path?: string): string {
  if (isSyntheticProjectPath(path)) return path!.replace(/:/g, "/");
  return decodeFolderName(name);
}

/**
 * Encodes a filesystem path into a Claude-compatible project folder name.
 * Inverse of `decodeFolderName`.
 */
export function encodeFolderName(path: string): string {
  // Windows drive-letter pattern: "C:/code/project" → "C--code-project"
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (driveMatch) {
    return driveMatch[1] + "--" + driveMatch[2].replace(/[\\/]/g, "-");
  }
  return path.replace(/[\\/]/g, "-");
}

export function getClaudeProjectsPath(): string {
  // Check if path is provided via environment variable
  const envPath = process.env.CLAUDE_PROJECTS_PATH;
  
  if (envPath) {
    return envPath;
  }
  
  return getDefaultClaudeProjectsPath();
}

