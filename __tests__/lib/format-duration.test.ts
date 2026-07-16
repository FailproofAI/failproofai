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

  it("rounds seconds up to a minute", () => {
    expect(formatDuration(59999)).toBe("1m 0s");
  });

  it("boundary: exactly 60000ms", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
  });

  it("minutes: 312000ms", () => {
    expect(formatDuration(312000)).toBe("5m 12s");
  });

  it("rounds seconds up without emitting 60s", () => {
    expect(formatDuration(119600)).toBe("2m 0s");
  });

  it("rounds minutes up to an hour", () => {
    expect(formatDuration(3599600)).toBe("1h 0m");
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
});
