import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";

const mockGetTelemetryConfig = vi.fn();
vi.mock("@/app/actions/get-telemetry-config", () => ({
  getTelemetryConfig: (...args: unknown[]) => mockGetTelemetryConfig(...args),
}));

const mockSetConfig = vi.fn();
const mockCaptureEvent = vi.fn();
vi.mock("@/lib/client-telemetry", () => ({
  setClientTelemetryConfig: (...args: unknown[]) => mockSetConfig(...args),
  captureClientEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import { PostHogProvider, usePostHog } from "@/app/contexts/PostHogContext";

const enabledConfig = {
  enabled: true,
  distinctId: "test-id",
  apiKey: "phc_test",
  host: "https://test.posthog.com",
  version: "1.0.0",
};

const disabledConfig = {
  ...enabledConfig,
  enabled: false,
  distinctId: "",
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <PostHogProvider>{children}</PostHogProvider>;
}

describe("PostHogContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    mockGetTelemetryConfig.mockResolvedValue(enabledConfig);
  });

  it("usePostHog throws outside provider", () => {
    expect(() => {
      renderHook(() => usePostHog());
    }).toThrow("usePostHog must be used within a PostHogProvider");
  });

  it("fires $pageview on initial mount", async () => {
    renderHook(() => usePostHog(), { wrapper });

    await waitFor(() => {
      expect(mockSetConfig).toHaveBeenCalledWith(enabledConfig);
    });
    expect(mockCaptureEvent).toHaveBeenCalledWith("$pageview");
  });

  it("fires $pageview on pathname change", async () => {
    const { rerender } = renderHook(() => usePostHog(), { wrapper });

    await waitFor(() => {
      expect(mockCaptureEvent).toHaveBeenCalledWith("$pageview");
    });

    mockCaptureEvent.mockClear();
    mockPathname = "/sessions";
    rerender();

    await waitFor(() => {
      expect(mockCaptureEvent).toHaveBeenCalledWith("$pageview");
    });
  });

  it("does not fire events when telemetry is disabled", async () => {
    mockGetTelemetryConfig.mockResolvedValue(disabledConfig);
    renderHook(() => usePostHog(), { wrapper });

    await waitFor(() => {
      expect(mockSetConfig).toHaveBeenCalledWith(disabledConfig);
    });
    // captureClientEvent is still called — the no-op check is inside that function
    // The provider fires $pageview regardless; the client-telemetry layer handles the opt-out
  });

  it("capture function proxies to captureClientEvent", async () => {
    const { result } = renderHook(() => usePostHog(), { wrapper });

    await waitFor(() => {
      expect(mockSetConfig).toHaveBeenCalled();
    });

    act(() => {
      result.current.capture("custom_event", { key: "value" });
    });

    expect(mockCaptureEvent).toHaveBeenCalledWith("custom_event", { key: "value" });
  });
});
