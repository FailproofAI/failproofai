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
import { readFileSync } from "node:fs";

/** Where Claude Code looks for the managed (enterprise) settings file. */
export const CLAUDE_MANAGED_SETTINGS_PATHS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  linux: "/etc/claude-code/managed-settings.json",
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
};

/** The settings files that can decide `disableAllHooks`, highest precedence first. */
export function claudeSettingsLayersByPrecedence(
  scopes: { user: string; project: string; local: string },
  platform: NodeJS.Platform = process.platform,
): string[] {
  const managed = CLAUDE_MANAGED_SETTINGS_PATHS[platform];
  return [...(managed ? [managed] : []), scopes.local, scopes.project, scopes.user];
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
