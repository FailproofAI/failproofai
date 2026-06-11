// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchWithTimeout,
  isAbortError,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "@/lib/fetch-with-timeout";

/**
 * Helper: install a fetch mock that resolves when the request signal
 * aborts (rejecting with `signal.reason`), so the tests can exercise the
 * timeout / external-signal paths without real network or real time.
 */
function installAbortAwareFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
}

describe("fetchWithTimeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the response on the happy path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const res = await fetchWithTimeout("/api/x");
    expect(res.status).toBe(200);
  });

  it("forwards a composed AbortSignal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    const external = new AbortController();
    await fetchWithTimeout("/api/x", { signal: external.signal });
    const passedInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(passedInit.signal).toBeInstanceOf(AbortSignal);
    // Composed signal must NOT be the raw external one — otherwise the
    // timeout half of the union would be missing.
    expect(passedInit.signal).not.toBe(external.signal);
  });

  it("passes the raw timeout signal when no external signal is supplied", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await fetchWithTimeout("/api/x");
    const passedInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(passedInit.signal).toBeInstanceOf(AbortSignal);
    expect(passedInit.signal?.aborted).toBe(false);
  });

  it("rejects with a TimeoutError when the timeout fires", async () => {
    installAbortAwareFetch();
    await expect(
      fetchWithTimeout("/api/slow", {}, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rejects when the caller's external signal aborts", async () => {
    installAbortAwareFetch();
    const ctrl = new AbortController();
    const promise = fetchWithTimeout("/api/x", { signal: ctrl.signal }, 30_000);
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately if the caller's external signal is already aborted", async () => {
    installAbortAwareFetch();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      fetchWithTimeout("/api/x", { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates a non-abort fetch rejection unchanged", async () => {
    const boom = new TypeError("network down");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(boom);
    await expect(fetchWithTimeout("/api/x")).rejects.toBe(boom);
  });

  it("DEFAULT_FETCH_TIMEOUT_MS exceeds the 10s api-server budget", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});

describe("isAbortError", () => {
  it("matches user-cancelled aborts (AbortError)", () => {
    expect(isAbortError(new DOMException("user aborted", "AbortError"))).toBe(true);
  });

  it("matches AbortSignal.timeout firings (TimeoutError)", () => {
    expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  it("does not match generic errors", () => {
    expect(isAbortError(new Error("network failure"))).toBe(false);
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
  });

  it("does not match primitives", () => {
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(123)).toBe(false);
    expect(isAbortError(true)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it("duck-types objects with matching name (covers cross-realm errors)", () => {
    // Production callers always pass values caught from try/catch — the
    // universe of inputs is narrow enough that we accept any object
    // shaped like an abort error, regardless of its Error prototype
    // chain (jsdom's polyfilled DOMException, cross-realm fetches, etc.).
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ name: "TimeoutError" })).toBe(true);
    expect(isAbortError({ name: "TypeError" })).toBe(false);
  });
});
