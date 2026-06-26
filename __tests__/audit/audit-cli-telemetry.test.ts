// @vitest-environment node
/**
 * Reliability coverage for `failproofai audit` telemetry (cli_audit_*).
 *
 * The bug this guards: the started/completed/failed events were emitted
 * fire-and-forget (`void trackHookEvent(...)`) and then the failed path calls
 * die()->process.exit(1) and the empty-history path calls process.exit(0)
 * immediately after — killing the in-flight fetch before it lands, so those
 * events never reached PostHog. The fix awaits the two exit-adjacent events.
 *
 * These tests prove (a) each path emits its event, and (b) the exit-adjacent
 * events are actually AWAITED — process.exit is observed to fire only after the
 * event's promise has resolved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuditResult } from "../../src/audit/types";

const resolvedEvents = new Set<string>();

const h = vi.hoisted(() => ({
  trackHookEvent: vi.fn(),
  runAudit: vi.fn(),
  writeDashboardCache: vi.fn(() => true),
  openWhenReady: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: h.trackHookEvent }));
vi.mock("../../src/audit/index", () => ({ runAudit: h.runAudit }));
vi.mock("../../src/audit/dashboard-cache", () => ({ writeDashboardCache: h.writeDashboardCache }));
vi.mock("../../src/audit/open-browser", () => ({ openWhenReady: h.openWhenReady }));
vi.mock("../../scripts/launch", () => ({ launch: h.launch }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: () => "test-instance" }));

import { runAuditCli } from "../../src/audit/cli";

function result(over: Partial<AuditResult>): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-06-26T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 3, skipped: 0, errors: 0, durationMs: 0 },
    results: [],
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 100,
    enabledBuiltinNames: [],
    ...over,
  };
}

let exitInfo: { code: number | undefined; resolvedAtExit: Set<string> } | null;

beforeEach(() => {
  vi.clearAllMocks();
  resolvedEvents.clear();
  exitInfo = null;
  // Exit-adjacent events resolve on a macrotask so we can prove the caller
  // awaited them (the resolved-set is checked at process.exit time). Others
  // resolve immediately.
  h.trackHookEvent.mockImplementation((_id: string, name: string) => {
    if (name === "cli_audit_completed" || name === "cli_audit_failed") {
      return new Promise<void>((res) =>
        setTimeout(() => {
          resolvedEvents.add(name);
          res();
        }, 5),
      );
    }
    return Promise.resolve();
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitInfo = { code, resolvedAtExit: new Set(resolvedEvents) };
    throw new Error("__EXIT__");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const names = () => h.trackHookEvent.mock.calls.map((c) => c[1] as string);

describe("failproofai audit telemetry", () => {
  it("emits cli_audit_started then cli_audit_completed and launches the dashboard (happy path)", async () => {
    h.runAudit.mockResolvedValue(result({ eventsScanned: 100, totals: { hits: 2, projectsWithHits: 1 } }));

    await runAuditCli([]);

    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_completed", {
      source: "cli",
      events_scanned: 100,
      sessions_scanned: 3,
      total_hits: 2,
      findings: 0,
    });
    expect(h.launch).toHaveBeenCalledWith("start");
    expect(exitInfo).toBeNull(); // happy path never exits — launch() keeps the process alive
  });

  it("awaits cli_audit_completed before process.exit(0) on the empty-history path", async () => {
    h.runAudit.mockResolvedValue(result({ eventsScanned: 0, transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 } }));

    await expect(runAuditCli([])).rejects.toThrow("__EXIT__");

    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
    expect(exitInfo?.code).toBe(0);
    // The fix: completed must have RESOLVED before the exit fired.
    expect(exitInfo?.resolvedAtExit.has("cli_audit_completed")).toBe(true);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("awaits cli_audit_failed before die()/process.exit(1) when the scan throws", async () => {
    h.runAudit.mockRejectedValue(new TypeError("disk exploded"));

    await expect(runAuditCli([])).rejects.toThrow("__EXIT__");

    expect(names()).toEqual(["cli_audit_started", "cli_audit_failed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_failed", {
      source: "cli",
      error_type: "TypeError",
    });
    expect(exitInfo?.code).toBe(1);
    // The fix: failed must have RESOLVED before the exit fired.
    expect(exitInfo?.resolvedAtExit.has("cli_audit_failed")).toBe(true);
  });
});
