/**
 * Per-CLI cwd resolver.
 *
 * Most CLIs send `cwd` as a top-level string on the hook stdin payload, so
 * the default branch is a simple passthrough. Cursor is the exception.
 *
 *   • Cursor Agent CLI: per https://cursor.com/docs/hooks, only the
 *     tool-execution hooks (`preToolUse`, `postToolUse`) include `cwd` at
 *     the top level. Session-lifecycle and prompt events (`sessionStart`,
 *     `sessionEnd`, `beforeSubmitPrompt`, `stop`) carry
 *     `workspace_roots: string[]` instead. Without this fallback, Cursor
 *     non-tool events land in the activity store with `cwd: undefined`,
 *     the dashboard renders an em-dash, and `readMergedHooksConfig(cwd)` /
 *     `loadAllCustomHooks({ sessionCwd })` skip project-scope discovery.
 *
 *   • Claude / Codex / Copilot / Pi / OpenCode: stdin's top-level
 *     `cwd` is reliable for every event; passthrough.
 *
 * Mirrors the dispatch pattern of `resolve-permission-mode.ts` and
 * `resolve-transcript-path.ts`.
 */
import type { IntegrationType } from "./types";

export function resolveCwd(
  integration: IntegrationType,
  parsed: Record<string, unknown>,
): string | undefined {
  const direct = typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  if (direct) return direct;

  if (integration === "cursor") {
    const wr = parsed.workspace_roots;
    if (Array.isArray(wr) && typeof wr[0] === "string" && wr[0].length > 0) {
      return wr[0];
    }
  }

  return undefined;
}
