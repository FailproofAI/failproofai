/**
 * `failproofai update` restarts a running gateway so it loads the plugin now on
 * disk — but only one a service manager runs, and only through the host's own
 * drain-aware restart. A hand-run gateway is never touched: without a service,
 * `hermes gateway restart` runs the new gateway in the caller's foreground.
 */
import { describe, it, expect, vi } from "vitest";
import {
  openclawRestartLines,
  restartHermesGateway,
  restartOpenClawGateway,
  restartOpenClawGateways,
  openclawProfileEnv,
  type CommandResult,
} from "../../src/hooks/gateway-restart";

const PROFILE = { name: "work", home: "/home/u/.hermes/profiles/work" };

function deps(outputs: Record<string, CommandResult>, spawned = true) {
  const run = vi.fn((cmd: string, args: string[], _env: NodeJS.ProcessEnv) => {
    const out = outputs[`${cmd} ${args.join(" ")}`];
    if (!out) throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    return out;
  });
  const spawnDetached = vi.fn((_cmd: string, _args: string[], _env: NodeJS.ProcessEnv) => spawned);
  return { run, spawnDetached };
}

const ok = (stdout: string): CommandResult => ({ status: 0, stdout });

describe("Hermes gateway restart", () => {
  it.each([
    ["systemd", "● hermes-gateway.service\n✓ User gateway service is running\n"],
    ["launchd", "Launchd plist: x\n✓ Gateway is supervised by launchd (PID 42)\n"],
  ])("restarts a %s-supervised gateway with the host's drain-aware restart", (_kind, status) => {
    const d = deps({ "hermes gateway status": ok(status) });
    expect(restartHermesGateway(PROFILE, d)).toEqual({ host: "hermes", profile: "work", status: "restarting" });
    expect(d.spawnDetached).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = d.spawnDetached.mock.calls[0];
    expect([cmd, ...args]).toEqual(["hermes", "gateway", "restart"]);
    // The profile is selected the way Hermes derives its service name.
    expect(env.HERMES_HOME).toBe(PROFILE.home);
    expect(d.run.mock.calls[0][2].HERMES_HOME).toBe(PROFILE.home);
  });

  it.each([
    ["a system-scope service (needs root)", "✓ System gateway service is running\n"],
    ["a detached fallback", "⚠ Gateway service is registered but launchd is not supervising it\n✓ Detached fallback process is running (PID 7)\n"],
  ])("never restarts %s", (_kind, status) => {
    const d = deps({ "hermes gateway status": ok(status) });
    expect(restartHermesGateway(PROFILE, d).status).toBe("not-supervised");
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it("leaves a gateway that is not running alone", () => {
    const d = deps({ "hermes gateway status": { status: 1, stdout: "✗ Gateway service is not installed\n" } });
    expect(restartHermesGateway(PROFILE, d).status).toBe("not-running");
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it("reports a status that never came back, or a restart that could not start, as failed", () => {
    expect(restartHermesGateway(PROFILE, deps({ "hermes gateway status": { status: null, stdout: "" } })).status)
      .toBe("failed");
    const d = deps({ "hermes gateway status": ok("✓ User gateway service is running") }, false);
    expect(restartHermesGateway(PROFILE, d).status).toBe("failed");
  });

  it("never throws", () => {
    const run = () => { throw new Error("ENOENT"); };
    expect(restartHermesGateway(PROFILE, { run }).status).toBe("failed");
  });
});

const RUNNING = JSON.stringify({ service: { loaded: true, runtime: { status: "running" } } });
const SAFE_HELP = ok("  --safe   Request an OpenClaw-aware restart after active work drains\n");

describe("OpenClaw gateway restart", () => {
  it("restarts a running service with --safe, so active work drains first", () => {
    const d = deps({
      "openclaw gateway status --json": ok(RUNNING),
      "openclaw gateway restart --help": SAFE_HELP,
    });
    expect(restartOpenClawGateway({ name: "default", home: "/h/.openclaw" }, d).status).toBe("restarting");
    const [cmd, args] = d.spawnDetached.mock.calls[0];
    expect([cmd, ...args]).toEqual(["openclaw", "gateway", "restart", "--safe"]);
  });

  it("selects a named profile with --profile", () => {
    const d = deps({
      "openclaw --profile ops gateway status --json": ok(`warning: x\n${RUNNING}`),
      "openclaw gateway restart --help": SAFE_HELP,
    });
    expect(restartOpenClawGateway({ name: "ops", home: "/h/.openclaw-ops" }, d).status).toBe("restarting");
    expect(d.spawnDetached.mock.calls[0][1]).toEqual(["--profile", "ops", "gateway", "restart", "--safe"]);
  });

  it("does not plain-restart an OpenClaw that has no --safe", () => {
    const d = deps({
      "openclaw gateway status --json": ok(RUNNING),
      "openclaw gateway restart --help": ok("  --force  Begin restart now\n"),
    });
    expect(restartOpenClawGateway({ name: "default", home: "/h" }, d).status).toBe("not-supervised");
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it.each([
    ["stopped", JSON.stringify({ service: { loaded: true, runtime: { status: "stopped" } } }), "not-running"],
    ["running without a service", JSON.stringify({ service: { loaded: false, runtime: { status: "running" } } }), "not-supervised"],
    ["unreadable", "not json", "failed"],
  ])("does not restart a gateway whose status is %s", (_label, stdout, status) => {
    const d = deps({ "openclaw gateway status --json": ok(stdout) });
    expect(restartOpenClawGateway({ name: "default", home: "/h" }, d).status).toBe(status);
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it("restarts only the profiles it is given", () => {
    const d = deps({
      "openclaw gateway status --json": ok(RUNNING),
      "openclaw gateway restart --help": SAFE_HELP,
    });
    const out = restartOpenClawGateways({ ...d, openclawProfiles: () => [{ name: "default", home: "/h" }] });
    expect(out).toEqual([{ host: "openclaw", profile: "default", status: "restarting" }]);
  });
});

describe("update's OpenClaw rows", () => {
  it("prints one row per gateway that has something to say, and nothing otherwise", () => {
    expect(openclawRestartLines([{ host: "openclaw", profile: "default", status: "not-running" }])).toEqual([]);
    expect(openclawRestartLines([
      { host: "openclaw", profile: "default", status: "restarting" },
      { host: "openclaw", profile: "ops", status: "not-supervised" },
      { host: "openclaw", profile: "idle", status: "not-running" },
    ])).toEqual([
      "OpenClaw:",
      "  openclaw/default  gateway restarting",
      "  openclaw/ops      restart the gateway",
    ]);
  });
});

describe("OpenClaw profile selection", () => {
  it("drops every selector the caller's shell set, so a row acts on its own profile", () => {
    const shell = { OPENCLAW_PROFILE: "ops", OPENCLAW_STATE_DIR: "/h/.openclaw-ops", OPENCLAW_CONFIG_PATH: "/x.json", PATH: "/bin" } as unknown as NodeJS.ProcessEnv;
    const { homedir } = require("node:os") as typeof import("node:os");
    const env = openclawProfileEnv({ name: "default", home: `${homedir()}/.openclaw` }, shell);
    expect(env).toEqual({ PATH: "/bin" });
    // A default profile at a non-standard location is named by its directory.
    expect(openclawProfileEnv({ name: "default", home: "/srv/claw" }, shell).OPENCLAW_STATE_DIR).toBe("/srv/claw");
    // Relocated, even when the directory is itself named `.openclaw`.
    expect(openclawProfileEnv({ name: "default", home: "/srv/claw/.openclaw" }, shell).OPENCLAW_STATE_DIR)
      .toBe("/srv/claw/.openclaw");
    // A named one is selected by --profile, never by the inherited env.
    expect(openclawProfileEnv({ name: "ops", home: "/h/.openclaw-ops" }, shell).OPENCLAW_PROFILE).toBeUndefined();
  });

  it("probes and restarts the default profile with no inherited selector", () => {
    const prev = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "ops";
    try {
      const d = deps({
        "openclaw gateway status --json": ok(RUNNING),
        "openclaw gateway restart --help": SAFE_HELP,
      });
      restartOpenClawGateway({ name: "default", home: "/h/.openclaw" }, d);
      for (const call of [...d.run.mock.calls, ...d.spawnDetached.mock.calls]) {
        expect(call[2].OPENCLAW_PROFILE).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_PROFILE;
      else process.env.OPENCLAW_PROFILE = prev;
    }
  });
});
