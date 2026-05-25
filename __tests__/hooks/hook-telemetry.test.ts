// @vitest-environment node
/**
 * Real-payload coverage for the hook-binary telemetry choke point.
 * Every hook + audit event flows through trackHookEvent, so asserting the
 * fetch body here guarantees `product: failproofai-oss` is stamped on all of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trackHookEvent } from "../../src/hooks/hook-telemetry";

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
