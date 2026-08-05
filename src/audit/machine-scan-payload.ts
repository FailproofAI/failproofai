/**
 * The wire payload for a scheduled scan — built field by field, never filtered.
 *
 * # The rule this file exists to enforce
 *
 * An `AuditResult` is a summary of the CONTENTS of every session transcript on
 * the machine. Almost none of it may cross the network. Two fields are known,
 * verified hazards:
 *
 *   - `AuditCount.examples` carries verbatim shell commands AND the session
 *     `cwd` — a real sample had `psql "postgres://user:pw@host/db"` in it.
 *   - `AuditResult.projectsScanned` is a list of absolute filesystem paths —
 *     79 of them on the real sample, i.e. a map of everything the person works
 *     on, including client names.
 *
 * They are not the only ones, and that is the point: `scope.projects` is a path
 * list too, `AuditCount.displayTitle`/`impact`/`installHint` are prose, and
 * nothing stops a future field from being worse. So this module NEVER takes an
 * `AuditResult` and deletes fields from it. A subtractive filter is safe only
 * until the next person adds a field upstream, and then it leaks by default,
 * silently, in a release nobody associated with privacy. Every value below is
 * named, read, validated and assigned individually; a new upstream field
 * arrives as nothing at all, and `machine-scan-payload.test.ts` freezes the
 * emitted key set so it stays that way.
 *
 * # Everything here is a counter, an identifier or a timestamp
 *
 * Rule ids come from our own catalog and are checked against it (`KNOWN_RULE_IDS`)
 * rather than passed through, so a future change that replays a customer's own
 * policies cannot ship `block-acme-prod-deploy` — a business fact — to us.
 * `projects` is a COUNT of distinct projects, never their names. There is no
 * free-text field, and the server's structs are `deny_unknown_fields`, so an
 * accidental one is a 422 rather than a silent write.
 */
import { BUILTIN_POLICIES } from "../hooks/builtin-policies";
import { normalizePolicyName } from "../hooks/policy-registry";
import { AUDIT_DETECTORS } from "./detectors";
import { harmfulSeverity, type HarmfulSeverity } from "./harmful";
import type { AuditCount, AuditResult } from "./types";

/**
 * Wire schema version. Bumped only for a DELIBERATE change to the field set.
 *
 * It is what lets the server tell an intentional extension from an accidental
 * one: with `deny_unknown_fields` on the receiving side, a stray key is already
 * a 422, and this number is how a real change announces itself instead.
 */
export const MACHINE_SCAN_SCHEMA_VERSION = 1;

/** Path the scan is POSTed to, appended to the cloud base URL. Under
 *  `/enforcement/v1/` because that is the ONLY prefix the hosted ingress routes
 *  from a machine to the server — anywhere else reaches the Next.js dashboard,
 *  which answers with an HTML login page and a 200. */
export const MACHINE_SCAN_PATH = "/enforcement/v1/machine-scans";

/** Server-side cap on findings per scan. Exceeding it is a 422 for the whole
 *  scan, so we truncate rather than let one noisy machine lose its report. */
export const MAX_SCAN_FINDINGS = 200;

/** Server bound on every count field. */
const MAX_COUNT = 1_000_000_000;

/** Server bound on `durationMs` (7 days). */
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** How far in the past/future the server accepts a `scannedAt`. */
const SCANNED_AT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const SCANNED_AT_MAX_SKEW_MS = 10 * 60 * 1000;

/**
 * THE FROZEN ALLOWLIST — the complete set of keys that may cross the network.
 *
 * `machine-scan-payload.test.ts` asserts the emitted object's keys equal this
 * exactly, so adding a field to `AuditResult` cannot silently join the payload
 * and adding one HERE cannot happen without someone editing this list on
 * purpose. Order matches the server's `MachineScanRequest`.
 */
export const MACHINE_SCAN_PAYLOAD_KEYS = [
  "schemaVersion",
  "machineId",
  "osUser",
  "scannedAt",
  "transcriptsScanned",
  "eventsScanned",
  "durationMs",
  "findings",
] as const;

/** The same, for one finding. */
export const MACHINE_SCAN_FINDING_KEYS = [
  "ruleId",
  "source",
  "category",
  "severity",
  "hits",
  "projects",
  "firstSeen",
  "lastSeen",
] as const;

export interface MachineScanFinding {
  ruleId: string;
  source: "builtin" | "audit-detector";
  category: string;
  severity: HarmfulSeverity;
  hits: number;
  /** A COUNT of distinct projects this fired in. Never their names or paths. */
  projects: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface MachineScanPayload {
  schemaVersion: number;
  machineId: string;
  osUser: string;
  scannedAt: string;
  transcriptsScanned: number;
  eventsScanned: number;
  durationMs: number;
  findings: MachineScanFinding[];
}

export interface BuildScanPayloadInput {
  result: AuditResult;
  /** The stable machine key from `credentials.toml`, not the hostname. */
  machineId: string;
  /** The OS user this scan ran as. Identity is the PAIR — two people on one
   *  box are two reporting identities, which is what the collector already
   *  stamps on every event. */
  osUser: string;
  /** Injected by tests. */
  now?: number;
}

// ── Identifier validation ────────────────────────────────────────────────────
//
// Each mirrors the server's own validator. Duplicated rather than shared
// because there is nothing to share with across a process and a language
// boundary — but a mismatch here is a 422 that drops a whole scan, so they are
// pinned by tests rather than left to memory.

const MACHINE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const OS_USER_RE = /^[A-Za-z0-9._\-\\$]{1,64}$/;
const RULE_ID_RE = /^[A-Za-z0-9._\-/]{1,128}$/;
const CATEGORY_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidMachineId(value: string): boolean {
  return MACHINE_ID_RE.test(value) && value !== "." && value !== "..";
}

export function isValidOsUser(value: string): boolean {
  return OS_USER_RE.test(value);
}

/**
 * Every rule id this build knows how to name.
 *
 * Both the namespaced (`failproofai/block-sudo`) and bare (`block-sudo`) forms,
 * because the audit's row names come from the policy registry while the
 * catalog stores them bare. An id that is in neither is dropped: it is either a
 * policy from outside our catalog — whose NAME is the customer's, not ours — or
 * a shape from a newer build, and neither is something to forward blind.
 */
export const KNOWN_RULE_IDS: ReadonlySet<string> = new Set([
  ...BUILTIN_POLICIES.flatMap((p) => [p.name, normalizePolicyName(p.name)]),
  ...AUDIT_DETECTORS.map((d) => d.name),
]);

/**
 * `"Packages & System"` → `"packages-system"`.
 *
 * The audit's categories are hand-authored display strings with spaces and an
 * ampersand; the server's column accepts `[A-Za-z0-9._-]` only, so passing one
 * through unchanged 422s the entire scan. Returns null when nothing usable
 * survives, and the caller then omits the finding rather than inventing a
 * category — a wrong grouping in an email is worse than a missing row.
 */
export function slugifyCategory(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return CATEGORY_RE.test(slug) ? slug : null;
}

/** A whole, non-negative count inside the server's bound. Anything else — NaN,
 *  Infinity, a negative from an arithmetic slip — resolves to 0 rather than
 *  failing the scan on a number nobody reads closely. */
function count(value: unknown, max = MAX_COUNT): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), max);
}

/** An RFC3339 timestamp, or null. Re-serialised from a parsed Date rather than
 *  forwarded as-is, so whatever formatting a transcript used becomes the one
 *  shape the server parses. */
function rfc3339(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * When the scan ran, held inside the window the server accepts.
 *
 * A machine whose clock is wrong enough to put its own `scannedAt` 90 days in
 * the past would have every scan rejected — and the report is about findings,
 * not about the clock — so an out-of-window value falls back to now. That is
 * the honest reading anyway: this runs moments after the audit finished.
 */
function scanTimestamp(raw: unknown, now: number): string {
  const parsed = rfc3339(raw);
  if (parsed) {
    const ms = Date.parse(parsed);
    if (ms <= now + SCANNED_AT_MAX_SKEW_MS && ms >= now - SCANNED_AT_MAX_AGE_MS) return parsed;
  }
  return new Date(now).toISOString();
}

/** Project one harmful row, or null when any part of it fails validation. */
function projectFinding(row: AuditCount, severity: HarmfulSeverity): MachineScanFinding | null {
  const ruleId = normalizePolicyName(row.name);
  if (!RULE_ID_RE.test(ruleId) || !KNOWN_RULE_IDS.has(row.name)) return null;

  const category = slugifyCategory(row.category ?? "");
  if (!category) return null;

  const hits = count(row.hits);
  if (hits < 1) return null;

  // Constructed key by key, in the frozen order. Never `{...row}` with
  // deletions — `examples` is one spread away at all times.
  return {
    ruleId,
    source: row.source,
    category,
    severity,
    hits,
    projects: count(row.projects),
    firstSeen: rfc3339(row.firstSeen),
    lastSeen: rfc3339(row.lastSeen),
  };
}

export type ScanPayloadRejection =
  /** `machineId` or `osUser` is not something the server will accept. Sending
   *  a mangled one would merge or split a reporting identity, so we send
   *  nothing instead. */
  | "invalid-identity"
  /** A clean week. `risks` mode's whole point — no proof-of-life digest. */
  | "no-harmful-findings";

export type BuildScanPayloadResult =
  | { ok: true; payload: MachineScanPayload }
  | { ok: false; reason: ScanPayloadRejection };

/**
 * Build the payload, or explain why there isn't one.
 *
 * Returns a reason rather than throwing: every caller is a best-effort
 * background path where "nothing to send" and "cannot send" are both normal
 * outcomes and neither may fail the audit.
 */
export function buildMachineScanPayload(input: BuildScanPayloadInput): BuildScanPayloadResult {
  const machineId = input.machineId.trim();
  const osUser = input.osUser.trim();
  if (!isValidMachineId(machineId) || !isValidOsUser(osUser)) {
    return { ok: false, reason: "invalid-identity" };
  }

  const now = input.now ?? Date.now();
  const findings: MachineScanFinding[] = [];
  const seen = new Set<string>();
  for (const row of input.result.results ?? []) {
    // ONE call decides both "does this go" and "what is it labelled". There is
    // deliberately no second place that could answer the first question yes and
    // then attach a severity the server reads as benign.
    const severity = harmfulSeverity(row);
    if (!severity) continue;
    const finding = projectFinding(row, severity);
    if (!finding) continue;
    // The server rejects duplicate rule ids for the whole scan. Two rows can
    // normalise to one id (a bare and a namespaced spelling of the same
    // policy), and losing the report over it would be absurd.
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    findings.push(finding);
    if (findings.length >= MAX_SCAN_FINDINGS) break;
  }

  // Nothing harmful survived validation either — same outcome as a clean week,
  // and the same silence.
  if (findings.length === 0) return { ok: false, reason: "no-harmful-findings" };

  return {
    ok: true,
    payload: {
      schemaVersion: MACHINE_SCAN_SCHEMA_VERSION,
      machineId,
      osUser,
      scannedAt: scanTimestamp(input.result.scannedAt, now),
      transcriptsScanned: count(input.result.transcripts?.scanned),
      eventsScanned: count(input.result.eventsScanned),
      durationMs: count(input.result.transcripts?.durationMs, MAX_DURATION_MS),
      findings,
    },
  };
}
