// @vitest-environment node
/**
 * Real-payload coverage for the npm-lifecycle telemetry choke point.
 * package_installed / package_uninstalled both flow through trackInstallEvent,
 * so asserting the fetch body here guarantees `product: failproofai-oss` is
 * stamped on install/uninstall events too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trackInstallEvent } from "../../scripts/install-telemetry.mjs";

describe("install-telemetry trackInstallEvent", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
    process.env.npm_package_version = "9.9.9-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("stamps product: failproofai-oss on every event", async () => {
    await trackInstallEvent("package_installed", { hooks_configured: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event).toBe("package_installed");
    expect(body.properties.product).toBe("failproofai-oss");
    expect(body.properties.$lib).toBe("failproofai-install");
    expect(body.properties.hooks_configured).toBe(true);
  });

  it("is a no-op when telemetry is disabled", async () => {
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    await trackInstallEvent("package_installed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
