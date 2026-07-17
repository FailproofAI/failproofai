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

import { runAuditCli, runPostSetupAudit } from "../../src/audit/cli";

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
      error_message: "disk exploded",
    });
    expect(exitInfo?.code).toBe(1);
    // The fix: failed must have RESOLVED before the exit fired.
    expect(exitInfo?.resolvedAtExit.has("cli_audit_failed")).toBe(true);
  });
});

/**
 * The onboarding auto-audit — the FIRST audit any new user runs — previously
 * emitted nothing at all, so first-run audits were invisible in PostHog while
 * explicit `failproofai audit` runs reported normally.
 */
describe("post-setup (onboarding) audit telemetry", () => {
  afterEach(() => {
    delete process.env.FAILPROOFAI_NO_AUTO_AUDIT;
  });

  it("emits cli_audit_started then cli_audit_completed, tagged source=onboarding", async () => {
    h.runAudit.mockResolvedValue(result({ eventsScanned: 100, totals: { hits: 2, projectsWithHits: 1 } }));

    await runPostSetupAudit();

    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_started", {
      source: "onboarding",
    });
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_completed", {
      source: "onboarding",
      events_scanned: 100,
      sessions_scanned: 3,
      total_hits: 2,
      findings: 0,
    });
  });

  // source is what separates the onboarding run from a deliberate one in PostHog.
  it("distinguishes itself from an explicit `failproofai audit` run", async () => {
    h.runAudit.mockResolvedValue(result({}));

    await runPostSetupAudit();
    const onboarding = h.trackHookEvent.mock.calls.map((c) => (c[2] as { source: string }).source);

    expect(new Set(onboarding)).toEqual(new Set(["onboarding"]));
  });

  it("emits cli_audit_failed when the scan throws, and still does not throw", async () => {
    h.runAudit.mockRejectedValue(new TypeError("disk exploded"));

    await expect(runPostSetupAudit()).resolves.toBeUndefined();

    expect(names()).toEqual(["cli_audit_started", "cli_audit_failed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_failed", {
      source: "onboarding",
      error_type: "TypeError",
      error_message: "disk exploded",
    });
  });

  // Mirrors runAuditCli, which reports completed regardless of what it found —
  // a fresh user with no agent history is exactly who we want counted.
  it("still emits cli_audit_completed when there is no history to scan", async () => {
    h.runAudit.mockResolvedValue(
      result({ eventsScanned: 0, transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 } }),
    );

    await runPostSetupAudit();

    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_completed", {
      source: "onboarding",
      events_scanned: 0,
      sessions_scanned: 0,
      total_hits: 0,
      findings: 0,
    });
    // Nothing found — no point warming a cache or opening a dashboard.
    expect(h.writeDashboardCache).not.toHaveBeenCalled();
  });

  it("emits nothing when the auto-audit is opted out", async () => {
    process.env.FAILPROOFAI_NO_AUTO_AUDIT = "1";

    await runPostSetupAudit();

    expect(names()).toEqual([]);
    expect(h.runAudit).not.toHaveBeenCalled();
  });

  it("never exits the process — onboarding must continue to the dashboard", async () => {
    h.runAudit.mockResolvedValue(result({}));

    await runPostSetupAudit();

    expect(exitInfo).toBeNull();
  });
});
