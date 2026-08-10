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

  it("leaves host undefined by default, so the loopback default applies", () => {
    expect(parseScriptArgs([]).host).toBeUndefined();
  });

  it("parses --host in both forms", () => {
    expect(parseScriptArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseScriptArgs(["--host=192.168.1.5"]).host).toBe("192.168.1.5");
    expect(parseScriptArgs(["--host", "0.0.0.0"]).remainingArgs).toEqual([]);
  });

  // `bun run dev` passes anything it does not recognise straight to `next dev`,
  // and Next's own spelling is `-H` / `--hostname`. Capturing only `--host` let
  // a raw `-H 0.0.0.0` reach Next while `bindHost` stayed on the loopback
  // default — so the server was reachable from the network and `proxy.ts` was
  // told it was on loopback, which is precisely the combination that leaves the
  // Host pin (forgeable by a non-browser client) as the only check and skips
  // the no-Origin refusal written for a routable bind.
  it.each([
    [["-H", "0.0.0.0"], "0.0.0.0"],
    [["--hostname", "0.0.0.0"], "0.0.0.0"],
    [["--hostname=192.168.1.5"], "192.168.1.5"],
  ])("captures Next's own host spelling %s so the bind address cannot desync", (argv, expected) => {
    const result = parseScriptArgs([...argv]);
    expect(result.host).toBe(expected);
    // Consumed, not passed through — launch.ts re-injects a single `-H
    // <bindHost>`, so leaving it here would hand `next dev` two of them.
    expect(result.remainingArgs).toEqual([]);
  });
});
