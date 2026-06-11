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
const MAX_POLL_MS = 5 * 60_000; // 5 min hard cap

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
  // Kick off the run. 409 (already running) is OK — we'll just poll.
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

  // Poll status until running flips false. The status route returns
  // `cachedAt`, which the polling caller can compare against the prior
  // value to detect "fresh result available" — but for `triggerRun`'s
  // purposes the `running: false` flip is the success signal.
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const sres = await fetchWithTimeout("/api/audit/status", { cache: "no-store" });
      if (!sres.ok) continue;
      const s = await sres.json() as { running: boolean };
      if (!s.running) return;
    } catch {
      // Transient (including per-request timeout) — keep polling until the
      // outer MAX_POLL_MS budget runs out.
    }
  }
  throw new RerunError("timeout", "audit poll loop timed out");
}
