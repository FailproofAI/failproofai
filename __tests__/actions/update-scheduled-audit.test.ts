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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `setAutoAuditAction(true)` now refuses without a session — scheduling and
// mailing are one decision, so a timer with nobody to tell is a switch that
// reads as on and produces nothing. These tests are about the CONFIG WRITE, so
// the session check is stubbed to "signed in"; the refusal itself is covered in
// the settings component tests.
const { whoAmIMock, readAuthMock } = vi.hoisted(() => ({
  whoAmIMock: vi.fn(),
  readAuthMock: vi.fn(),
}));
vi.mock("../../lib/auth/auth-store", () => ({ whoAmI: whoAmIMock, readAuth: readAuthMock }));
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
  whoAmIMock.mockReset().mockResolvedValue({
    me: { id: "u1", email: "sidd@exosphere.host", status: "active", created_at: "" },
    auth: { user: { id: "u1", email: "sidd@exosphere.host" } },
  });
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
    expect(res).toEqual({ ok: true, auto: true });
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
    expect(JSON.parse(readFileSync(configFile(), "utf8")).telemetry).toEqual({ enabled: false });

    // Now drive the dashboard's write paths.
    await setAutoAuditAction(true);
    await setAuditIntervalAction(14);

    // Telemetry is still off, in memory and on disk. A dropped field would have
    // re-enabled it (absent [telemetry] block reads as enabled).
    expect(readConfig().telemetry.enabled).toBe(false);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).telemetry).toEqual({ enabled: false });
    // And the audit write actually landed alongside it.
    expect(readConfig().audit).toMatchObject({ auto: true, intervalDays: 14 });
    // Enabling from the dashboard also records consent to send, in the same
    // write — that stamp, not `auto`, is what `reportHarm` gates on.
    expect(typeof readConfig().audit.reportsConsentedAt).toBe("number");
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

describe("a session the server rejects", () => {
  it("is REPORTED, not thrown, so the caller can act on it", async () => {
    // Next masks a thrown server-action error before the browser sees it — the
    // client gets an opaque digest and never the message. A caller matching on
    // the text works in development and silently degrades to a generic failure
    // in production, which is what shipped: the page showed an address read
    // from the local session file, the toggle took the signed-in path, and the
    // click dead-ended on "could not turn that on."
    whoAmIMock.mockResolvedValue(null);
    // `whoAmI()` deletes the session on a 401, so nothing is left on disk.
    readAuthMock.mockReturnValue(null);

    const res = await setAutoAuditAction(true);

    expect(res).toEqual({ ok: false, reason: "signed-out" });
    // And nothing was written: a timer with nobody to tell reads as on and
    // produces nothing.
    expect(readConfig().audit.auto).toBe(false);
  });

  it("tells an OFFLINE machine apart from an expired one", async () => {
    // `whoAmI()` collapses them: null for a 401 and null for every transport
    // failure. The client discriminated on `res.ok` alone, so a machine behind
    // a proxy or with the wifi down hit the 10s timeout, watched the switch
    // snap back, and was told "that sign-in expired" — then handed a code
    // prompt that cannot succeed either, which is how a working session gets
    // abandoned. What is left ON DISK tells them apart: a 401 wipes it, a
    // network failure leaves it.
    whoAmIMock.mockResolvedValue(null);
    readAuthMock.mockReturnValue({
      access_token: "at",
      refresh_token: "rt",
      access_expires_at: Math.floor(Date.now() / 1000) + 900,
      refresh_expires_at: Math.floor(Date.now() / 1000) + 86_400,
      user: { id: "u1", email: "sidd@exosphere.host" },
    });

    const res = await setAutoAuditAction(true);

    expect(res).toEqual({ ok: false, reason: "unreachable" });
    expect(readConfig().audit.auto).toBe(false);
  });

  it("calls a session past its refresh window signed-out, not unreachable", async () => {
    // The file being present is not the test — a lapsed refresh token cannot
    // mint anything, so the code prompt really is the remedy here.
    whoAmIMock.mockResolvedValue(null);
    readAuthMock.mockReturnValue({
      access_token: "at",
      refresh_token: "rt",
      access_expires_at: Math.floor(Date.now() / 1000) - 7200,
      refresh_expires_at: Math.floor(Date.now() / 1000) - 3600,
      user: { id: "u1", email: "sidd@exosphere.host" },
    });

    expect(await setAutoAuditAction(true)).toEqual({ ok: false, reason: "signed-out" });
  });

  it("still lets somebody turn scheduling OFF", async () => {
    // The refusal is one-directional on purpose. An expired session must not
    // trap a person into keeping a feature they are trying to disable.
    whoAmIMock.mockResolvedValue({ me: { id: "u", email: "a@b.c" } });
    await setAutoAuditAction(true);
    expect(readConfig().audit.auto).toBe(true);

    whoAmIMock.mockResolvedValue(null);
    const res = await setAutoAuditAction(false);

    expect(res).toEqual({ ok: true, auto: false });
    expect(readConfig().audit.auto).toBe(false);
  });
});
