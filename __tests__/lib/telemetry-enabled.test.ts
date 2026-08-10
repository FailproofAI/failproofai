// @vitest-environment node
/**
 * The shared telemetry gate. Four dispatchers consult this; if they could
 * disagree, the opt-out would be one that silently does not hold.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isTelemetryEnabled } from "../../lib/telemetry-enabled";
import { configFile } from "../../src/hooks/fp-home";

let home: string;
const ORIGINAL_HOME = process.env.FAILPROOFAI_HOME;
const ORIGINAL_DISABLED = process.env.FAILPROOFAI_TELEMETRY_DISABLED;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "fpai-tel-"));
  process.env.FAILPROOFAI_HOME = home;
  delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = ORIGINAL_HOME;
  if (ORIGINAL_DISABLED === undefined) delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
  else process.env.FAILPROOFAI_TELEMETRY_DISABLED = ORIGINAL_DISABLED;
  rmSync(home, { recursive: true, force: true });
});

function writeTelemetryBlock(enabled: boolean): void {
  writeFileSync(configFile(), `[telemetry]\nenabled = ${enabled}\n`);
}

describe("isTelemetryEnabled", () => {
  it("is ON with no config file and no env var — the shipped default", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("is OFF when the config file says so", () => {
    // The documented off-switch, and the only one that can reach the daemon.
    writeTelemetryBlock(false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("is OFF when the env var says so", () => {
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("takes the MORE RESTRICTIVE of the two — env cannot re-enable a file opt-out", () => {
    // An env var that could override a written preference is not an opt-out.
    writeTelemetryBlock(false);
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("takes the MORE RESTRICTIVE of the two — a file 'true' cannot beat the env var", () => {
    writeTelemetryBlock(true);
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("only the exact string \"1\" disables via env", () => {
    for (const v of ["0", "", "true", "yes"]) {
      process.env.FAILPROOFAI_TELEMETRY_DISABLED = v;
      expect(isTelemetryEnabled(), v).toBe(true);
    }
  });

  it("a malformed config resolves to the shipped default rather than a third answer", () => {
    writeFileSync(configFile(), "[telemetry\nenabled = ");
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("re-reads on every call, so an opt-out takes effect without a restart", () => {
    // Memoising this was the tempting optimisation and it is the wrong one: a
    // long-lived process (dashboard server, warm worker) would keep reporting
    // until it restarted, which is an opt-out that does not hold.
    expect(isTelemetryEnabled()).toBe(true);
    writeTelemetryBlock(false);
    expect(isTelemetryEnabled()).toBe(false);
  });
});
