/**
 * The upgrade steps `update` runs, shared with `config`: the first setup on a
 * new version restarts running gateways so they load the plugin now on disk,
 * instead of leaving that to a `failproofai update` nobody knew to run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const svc = vi.hoisted(() => ({
  isDaemonSupportedPlatform: vi.fn(() => true),
  daemonServiceStatus: vi.fn(() => "running"),
  refreshDaemonToCliVersion: vi.fn(async () => ({ ok: true, lines: ["failproofaid 1.0.0 is already installed and running; nothing to update."] })),
  probeDaemonPolicyEvaluation: vi.fn(async () => true),
}));
const hermes = vi.hoisted(() => ({ runHermesUpdateMigration: vi.fn() }));
const gateways = vi.hoisted(() => ({
  restartHermesGateway: vi.fn(() => ({ host: "hermes", profile: "default", status: "restarting" })),
  restartOpenClawGateways: vi.fn(() => [] as unknown[]),
  openclawRestartLines: vi.fn((r: unknown[]) => (r.length > 0 ? ["OpenClaw:", "  openclaw/default  gateway restarting"] : [])),
}));
vi.mock("../../src/hooks/daemon-service", () => svc);
vi.mock("../../src/hooks/hermes-update", () => hermes);
vi.mock("../../src/hooks/gateway-restart", () => gateways);

import {
  markUpdated,
  readUpdatedVersion,
  restartNewlyPlugged,
  runUpdateSteps,
  setupGatewayLine,
  setupNeedsUpdateSteps,
  type PluggedProfile,
} from "../../src/hooks/update-run";
import type { GatewayRestart } from "../../src/hooks/gateway-restart";

/** Hermes as `runHermesUpdateMigration` reports it, calling the restart it was handed. */
function hermesWith(status: "current" | "migrated" | "untouched") {
  hermes.runHermesUpdateMigration.mockImplementation(async (deps: { restartGateway?: (p: unknown) => { status: string } }) => {
    if (status === "untouched") return { ok: true, lines: [], profiles: [{ name: "default", status }] };
    const restart = deps.restartGateway?.({ name: "default", home: "/h" });
    const gw = restart?.status === "restarting" ? ", gateway restarting" : "";
    const label = status === "current" ? "already current" : "migrated — linked";
    return { ok: true, lines: ["Hermes:", `  hermes/default  ${label}${gw}`], profiles: [{ name: "default", status }] };
  });
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fp-update-run-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("FAILPROOFAI_HOME", join(home, ".failproofai"));
  svc.daemonServiceStatus.mockReturnValue("running");
  gateways.restartOpenClawGateways.mockReturnValue([]);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("the version marker", () => {
  it("asks for the steps until this version has finished them, then stops asking", () => {
    const fp = home;
    expect(readUpdatedVersion(fp)).toBeNull();
    expect(setupNeedsUpdateSteps("1.0.16", fp)).toBe(true);
    markUpdated("1.0.16", fp);
    expect(readUpdatedVersion(fp)).toBe("1.0.16");
    expect(setupNeedsUpdateSteps("1.0.16", fp)).toBe(false);
    // The next npm upgrade asks again.
    expect(setupNeedsUpdateSteps("1.0.17", fp)).toBe(true);
    const file = join(home, ".failproofai", "state", "updated-version");
    expect(readFileSync(file, "utf8")).toBe("1.0.16\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("runUpdateSteps as config runs it (no layout, no daemon, restart)", () => {
  const AS_CONFIG = { layout: false, daemon: false, restart: true } as const;

  it("restarts running gateways onto the plugin on disk, and says so", async () => {
    hermesWith("current");
    gateways.restartOpenClawGateways.mockReturnValue([{ host: "openclaw", profile: "default", status: "restarting" }]);
    const run = await runUpdateSteps(AS_CONFIG);
    expect(run.ok).toBe(true);
    expect(run.changed).toBe(true);
    expect(gateways.restartHermesGateway).toHaveBeenCalledTimes(1);
    expect(gateways.restartOpenClawGateways).toHaveBeenCalledTimes(1);
    expect(run.lines).toContain("  hermes/default  already current, gateway restarting");
    expect(run.lines).toContain("  openclaw/default  gateway restarting");
    // Setup already brought the daemon to this version.
    expect(svc.refreshDaemonToCliVersion).not.toHaveBeenCalled();
  });

  it("touches no gateway when the daemon is not running", async () => {
    hermesWith("current");
    svc.daemonServiceStatus.mockReturnValue("stopped");
    const run = await runUpdateSteps(AS_CONFIG);
    expect(gateways.restartHermesGateway).not.toHaveBeenCalled();
    expect(gateways.restartOpenClawGateways).not.toHaveBeenCalled();
    // "already current" with nothing restarted is not worth a report.
    expect(run.changed).toBe(false);
  });

  it("is silent on a machine without Hermes or OpenClaw", async () => {
    hermesWith("untouched");
    const run = await runUpdateSteps(AS_CONFIG);
    expect(run).toMatchObject({ ok: true, changed: false, lines: [] });
  });
});

describe("runUpdateSteps as update runs it", () => {
  it("refreshes the daemon, and --no-daemon also leaves gateways alone", async () => {
    hermesWith("current");
    await runUpdateSteps({ layout: false, daemon: true, restart: true });
    expect(svc.refreshDaemonToCliVersion).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    hermesWith("current");
    const skipped = await runUpdateSteps({ layout: false, daemon: false, restart: false, noteSkippedDaemon: true });
    expect(svc.refreshDaemonToCliVersion).not.toHaveBeenCalled();
    expect(gateways.restartHermesGateway).not.toHaveBeenCalled();
    expect(skipped.lines).toContain("Skipped the daemon (--no-daemon). Its version may not match this CLI.");
  });

  it("does not restart gateways onto a daemon that failed to update", async () => {
    hermesWith("current");
    svc.refreshDaemonToCliVersion.mockResolvedValueOnce({ ok: false, lines: ["✕ failproofaid could not be updated"] });
    const run = await runUpdateSteps({ layout: false, daemon: true, restart: true });
    expect(run.ok).toBe(false);
    expect(gateways.restartHermesGateway).not.toHaveBeenCalled();
    expect(gateways.restartOpenClawGateways).not.toHaveBeenCalled();
  });
});

describe("what config prints about it", () => {
  const r = (host: "hermes" | "openclaw", profile: string, status: string) => ({ host, profile, status }) as never;

  it("is one line, in update's own words, naming every profile", () => {
    expect(setupGatewayLine([r("hermes", "default", "restarting"), r("hermes", "work", "restarting"), r("openclaw", "ops", "restarting")])).toEqual({
      ok: true,
      text: "hermes/default, hermes/work, openclaw/ops: gateway restarting",
    });
  });

  it("asks for a manual restart first when a gateway could not be restarted", () => {
    expect(setupGatewayLine([r("hermes", "default", "restarting"), r("openclaw", "lab", "not-supervised")])).toEqual({
      ok: false,
      text: "openclaw/lab: restart the gateway",
    });
  });

  it("says nothing when no gateway runs", () => {
    expect(setupGatewayLine([r("hermes", "default", "not-running")])).toBeNull();
    expect(setupGatewayLine([])).toBeNull();
  });

  it("collects each profile's restart, Hermes and OpenClaw", async () => {
    hermesWith("current");
    gateways.restartOpenClawGateways.mockReturnValue([{ host: "openclaw", profile: "ops", status: "restarting" }]);
    const run = await runUpdateSteps({ layout: false, daemon: false, restart: true });
    expect(run.restarts.map((x) => `${x.host}/${x.profile}:${x.status}`)).toEqual([
      "hermes/default:restarting",
      "openclaw/ops:restarting",
    ]);
  });
});

describe("a setup that plugs in a profile created after the version's first setup", () => {
  const p = (host: "hermes" | "openclaw", name: string): PluggedProfile => ({ host, name, home: `/h/${host}-${name}` });
  const before = [p("hermes", "default"), p("openclaw", "default")];
  const restarted =
    (host: "hermes" | "openclaw") =>
    (q: { name: string; home: string }): GatewayRestart => ({ host, profile: q.name, status: "restarting" });

  it("restarts only the gateways of the profiles it plugged in", async () => {
    const restartHermes = vi.fn(restarted("hermes"));
    const restartOpenClaw = vi.fn(restarted("openclaw"));
    const restarts = await restartNewlyPlugged(before, {
      plugged: async () => [...before, p("hermes", "work"), p("openclaw", "work")],
      daemonRunning: async () => true,
      restartHermes,
      restartOpenClaw,
    });
    expect(restartHermes).toHaveBeenCalledTimes(1);
    expect(restartHermes.mock.calls[0][0]).toMatchObject({ name: "work", home: "/h/hermes-work" });
    expect(restartOpenClaw).toHaveBeenCalledTimes(1);
    expect(setupGatewayLine(restarts)).toEqual({ ok: true, text: "hermes/work, openclaw/work: gateway restarting" });
  });

  it("restarts nothing when every plugged profile already was", async () => {
    const restartHermes = vi.fn(restarted("hermes"));
    const restarts = await restartNewlyPlugged(before, {
      plugged: async () => before,
      daemonRunning: async () => true,
      restartHermes,
      restartOpenClaw: restartHermes,
    });
    expect(restarts).toEqual([]);
    expect(restartHermes).not.toHaveBeenCalled();
    expect(setupGatewayLine(restarts)).toBeNull();
  });

  it("restarts nothing onto a daemon that is not running", async () => {
    const restartHermes = vi.fn(restarted("hermes"));
    const restarts = await restartNewlyPlugged([], {
      plugged: async () => [p("hermes", "work")],
      daemonRunning: async () => false,
      restartHermes,
      restartOpenClaw: restartHermes,
    });
    expect(restarts).toEqual([]);
    expect(restartHermes).not.toHaveBeenCalled();
  });
});
