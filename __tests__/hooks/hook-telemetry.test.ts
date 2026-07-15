// @vitest-environment node
/**
 * Real-payload coverage for the hook-binary telemetry choke point.
 * Every hook + audit event flows through trackHookEvent, so asserting the
 * fetch body here guarantees `product: failproofai-oss` is stamped on all of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trackHookEvent, flushHookTelemetry } from "../../src/hooks/hook-telemetry";

describe("hook-telemetry trackHookEvent", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("stamps product: failproofai-oss on every event", async () => {
    await trackHookEvent("inst-id", "hooks_installed", { count: 1 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event).toBe("hooks_installed");
    expect(body.distinct_id).toBe("inst-id");
    expect(body.properties.product).toBe("failproofai-oss");
    expect(body.properties.$lib).toBe("failproofai-hooks");
    expect(body.properties.failproofai_version).toEqual(expect.any(String));
    expect(body.properties.count).toBe(1);
  });

  it("stamps product even when no extra properties are passed", async () => {
    await trackHookEvent("inst-id", "audit_started");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties.product).toBe("failproofai-oss");
  });

  it("is a no-op when telemetry is disabled", async () => {
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    await trackHookEvent("inst-id", "hooks_installed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("flushHookTelemetry", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("resolves instantly when nothing is pending", async () => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(flushHookTelemetry()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("awaits an un-awaited (void) event so the POST completes before exit", async () => {
    // Control when the fetch settles to prove flush actually waits for it.
    let resolveFetch!: (r: Response) => void;
    fetchSpy = vi.fn(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Fire WITHOUT awaiting — this is exactly how the handler's load/error
    // events are sent (`void trackHookEvent(...)`).
    void trackHookEvent("inst-id", "custom_hooks_loaded", { n: 1 });
    await Promise.resolve(); // let the pending promise register
    expect(fetchSpy).toHaveBeenCalledOnce();

    let flushed = false;
    const flushP = flushHookTelemetry().then(() => { flushed = true; });

    // Fetch is still in flight → flush must not have resolved yet.
    await Promise.resolve();
    expect(flushed).toBe(false);

    // Once the POST settles, flush drains and resolves.
    resolveFetch(new Response("{}", { status: 200 }));
    await flushP;
    expect(flushed).toBe(true);
  });

  it("does not throw when an in-flight POST rejects", async () => {
    fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    void trackHookEvent("inst-id", "custom_hooks_loaded");
    await Promise.resolve();

    await expect(flushHookTelemetry()).resolves.toBeUndefined();
  });
});
