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
  /** Pre-canonicalization tool name (e.g. "run_shell_command" for Gemini). */
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
  /** Per-policy/detector hit count for this one transcript. */
  hitsByName: Record<string, number>;
  /** Up to 3 example commands per policy/detector (later coalesced upstream). */
  examplesByName: Record<string, { timestamp: string; cwd: string; example: string }[]>;
  /** First/last timestamp per name. */
  rangeByName: Record<string, { first: string; last: string }>;
}

/** Top-level result of `runAudit()`. */
export interface AuditResult {
  /** Schema version of this JSON shape. Increment on incompatible changes. */
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
