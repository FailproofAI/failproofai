// @vitest-environment node
//
// `failproofai uninstall` exists because npm runs no uninstall script, so
// `npm rm -g failproofai` leaves hook entries in every agent CLI and a
// root-owned systemd unit behind. The property these tests defend is not "it
// deletes things" — it is the ORDER it deletes them in.
//
// `daemonConfigured` must come down FIRST. Any other order leaves a window in
// which the flag demands a daemon that has already been removed, and on a
// fail-closed machine that window denies every tool call in every agent CLI.
// That exact combination bricked a machine during development; these tests are
// what stop it coming back through the uninstall path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Call order across the mocked modules, which is the actual thing under test. */
const calls: string[] = [];

let home: string;
let servicePath: string;
let serviceExists = true;
let configured = true;
let installedClis: string[] = ["claude", "codex"];

vi.mock("../../src/hooks/manager", () => ({
  removeHooks: vi.fn(async () => {
    calls.push("removeHooks");
  }),
}));

vi.mock("../../src/hooks/daemon-service", () => ({
  isDaemonSupportedPlatform: () => true,
  daemonServiceFilePath: () => servicePath,
  daemonStatusCommand: () => "systemctl status failproofaid@tester",
  daemonServiceStatus: () => "running",
  setDaemonConfigured: vi.fn((v: boolean) => {
    calls.push(`setDaemonConfigured(${v})`);
    configured = v;
  }),
  uninstallDaemonService: vi.fn(async () => {
    calls.push("uninstallDaemonService");
    if (serviceExists) rmSync(servicePath, { force: true });
  }),
}));

vi.mock("../../src/hooks/fp-config", () => ({
  readConfig: () => ({ daemon: { configured } }),
}));

vi.mock("../../src/hooks/integrations", () => ({
  listInstallableIds: () => ["claude", "codex", "cursor"],
  getIntegration: (id: string) => ({
    displayName: id === "claude" ? "Claude Code" : id === "codex" ? "OpenAI Codex" : "Cursor",
    hooksInstalledInSettings: (scope: string) => scope === "user" && installedClis.includes(id),
  }),
}));

vi.mock("../../src/hooks/fp-home", () => ({
  failproofaiHome: () => home,
}));

beforeEach(() => {
  calls.length = 0;
  home = mkdtempSync(join(tmpdir(), "fpai-uninstall-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "config.toml"), "[daemon]\nconfigured = true\n");
  servicePath = join(home, "failproofaid@tester.service");
  writeFileSync(servicePath, "[Unit]\n");
  serviceExists = true;
  configured = true;
  installedClis = ["claude", "codex"];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("hooks/uninstall-cli", () => {
  it("clears daemonConfigured BEFORE removing hooks or the service", async () => {
    // The whole safety argument in one assertion. If the flag is cleared last,
    // a failure at any earlier step leaves the machine requiring a daemon that
    // is already gone — which denies every tool call, including the prompt
    // events, locking the user out of their own agent.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    expect(res.exitCode).toBe(0);
    expect(calls[0]).toBe("setDaemonConfigured(false)");
    expect(calls.indexOf("setDaemonConfigured(false)")).toBeLessThan(calls.indexOf("removeHooks"));
    expect(calls.indexOf("setDaemonConfigured(false)")).toBeLessThan(
      calls.indexOf("uninstallDaemonService"),
    );
  });

  it("stops before touching the service when the flag cannot be cleared", async () => {
    // Pressing on here is the lockout: the service goes away while the machine
    // still insists on routing through it.
    const svc = await import("../../src/hooks/daemon-service");
    vi.mocked(svc.setDaemonConfigured).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open 'config.toml'");
    });
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    expect(res.exitCode).toBe(2);
    expect(calls).not.toContain("uninstallDaemonService");
    expect(calls).not.toContain("removeHooks");
    expect(res.lines.join("\n")).toMatch(/would deny every tool call/);
  });

  it("refuses without --yes when there is no way to confirm", async () => {
    // A prompt that cannot be answered must never read as consent to delete a
    // root-owned service — this is the CI / piped-stdin path.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({});

    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toMatch(/Re-run with --yes/);
    expect(calls).toEqual([]);
  });

  it("changes nothing when the confirmation is declined", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ confirm: async () => false });

    expect(res.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(servicePath)).toBe(true);
  });

  it("--dry-run reports the plan and touches nothing", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ dryRun: true, purge: true });

    expect(res.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(home)).toBe(true);
    expect(res.lines.join("\n")).toMatch(/--dry-run: nothing was changed/);
  });

  it("keeps ~/.failproofai unless --purge, and deletes it after the service is down", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");

    const kept = await runUninstallCommand({ yes: true });
    expect(existsSync(home)).toBe(true);
    expect(kept.lines.join("\n")).toMatch(/was kept/);

    // Purge must come after the service teardown: the daemon binary and socket
    // live in this directory, and pulling them from under a running unit turns
    // a clean uninstall into a restart loop.
    calls.length = 0;
    configured = true;
    writeFileSync(servicePath, "[Unit]\n");
    const purged = await runUninstallCommand({ yes: true, purge: true });
    expect(purged.exitCode).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(calls.indexOf("uninstallDaemonService")).toBeGreaterThan(-1);
  });

  it("exits non-zero and prints manual commands when the service survives", async () => {
    // `uninstallDaemonService` is best-effort by contract — it warns and returns
    // rather than throwing when it cannot elevate. Believing the absence of an
    // exception is how a machine gets reported clean with a root-owned unit
    // still on it.
    serviceExists = false; // the mock then leaves the file in place
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    expect(res.exitCode).toBe(1);
    const out = res.lines.join("\n");
    expect(out).toMatch(/still there/);
    expect(out).toMatch(/sudo systemctl disable --now failproofaid@tester\.service/);
    expect(out).toMatch(/sudo rm -f/);
    // Enforcement is still off even though cleanup was incomplete.
    expect(calls[0]).toBe("setDaemonConfigured(false)");
  });

  it("surveys every installable CLI, not just the ones still on PATH", async () => {
    // Hook entries outlive the CLI that owned them; a survey of what is
    // currently installed walks straight past the orphans.
    installedClis = ["cursor"];
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ dryRun: true });

    expect(res.lines.join("\n")).toMatch(/Cursor/);
  });

  it("reports nothing to do on a machine that has nothing", async () => {
    installedClis = [];
    configured = false;
    rmSync(servicePath, { force: true });
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    expect(res.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(res.lines[0]).toMatch(/Nothing to uninstall/);
  });

  it("reports how much of `lines` the plan is, so callers do not print it twice", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ confirm: async () => false });

    expect(res.planLines).toBeGreaterThan(0);
    // The plan is a prefix of the output, and what follows it is the outcome.
    expect(res.lines.slice(0, res.planLines).join("\n")).toMatch(/failproofai uninstall will:/);
    expect(res.lines.slice(res.planLines).join("\n")).toMatch(/Cancelled/);
  });
});

describe("hooks/uninstall-cli — purge leaves nothing behind", () => {
  it("reports `purged` so the caller knows not to touch the home again", async () => {
    // The caller's post-command telemetry resolves an instance id, and
    // `getInstanceId()` lazily WRITES ~/.failproofai/state/telemetry-id — which
    // re-created the entire directory seconds after the purge deleted it. The
    // machine the user had just wiped came back holding a brand-new tracking
    // identifier, and "✓ deleted" was a lie. Found by the container test, which
    // checked the filesystem rather than the command's own output.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true, purge: true });

    expect(res.purged).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it("reports purged=false on every path that keeps the home", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");

    expect((await runUninstallCommand({ dryRun: true, purge: true })).purged).toBe(false);
    expect((await runUninstallCommand({ confirm: async () => false, purge: true })).purged).toBe(false);
    expect((await runUninstallCommand({ yes: true })).purged).toBe(false);
    expect(existsSync(home)).toBe(true);
  });
});
