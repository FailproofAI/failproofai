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

import { listClaudeTranscriptMetadata, streamClaudeEvents, streamClaudeEventsFrom } from "./claude";
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
import { listGrokTranscriptMetadata, streamGrokEvents } from "./grok";
import { listQwenTranscriptMetadata, streamQwenEvents } from "./qwen";

export type { ListOpts };

/** What an append-only source can hand back when asked to resume. */
export interface IncrementalEvents {
  events: NormalizedToolEvent[];
  /**
   * How far into the file `events` accounts for, at a LINE boundary — which is
   * NOT the file size when a transcript is being appended to as it is read. The
   * trailing partial line is left unparsed and uncounted so the next run picks
   * it up whole; recording the file size instead would skip it permanently.
   */
  bytesConsumed: number;
  /** The session cwd, when the resumed region carried one. */
  cwd?: string;
}

export interface CliAdapter {
  cli: IntegrationType;
  listTranscripts: (opts?: ListOpts) => Promise<TranscriptMetadata[]>;
  streamEvents: (meta: TranscriptMetadata) => Promise<NormalizedToolEvent[]>;
  /**
   * Read only the events after `fromByte`, for sources whose transcripts are
   * append-only files.
   *
   * OPTIONAL, and deliberately a separate method rather than a parameter on
   * `streamEvents`. A parameter an adapter ignored would return the WHOLE
   * transcript to a caller that is about to merge it into an existing partial
   * result — every event counted twice, quietly, on exactly the sources that
   * had not been updated. Absence of this method is what tells the caller it
   * cannot resume, and there is no way to be wrong about that by omission.
   */
  streamEventsFrom?: (
    meta: TranscriptMetadata,
    fromByte: number,
  ) => Promise<IncrementalEvents | null>;
}

export const ADAPTERS: Record<IntegrationType, CliAdapter> = {
  claude: {
    cli: "claude",
    listTranscripts: listClaudeTranscriptMetadata,
    streamEvents: streamClaudeEvents,
    streamEventsFrom: streamClaudeEventsFrom,
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
  grok: {
    cli: "grok",
    listTranscripts: listGrokTranscriptMetadata,
    streamEvents: streamGrokEvents,
  },
  qwen: {
    cli: "qwen",
    listTranscripts: listQwenTranscriptMetadata,
    streamEvents: streamQwenEvents,
  },
};

export function getAdapter(cli: IntegrationType): CliAdapter {
  return ADAPTERS[cli];
}
