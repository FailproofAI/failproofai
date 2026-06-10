"use server";

import { readDashboardCache, readDashboardCacheMeta } from "@/src/audit/dashboard-cache";
import type { AuditResult, RunAuditOptions } from "@/src/audit/types";

export type AuditResultPayload =
  | { status: "cached"; cachedAt: string; params: RunAuditOptions; result: AuditResult }
  | { status: "empty"; expired: boolean; expiredAt: string | null };

/**
 * Read the dashboard cache. Never triggers a run — `/audit` shows the empty
 * state when there's no cache and lets the user opt in to scanning. Mirrors
 * the read-only ergonomics of `getHooksConfigAction()`.
 *
 * On the empty path, `expired` distinguishes "no audit has ever run" from
 * "your last audit aged out past the 7-day TTL" so the top bar can show a
 * different banner copy in each case.
 */
export async function getAuditResultAction(): Promise<AuditResultPayload> {
  const entry = readDashboardCache();
  if (!entry) {
    const meta = readDashboardCacheMeta();
    return {
      status: "empty",
      expired: meta !== null,
      expiredAt: meta?.cachedAt ?? null,
    };
  }
  return {
    status: "cached",
    cachedAt: entry.cachedAt,
    params: entry.params,
    result: entry.result,
  };
}
