import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on fetchWithTimeout while keeping the real isAbortError /
// DEFAULT_FETCH_TIMEOUT_MS exports intact.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/fetch-with-timeout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/fetch-with-timeout")>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

import {
  paramsToBody,
  triggerRun,
  RerunError,
} from "@/app/audit/_components/rerun-button";

describe("paramsToBody", () => {
  it("omits cli/since/noCache by default (all CLIs, all time, cache on)", () => {
    expect(paramsToBody({ cli: [], since: "all" })).toEqual({
      cli: undefined,
      since: undefined,
      noCache: undefined,
    });
  });

  it("forwards a since window and selected clis", () => {
    expect(paramsToBody({ cli: ["claude"], since: "30d" })).toEqual({
      cli: ["claude"],
      since: "30d",
      noCache: undefined,
    });
  });

  it("sets noCache:true so an explicit re-audit forces a fresh scan", () => {
    expect(paramsToBody({ cli: [], since: "30d", noCache: true })).toEqual({
      cli: undefined,
      since: "30d",
      noCache: true,
    });
  });

  it("leaves noCache undefined when false or absent (uses the cache)", () => {
    expect(paramsToBody({ cli: [], since: "30d", noCache: false }).noCache).toBeUndefined();
    expect(paramsToBody({ cli: [], since: "30d" }).noCache).toBeUndefined();
  });
});

describe("triggerRun", () => {
  // Mirrors the (unexported) constants in rerun-button.tsx.
  const POLL_INTERVAL_MS = 1000;
  const MAX_CONSECUTIVE_POLL_FAILURES = 10;

  const POST_STARTED = { ok: true, status: 202 } as unknown as Response;

  function statusResponse(body: { running: boolean; error?: string | null }) {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the run starts (202) and the first status poll reports finished", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") return Promise.resolve(POST_STARTED);
      return Promise.resolve(statusResponse({ running: false, error: null }));
    });

    vi.useFakeTimers();
    const settled = triggerRun({ cli: [], since: "all" }).then(
      () => "resolved",
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50);
    expect(await settled).toBe("resolved");

    // The kickoff POST uses the default fast timeout (no explicit override) —
    // it only times the 202 kickoff, not the run.
    const runCall = fetchMock.mock.calls.find((c) => c[0] === "/api/audit/run");
    expect(runCall?.[2]).toBeUndefined();
  });

  it("keeps polling with no duration cap — a run still going past 5 minutes is not aborted", async () => {
    let polls = 0;
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") return Promise.resolve(POST_STARTED);
      polls += 1;
      // Stay "running" for >5 minutes of 1s polls (the old MAX_POLL_MS cap),
      // then finish — proving the client never gives up on a long run.
      return Promise.resolve(statusResponse({ running: polls < 320, error: null }));
    });

    vi.useFakeTimers();
    const settled = triggerRun({ cli: [], since: "all" }).then(
      () => "resolved",
      (e) => e,
    );
    // Advance ~5.5 minutes of polling.
    await vi.advanceTimersByTimeAsync(330 * POLL_INTERVAL_MS);
    expect(await settled).toBe("resolved");
    expect(polls).toBeGreaterThanOrEqual(320);
  });

  it("rejects post_failed when the finished run reports a server-side error", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") return Promise.resolve(POST_STARTED);
      return Promise.resolve(statusResponse({ running: false, error: "scan blew up" }));
    });

    vi.useFakeTimers();
    const settled = triggerRun({ cli: [], since: "all" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50);
    const err = await settled;
    expect(err).toBeInstanceOf(RerunError);
    expect(err.kind).toBe("post_failed");
    expect(err.message).toBe("scan blew up");
  });

  it("rejects network only after consecutive status failures, not on a single blip", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") return Promise.resolve(POST_STARTED);
      return Promise.reject(new TypeError("connection refused"));
    });

    vi.useFakeTimers();
    const settled = triggerRun({ cli: [], since: "all" }).catch((e) => e);
    // Drive past the backstop: MAX_CONSECUTIVE_POLL_FAILURES polls at 1s each.
    await vi.advanceTimersByTimeAsync((MAX_CONSECUTIVE_POLL_FAILURES + 1) * POLL_INTERVAL_MS);
    const err = await settled;
    expect(err).toBeInstanceOf(RerunError);
    expect(err.kind).toBe("network");
  });

  it("rejects post_failed when the kickoff POST is not ok", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "boom",
        } as unknown as Response);
      }
      return Promise.resolve(statusResponse({ running: false, error: null }));
    });

    const err = await triggerRun({ cli: [], since: "all" }).catch((e) => e);
    expect(err).toBeInstanceOf(RerunError);
    expect(err.kind).toBe("post_failed");
  });

  it("treats a 409 (already running) as success and polls the in-flight run to completion", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (url === "/api/audit/run") {
        return Promise.resolve({ ok: false, status: 409 } as unknown as Response);
      }
      return Promise.resolve(statusResponse({ running: false, error: null }));
    });

    vi.useFakeTimers();
    const settled = triggerRun({ cli: [], since: "all" }).then(
      () => "resolved",
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50);
    expect(await settled).toBe("resolved");
  });
});
