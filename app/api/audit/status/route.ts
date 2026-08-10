/**
 * GET /api/audit/status — lightweight poll endpoint. Client polls this at
 * 1s while a run is in flight; switches off polling once `running: false`.
 *
 * Also returns the cache's `cachedAt` so the client can detect that a new
 * result has landed (older `cachedAt` value in client → refetch via the
 * server action).
 */
import { NextResponse } from "next/server";
import { readDashboardCache } from "@/src/audit/dashboard-cache";
import { readActiveAuditLock } from "@/src/audit/audit-lock";
import { getRunState } from "../_state";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const state = getRunState();
  const cache = readDashboardCache();
  // `running` must answer "is a scan running on this MACHINE", not just "in this
  // process". The in-memory state only sees dashboard-initiated runs; a
  // scheduled daemon child or a `failproofai audit` writes the same cache from
  // another process and holds the cross-process lock instead. Fold that in so a
  // client polling after a 409 (or the settings page on mount) sees the machine
  // as busy and waits it out, rather than reading idle and clobbering a live
  // scan's cache. `readActiveAuditLock` applies the same dead-pid/age staleness
  // rules as acquire, so a crashed run's leftover lockfile never wedges this at
  // "running" forever.
  const externalLock = readActiveAuditLock();
  const externallyRunning = externalLock !== null && externalLock.pid !== process.pid;
  return NextResponse.json({
    running: state.running || externallyRunning,
    startedAt: state.startedAt ?? null,
    cachedAt: cache?.cachedAt ?? null,
    error: state.error,
  });
}
