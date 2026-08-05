// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Mock the heavy audit modules so the route is exercised in isolation: runAudit
// is replaced with a controllable promise, the cache write is a no-op, and the
// telemetry channel is a spy so we can assert the dashboard run funnel.
const {
  runAuditMock,
  writeCacheMock,
  trackEventMock,
  initTelemetryMock,
  acquireAuditLockMock,
  releaseSpy,
} = vi.hoisted(() => ({
  runAuditMock: vi.fn(),
  writeCacheMock: vi.fn(),
  trackEventMock: vi.fn(),
  initTelemetryMock: vi.fn(async () => {}),
  acquireAuditLockMock: vi.fn(),
  releaseSpy: vi.fn(),
}));
vi.mock("@/src/audit", () => ({ runAudit: runAuditMock }));
vi.mock("@/src/audit/dashboard-cache", () => ({ writeDashboardCache: writeCacheMock }));
vi.mock("@/lib/telemetry", () => ({ initTelemetry: initTelemetryMock, trackEvent: trackEventMock }));
// The route now also takes the cross-process audit lock. Mock it so the route
// is exercised in isolation — the real acquire writes to ~/.failproofai/run and
// installs a process-exit handler, neither of which belongs in a unit test (the
// lock's own semantics are covered by __tests__/audit/audit-lock.test.ts). The
// default grants the lock; a test overrides it to simulate a foreign holder.
vi.mock("@/src/audit/audit-lock", () => ({ acquireAuditLock: acquireAuditLockMock }));

import { POST } from "@/app/api/audit/run/route";
import { getRunState, releaseRun } from "@/app/api/audit/_state";

function req(body: string): NextRequest {
  return { text: async () => body } as unknown as NextRequest;
}

// A well-formed AuditResult so the route's audit_run_completed property reads
// (result.transcripts.scanned, result.totals.hits, …) don't throw.
function auditResult(over: Record<string, unknown> = {}) {
  return {
    eventsScanned: 1240,
    transcripts: { scanned: 18, skipped: 0, errors: 0, durationMs: 0 },
    projectsScanned: ["/a", "/b"],
    results: [{}, {}, {}],
    totals: { hits: 7, projectsWithHits: 2 },
    ...over,
  };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};
const trackedNames = () => trackEventMock.mock.calls.map((c) => c[0] as string);

describe("POST /api/audit/run (fire-and-forget)", () => {
  beforeEach(() => {
    releaseRun();
    runAuditMock.mockReset();
    writeCacheMock.mockReset();
    trackEventMock.mockReset();
    initTelemetryMock.mockClear();
    releaseSpy.mockReset();
    // Default: the cross-process lock is free and this run gets it. A handle
    // whose release() is a spy so we can assert it fires exactly when the scan
    // settles.
    acquireAuditLockMock.mockReset();
    acquireAuditLockMock.mockReturnValue({
      ok: true,
      lock: { info: { pid: process.pid, startedAt: Date.now(), source: "dashboard" }, release: releaseSpy },
    });
  });
  afterEach(() => releaseRun());

  it("returns 202 immediately WITHOUT awaiting the run, marks the lock, and emits audit_run_started", async () => {
    // runAudit never resolves during the test — if POST awaited it, this would
    // hang. Reaching the assertions proves the run is detached.
    runAuditMock.mockImplementation(() => new Promise<never>(() => {}));

    const res = await POST(req("{}"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ status: "started" });
    expect(getRunState().running).toBe(true);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(trackedNames()).toContain("audit_run_started");
  });

  it("409s WITHOUT starting a run when the cross-process lock is held elsewhere, and frees the in-memory lock", async () => {
    // A scheduled daemon child or a `failproofai audit` in another process holds
    // the shared cache lock. The dashboard must NOT co-write that cache — it
    // backs out and reports "already running" (information, not an error), and
    // crucially must release the in-memory lock it took first, or the next POST
    // would be wedged behind a run that never started.
    acquireAuditLockMock.mockReturnValue({
      ok: false,
      heldBy: { pid: 999999, startedAt: Date.now(), source: "scheduled" },
    });

    const res = await POST(req("{}"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ status: "already-running" }),
    );
    expect(runAuditMock).not.toHaveBeenCalled();
    expect(getRunState().running).toBe(false); // in-memory lock backed out
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_rejected",
      expect.objectContaining({ reason: "cross_process_lock" }),
    );
    // A run that never started must not have started the funnel either.
    expect(trackedNames()).not.toContain("audit_run_started");
  });

  it("409s a second concurrent run and tracks audit_run_rejected(already_running)", async () => {
    runAuditMock.mockImplementation(() => new Promise<never>(() => {}));

    const first = await POST(req("{}"));
    expect(first.status).toBe(202);

    const second = await POST(req("{}"));
    expect(second.status).toBe(409);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_rejected",
      expect.objectContaining({ reason: "already_running" }),
    );
  });

  it("tracks audit_run_failed, records the error, and releases the lock when the detached run throws", async () => {
    let reject!: (e: unknown) => void;
    runAuditMock.mockImplementation(() => new Promise((_res, rej) => { reject = rej; }));

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);
    expect(getRunState().running).toBe(true);

    reject(new Error("scan blew up"));
    await flush();

    const s = getRunState();
    expect(s.running).toBe(false);
    expect(s.error).toBe("scan blew up");
    expect(writeCacheMock).not.toHaveBeenCalled();
    // The cross-process lock is released even when the detached run throws, or a
    // failed scan would lock every other writer out for up to an hour.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(trackedNames()).toContain("audit_run_failed");
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_failed",
      expect.objectContaining({ error_type: "Error", error_message: "scan blew up" }),
    );
  });

  it("writes the cache, tracks audit_run_completed with metrics, and clears the lock on success", async () => {
    let resolveRun!: (value: unknown) => void;
    runAuditMock.mockImplementation(() => new Promise((res) => { resolveRun = res; }));
    writeCacheMock.mockReturnValue(true);

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);
    expect(getRunState().running).toBe(true);

    resolveRun(auditResult());
    await flush();

    expect(writeCacheMock).toHaveBeenCalledTimes(1);
    expect(getRunState()).toMatchObject({ running: false, error: null });
    // Lock released on the success path too — held only for the scan's duration.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_completed",
      expect.objectContaining({
        source: "dashboard",
        events_scanned: 1240,
        sessions_scanned: 18,
        findings: 3,
        total_hits: 7,
        persisted: true,
      }),
    );
  });

  it("reports a run error when the result cannot be persisted (cache write fails)", async () => {
    let resolveRun!: (value: unknown) => void;
    runAuditMock.mockImplementation(() => new Promise((res) => { resolveRun = res; }));
    // writeDashboardCache swallows its own IO errors and returns false; in
    // fire-and-forget the cache is the only delivery channel, so a failed
    // persist must surface as a run error rather than a silent success.
    writeCacheMock.mockReturnValue(false);

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);

    resolveRun(auditResult());
    await flush();

    const s = getRunState();
    expect(s.running).toBe(false);
    expect(s.error).toBeTruthy();
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_completed",
      expect.objectContaining({ persisted: false }),
    );
  });

  it("400s a non-object JSON body and tracks audit_run_rejected(non_object_body)", async () => {
    const res = await POST(req("[]"));
    expect(res.status).toBe(400);
    expect(getRunState().running).toBe(false);
    expect(runAuditMock).not.toHaveBeenCalled();
    expect(trackEventMock).toHaveBeenCalledWith(
      "audit_run_rejected",
      expect.objectContaining({ reason: "non_object_body" }),
    );
  });
});
