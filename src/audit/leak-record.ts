/**
 * The per-credential record — what the audit knows that `AuditCount` cannot say.
 *
 * `AuditCount` aggregates BY RULE: it can report that `sanitize-api-keys` fired
 * 47 times and show three 80-character examples. It cannot enumerate 47 distinct
 * keys, say which of them is the same key seen twice, or answer "which CLI, in
 * which project, at what time, and how did it get there". Every surface the
 * narrowed product needs — the emailed digest, the dashboard's leak view, and
 * the once-per-finding notification guard — asks exactly those questions, so
 * none of them can be built on the rule-level record.
 *
 * ## Grouped by VALUE, not by occurrence — this is the whole bloat story
 *
 * The obvious shape is one row per sighting. Measured against the real corpus
 * that is 10,301 rows, against roughly 266 distinct values, against about 25
 * genuinely real credentials. Two orders of magnitude of duplication, because
 * one pasted key fans out across every session that touched it — the single
 * confirmed-live password in the corpus appeared in 11 files and 22 occurrences,
 * partly because Claude's own checkpoint records replay the prompt that carried
 * it.
 *
 * So the unit is the DISTINCT VALUE, with a bounded list of sightings attached
 * as evidence. A finding seen a thousand times costs the same on disk as one
 * seen twice: `MAX_SIGHTINGS` entries, plus a count. At the corpus's own numbers
 * that is roughly 130 KB for the whole file, which is why this is one file and
 * not a directory — a per-finding file would spend more on inodes and directory
 * entries than on the findings.
 *
 * ## What is deliberately NOT stored
 *
 * The credential itself, ever. The record holds a salted id (for dedupe across
 * scans) and a fingerprint (for a human to recognise the key in a console) and
 * nothing that could reconstruct the value. `~/.failproofai/` is a directory the
 * user did not ask for and cannot audit, so a leak scanner that caches the leaks
 * has made the problem worse rather than better.
 */
import type { IntegrationType } from "../hooks/types";
import type { LeakFingerprint } from "./leak-fingerprint";

/** Sightings kept per distinct value. Enough to answer 5W1H for the first and
 *  most recent exposure without storing the long tail nobody reads. */
export const MAX_SIGHTINGS = 5;

/** Findings not seen in this many days are dropped on the next write. A key
 *  whose transcripts have aged out of the scan window is not evidence of
 *  anything current, and keeping it forever grows the file without bound. */
export const FINDING_TTL_DAYS = 90;

/** Cap on distinct findings retained, newest-first. A machine with more than
 *  this is not going to triage them, and the census measured a name-only rule
 *  emitting thousands — the cap is what stops a bad matcher filling the disk. */
export const MAX_FINDINGS = 500;

/**
 * How a credential came to be where it was found — the "how" of 5W1H.
 *
 * Derived from the tool event rather than authored, so it is always specific:
 * "read from ~/…/.env" beats "detected in a file operation". The path is
 * home-shortened by the caller before it reaches here.
 */
export interface LeakMechanism {
  /** Short past-tense phrase, e.g. "read from ~/…/.env". */
  summary: string;
  /** Canonical tool name (Bash, Read, Write, Edit…). */
  toolName: string;
  /** Where the value appeared: the tool's INPUT (the agent sent it) or its
   *  RESULT (the agent received it). Different exposures with different
   *  remedies — an input is deniable at PreToolUse, a result is not. */
  direction: "input" | "result";
}

/** One exposure of one credential: the where/when/who of 5W1H. */
export interface LeakSighting {
  /** WHO — the harness whose transcript carried it. */
  cli: IntegrationType;
  /** WHERE — session and project. `cwd` is already home-shortened. */
  sessionId: string;
  cwd: string;
  /** WHEN — ISO-8601, from the transcript line. */
  at: string;
  /** HOW. */
  mechanism: LeakMechanism;
}

/** One distinct credential, however many times it was seen. */
export interface LeakFinding {
  /** Salted, machine-local, stable across scans. Never derived from the
   *  fingerprint, which is not unique. */
  id: string;
  /** WHAT — the masked rendering, its class, and its length. */
  fingerprint: LeakFingerprint;
  /** The identifier it was assigned to, when it came from an assignment
   *  (`COMPOSIO_API_KEY`). For the 230-of-237 first-party class this is the
   *  only actionable field there is, since no vendor console exists. */
  name: string | null;
  /** Which rule found it, for explaining and for suppression. */
  rule: string;
  /** How much we trust the attribution — mirrors the pattern census's tiers. */
  confidence: "doc-verified" | "source-verified" | "partner-corroborated" | "observed-only" | "name-only";
  firstSeen: string;
  lastSeen: string;
  /** Total exposures, which is NOT `sightings.length` — see MAX_SIGHTINGS. */
  occurrences: number;
  /** Bounded evidence, oldest first. */
  sightings: LeakSighting[];
  /** Set when the user dismisses it. Dismissed findings are retained (so they
   *  do not re-alert) but never notified about again. */
  dismissedAt?: string;
  /** Set when a notice for this finding has been delivered, so the next scan
   *  stays quiet. The delivery guard itself is a separate O_EXCL marker; this
   *  is the human-readable record of it. */
  notifiedAt?: string;
}

export interface LeakRecord {
  schemaVersion: number;
  /** Per-machine HMAC salt for `fingerprintId`. Generated once, never sent. */
  salt: string;
  updatedAt: string;
  findings: LeakFinding[];
}

export const LEAK_RECORD_SCHEMA_VERSION = 1;

/**
 * Fold one new sighting into the record.
 *
 * Returns whether this is a **newly seen** credential, which is what the
 * notification guard keys on: a finding whose id is already present must not
 * alert again, however many new sightings it accumulates. Getting this backwards
 * is the failure the census measured — keying on the rule-level examples, which
 * `mergeIncremental` freezes at the first three, silently misses the arrival of
 * a brand-new key while re-alerting for old ones.
 */
export function upsertFinding(
  record: LeakRecord,
  incoming: Omit<LeakFinding, "firstSeen" | "lastSeen" | "occurrences" | "sightings"> & {
    sighting: LeakSighting;
  },
): { record: LeakRecord; isNew: boolean } {
  const { sighting, ...rest } = incoming;
  const existing = record.findings.find((f) => f.id === rest.id);

  if (!existing) {
    record.findings.push({
      ...rest,
      firstSeen: sighting.at,
      lastSeen: sighting.at,
      occurrences: 1,
      sightings: [sighting],
    });
    return { record, isNew: true };
  }

  existing.occurrences += 1;
  if (sighting.at > existing.lastSeen) existing.lastSeen = sighting.at;
  if (sighting.at < existing.firstSeen) existing.firstSeen = sighting.at;

  // Keep the earliest sighting AND the most recent evidence. The report/email
  // promises the CLI and timestamp of the latest exposure; keeping only the
  // first five made those fields stale forever after a busy credential crossed
  // the cap. Middle sightings are the expendable ones.
  const seen = existing.sightings.some(
    (s) => s.sessionId === sighting.sessionId && s.at === sighting.at,
  );
  if (!seen) {
    existing.sightings.push(sighting);
    existing.sightings.sort((a, b) => a.at.localeCompare(b.at));
    if (existing.sightings.length > MAX_SIGHTINGS) {
      existing.sightings.splice(1, existing.sightings.length - MAX_SIGHTINGS);
    }
  }
  return { record, isNew: false };
}

/**
 * Drop what is no longer worth keeping, so the file cannot grow without bound.
 *
 * Order matters: age out first, then cap. Capping first would let a burst of
 * stale findings evict fresh ones.
 */
export function pruneRecord(record: LeakRecord, nowMs: number): LeakRecord {
  const cutoff = new Date(nowMs - FINDING_TTL_DAYS * 86_400_000).toISOString();
  const live = record.findings.filter((f) => f.lastSeen >= cutoff);
  live.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  record.findings = live.slice(0, MAX_FINDINGS);
  return record;
}

/** An empty record, for a machine that has never scanned. */
export function emptyRecord(salt: string, nowIso: string): LeakRecord {
  return {
    schemaVersion: LEAK_RECORD_SCHEMA_VERSION,
    salt,
    updatedAt: nowIso,
    findings: [],
  };
}

/**
 * Describe how a credential came to be in a tool event.
 *
 * Specific by construction: the path or command is what makes a finding
 * recognisable to the person who caused it, and a generic phrase ("detected in
 * tool input") is the kind of alert people learn to ignore.
 */
export function describeMechanism(
  toolName: string,
  direction: "input" | "result",
  shortPath: string | null,
): LeakMechanism {
  const where = shortPath ? ` ${shortPath}` : "";
  let summary: string;
  if (direction === "result") {
    summary = shortPath ? `appeared in the output of reading${where}` : "appeared in tool output";
  } else {
    switch (toolName) {
      case "Read":
        summary = `read from${where || " a file"}`;
        break;
      case "Write":
        summary = `written to${where || " a file"}`;
        break;
      case "Edit":
      case "NotebookEdit":
        summary = `edited into${where || " a file"}`;
        break;
      case "Bash":
        summary = "passed in a shell command";
        break;
      default:
        summary = `sent to the ${toolName} tool`;
    }
  }
  return { summary, toolName, direction };
}
