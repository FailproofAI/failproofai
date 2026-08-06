// @vitest-environment node
//
// The daemon reads its ingest credential ONCE, at collector start. `main.rs`
// starts the collector manager once and never tears it down, and the uploader
// caches its bearer key at construction. Config is re-read on a 5s tick; the
// CREDENTIAL is not.
//
// So rotating a key left the file correct and the process wrong, and the
// failure is invisible from every angle a person can check: `--connect`
// verifies the NEW key itself and prints success, `systemctl` reports the
// service healthy, `credentials.toml` holds a key that works when you curl it —
// and every batch 401s and parks. The only symptom is data that never arrives.
//
// Observed live before this existed: a key revoked at 13:05:37 and replaced
// 37 seconds later still produced 401s twenty minutes on, 26 batches parked,
// and a CLI that said "connected".
//
// The codebase already KNEW — `--disconnect` printed a line telling the user to
// restart by hand. These tests exist because printing the remedy is strictly
// worse than applying it: it relies on someone reading past a success message
// to discover the success is conditional.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
let status = "running";
let elevate = true;
let restartThrows = false;
let probeOk = true;

vi.mock("../../src/hooks/daemon-client", () => ({
  attemptDaemonHook: vi.fn(async () => ({ ok: true, response: { exitCode: 0 } })),
  daemonAcceptsConnections: vi.fn(async () => true),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[] = []) => {
      const line = `${cmd} ${args.join(" ")}`;
      // Only the service-control calls are of interest; status probes must keep
      // answering or the helper never reaches the restart it is being tested on.
      if (line.includes("systemctl") && (line.includes("restart") || line.includes("reset-failed"))) {
        calls.push(line);
        if (restartThrows && line.includes("restart")) throw new Error("Interactive authentication required");
      }
      if (line.includes("is-active")) return Buffer.from(status === "running" ? "active" : "inactive");
      return Buffer.from("");
    }),
  };
});

beforeEach(() => {
  calls.length = 0;
  status = "running";
  elevate = true;
  restartThrows = false;
  probeOk = true;
  vi.resetModules();
});

afterEach(() => vi.clearAllMocks());

/**
 * The knobs, as dependencies.
 *
 * NOT `vi.spyOn(mod, …)`: these are module-INTERNAL calls, and ESM binds them at
 * module scope, so replacing the export leaves the function calling the
 * original. That mistake fails in the most misleading way available — three of
 * these tests passed against a stub that was never consulted.
 */
function deps() {
  return {
    status: () => status as never,
    elevate: () => elevate,
    probe: async () => (probeOk ? { ok: true as const } : { ok: false as const, reason: "worker" as const }),
  };
}

async function load() {
  return import("../../src/hooks/daemon-service");
}

describe("reloadDaemonAfterConfigChange", () => {
  it("restarts a running daemon so it picks up the new credential", async () => {
    const { reloadDaemonAfterConfigChange } = await load();
    const out = await reloadDaemonAfterConfigChange(deps());

    expect(out).toEqual({ reloaded: true });
    expect(calls.some((c) => c.includes("restart"))).toBe(true);
  });

  it("clears a latched start-limit before restarting", async () => {
    // `Restart=on-failure` plus a definition that cannot start trips systemd's
    // start limit, and a latched unit then REFUSES a legitimate restart. Every
    // restart path in this file resets first for that reason.
    const { reloadDaemonAfterConfigChange } = await load();
    await reloadDaemonAfterConfigChange(deps());

    const reset = calls.findIndex((c) => c.includes("reset-failed"));
    const restart = calls.findIndex((c) => c.includes("restart"));
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(restart);
  });

  it("does nothing when there is no service to reload", async () => {
    status = "not-installed";
    const { reloadDaemonAfterConfigChange } = await load();

    expect(await reloadDaemonAfterConfigChange(deps())).toEqual({ reloaded: false, reason: "no-service" });
    expect(calls).toEqual([]);
  });

  it("leaves a stopped service alone — its next start reads the new file", async () => {
    // Restarting something deliberately down is not this function's business,
    // and on `condition-failed` it could not start anyway.
    status = "stopped";
    const { reloadDaemonAfterConfigChange } = await load();

    expect(await reloadDaemonAfterConfigChange(deps())).toEqual({ reloaded: false, reason: "not-running" });
    expect(calls).toEqual([]);
  });

  it("reports the exact command when it cannot elevate", async () => {
    // The machine keeps shipping with the old key until someone runs this, so
    // the command is the whole message — "restart it" is not actionable at 2am.
    elevate = false;
    const { reloadDaemonAfterConfigChange } = await load();
    const out = await reloadDaemonAfterConfigChange(deps());

    expect(out.reloaded).toBe(false);
    expect(out).toMatchObject({ reason: "no-elevation" });
    expect("command" in out && out.command).toMatch(/systemctl restart|launchctl kickstart/);
    expect(calls.some((c) => c.includes("restart"))).toBe(false);
  });

  it("reports a restart that threw rather than claiming success", async () => {
    restartThrows = true;
    const { reloadDaemonAfterConfigChange } = await load();
    const out = await reloadDaemonAfterConfigChange(deps());

    expect(out).toMatchObject({ reloaded: false, reason: "restart-failed" });
  });

  it("does not call it reloaded when the daemon comes back unable to evaluate", async () => {
    // `systemctl restart` returning 0 proves the fork happened, not that the
    // thing can answer a hook — a `Type=simple` unit is active the instant it
    // is forked. Believing the exit code is how a daemon that cannot evaluate
    // gets reported as a successful reload.
    probeOk = false;
    const { reloadDaemonAfterConfigChange } = await load();
    const out = await reloadDaemonAfterConfigChange(deps());

    expect(out).toMatchObject({ reloaded: false, reason: "did-not-return" });
  });
});
