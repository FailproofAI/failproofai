/**
 * Per-CLI permission mode resolver.
 *
 *   • Claude Code: reads `permission_mode` directly from the hook stdin payload.
 *     Possible values per `claude --help`: acceptEdits, auto, bypassPermissions,
 *     default, dontAsk, plan.
 *
 *   • Codex: stdin doesn't carry the permission mode. We walk
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/<file containing sessionId>.jsonl
 *     looking for a `turn_context` record whose payload has `approval_policy`,
 *     and map: never → full-auto, on-request → default. Other values pass
 *     through. If the transcript can't be read, falls back to "default".
 *
 *     Transcript discovery (cache → today/yesterday → full tree scan) lives
 *     in `lib/codex-sessions.ts` and is shared with the dashboard's Codex
 *     session viewer.
 *
 *   • GitHub Copilot CLI: no documented permission-mode equivalent on the
 *     hook payload today; falls back to "default". Revisit when Copilot's
 *     hook protocol exposes one.
 *
 *   • Cursor Agent CLI: no permission-mode field in the hook payload (Cursor's
 *     `loop_limit` is per-hook, not per-session). Falls back to "default" via
 *     the same final branch as Copilot.
 *
 *   • OpenCode: the plugin shim (.opencode/plugins/failproofai.mjs) does not
 *     receive any permission-mode signal from opencode and does not include
 *     one in the JSON it pipes to the failproofai binary. Falls back to
 *     "default" via the same final branch as Copilot/Cursor.
 *
 *   • Pi (pi-coding-agent): no permission-mode concept in the extension API;
 *     `tool_call` handlers always run with the same authority. Falls back to
 *     "default" via the same final branch as Copilot/Cursor.
 *
 */
import { readFileSync } from "node:fs";
import { findCodexTranscript } from "../../lib/codex-sessions";
import type { IntegrationType } from "./types";

export function resolvePermissionMode(
  integration: IntegrationType,
  parsed: Record<string, unknown>,
  sessionId: string | undefined,
): string {
  if (integration === "claude") {
    return (parsed.permission_mode as string | undefined) ?? "default";
  }

  if (integration === "codex" && sessionId) {
    return resolveCodexMode(sessionId) ?? "default";
  }

  // copilot, cursor, opencode, pi, unknown integrations, or codex without a sessionId
  return "default";
}

function resolveCodexMode(sessionId: string): string | undefined {
  try {
    const path = findCodexTranscript(sessionId);
    if (!path) return undefined;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.includes("turn_context")) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "turn_context") {
          const policy = (obj.payload as Record<string, unknown> | undefined)?.approval_policy as
            | string
            | undefined;
          if (policy === "never") return "full-auto";
          if (policy === "on-request") return "default";
          if (policy) return policy;
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // file vanished or permission denied — fall through to undefined
  }
  return undefined;
}
