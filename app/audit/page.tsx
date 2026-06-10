/**
 * /audit — server entry. Reads the dashboard cache, parses URL params
 * (?p=project), and hands off to the client dashboard.
 *
 * Imports audit-styles.css globally for this route only — the existing
 * site-wide globals continue to load via the root layout. Audit styles
 * override where they clash (dark canvas, JetBrains Mono everywhere, etc.).
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { readDashboardCache, readDashboardCacheMeta } from "@/src/audit/dashboard-cache";
import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";
import { AUDIT_DETECTORS } from "@/src/audit/detectors";
import { AuditDashboard } from "./_components/audit-dashboard";
import "./audit-styles.css";

// Computed server-side: shipping these modules to the client would pull
// in node:fs / execSync from the workflow policies.
const TOTAL_CATALOG_SIZE = BUILTIN_POLICIES.length + AUDIT_DETECTORS.length;

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ p?: string }>;
}

export default async function AuditPage({ searchParams }: PageProps) {
  const disabled = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (disabled.includes("audit")) notFound();

  const { p } = await searchParams;

  const cache = readDashboardCache();
  let initial;
  if (cache) {
    initial = {
      status: "cached" as const,
      cachedAt: cache.cachedAt,
      params: cache.params,
      result: cache.result,
    };
  } else {
    // No fresh cache. Probe meta so we can distinguish "first run" from
    // "your last audit expired" and surface the right top-bar nudge.
    const meta = readDashboardCacheMeta();
    initial = {
      status: "empty" as const,
      expired: meta !== null,
      expiredAt: meta?.cachedAt ?? null,
    };
  }

  return (
    <Suspense>
      <AuditDashboard
        initial={initial}
        projectFromUrl={p}
        totalCatalogSize={TOTAL_CATALOG_SIZE}
      />
    </Suspense>
  );
}
