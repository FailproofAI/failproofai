/**
 * Whether Claude Code's `disableAllHooks` is switching failproofai's hooks off.
 *
 * Claude Code reads ONE value of the key: the one left after settings precedence
 * (managed, then local, then project, then user). So a `true` in a project's
 * `.claude/settings.local.json` turns off hooks installed in
 * `~/.claude/settings.json`, and a running session picks the change up from its
 * settings file watcher. Nothing in failproofai read the key, so a machine whose
 * agent had set it — the cheapest way for a prompt-injected agent to switch its
 * own enforcement off — still reported itself as enforcing.
 *
 * Pure apart from the reads, which go through a seam: `config --status` passes
 * the real files, tests pass their own.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Where Claude Code looks for the managed (enterprise) settings file. It no
 * longer reads the old Windows location, `C:\ProgramData\ClaudeCode`.
 */
export const CLAUDE_MANAGED_SETTINGS_PATHS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "/etc/claude-code/managed-settings.json",
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
};

/** The settings files that can decide `disableAllHooks`, highest precedence first. */
export function claudeSettingsLayersByPrecedence(
  scopes: { user: string; project: string; local: string | readonly string[] },
  managed: string | undefined = CLAUDE_MANAGED_SETTINGS_PATHS[process.platform],
): string[] {
  const local = typeof scopes.local === "string" ? [scopes.local] : scopes.local;
  return [...(managed ? [managed] : []), ...local, scopes.project, scopes.user];
}

/** The nearest directory at or above `cwd` holding a `.git` (a worktree's is a file). */
function gitRepositoryRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 256; depth++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Whether the repository root, its `.git` and its `.claude` (where present) are the user's own. */
function ownedByCurrentUser(root: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return [root, join(root, ".git"), join(root, ".claude")].every((path) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat === undefined || stat.uid === uid;
  });
}

/**
 * Where Claude Code reads a project's `settings.local.json`, current place
 * first. Since v2.1.211 a session started in a subdirectory of a git
 * repository keeps it at the repository root — except outside a repository,
 * when that root is the home directory, on Windows, or when the root, its
 * `.git` or its `.claude` is not the user's — and it still reads one an older
 * version left in the starting directory.
 */
export function claudeLocalSettingsPaths(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const here = join(resolve(cwd), ".claude", "settings.local.json");
  if (platform === "win32") return [here];
  const root = gitRepositoryRoot(cwd);
  if (root === null || root === resolve(home) || !ownedByCurrentUser(root)) return [here];
  const atRoot = join(root, ".claude", "settings.local.json");
  return atRoot === here ? [here] : [atRoot, here];
}

/**
 * The settings file whose `"disableAllHooks": true` is in effect, or null.
 *
 * The first layer that sets the key as a boolean decides, as in Claude Code: a
 * `false` higher up wins over a `true` below it. A file that is missing or does
 * not parse is skipped, which is what Claude Code does with it too.
 */
export function claudeHooksSwitchedOffBy(
  layers: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  // Two scopes resolve to one file when run from the home directory.
  for (const path of new Set(layers)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read(path));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const value = (parsed as Record<string, unknown>).disableAllHooks;
    if (typeof value !== "boolean") continue;
    return value ? path : null;
  }
  return null;
}
