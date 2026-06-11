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
import { getRunState } from "../_state";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const state = getRunState();
  const cache = readDashboardCache();
  return NextResponse.json({
    running: state.running,
    startedAt: state.startedAt ?? null,
    cachedAt: cache?.cachedAt ?? null,
    error: state.error,
  });
}
