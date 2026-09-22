// @vitest-environment node
/**
 * The Jev properties of hook telemetry: present only when Jev was involved,
 * and built from codes and names only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jevTelemetryProperties, trackHookEvent } from "../../src/hooks/hook-telemetry";

describe("jevTelemetryProperties", () => {
  it("is empty when Jev was not involved, so spreading it changes nothing", () => {
    expect(jevTelemetryProperties({})).toEqual({});
    expect(jevTelemetryProperties({ jevDecision: "deny" })).toEqual({});
  });

  it("carries an answered call's verdict, clears, latency, model and mode", () => {
    expect(
      jevTelemetryProperties({
        evaluator: "jev",
        jevDecision: "allow",
        jevCleared: ["block-read-outside-cwd", "protect-env-vars"],
        jevLatencyMs: 41.4,
        jevModel: "jev-1.13.0",
        jevMode: "enforce",
      }),
    ).toEqual({
      jev_evaluator: "jev",
      jev_mode: "enforce",
      jev_decision: "allow",
      jev_cleared: ["block-read-outside-cwd", "protect-env-vars"],
      jev_cleared_count: 2,
      jev_latency_ms: 41,
      jev_model: "jev-1.13.0",
    });
  });

  it("carries a fallback's reason as a code", () => {
    expect(
      jevTelemetryProperties({
        evaluator: "jev-fallback",
        jevFallbackReason: "error: connect ECONNREFUSED",
        jevLatencyMs: 3,
        jevMode: "shadow",
      }),
    ).toEqual({
      jev_evaluator: "jev-fallback",
      jev_mode: "shadow",
      jev_fallback_reason: "error",
      jev_latency_ms: 3,
    });
  });
});

describe("hook_policy_triggered with Jev properties", () => {
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

  it("sends them alongside the existing properties", async () => {
    await trackHookEvent("inst-id", "hook_policy_triggered", {
      event_type: "PreToolUse",
      cli: "claude",
      tool_name: "Bash",
      policy_name: "semantic/destructive-delete",
      decision: "deny",
      ...jevTelemetryProperties({ evaluator: "jev", jevDecision: "deny", jevCleared: [], jevMode: "enforce" }),
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties).toMatchObject({
      policy_name: "semantic/destructive-delete",
      decision: "deny",
      jev_evaluator: "jev",
      jev_decision: "deny",
      jev_cleared_count: 0,
      jev_mode: "enforce",
    });
  });
});
