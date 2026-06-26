import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setClientTelemetryConfig,
  captureClientEvent,
} from "@/lib/client-telemetry";
import type { TelemetryConfig } from "@/app/actions/get-telemetry-config";

const enabledConfig: TelemetryConfig = {
  enabled: true,
  distinctId: "test-id",
  apiKey: "phc_test",
  host: "https://test.posthog.com",
  version: "1.0.0-test",
};

describe("client-telemetry", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // Reset config to null by setting a disabled config then re-enabling
    setClientTelemetryConfig(null as unknown as TelemetryConfig);
  });

  it("no-ops when config is null", () => {
    captureClientEvent("$pageview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when config.enabled is false", () => {
    setClientTelemetryConfig({ ...enabledConfig, enabled: false });
    captureClientEvent("$pageview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch with correct PostHog payload when enabled", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview", { extra: "prop" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://test.posthog.com/capture/");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("$pageview");
    expect(body.distinct_id).toBe("test-id");
    expect(body.properties.$lib).toBe("failproofai-web");
    expect(body.properties.failproofai_version).toBe("1.0.0-test");
    expect(body.properties.product).toBe("failproofai-oss");
    expect(body.properties.extra).toBe("prop");
  });

  it("sets keepalive:true so events survive a page navigation/unload", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview");
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it("includes $current_url and $pathname in properties", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties).toHaveProperty("$current_url");
    expect(body.properties).toHaveProperty("$pathname");
  });

  it("strips trailing slashes from host before appending /capture/", () => {
    setClientTelemetryConfig({ ...enabledConfig, host: "https://test.posthog.com/" });
    captureClientEvent("$pageview");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toBe("https://test.posthog.com/capture/");
  });

  it("swallows fetch errors silently", () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));
    setClientTelemetryConfig(enabledConfig);

    // Should not throw
    expect(() => captureClientEvent("$pageview")).not.toThrow();
  });
});
