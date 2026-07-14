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
 * Mirrors the dispatch pattern of `resolve-permission-mode.ts`. Each
 * `find*Transcript` helper performs its own existsSync + path-traversal
 * containment check, so passing in a malformed sessionId is safe (returns
 * null → undefined).
 */
import { findCodexTranscript } from "../../lib/codex-sessions";
import { findCopilotTranscript } from "../../lib/copilot-sessions";
import { findCursorTranscript } from "../../lib/cursor-sessions";
import { findPiTranscript } from "../../lib/pi-sessions";
import { findFactoryTranscript } from "../../lib/factory-sessions";
import { findAntigravityTranscript } from "../../lib/antigravity-sessions";
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
    case "factory":
      // Factory writes real JSONL at
      // ~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl (Claude-style).
      return findFactoryTranscript(sessionId) ?? undefined;
    case "antigravity":
      // Antigravity writes real JSONL at ~/.gemini/antigravity-cli/brain/
      // <conversationId>/.system_generated/logs/transcript_full.jsonl.
      return findAntigravityTranscript(sessionId) ?? undefined;
    case "devin":
      // Devin keeps sessions in SQLite (~/.local/share/devin/cli/sessions.db);
      // there is no on-disk transcript file, so hand back a virtual path (like
      // opencode) — audit/download read the DB directly.
      return `devin-db://${sessionId}`;
    case "goose":
      // Goose keeps sessions in SQLite (~/.local/share/goose/sessions/sessions.db);
      // its live-hook payload carries no transcript file, so hand back a virtual
      // path (like devin) — audit/download read the DB directly.
      return `goose-db://${sessionId}`;
    case "opencode":
      return `opencode-db://${sessionId}`;
    case "hermes":
      // Hermes live-hook payloads carry no transcript file; the audit path
      // reads sessions straight from ~/.hermes/state.db (see hermes-sessions.ts).
      return undefined;
    case "openclaw":
      // OpenClaw's plugin shim forwards transcript_path in stdin (handled by the
      // early return above); its audit path reads the real JSONL sessions
      // directly via lib/openclaw-sessions.ts, so no discovery is needed here.
      return undefined;
    default:
      return undefined;
  }
}
