/**
 * Per-CLI transcript-path resolver.
 *
 *   • Claude Code: `transcript_path` arrives on the hook stdin payload —
 *     passthrough.
 *
 *   • Codex: stdin doesn't carry transcript_path. Discover via
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/<file containing sessionId>.jsonl.
 *
 *   • Copilot: stdin doesn't carry transcript_path. Discover at
 *     ~/.copilot/session-state/<sessionId>/events.jsonl.
 *
 *   • Cursor: stdin doesn't carry transcript_path. Discover under
 *     ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 *     (with legacy fallbacks).
 *
 *   • OpenCode: transcripts live in SQLite at
 *     ~/.local/share/opencode/opencode.db, not on disk. Synthesize an
 *     `opencode-db://<sessionId>` marker so the dashboard renders something
 *     meaningful and the value is distinguishable from a genuine miss.
 *
 *   • Pi: shim doesn't forward transcript_path. Discover at
 *     ~/.pi/agent/sessions/<encodedCwd>/<isoTimestamp>_<sessionId>.jsonl.
 *
 *   • Gemini: docs say stdin carries transcript_path, but coverage is uneven
 *     across versions. Trust stdin first; fall back to discovery under
 *     ~/.gemini/tmp/<projectHash>/chats/<sessionId>.json.
 *
 * Mirrors the dispatch pattern of `resolve-permission-mode.ts`. Each
 * `find*Transcript` helper performs its own existsSync + path-traversal
 * containment check, so passing in a malformed sessionId is safe (returns
 * null → undefined).
 */
import { findCodexTranscript } from "../../lib/codex-sessions";
import { findCopilotTranscript } from "../../lib/copilot-sessions";
import { findCursorTranscript } from "../../lib/cursor-sessions";
import { findPiTranscript } from "../../lib/pi-sessions";
import { findGeminiTranscript } from "../../lib/gemini-sessions";
import type { IntegrationType } from "./types";

export function resolveTranscriptPath(
  integration: IntegrationType,
  parsed: Record<string, unknown>,
  sessionId: string | undefined,
): string | undefined {
  const stdinPath =
    typeof parsed.transcript_path === "string" ? parsed.transcript_path : undefined;
  if (stdinPath) return stdinPath;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;

  switch (integration) {
    case "claude":
      return undefined;
    case "codex":
      return findCodexTranscript(sessionId) ?? undefined;
    case "copilot":
      return findCopilotTranscript(sessionId) ?? undefined;
    case "cursor":
      return findCursorTranscript(sessionId) ?? undefined;
    case "pi":
      return findPiTranscript(sessionId) ?? undefined;
    case "gemini":
      return findGeminiTranscript(sessionId) ?? undefined;
    case "opencode":
      return `opencode-db://${sessionId}`;
    case "hermes":
      // Hermes live-hook payloads carry no transcript file; the audit path
      // reads sessions straight from ~/.hermes/state.db (see hermes-sessions.ts).
      return undefined;
    default:
      return undefined;
  }
}
