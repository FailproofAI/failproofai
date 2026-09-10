/**
 * Persistence for the leak record.
 *
 * Two files, because the data has two different reset semantics and one class
 * cannot be right for both — the same lesson `fp-home.ts` learned when
 * `session.json` moved into a directory classified wholesale as `derived`:
 *
 *   audit/leaks.json          derived   — every finding is reproducible by
 *                                          rescanning, so losing it costs a scan
 *   audit/leak-identity.json  identity  — the HMAC salt and the user's
 *                                          dismissals, neither of which any
 *                                          rescan can recreate
 *
 * Regenerate the salt and every finding id changes, so a machine that has been
 * quiet for months re-alerts for every credential at once. Drop the dismissals
 * and findings a human already judged not-a-secret come back, which is worse
 * than a missed alert: it teaches them the tool does not listen.
 *
 * ## Never throws
 *
 * A scan must not fail because a cache file is corrupt, unreadable, or written
 * by a newer version. Every read degrades to "no record yet" and every write
 * degrades to a no-op with a logged reason. The audit's job is to find leaks,
 * and refusing to run because its own bookkeeping is damaged would be the
 * failure mode that matters least causing the one that matters most.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { auditLeaksFile, auditLeakIdentityFile } from "../hooks/fp-home";
import { writeJsonAtomically } from "../../lib/atomic-write";
import {
  emptyRecord,
  pruneRecord,
  LEAK_RECORD_SCHEMA_VERSION,
  type LeakRecord,
  type LeakFinding,
  type LeakSighting,
} from "./leak-record";
import { isFindingId } from "./leak-fingerprint";

interface LeakIdentity {
  /** Hex HMAC salt. Generated once, never transmitted, never derived from
   *  anything guessable — see `fingerprintId`. */
  salt: string;
  /** Finding ids the user has said are not secrets. */
  dismissed: string[];
}

/** Mode for both files. They carry no credential, but they do carry a machine
 *  salt and a map of which projects leaked what — not world-readable. */
const FILE_MODE = 0o600;

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Corrupt, truncated by a crash, or written by a version we cannot read.
    // Treated as absent: the next write replaces it.
    return null;
  }
}

/**
 * The machine's leak identity, minting a salt on first use.
 *
 * `randomBytes(32)`, not a hash of anything about the machine. A salt derived
 * from a hostname or a uid would be reproducible by anyone who knows those, and
 * the whole point of salting the fingerprint is that a third party holding a
 * guessable candidate cannot confirm it by recomputing the digest.
 */
export function readLeakIdentity(home?: string): LeakIdentity {
  const existing = readJson<Partial<LeakIdentity>>(auditLeakIdentityFile(home));
  if (existing && typeof existing.salt === "string" && existing.salt.length >= 32) {
    return {
      salt: existing.salt,
      dismissed: existing.dismissed ?? [],
    };
  }
  const minted: LeakIdentity = { salt: randomBytes(32).toString("hex"), dismissed: [] };
  writeLeakIdentity(minted, home);
  return minted;
}

export function writeLeakIdentity(identity: LeakIdentity, home?: string): boolean {
  const path = auditLeakIdentityFile(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomically(path, identity, { mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the record, or an empty one.
 *
 * A record written by a NEWER schema is discarded rather than migrated or
 * partially read: this file is a cache of derived findings, so throwing it away
 * costs one rescan, while guessing at an unknown shape risks reporting a
 * fingerprint built by rules we no longer understand.
 */
/**
 * Drop a finding this build cannot render, and repair one it can.
 *
 * `leaks.json` is a file on disk. It can be truncated by a full disk mid-write,
 * edited by hand, or written by a NEWER build whose findings carry a shape this
 * one does not expect — and the envelope check below cannot see any of that,
 * because it only looks at `schemaVersion` and `findings` being an array.
 *
 * The failure that motivated this was not hypothetical in its consequences: one
 * malformed entry made `selectLeaks` dereference `undefined`, which threw out
 * of `buildHarmReport`, which sits OUTSIDE `reportHarm`'s try — so a scheduled
 * run that scanned correctly and wrote its cache correctly still exited 1, and
 * would keep doing so on every run until somebody opened the file.
 *
 * A bad SIGHTING loses the sighting, not the finding: the credential is the
 * thing that needs rotating, and "seen in a transcript" with no detail beats
 * silence about a leaked key.
 */
function sanitizeFinding(raw: unknown): LeakFinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  // The id becomes a filename in the macOS notification queue, so anything
  // that is not the exact minted shape disqualifies the whole entry.
  if (typeof f.id !== "string" || !isFindingId(f.id)) return null;

  const fp = f.fingerprint as Record<string, unknown> | undefined;
  if (!fp || typeof fp !== "object" || typeof fp.display !== "string" || typeof fp.label !== "string") {
    return null; // with no way to name it, a row would say nothing at all
  }

  const sightings = Array.isArray(f.sightings)
    ? (f.sightings as unknown[]).filter((s): s is LeakSighting => {
        if (!s || typeof s !== "object") return false;
        const m = (s as Record<string, unknown>).mechanism as Record<string, unknown> | undefined;
        return !!m && typeof m === "object" && typeof m.summary === "string";
      })
    : [];

  return {
    ...(f as unknown as LeakFinding),
    fingerprint: {
      display: fp.display,
      label: fp.label,
      length: typeof fp.length === "number" && Number.isFinite(fp.length) ? fp.length : 0,
      attributed: fp.attributed === true,
    },
    name: typeof f.name === "string" ? f.name : null,
    firstSeen: typeof f.firstSeen === "string" ? f.firstSeen : "",
    lastSeen: typeof f.lastSeen === "string" ? f.lastSeen : "",
    occurrences:
      typeof f.occurrences === "number" && Number.isFinite(f.occurrences) ? f.occurrences : sightings.length,
    sightings,
  };
}

export function readLeakRecord(home?: string): LeakRecord {
  const identity = readLeakIdentity(home);
  const raw = readJson<LeakRecord>(auditLeaksFile(home));
  if (!raw || raw.schemaVersion !== LEAK_RECORD_SCHEMA_VERSION || !Array.isArray(raw.findings)) {
    return emptyRecord(identity.salt, new Date().toISOString());
  }
  // Every consumer — the digest, the dashboard, the notice guard — reads through
  // here, so validating once at the gate is what keeps them all from each
  // needing to defend against the same corrupt file.
  const findings = (raw.findings as unknown[])
    .map(sanitizeFinding)
    .filter((f): f is LeakFinding => f !== null);
  // The salt always comes from the identity file, never from the record — if
  // the two ever disagree the identity file is authoritative, because it is the
  // one classified to survive a reset.
  return { ...raw, findings, salt: identity.salt };
}

/**
 * Persist the record, pruned.
 *
 * Pruning on WRITE rather than on read, so the bound is enforced exactly once
 * per scan and a reader never pays for it. Returns false on failure rather than
 * throwing — see the module header.
 */
export function writeLeakRecord(record: LeakRecord, home?: string, nowMs = Date.now()): boolean {
  const path = auditLeaksFile(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const pruned = pruneRecord(record, nowMs);
    pruned.updatedAt = new Date(nowMs).toISOString();
    writeJsonAtomically(path, pruned, { mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/** Mark a finding as not-a-secret. Survives a reset; see the module header. */
export function dismissFinding(id: string, home?: string): boolean {
  const identity = readLeakIdentity(home);
  if (identity.dismissed.includes(id)) return true;
  identity.dismissed.push(id);
  return writeLeakIdentity(identity, home);
}

/**
 * Findings worth showing a human: undismissed, newest first.
 *
 * The dismissal list is applied HERE rather than at write time, so a dismissal
 * never destroys evidence — the finding stays in the record and simply stops
 * being surfaced. A user who dismisses by mistake has lost a row in a list, not
 * the fact that a credential leaked.
 */
export function activeFindings(record: LeakRecord, home?: string): LeakRecord["findings"] {
  const dismissed = new Set(readLeakIdentity(home).dismissed);
  return record.findings
    .filter((f) => !dismissed.has(f.id))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}
