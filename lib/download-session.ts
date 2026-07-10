/**
 * Per-CLI dispatcher for the dashboard's Download Logs endpoint.
 *
 * Returns either a real on-disk path (so the route can `createReadStream` and
 * stream the bytes verbatim) or a synthesized JSONL body (used only by
 * OpenCode, whose transcripts live in SQLite rather than on disk).
 *
 * Per-CLI session loaders / transcript finders already exist in their own
 * files; this module is the thin glue that picks the right one. Imports of
 * the per-CLI modules are dynamic so callers that only need the dispatch
 * type can avoid pulling Node-only deps into client bundles.
 */
import { resolveSessionFilePath, UUID_RE } from "./projects";
import type { CliId } from "./cli-registry";

export const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]+$/;
/** Hermes session IDs (e.g. `YYYYMMDD_HHMMSS_<hash>` / `cron_<hash>_...`). Kept
 *  in sync with `getHermesSessionLog`'s validator in lib/hermes-sessions.ts —
 *  a stricter pattern here would let a session list/open in the viewer yet fail
 *  its download with `RangeError("Invalid session ID")`. */
export const HERMES_SESSION_RE = /^[A-Za-z0-9_-]+$/;

export type DownloadSource =
  | { kind: "file"; path: string }
  | { kind: "synthesized"; body: string; contentType: string; extension: string };

/** Validate a session ID against the per-CLI shape. OpenCode uses `ses_*`
 *  prefixes; everyone else is a UUID. */
export function isValidSessionId(cli: CliId, sessionId: string): boolean {
  if (cli === "opencode") return OPENCODE_SESSION_RE.test(sessionId);
  if (cli === "hermes") return HERMES_SESSION_RE.test(sessionId);
  return UUID_RE.test(sessionId);
}

/**
 * Resolve a download source for `(cli, sessionId)`. `project` is only
 * meaningful for Claude (path-traversal validation under the projects root);
 * the other CLIs key sessions by ID alone.
 *
 * Returns `null` when the session can't be located. Throws RangeError when
 * the inputs fail validation (caller should map to 400).
 */
export async function resolveDownloadSource(
  cli: CliId,
  project: string,
  sessionId: string,
): Promise<DownloadSource | null> {
  if (!isValidSessionId(cli, sessionId)) {
    throw new RangeError("Invalid session ID");
  }

  if (cli === "claude") {
    // resolveSessionFilePath validates project and joins under the Claude root.
    return { kind: "file", path: resolveSessionFilePath(project, sessionId) };
  }

  if (cli === "codex") {
    const { findCodexTranscript } = await import("./codex-sessions");
    const path = findCodexTranscript(sessionId);
    return path ? { kind: "file", path } : null;
  }
  if (cli === "copilot") {
    const { findCopilotTranscript } = await import("./copilot-sessions");
    const path = findCopilotTranscript(sessionId);
    return path ? { kind: "file", path } : null;
  }
  if (cli === "cursor") {
    const { findCursorTranscript } = await import("./cursor-sessions");
    const path = findCursorTranscript(sessionId);
    return path ? { kind: "file", path } : null;
  }
  if (cli === "pi") {
    const { findPiTranscript } = await import("./pi-sessions");
    const path = findPiTranscript(sessionId);
    return path ? { kind: "file", path } : null;
  }
  if (cli === "gemini") {
    const { findGeminiTranscript } = await import("./gemini-sessions");
    const path = findGeminiTranscript(sessionId);
    return path ? { kind: "file", path } : null;
  }
  if (cli === "opencode") {
    // OpenCode keeps sessions in SQLite (~/.local/share/opencode/opencode.db)
    // across three tables: session / message / part. Export all three so
    // users get a faithful snapshot of the underlying structure rather than
    // a collapsed single-stream that loses parts.
    const { getOpenCodeSessionExport } = await import("./opencode-sessions");
    const result = await getOpenCodeSessionExport(sessionId);
    if (!result) return null;
    const body = JSON.stringify(result, null, 2) + "\n";
    return { kind: "synthesized", body, contentType: "application/json", extension: "json" };
  }

  if (cli === "hermes") {
    // Hermes keeps sessions in SQLite (~/.hermes/state.db). Synthesize a JSONL
    // export of the session's raw `messages` rows.
    const { getHermesSessionLog } = await import("./hermes-sessions");
    const result = await getHermesSessionLog(sessionId);
    if (!result) return null;
    const body = result.rawLines.map((r) => JSON.stringify(r)).join("\n") + "\n";
    return { kind: "synthesized", body, contentType: "application/x-ndjson", extension: "jsonl" };
  }

  // Exhaustive — but TypeScript can't always see CliId is exhausted across the
  // if-chain above, so guard with a runtime fallback.
  const _exhaustive: never = cli;
  return _exhaustive;
}
