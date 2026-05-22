/**
 * Shared helpers used by every per-CLI adapter.
 *
 * The lib/<cli>-sessions.ts parsers all produce the same `LogEntry[]` shape
 * (defined in lib/log-entries.ts), so the conversion from LogEntry[] to
 * NormalizedToolEvent[] is uniform across CLIs. The only per-CLI difference is
 * the canonicalization function, which we delegate to
 * `src/hooks/tool-name-canonicalize.ts`.
 */
import type { LogEntry } from "../../../lib/log-entries";
import type { IntegrationType } from "../../hooks/types";
import {
  canonicalizeToolName,
  canonicalizeToolInput,
} from "../../hooks/tool-name-canonicalize";
import {
  AUDIT_TOOL_RESULT_MAX_BYTES,
  type NormalizedToolEvent,
} from "../types";

export interface ConvertContext {
  cli: IntegrationType;
  sessionId: string;
  transcriptPath: string;
  /** Cwd resolved by the per-CLI parser. May be empty if the transcript had no
   *  session-start record. The audit falls back to the decoded project name. */
  cwd: string;
}

/** Walks the LogEntry[] in timestamp order and yields one NormalizedToolEvent
 *  per `tool_use` content block, with the matching `tool_result.content` text
 *  attached (truncated). Returns events in chronological order. */
export function logEntriesToEvents(
  entries: LogEntry[],
  ctx: ConvertContext,
): NormalizedToolEvent[] {
  const events: NormalizedToolEvent[] = [];

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "tool_use") continue;
      const rawName = block.name;
      const canonicalName = canonicalizeToolName(rawName, ctx.cli) ?? rawName;
      const canonicalInput = canonicalizeToolInput(
        canonicalName,
        block.input,
        ctx.cli,
      ) as Record<string, unknown>;

      let toolResultText: string | undefined;
      if (block.result?.content) {
        toolResultText =
          block.result.content.length > AUDIT_TOOL_RESULT_MAX_BYTES
            ? block.result.content.slice(0, AUDIT_TOOL_RESULT_MAX_BYTES)
            : block.result.content;
      }

      events.push({
        cli: ctx.cli,
        sessionId: ctx.sessionId,
        transcriptPath: ctx.transcriptPath,
        cwd: ctx.cwd,
        timestamp: entry.timestamp,
        toolName: canonicalName,
        rawToolName: rawName,
        toolInput: canonicalInput ?? {},
        toolResultText,
      });
    }
  }

  return events;
}
