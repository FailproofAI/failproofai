// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock posthog-node before any imports that might trigger it
const mockCapture = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockShutdown = vi.fn().mockResolvedValue(undefined);

let lastConstructorOpts: Record<string, unknown> | undefined;

vi.mock("posthog-node", () => {
  return {
    PostHog: class MockPostHog {
      capture = mockCapture;
      flush = mockFlush;
      shutdown = mockShutdown;
      constructor(_apiKey: string, opts: Record<string, unknown>) {
        lastConstructorOpts = opts;
      }
    },
  };
});

vi.mock("@/lib/telemetry-id", () => ({
  getInstanceId: () => "test-instance-id",
}));

import {
  isTelemetryEnabled,
  initTelemetry,
  trackEvent,
  flushTelemetry,
  shutdownTelemetry,
} from "@/lib/telemetry";

describe("lib/telemetry", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset globalThis client between tests
    globalThis.__FAILPROOFAI_POSTHOG__ = undefined;
    lastConstructorOpts = undefined;
    mockCapture.mockClear();
    mockShutdown.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isTelemetryEnabled", () => {
    it("returns true by default", () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('returns false when FAILPROOFAI_TELEMETRY_DISABLED is "1"', () => {
      process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
      expect(isTelemetryEnabled()).toBe(false);
    });

    it("returns true for other values of the env var", () => {
      process.env.FAILPROOFAI_TELEMETRY_DISABLED = "0";
      expect(isTelemetryEnabled()).toBe(true);
    });
  });

  describe("initTelemetry", () => {
    it("is a no-op when telemetry is disabled", async () => {
      process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
      await initTelemetry();
      expect(globalThis.__FAILPROOFAI_POSTHOG__).toBeUndefined();
    });

    it("creates a PostHog client when enabled", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      expect(globalThis.__FAILPROOFAI_POSTHOG__).toBeDefined();
    });

    it("passes custom resilientFetch to PostHog constructor", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      expect(lastConstructorOpts).toBeDefined();
      expect(lastConstructorOpts!.fetch).toBeTypeOf("function");
      expect(lastConstructorOpts!.fetchRetryCount).toBe(0);
    });

    it("reuses existing client on subsequent calls", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      const first = globalThis.__FAILPROOFAI_POSTHOG__;
      await initTelemetry();
      expect(globalThis.__FAILPROOFAI_POSTHOG__).toBe(first);
    });
  });

  describe("trackEvent", () => {
    it("is a no-op when telemetry is disabled", async () => {
      process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
      // Even if a client somehow exists, should not call capture
      globalThis.__FAILPROOFAI_POSTHOG__ = {
        capture: mockCapture,
        flush: mockFlush,
        shutdown: mockShutdown,
      };
      trackEvent("test_event");
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("is a no-op when client is not initialized", () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      trackEvent("test_event");
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("calls capture with correct arguments when enabled", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      trackEvent("feature_used", { feature: "dashboard" });
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "test-instance-id",
        event: "feature_used",
        properties: expect.objectContaining({ feature: "dashboard", $lib: "failproofai", failproofai_version: expect.any(String), product: "failproofai-oss" }),
      });
    });

    it("calls capture without properties when none provided", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      trackEvent("app_started");
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "test-instance-id",
        event: "app_started",
        properties: { $lib: "failproofai", failproofai_version: expect.any(String), product: "failproofai-oss" },
      });
    });
  });

  describe("shutdownTelemetry", () => {
    it("calls shutdown on the client", async () => {
      delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
      await initTelemetry();
      await shutdownTelemetry();
      expect(mockShutdown).toHaveBeenCalledOnce();
    });

    it("is a no-op when no client exists", async () => {
      await shutdownTelemetry();
      expect(mockShutdown).not.toHaveBeenCalled();
    });
  });
});
