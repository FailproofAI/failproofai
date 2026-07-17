// @vitest-environment node
/**
 * Real-payload coverage for the install telemetry choke point.
 * first_install / version_changed / package_installed all flow through
 * trackInstallEvent, so asserting the fetch body here guarantees
 * `product: failproofai-oss` is stamped on every install event.
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

  // npm only sets npm_package_version inside a lifecycle script. These events now
  // fire from the CLI, so the caller supplies the version explicitly.
  it("prefers an explicitly-passed version over npm_package_version", async () => {
    await trackInstallEvent("first_install", {}, { version: "1.2.3" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties.failproofai_version).toBe("1.2.3");
  });

  it("reports the real version when npm_package_version is absent (the CLI case)", async () => {
    delete process.env.npm_package_version;
    await trackInstallEvent("first_install", {}, { version: "4.5.6" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties.failproofai_version).toBe("4.5.6");
    expect(body.properties.failproofai_version).not.toBe("unknown");
  });
});
