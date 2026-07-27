/**
 * AdaL (@sylphai/adal-cli) transcript adapter — AUDIT (Pillar 2).
 *
 * ⚠️ INERT BY DESIGN — AdaL is a live-hooks-only integration today.
 *
 * Unlike every sibling adapter in this directory, this one has no data source
 * to read. AdaL does not currently persist a replayable per-turn tool-event log:
 *
 *   • `~/.adal/sessions/<id>/` holds only side-artifacts (documents/, images/,
 *     scratch/, system_prompt.txt) — no transcript.
 *   • `~/.adal/sessions/<id>_metadata.json` has session identity (conversation_id,
 *     created_at, last_accessed, project_path, total_turns) but no tool calls.
 *   • `~/.adal/adal.db` exists but contains no tables.
 *
 * So there is no equivalent of Claude's JSONL transcript, Goose's SQLite
 * `messages` rows, or Antigravity's `transcript_full.jsonl`.
 *
 * `listTranscripts` deliberately returns [] rather than enumerating sessions
 * from the metadata files. Listing sessions whose events can never be streamed
 * would populate the dashboard with rows that always open empty, which reads as
 * broken rather than unsupported. Empty and honest is the better failure mode.
 *
 * This module exists because `ADAPTERS` in ./index.ts is an exhaustive
 * `Record<IntegrationType, CliAdapter>`, so a live-hooks-only CLI cannot be
 * registered without it. `INTEGRATIONS` (live hooks) is `Partial` for the mirror
 * reason — see the PR discussion about making `ADAPTERS` `Partial` too.
 *
 * When AdaL gains a persisted tool-event log, replace both functions with a
 * real reader (lib/adal-sessions.ts) following the antigravity.ts pattern; the
 * ADAL_TOOL_MAP / ADAL_TOOL_INPUT_MAP canonicalization this needs already
 * exists in src/hooks/types.ts.
 */
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";

export async function listAdalTranscriptMetadata(
  _opts: ListOpts = {},
): Promise<TranscriptMetadata[]> {
  // No replayable transcript source — see the module header.
  return [];
}

export async function streamAdalEvents(
  _meta: TranscriptMetadata,
): Promise<NormalizedToolEvent[]> {
  // No replayable transcript source — see the module header.
  return [];
}
