/**
 * The one writer of `~/.failproofai/state/backfill-request.json`.
 *
 * Two commands write it: `failproofai backfill` (a `user` request: re-send
 * what was modified since `sinceMs`) and `failproofai config` (an `added`
 * request: agents this run started tracing again, whose old cursors must not be
 * resumed). The file is a single slot, so each writer MERGES with whatever is
 * still pending instead of replacing it — otherwise config's request would
 * quietly cancel a backfill somebody asked for and the daemon has not picked up
 * yet. The daemon's reader is `crates/failproofaid/src/backfill.rs`.
 *
 * Merging keeps the stronger request. A pending `user` request stays `user`:
 * its window is the one somebody chose, and an added agent swept into it is
 * re-read over that window instead of the default seven days. A request with no
 * `agents` reaches every traced agent, so a merge with one has no list either.
 *
 * An `added` request never carries `sinceMs`. A daemon older than `kind` reads
 * every request as a backfill of `sinceMs`, so one written with it would
 * rewind every agent on such a machine; without it, the old daemon drops it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomically } from "../../lib/atomic-write";
import { failproofaiHome } from "./fp-home";

/** How long the daemon acts on an `added` request; `ADDED_REQUEST_MAX_AGE` there. */
export const ADDED_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;

export type BackfillRequest =
  | { kind: "user"; sinceMs: number; requestedAtMs: number; agents?: string[] }
  | { kind: "added"; requestedAtMs: number; agents: string[] };

/**
 * `~/.failproofai/state/backfill-request.json` — mirrored from the daemon's
 * `paths::backfill_request_path()`. Two processes, one path; the comment there
 * says why that is written down twice rather than derived.
 */
export function backfillRequestPath(home?: string): string {
  return join(failproofaiHome(home), "state", "backfill-request.json");
}

/** A pending request as the daemon would read it, or null when it would drop it. */
export function readPendingRequest(raw: unknown, now: number): BackfillRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  let agents: string[] | undefined;
  if (Array.isArray(r.agents)) {
    agents = [...new Set(r.agents.filter((a): a is string => typeof a === "string" && a.trim() !== ""))];
  } else if (r.agents !== undefined && r.agents !== null) {
    return null;
  }
  const requestedAtMs = typeof r.requestedAtMs === "number" ? r.requestedAtMs : undefined;
  const kind = r.kind === undefined || r.kind === null ? "user" : r.kind;
  if (kind === "user") {
    if (typeof r.sinceMs !== "number") return null;
    return { kind: "user", sinceMs: r.sinceMs, requestedAtMs: requestedAtMs ?? now, ...(agents ? { agents } : {}) };
  }
  if (kind === "added") {
    if (requestedAtMs === undefined || !agents) return null;
    if (now - requestedAtMs > ADDED_REQUEST_MAX_AGE_MS) return null;
    return { kind: "added", requestedAtMs, agents };
  }
  return null;
}

/** What `next` becomes when `pending` is still waiting. Pure, for tests. */
export function mergeBackfillRequests(pending: BackfillRequest | null, next: BackfillRequest): BackfillRequest {
  if (!pending) return next;
  const union = (a?: string[], b?: string[]): string[] | undefined =>
    a === undefined || b === undefined ? undefined : [...new Set([...a, ...b])];
  if (pending.kind === "added" && next.kind === "added") {
    return { kind: "added", requestedAtMs: next.requestedAtMs, agents: [...new Set([...pending.agents, ...next.agents])] };
  }
  const sinces = [pending, next].flatMap((r) => (r.kind === "user" ? [r.sinceMs] : []));
  const agents = union(pending.agents, next.agents);
  return {
    kind: "user",
    sinceMs: Math.min(...sinces),
    requestedAtMs: next.requestedAtMs,
    ...(agents ? { agents } : {}),
  };
}

/** Write `next`, merged with whatever is still pending. Returns what was written. Throws on I/O failure. */
export function writeBackfillRequest(next: BackfillRequest, home?: string): BackfillRequest {
  const path = backfillRequestPath(home);
  let pending: BackfillRequest | null = null;
  if (existsSync(path)) {
    try {
      pending = readPendingRequest(JSON.parse(readFileSync(path, "utf8")), next.requestedAtMs);
    } catch {
      // Unparseable: the daemon discards it, and so does this.
      pending = null;
    }
  }
  const merged = mergeBackfillRequests(pending, next);
  writeJsonAtomically(path, merged);
  return merged;
}
