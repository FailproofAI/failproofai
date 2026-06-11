"use client";

/**
 * `triggerRun` — POST /api/audit/run, then poll /api/audit/status until the
 * server reports the run finished. Used by:
 *  - the audit empty-state CTA (`empty-state.tsx`),
 *  - the return-section's `[ re-audit now ]` button (`return-section.tsx`).
 *
 * The original `<RerunButton>` React component lived here too, but no
 * caller ever rendered it (the rerun UI is integrated into the two
 * sections above). Dropped in this refactor to remove dead code and the
 * stale `lucide-react`/`usePostHog`/`cn` imports it dragged in.
 *
 * `triggerRun` throws `RerunError` on POST failure / network failure /
 * poll-loop timeout — callers should catch and render a distinct
 * "rerun failed" state. The `kind` discriminates timeout vs other
 * network failures so the UI can show different copy.
 */
import { fetchWithTimeout, isAbortError } from "@/lib/fetch-with-timeout";

export interface ScanParams {
  /** Empty array = all CLIs. */
  cli: string[];
  /** "7d" | "30d" | "90d" | "all" (or any value accepted by parseSinceOpt). */
  since: string;
  /** Skip the per-transcript cache and produce a genuinely fresh scan. Set by
   *  the explicit re-audit affordance so "re-audit" never silently returns the
   *  identical cached result — it re-scans every transcript from scratch. */
  noCache?: boolean;
}

const POLL_INTERVAL_MS = 1000;

/** Give up polling only after this many *consecutive* status-fetch failures.
 *  There is no duration cap on a run (a cold all-history scan is unbounded), so
 *  the only thing that should stop a live poll is losing the server — not the
 *  run taking a while. At POLL_INTERVAL_MS, this is ~10s of an unreachable
 *  server before we surface a network error. */
const MAX_CONSECUTIVE_POLL_FAILURES = 10;

/** Exported for unit testing the option-threading. */
export function paramsToBody(p: ScanParams) {
  return {
    cli: p.cli.length > 0 ? p.cli : undefined,
    since: p.since === "all" ? undefined : p.since,
    noCache: p.noCache ? true : undefined,
  };
}

export class RerunError extends Error {
  readonly kind: "post_failed" | "network" | "timeout";
  constructor(kind: RerunError["kind"], message: string) {
    super(message);
    this.kind = kind;
    this.name = "RerunError";
  }
}

export async function triggerRun(scanParams: ScanParams): Promise<void> {
  // Start the run. The route is fire-and-forget — it kicks off runAudit() in
  // the background and returns 202 in milliseconds — so the default fast fetch
  // timeout is correct here: it bounds the *kickoff request*, not the run.
  // 409 (already running) is fine — we just poll the in-flight run.
  try {
    const res = await fetchWithTimeout("/api/audit/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(paramsToBody(scanParams)),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => "");
      console.error("audit run failed:", res.status, text);
      throw new RerunError("post_failed", `audit run failed (${res.status})`);
    }
  } catch (err) {
    if (err instanceof RerunError) throw err;
    console.error("audit run request failed:", err);
    throw new RerunError(isAbortError(err) ? "timeout" : "network", "audit run request failed");
  }

  // Poll /api/audit/status until the run finishes. There is deliberately NO
  // duration cap: a cold, all-history scan can run arbitrarily long and must
  // not be guillotined client-side. The only failure mode that stops polling is
  // losing the server, tracked as consecutive status-fetch failures.
  let consecutiveFailures = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let status: { running: boolean; error?: string | null } | null = null;
    try {
      const sres = await fetchWithTimeout("/api/audit/status", { cache: "no-store" });
      if (sres.ok) {
        status = (await sres.json()) as { running: boolean; error?: string | null };
      }
    } catch {
      // Transient fetch/JSON failure (including a per-request timeout) — handled
      // by the connectivity backstop below.
    }

    if (status === null) {
      // Status unreachable or non-OK. Only give up once the server has been
      // unreachable for MAX_CONSECUTIVE_POLL_FAILURES polls in a row; a single
      // blip must not kill a long, healthy run.
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new RerunError("network", "audit status poll lost the server");
      }
      continue;
    }

    consecutiveFailures = 0;
    if (!status.running) {
      // Run finished. A non-null error means the background runAudit() threw —
      // surface it (the dashboard cache was NOT updated). Otherwise it's a clean
      // success: writeDashboardCache ran before finishRun(null).
      if (status.error) throw new RerunError("post_failed", status.error);
      return;
    }
  }
}
