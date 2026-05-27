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
 *   • Claude / Codex / Copilot / Gemini / Pi / OpenCode: stdin's top-level
 *     `cwd` is reliable for every event; passthrough.
 *
 * Mirrors the dispatch pattern of `resolve-permission-mode.ts` and
 * `resolve-transcript-path.ts`.
 */
import { isAbsolute, normalize } from "node:path";
import type { IntegrationType } from "./types";

/** Validate that a cwd value is a plausible absolute path.
 *  Rejects relative paths, empty strings, and paths with null bytes. */
function isValidCwd(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0")) return false;
  return isAbsolute(normalize(value));
}

export function resolveCwd(
  integration: IntegrationType,
  parsed: Record<string, unknown>,
): string | undefined {
  const direct = typeof parsed.cwd === "string" && isValidCwd(parsed.cwd) ? parsed.cwd : undefined;
  if (direct) return direct;

  if (integration === "cursor") {
    const wr = parsed.workspace_roots;
    if (Array.isArray(wr) && typeof wr[0] === "string" && isValidCwd(wr[0])) {
      return wr[0];
    }
  }

  return undefined;
}
