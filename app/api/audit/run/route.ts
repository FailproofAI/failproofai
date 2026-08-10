/**
 * POST /api/audit/run — start a `runAudit()` call in the background and return
 * `202 { status: "started" }` immediately. The run is fire-and-forget: it
 * executes as a detached task in this long-lived server process (NOT awaited by
 * the handler), writes the dashboard cache on success, and records its outcome
 * in `_state.ts`. The client (rerun-button.tsx) polls /api/audit/status until
 * the run finishes — there is deliberately no per-request or per-run time cap,
 * so a cold all-history scan runs to completion however long it takes.
 *
 * Concurrency: a module-level singleton in `_state.ts` guards against
 * overlapping runs — the second concurrent POST gets a 409. The client then
 * just falls back to polling /status for the in-flight run.
 */
import { NextRequest, NextResponse } from "next/server";
import { runAudit } from "@/src/audit";
import { writeDashboardCache } from "@/src/audit/dashboard-cache";
import { INTEGRATION_TYPES, type IntegrationType } from "@/src/hooks/types";
import type { RunAuditOptions } from "@/src/audit/types";
import { finishRun, tryAcquireRun } from "../_state";
import { acquireAuditLock } from "@/src/audit/audit-lock";
import { initTelemetry, trackEvent } from "@/lib/telemetry";
import { sanitizeErrorMessage } from "@/lib/telemetry-sanitize";

export const dynamic = "force-dynamic";

interface RunBody {
  since?: string;
  cli?: string[];
  project?: string[];
  policy?: string[];
  noCache?: boolean;
}

const VALID_CLIS = new Set<string>(INTEGRATION_TYPES);

function sanitize(body: RunBody): RunAuditOptions {
  const opts: RunAuditOptions = {};
  if (typeof body.since === "string" && body.since.trim()) {
    opts.since = body.since.trim();
  }
  if (Array.isArray(body.cli) && body.cli.length > 0) {
    const valid = body.cli.filter((c): c is IntegrationType =>
      typeof c === "string" && VALID_CLIS.has(c)
    );
    if (valid.length > 0) opts.clis = valid;
  }
  if (Array.isArray(body.project) && body.project.length > 0) {
    opts.projects = body.project.filter((p) => typeof p === "string");
  }
  if (Array.isArray(body.policy) && body.policy.length > 0) {
    opts.policies = body.policy.filter((p) => typeof p === "string");
  }
  if (body.noCache === true) opts.noCache = true;
  return opts;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // initTelemetry never throws; init up front so every exit path (incl. the
  // 400/409 rejections and the detached run task below) can report. The
  // dashboard is a long-lived process, so trackEvent's background flush
  // delivers even after this handler returns 202.
  await initTelemetry();
  let body: RunBody = {};
  try {
    const raw = await request.text();
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      // JSON.parse("null") returns null and JSON.parse("[]") returns an
      // array — both pass the catch but break sanitize()'s field access.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        trackEvent("audit_run_rejected", { source: "dashboard", reason: "non_object_body" });
        return NextResponse.json(
          { error: "Request body must be a JSON object" },
          { status: 400 },
        );
      }
      body = parsed as RunBody;
    }
  } catch {
    trackEvent("audit_run_rejected", { source: "dashboard", reason: "invalid_json" });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const opts = sanitize(body);

  if (!tryAcquireRun()) {
    trackEvent("audit_run_rejected", { source: "dashboard", reason: "already_running" });
    return NextResponse.json(
      { error: "Audit already running", status: "already-running" },
      { status: 409 },
    );
  }

  // The in-memory lock above only serialises runs WITHIN this Next.js process.
  // The scheduled daemon child and a manual `failproofai audit` are separate
  // processes writing the same sha1-keyed per-transcript cache and the same
  // single-slot dashboard cache — three writers, and the module singleton is
  // blind to the other two. Take the cross-process lock as well so this run
  // cannot co-write that cache with one of them. Held ⇒ back the in-memory lock
  // out and report "already running" — the same 409 the client already treats
  // as "poll the in-flight run"; /api/audit/status reflects the cross-process
  // lock via readActiveAuditLock, so the poll waits out the external scan rather
  // than reading the machine as idle. This is information, not an error.
  const auditLock = acquireAuditLock("dashboard");
  if (!auditLock.ok) {
    finishRun(null); // release the in-memory lock we just took
    trackEvent("audit_run_rejected", { source: "dashboard", reason: "cross_process_lock" });
    return NextResponse.json(
      { error: "Audit already running", status: "already-running" },
      { status: 409 },
    );
  }

  // Mirror the CLI's cli_audit_* funnel for the dashboard path (which shares the
  // same runAudit() core but previously emitted no server telemetry at all).
  trackEvent("audit_run_started", {
    source: "dashboard",
    since: opts.since ?? null,
    no_cache: opts.noCache === true,
    cli_count: opts.clis?.length ?? 0,
    project_count: opts.projects?.length ?? 0,
  });
  const startedAt = Date.now();

  // Fire-and-forget: a cold, all-history scan can run far longer than any HTTP
  // request should stay open — and longer than Node's `server.requestTimeout`
  // on the standalone production server. Start runAudit() as a detached task in
  // this long-lived server process and return immediately; the client polls
  // /api/audit/status until `running` flips false. The task settles the lock
  // via finishRun() in its own try/catch, surfacing any error through /status.
  void (async () => {
    try {
      const result = await runAudit(opts);
      // The cache is the only channel by which a detached run's result reaches
      // the client (the POST already returned 202), so a failed persist is a
      // failed run from the user's view — surface it instead of reporting OK.
      const persisted = writeDashboardCache(opts, result);
      trackEvent("audit_run_completed", {
        source: "dashboard",
        duration_ms: Date.now() - startedAt,
        events_scanned: result.eventsScanned,
        sessions_scanned: result.transcripts.scanned,
        projects_scanned: result.projectsScanned.length,
        findings: result.results.length,
        total_hits: result.totals.hits,
        persisted,
      });
      finishRun(persisted ? null : "audit finished but its result could not be saved");
    } catch (err) {
      trackEvent("audit_run_failed", {
        source: "dashboard",
        duration_ms: Date.now() - startedAt,
        error_type: err instanceof Error ? err.name : "unknown",
        error_message: sanitizeErrorMessage(err),
      });
      finishRun(err instanceof Error ? err.message : String(err));
    } finally {
      // Release the cross-process lock the moment the scan settles — before the
      // in-memory lock is even relevant again — so the next scheduled tick or a
      // `failproofai audit` is not locked out longer than the scan actually ran.
      // Idempotent and never throws; the process-exit hook is the backstop if
      // this task is killed outright.
      auditLock.lock.release();
    }
  })();

  return NextResponse.json({ status: "started" }, { status: 202 });
}
