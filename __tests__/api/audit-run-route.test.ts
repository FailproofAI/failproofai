// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Mock the heavy audit modules so the route is exercised in isolation: runAudit
// is replaced with a controllable promise, and the cache write is a no-op.
const { runAuditMock, writeCacheMock } = vi.hoisted(() => ({
  runAuditMock: vi.fn(),
  writeCacheMock: vi.fn(),
}));
vi.mock("@/src/audit", () => ({ runAudit: runAuditMock }));
vi.mock("@/src/audit/dashboard-cache", () => ({ writeDashboardCache: writeCacheMock }));

import { POST } from "@/app/api/audit/run/route";
import { getRunState, releaseRun } from "@/app/api/audit/_state";

function req(body: string): NextRequest {
  return { text: async () => body } as unknown as NextRequest;
}

describe("POST /api/audit/run (fire-and-forget)", () => {
  beforeEach(() => {
    releaseRun();
    runAuditMock.mockReset();
    writeCacheMock.mockReset();
  });
  afterEach(() => releaseRun());

  it("returns 202 immediately WITHOUT awaiting the run, and marks the lock running", async () => {
    // runAudit never resolves during the test — if POST awaited it, this would
    // hang. Reaching the assertions proves the run is detached.
    runAuditMock.mockImplementation(() => new Promise<never>(() => {}));

    const res = await POST(req("{}"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ status: "started" });
    expect(getRunState().running).toBe(true);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
  });

  it("409s a second concurrent run while one is in flight", async () => {
    runAuditMock.mockImplementation(() => new Promise<never>(() => {}));

    const first = await POST(req("{}"));
    expect(first.status).toBe(202);

    const second = await POST(req("{}"));
    expect(second.status).toBe(409);
    // The detached first run is still the only one that ran.
    expect(runAuditMock).toHaveBeenCalledTimes(1);
  });

  it("records the error and releases the lock when the detached run throws", async () => {
    let reject!: (e: unknown) => void;
    runAuditMock.mockImplementation(() => new Promise((_res, rej) => { reject = rej; }));

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);
    expect(getRunState().running).toBe(true);

    // Fail the background run and let its .catch settle.
    reject(new Error("scan blew up"));
    await Promise.resolve();
    await Promise.resolve();

    const s = getRunState();
    expect(s.running).toBe(false);
    expect(s.error).toBe("scan blew up");
    expect(writeCacheMock).not.toHaveBeenCalled();
  });

  it("writes the cache and clears the lock when the detached run succeeds", async () => {
    let resolveRun!: (value: unknown) => void;
    runAuditMock.mockImplementation(
      () => new Promise((res) => { resolveRun = res; }),
    );
    writeCacheMock.mockReturnValue(true);

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);
    expect(getRunState().running).toBe(true);

    // Complete the detached run and let its .then settle.
    resolveRun({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(writeCacheMock).toHaveBeenCalledTimes(1);
    expect(getRunState()).toMatchObject({ running: false, error: null });
  });

  it("reports a run error when the result cannot be persisted (cache write fails)", async () => {
    let resolveRun!: (value: unknown) => void;
    runAuditMock.mockImplementation(
      () => new Promise((res) => { resolveRun = res; }),
    );
    // writeDashboardCache swallows its own IO errors and returns false; in
    // fire-and-forget the cache is the only delivery channel, so a failed
    // persist must surface as a run error rather than a silent success.
    writeCacheMock.mockReturnValue(false);

    const res = await POST(req("{}"));
    expect(res.status).toBe(202);

    resolveRun({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    const s = getRunState();
    expect(s.running).toBe(false);
    expect(s.error).toBeTruthy();
  });

  it("400s a non-object JSON body", async () => {
    const res = await POST(req("[]"));
    expect(res.status).toBe(400);
    expect(getRunState().running).toBe(false);
    expect(runAuditMock).not.toHaveBeenCalled();
  });
});
