import { describe, it, expect } from "vitest";
import { formatDuration } from "@/lib/format-duration";

describe("formatDuration", () => {
  it("sub-second: 0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("sub-second: 42ms", () => {
    expect(formatDuration(42)).toBe("42ms");
  });

  it("sub-second: 999ms", () => {
    expect(formatDuration(999)).toBe("999ms");
  });

  it("boundary: exactly 1000ms", () => {
    expect(formatDuration(1000)).toBe("1.0s");
  });

  it("seconds: 1500ms", () => {
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("seconds: 3200ms", () => {
    expect(formatDuration(3200)).toBe("3.2s");
  });

  it("boundary: exactly 60000ms", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
  });

  it("minutes: 312000ms", () => {
    expect(formatDuration(312000)).toBe("5m 12s");
  });

  it("boundary: exactly 3600000ms", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
  });

  it("hours: 8100000ms", () => {
    expect(formatDuration(8100000)).toBe("2h 15m");
  });

  it("large: 86400000ms (24h)", () => {
    expect(formatDuration(86400000)).toBe("24h 0m");
  });

  // Issue #521: rounding must happen before bucketing so carries propagate.
  it("carries rounded seconds to minutes (59999ms -> 1m 0s)", () => {
    expect(formatDuration(59999)).toBe("1m 0s");
  });

  it("carries rounded seconds to minutes (119600ms -> 2m 0s)", () => {
    expect(formatDuration(119600)).toBe("2m 0s");
  });

  it("carries rounded seconds to hours (3599600ms -> 1h 0m)", () => {
    expect(formatDuration(3599600)).toBe("1h 0m");
  });

  it("boundary: just below second-to-minute carry (59949ms)", () => {
    expect(formatDuration(59949)).toBe("59.9s");
  });

  it("boundary: second-to-minute carry (59950ms -> 1m 0s)", () => {
    expect(formatDuration(59950)).toBe("1m 0s");
  });

  it("boundary: just below minute-to-hour carry (3599499ms)", () => {
    expect(formatDuration(3599499)).toBe("59m 59s");
  });

  it("boundary: minute-to-hour carry (3599500ms -> 1h 0m)", () => {
    expect(formatDuration(3599500)).toBe("1h 0m");
  });

  it("boundary: just above hour bucket (3660000ms -> 1h 1m)", () => {
    expect(formatDuration(3660000)).toBe("1h 1m");
  });

  it("regression pin: seconds rounding still formats 1499ms as 1.5s", () => {
    expect(formatDuration(1499)).toBe("1.5s");
  });

  it("regression pin: minutes rounding still formats 312000ms as 5m 12s", () => {
    expect(formatDuration(312000)).toBe("5m 12s");
  });
});
