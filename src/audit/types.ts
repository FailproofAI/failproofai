/**
 * Types for the `failproofai audit` command.
 *
 * The audit walks past agent-CLI transcripts, replays each tool-use event
 * through the existing policy engine, and runs each event through a separate
 * set of audit-only detectors. Counts are aggregated per (policy|detector) and
 * rendered as a table to stdout plus a markdown report.
 */
import type { IntegrationType } from "../hooks/types";

/**
 * A single tool-use event extracted from a transcript, canonicalized to the
 * shape failproofai's policy engine + audit detectors expect.
 */
export interface NormalizedToolEvent {
  cli: IntegrationType;
  sessionId: string;
  transcriptPath: string;
  /** Working directory of the session at the time of the event. */
  cwd: string;
  /** ISO-8601 timestamp from the transcript line. */
  timestamp: string;
  /** Canonical Claude PascalCase tool name (Bash, Read, Edit, …). */
  toolName: string;
  /** Canonicalized tool input (snake_case keys for OpenCode/Pi). */
  toolInput: Record<string, unknown>;
  /** Pre-canonicalization tool name (e.g. "exec" for OpenClaw). */
  rawToolName: string;
  /**
   * Result text from the matching tool_result block, if present in the
   * transcript. Used to synthesize PostToolUse events for sanitize-* policies.
   * Truncated to AUDIT_TOOL_RESULT_MAX_BYTES at the adapter to bound memory.
   */
  toolResultText?: string;
}

/** Metadata about a single transcript (one session's JSONL file). */
export interface TranscriptMetadata {
  cli: IntegrationType;
  /** Encoded project folder name (e.g. "-home-user-project"). */
  projectName: string;
  sessionId: string;
  transcriptPath: string;
  /** mtime of the transcript file. Used for cache invalidation + --since filtering. */
  mtimeMs: number;
  /** Byte size of the transcript file. Used for cache invalidation. */
  sizeBytes: number;
}

/** Per-session detector state. Detectors mutate this freely. */
export type DetectorSessionState = Record<string, unknown>;

/** One detected occurrence of a "stupid behavior". */
export interface DetectorHit {
  /** A short, one-line summary of what triggered the detector. Used as the
   *  example column in the table and the example list in the markdown report.
   *  Truncated to 80 chars upstream. */
  example: string;
}

/** A pure function over a normalized event (plus optional per-session state).
 *  Returns a DetectorHit when the event matches, null otherwise. */
export type DetectorFn = (
  event: NormalizedToolEvent,
  state: DetectorSessionState,
) => DetectorHit | null;

/** Audit-only detector definition. */
export interface Detector {
  name: string;
  description: string;
  /** Display group in the markdown report (Wasteful / Risky / …). */
  category: string;
  /** Severity tier — drives row color in the table. */
  severity: "warn" | "info";
  detect: DetectorFn;
  /** User-facing past-tense phrase, e.g. "Re-read a file just edited". Falls
   *  back to `description` when omitted. */
  displayTitle?: string;
  /** One short clause describing the consequence. */
  impact?: string;
}

/** Aggregated count for one policy or detector. */
export interface AuditCount {
  /** Either a policy name ("failproofai/block-force-push") or a detector name
   *  ("redundant-cd-cwd"). */
  name: string;
  /** "builtin" for replayed policies, "audit-detector" for audit-only patterns. */
  source: "builtin" | "audit-detector";
  category: string;
  /** Decision label for builtin replays (deny|instruct|allow|sanitize). For
   *  audit-detector entries this is the detector's severity. */
  severity: string;
  hits: number;
  /** Number of distinct projects (transcript folders) where this fired. */
  projects: number;
  /** ISO-8601 timestamp of the first matching event seen. */
  firstSeen?: string;
  /** ISO-8601 timestamp of the last matching event seen. */
  lastSeen?: string;
  /** Up to N example commands/snippets that triggered this (80 chars each). */
  examples: { sessionId: string; cwd: string; timestamp: string; example: string }[];
  /** User-facing past-tense phrase used in the report. Always populated by the
   *  orchestrator — falls back to the policy/detector description when no
   *  `displayTitle` was authored. */
  displayTitle: string;
  /** One short clause describing the consequence. May be empty for legacy
   *  policies without authored impact copy. */
  impact: string;
  /** Whether the user currently has this builtin enabled. Drives the
   *  "already protected" vs "slipping through" split in the report. Always
   *  `false` for audit-only detectors (they don't have a runtime enforcement
   *  path today). */
  enabledInConfig: boolean;
  /** Pre-built one-line install command (or audit-only notice) the report
   *  shows next to each row, so users can copy-paste to remediate. */
  installHint: string;
}

/** Per-transcript scan result (also the per-transcript cache value). */
export interface TranscriptAuditResult {
  /** Cache key: matches TranscriptMetadata.transcriptPath. */
  transcriptPath: string;
  cli: IntegrationType;
  projectName: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Cwd of the session (taken from the first event with a cwd field).
   *  Empty string when no events carried cwd. Surfaced up to `AuditResult.
   *  projectsScanned` so the dashboard's project filter can show every
   *  scanned project, not just those with examples. */
  cwd?: string;
  /** Total normalized tool-use events scanned in this transcript. Surfaced
   *  via `AuditResult.eventsScanned` so the report can show "X tool calls"
   *  across the whole audit. */
  eventsScanned?: number;
  /** Per-policy/detector hit count for this one transcript. */
  hitsByName: Record<string, number>;
  /** Up to 3 example commands per policy/detector (later coalesced upstream). */
  examplesByName: Record<string, { timestamp: string; cwd: string; example: string }[]>;
  /** First/last timestamp per name. */
  rangeByName: Record<string, { first: string; last: string }>;
}

/** Top-level result of `runAudit()`. */
export interface AuditResult {
  /** Schema version of this JSON shape. Increment on incompatible changes.
   *  v2: added `projectsScanned`. */
  version: number;
  scannedAt: string;
  scope: {
    cli: IntegrationType[];
    projects: string[] | "all";
    since: string | null;
  };
  transcripts: {
    scanned: number;
    skipped: number;
    errors: number;
    durationMs: number;
  };
  results: AuditCount[];
  totals: {
    hits: number;
    projectsWithHits: number;
  };
  /** Sorted, deduped list of cwds across every transcript that was scanned
   *  (including those with zero hits). Drives the dashboard's project filter.
   *  Transcripts without a usable cwd are excluded. */
  projectsScanned: string[];
  /** Total normalized tool-use events the audit walked across every
   *  scanned transcript. The audit dashboard surfaces this as the
   *  "X tool calls" headline counter. */
  eventsScanned: number;
  /** Short names (without `failproofai/` namespace) of every builtin
   *  policy that was enabled in the user's merged config at scan time.
   *  Lets the dashboard answer "is this policy already on?" for
   *  detector-mapped policies that may not have hit during this audit. */
  enabledBuiltinNames: string[];
}

/** CLI-supplied options for `runAudit()`. Set by `bin/failproofai.mjs`. */
export interface RunAuditOptions {
  /** Restrict to one or more CLIs. Default: all 7. */
  clis?: IntegrationType[];
  /** Restrict to sessions whose cwd matches one of these paths. */
  projects?: string[];
  /** "7d", "30d", or an ISO date. Filters on transcript mtime. */
  since?: string;
  /** Restrict to one or more policy/detector names. */
  policies?: string[];
  /** Top-N rows in the table output. */
  limit?: number;
  /** Include example column in the table. */
  showExamples?: boolean;
  /** Output path for the markdown report. Default: ./failproofai-audit.md */
  reportPath?: string;
  /** Skip writing the markdown report. */
  noReport?: boolean;
  /** Emit JSON to stdout instead of the table. */
  json?: boolean;
  /** Bypass the per-transcript cache. */
  noCache?: boolean;
}

/** Truncation budget for `NormalizedToolEvent.toolResultText`. Bounds memory
 *  for sanitize-* policy replay without losing the typical match window. */
export const AUDIT_TOOL_RESULT_MAX_BYTES = 64 * 1024;

/** Truncation budget for example strings shown in table + markdown. */
export const AUDIT_EXAMPLE_MAX_CHARS = 80;

/** Max examples kept per policy/detector in the final report. */
export const AUDIT_MAX_EXAMPLES_PER_NAME = 3;
