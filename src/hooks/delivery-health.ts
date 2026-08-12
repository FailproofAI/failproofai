/**
 * What the collector already knows about batches the server refused.
 *
 * The uploader records its verdict in the parked batch's FILENAME — a rename,
 * not a sidecar, precisely so the record cannot desynchronise from the batch it
 * describes (`crates/fpai-collect/src/uploader.rs`). So a machine whose key was
 * revoked is already carrying a complete, structured diagnosis on disk:
 *
 *     claude-2026-08-11-0.a3.c401.jsonl
 *                        │   └── client_status: the server's definitive refusal
 *                        └────── attempt count before it was parked
 *
 * Nothing has ever read that directory. The live incident recorded in
 * `crates/failproofaid/src/main.rs` — "a key revoked at 13:05:37 and replaced 37
 * seconds later was still producing 401s twenty minutes on, with 26 parked
 * batches and a CLI saying 'connected'. The only symptom was data that never
 * arrived." — is exactly this file's absence. The daemon had already worked out
 * what was wrong and had nowhere to say it.
 *
 * This is deliberately a READER. It never retries, never deletes, never probes
 * the network. The uploader's own rule is that a definitively-refused batch
 * "will fail identically until the cause is fixed", which is why
 * `is_auto_retryable()` excludes it from the retry pass — that is correct, and
 * re-litigating it here would burn the budget of batches that could succeed.
 * The gap was never the detection. It was that the detection was mute.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { failedDir } from "./fp-home";

/**
 * Mirrors `POISON_SUFFIX` in `crates/fpai-collect/src/uploader.rs`. Kept as its
 * own constant rather than inlined so the two sides are greppable together.
 */
const POISON_SUFFIX = ".poison";

/**
 * A credential the server refused. 401 is a rejected key; 403 is a key it
 * accepted but which lacks `events:add` — different causes, same user-visible
 * outcome (nothing arrives), and both are fixed by re-running `--connect` with
 * a key that works. Grouped so the message can say "credential" without
 * guessing which of the two it was.
 */
const CREDENTIAL_STATUSES = new Set([401, 403]);

/** The decomposed form of a parked batch's filename. */
export interface ParkedName {
  base: string;
  attempt: number;
  /** Present iff the server definitively refused this batch. */
  clientStatus?: number;
  poison: boolean;
}

/**
 * Mirrors `ParkedName::parse` in `crates/fpai-collect/src/uploader.rs`.
 *
 * Suffixes are stripped right to left (`.cNNN` then `.aN`), and each is parsed
 * rather than merely matched, which is what keeps a real spool name safe: a
 * base like `claude-...-0` has no numeric `.c`/`.a` to find, and anything that
 * looks like one but is not numeric stays part of the base.
 */
export function parseParkedName(name: string): ParkedName {
  const poison = name.endsWith(POISON_SUFFIX);
  const withoutPoison = poison ? name.slice(0, -POISON_SUFFIX.length) : name;
  const stem = withoutPoison.endsWith(".jsonl")
    ? withoutPoison.slice(0, -".jsonl".length)
    : withoutPoison;

  let base = stem;
  let attempt = 0;
  let clientStatus: number | undefined;

  const cIdx = base.lastIndexOf(".c");
  if (cIdx !== -1) {
    const code = Number(base.slice(cIdx + 2));
    if (Number.isInteger(code) && base.slice(cIdx + 2) !== "") {
      clientStatus = code;
      base = base.slice(0, cIdx);
    }
  }
  const aIdx = base.lastIndexOf(".a");
  if (aIdx !== -1) {
    const n = Number(base.slice(aIdx + 2));
    if (Number.isInteger(n) && base.slice(aIdx + 2) !== "") {
      attempt = n;
      base = base.slice(0, aIdx);
    }
  }

  return { base, attempt, clientStatus, poison };
}

export interface DeliveryHealth {
  /** Every batch sitting in `failed/`, whatever parked it. */
  total: number;
  /**
   * Batches the server definitively refused. These carry a client status and
   * are excluded from the automatic retry pass, so they stay until a human
   * fixes the cause — the count only grows.
   */
  rejected: number;
  /** Of those, the ones refused for a credential reason (401/403). */
  credentialRejected: number;
  /** Count per client status, e.g. `{ 401: 26 }`. */
  byStatus: Record<number, number>;
  /** Age of the oldest parked batch, in ms. Undefined when none are parked. */
  oldestAgeMs?: number;
}

const EMPTY: DeliveryHealth = {
  total: 0,
  rejected: 0,
  credentialRejected: 0,
  byStatus: {},
};

/**
 * Summarise `failed/` without touching it.
 *
 * A missing directory is the healthy case on a machine that has never had a
 * batch refused, not an error — the collector creates it lazily.
 */
export function deliveryHealth(home?: string, now: number = Date.now()): DeliveryHealth {
  const dir = failedDir(home);
  if (!existsSync(dir)) return EMPTY;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Unreadable is reported as healthy rather than thrown: this runs on the
    // hook path, and a status reader must never be the reason a tool call fails.
    return EMPTY;
  }

  const byStatus: Record<number, number> = {};
  let total = 0;
  let rejected = 0;
  let credentialRejected = 0;
  let oldestMtime: number | undefined;

  for (const name of entries) {
    // `.tmp` files are half-written renames, not parked batches.
    if (!name.includes(".jsonl")) continue;
    total += 1;

    const parsed = parseParkedName(name);
    if (parsed.clientStatus !== undefined) {
      rejected += 1;
      byStatus[parsed.clientStatus] = (byStatus[parsed.clientStatus] ?? 0) + 1;
      if (CREDENTIAL_STATUSES.has(parsed.clientStatus)) credentialRejected += 1;
    }

    try {
      const mtime = statSync(join(dir, name)).mtimeMs;
      if (oldestMtime === undefined || mtime < oldestMtime) oldestMtime = mtime;
    } catch {
      // Vanished mid-scan — the collector just drained or renamed it.
    }
  }

  return {
    total,
    rejected,
    credentialRejected,
    byStatus,
    ...(oldestMtime !== undefined ? { oldestAgeMs: Math.max(0, now - oldestMtime) } : {}),
  };
}

/** `2h 14m`, `3d`, `just now` — coarse on purpose; this is a "how stale" signal. */
export function describeAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The one-line verdict, or undefined when there is nothing to say.
 *
 * Deliberately silent unless a batch was DEFINITIVELY refused. Batches parked
 * after exhausting server-error retries carry no client status and are picked
 * up again by the retry pass, so reporting them would cry wolf over a blip the
 * daemon is already handling. A credential the server refuses is the opposite:
 * it never resolves on its own, and every session that passes without saying so
 * is another session of data quietly not arriving.
 */
export function deliveryHealthLine(health: DeliveryHealth): string | undefined {
  if (health.rejected === 0) return undefined;

  const batches = `${health.rejected} batch${health.rejected === 1 ? "" : "es"}`;
  const age = health.oldestAgeMs !== undefined ? `, oldest ${describeAge(health.oldestAgeMs)}` : "";

  if (health.credentialRejected > 0) {
    const codes = Object.keys(health.byStatus)
      .map(Number)
      .filter((c) => CREDENTIAL_STATUSES.has(c))
      .sort();
    return (
      `Ingest REJECTED (${codes.join("/")}) — ${batches} parked${age}. ` +
      `The key was accepted when it was connected and is not being accepted now; ` +
      `nothing from this machine is reaching the dashboard. ` +
      `Re-run \`failproofai config --connect\` with a working key.`
    );
  }

  const codes = Object.keys(health.byStatus).map(Number).sort().join("/");
  return (
    `Ingest REJECTED (${codes}) — ${batches} parked${age}. ` +
    `The server refused these and they are not retried; nothing from this ` +
    `machine is reaching the dashboard.`
  );
}
