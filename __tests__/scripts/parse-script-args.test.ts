// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { parseScriptArgs } from "@/scripts/parse-script-args";

describe("parseScriptArgs", () => {
  it("returns defaults when no args given", () => {
    const result = parseScriptArgs([]);
    expect(result.remainingArgs).toEqual([]);
  });

  it("passes remaining args through", () => {
    const result = parseScriptArgs(["--port", "3000"]);
    expect(result.remainingArgs).toEqual(["--port", "3000"]);
  });

  it("parses --disable-telemetry", () => {
    const result = parseScriptArgs(["--disable-telemetry"]);
    expect(result.disableTelemetry).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it("defaults disableTelemetry to false", () => {
    const result = parseScriptArgs([]);
    expect(result.disableTelemetry).toBe(false);
  });

  it("parses --logging=info", () => {
    const result = parseScriptArgs(["--logging=info"]);
    expect(result.loggingLevel).toBe("info");
    expect(result.remainingArgs).toEqual([]);
  });

  it("parses --logging warn (space-separated)", () => {
    const result = parseScriptArgs(["--logging", "warn"]);
    expect(result.loggingLevel).toBe("warn");
    expect(result.remainingArgs).toEqual([]);
  });

  it("rejects --logging with invalid level", () => {
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    expect(() => parseScriptArgs(["--logging=debug"])).toThrow("exit 1");
    vi.restoreAllMocks();
  });

  it("unknown flags pass through as remainingArgs", () => {
    const result = parseScriptArgs(["--auth-user=user:pass"]);
    expect(result.remainingArgs).toEqual(["--auth-user=user:pass"]);
  });

  it("combines known flags and passes unknown as remainingArgs", () => {
    const result = parseScriptArgs(["--turbopack", "--disable-telemetry"]);
    expect(result.disableTelemetry).toBe(true);
    expect(result.remainingArgs).toEqual(["--turbopack"]);
  });
});
