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
import { listHermesTranscriptMetadata, streamHermesEvents } from "./hermes";
import { listOpenClawTranscriptMetadata, streamOpenClawEvents } from "./openclaw";
import { listFactoryTranscriptMetadata, streamFactoryEvents } from "./factory";
import { listAntigravityTranscriptMetadata, streamAntigravityEvents } from "./antigravity";
import { listDevinTranscriptMetadata, streamDevinEvents } from "./devin";
import { listGooseTranscriptMetadata, streamGooseEvents } from "./goose";

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
  hermes: {
    cli: "hermes",
    listTranscripts: listHermesTranscriptMetadata,
    streamEvents: streamHermesEvents,
  },
  openclaw: {
    cli: "openclaw",
    listTranscripts: listOpenClawTranscriptMetadata,
    streamEvents: streamOpenClawEvents,
  },
  factory: {
    cli: "factory",
    listTranscripts: listFactoryTranscriptMetadata,
    streamEvents: streamFactoryEvents,
  },
  devin: {
    cli: "devin",
    listTranscripts: listDevinTranscriptMetadata,
    streamEvents: streamDevinEvents,
  },
  antigravity: {
    cli: "antigravity",
    listTranscripts: listAntigravityTranscriptMetadata,
    streamEvents: streamAntigravityEvents,
  },
  goose: {
    cli: "goose",
    listTranscripts: listGooseTranscriptMetadata,
    streamEvents: streamGooseEvents,
  },
};

export function getAdapter(cli: IntegrationType): CliAdapter {
  return ADAPTERS[cli];
}
