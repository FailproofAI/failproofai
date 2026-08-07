// @vitest-environment node
/**
 * The /settings scheduled-audit write actions, and the one invariant that would
 * be the worst bug in the whole feature: a settings write must never silently
 * re-enable telemetry.
 *
 * `writeConfig` regenerates `config.toml` WHOLESALE and emits `[telemetry]
 * enabled = false` ONLY when telemetry is off — a default install carries no
 * `[telemetry]` block at all. So if a settings write ever dropped the field it
 * read, an operator who had turned telemetry off would have it turned back on
 * underneath them the next time they toggled a scan setting from the dashboard.
 * `updateConfig` reads the current config first and re-writes every field, which
 * is what keeps that from happening — these tests pin it, exercising the exact
 * server actions the dashboard calls (not a reimplementation), so CLI/dashboard
 * parity is real: both write through the same `updateConfig`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { configFile } from "../../src/hooks/fp-home";
import { readConfig, writeConfig } from "../../src/hooks/fp-config";
import {
  setAutoAuditAction,
  setAuditIntervalAction,
} from "../../app/actions/update-scheduled-audit";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-settings-write-"));
  process.env.FAILPROOFAI_HOME = home;
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("scheduled-audit write actions", () => {
  it("setAutoAuditAction toggles [audit] auto and reflects what the config stored", async () => {
    expect(readConfig().audit.auto).toBe(false);
    const res = await setAutoAuditAction(true);
    expect(res.auto).toBe(true);
    expect(readConfig().audit.auto).toBe(true);
  });

  it("setAuditIntervalAction lets the config own the 1..90 clamp and returns the stored value", async () => {
    // A hand-typed 3650 must come back as the 90 the config actually enforces —
    // the action re-reads rather than trusting its own input, so there is no
    // second copy of the bounds to drift from fp-config.readIntervalDays.
    const clamped = await setAuditIntervalAction(3650);
    expect(clamped.intervalDays).toBe(90);
    expect(readConfig().audit.intervalDays).toBe(90);

    // 0 reads as "off" → falls back to the default, not the 1-day floor.
    const zero = await setAuditIntervalAction(0);
    expect(zero.intervalDays).toBe(7);
  });

  it("does NOT re-enable telemetry when a scan setting is written (the worst-bug guard)", async () => {
    // Operator turned telemetry off. The on-disk marker is the ONLY record of
    // that, and it exists only while telemetry is off.
    const off = readConfig();
    off.telemetry.enabled = false;
    writeConfig(off);
    expect(readFileSync(configFile(), "utf8")).toContain("[telemetry]\nenabled = false");

    // Now drive the dashboard's write paths.
    await setAutoAuditAction(true);
    await setAuditIntervalAction(14);

    // Telemetry is still off, in memory and on disk. A dropped field would have
    // re-enabled it (absent [telemetry] block reads as enabled).
    expect(readConfig().telemetry.enabled).toBe(false);
    expect(readFileSync(configFile(), "utf8")).toContain("[telemetry]\nenabled = false");
    // And the audit write actually landed alongside it.
    expect(readConfig().audit).toEqual({ auto: true, intervalDays: 14 });
  });

  it("preserves an unrelated cloud/collector setting across a scan write", async () => {
    // The same whole-file-regeneration risk for any other field a settings write
    // does not touch: a machine_id the identity work stamped, say.
    const c = readConfig();
    c.mode = "cloud";
    c.collector.machineId = "machine-abc";
    writeConfig(c);

    await setAutoAuditAction(true);

    const after = readConfig();
    expect(after.mode).toBe("cloud");
    expect(after.collector.machineId).toBe("machine-abc");
    expect(after.audit.auto).toBe(true);
  });
});
