/**
 * Adapter registry — maps each IntegrationType to its list+stream functions.
 *
 * Each adapter exposes:
 *   • listTranscripts(opts) → Promise<TranscriptMetadata[]>
 *   • streamEvents(meta)    → Promise<NormalizedToolEvent[]>
 *
 * Add a new CLI by writing a sibling module and registering it here.
 */
import type { IntegrationType } from "../../hooks/types";
import type { NormalizedToolEvent, TranscriptMetadata } from "../types";
import type { ListOpts } from "./claude";

import { listClaudeTranscriptMetadata, streamClaudeEvents } from "./claude";
import { listCodexTranscriptMetadata, streamCodexEvents } from "./codex";
import { listCopilotTranscriptMetadata, streamCopilotEvents } from "./copilot";
import { listCursorTranscriptMetadata, streamCursorEvents } from "./cursor";
import { listOpenCodeTranscriptMetadata, streamOpenCodeEvents } from "./opencode";
import { listPiTranscriptMetadata, streamPiEvents } from "./pi";
import { listGeminiTranscriptMetadata, streamGeminiEvents } from "./gemini";

export type { ListOpts };

export interface CliAdapter {
  cli: IntegrationType;
  listTranscripts: (opts?: ListOpts) => Promise<TranscriptMetadata[]>;
  streamEvents: (meta: TranscriptMetadata) => Promise<NormalizedToolEvent[]>;
}

export const ADAPTERS: Record<IntegrationType, CliAdapter> = {
  claude: {
    cli: "claude",
    listTranscripts: listClaudeTranscriptMetadata,
    streamEvents: streamClaudeEvents,
  },
  codex: {
    cli: "codex",
    listTranscripts: listCodexTranscriptMetadata,
    streamEvents: streamCodexEvents,
  },
  copilot: {
    cli: "copilot",
    listTranscripts: listCopilotTranscriptMetadata,
    streamEvents: streamCopilotEvents,
  },
  cursor: {
    cli: "cursor",
    listTranscripts: listCursorTranscriptMetadata,
    streamEvents: streamCursorEvents,
  },
  opencode: {
    cli: "opencode",
    listTranscripts: listOpenCodeTranscriptMetadata,
    streamEvents: streamOpenCodeEvents,
  },
  pi: {
    cli: "pi",
    listTranscripts: listPiTranscriptMetadata,
    streamEvents: streamPiEvents,
  },
  gemini: {
    cli: "gemini",
    listTranscripts: listGeminiTranscriptMetadata,
    streamEvents: streamGeminiEvents,
  },
};

export function getAdapter(cli: IntegrationType): CliAdapter {
  return ADAPTERS[cli];
}
