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
  // Recorded, so a test can assert the password prompt happens BEFORE the
  // removal rather than after it fails on `sudo -n`.
  primeElevation: vi.fn(() => {
    calls.push("primeElevation");
    return true;
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
  writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { configured: true } }));
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
    expect(res.lines.join("\n")).toMatch(/✓ Dry run: nothing was changed\./);
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
    expect(res.lines.slice(0, res.planLines).join("\n")).toMatch(/^▲ This removes /);
    expect(res.lines.slice(res.planLines).join("\n")).toMatch(/Cancelled/);
  });
});

describe("hooks/uninstall-cli — the one question (D17)", () => {
  it("states exactly what it removes: the hooks, the service, the policy settings, and what is kept", async () => {
    // Read off what the steps do, not summarised: `removeHooks(undefined,
    // "all", …)` also resets policies-config.json, which the old "settings
    // survive a reinstall" line hid.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    let shown: string[] = [];
    await runUninstallCommand({
      confirm: async (planLines) => {
        shown = planLines;
        return false;
      },
    });

    expect(shown).toEqual([
      "▲ This removes failproofai's hooks from 2 agents and the failproofaid service (needs sudo).",
      "  Agents: Claude Code, OpenAI Codex",
      "  Also resets enabled policies, custom policy paths and policy parameters in policies-config.json.",
      `  The rest of ${home} is kept unless you add --purge.`,
    ]);
  });

  it("says what --purge deletes, instead of what is kept", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ dryRun: true, purge: true });
    const plan = res.lines.slice(0, res.planLines);

    expect(plan[0]).toBe(
      `▲ This removes failproofai's hooks from 2 agents, the failproofaid service (needs sudo) and ${home}.`,
    );
    expect(plan).toContain(`  ${home} holds your settings, credentials, audit history and the daemon binary.`);
    expect(plan.join("\n")).not.toMatch(/is kept/);
  });

  it("names only what this machine has: no service, no service in the question", async () => {
    rmSync(servicePath, { force: true });
    configured = false;
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ dryRun: true });

    expect(res.lines[0]).toBe("▲ This removes failproofai's hooks from 2 agents.");
    expect(res.lines.join("\n")).not.toMatch(/failproofaid/);
  });

  it("asks nothing under --yes, so it shows no question: what it did follows", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    expect(res.planLines).toBe(0);
    expect(res.lines.join("\n")).not.toMatch(/This removes/);
    expect(res.lines).toContain("✓ Removed hooks from 2 agents.");
    expect(res.lines).toContain("✓ Stopped and removed the failproofaid service.");
    expect(res.lines).toContain("  Remove the npm package too:  npm rm -g failproofai");
  });

  it("paints by role with colour on, and writes no escape at all with it off", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const saved = { COLORTERM: process.env.COLORTERM, TERM: process.env.TERM };
    process.env.COLORTERM = "truecolor";
    process.env.TERM = "xterm-256color";
    try {
      const coloured = await runUninstallCommand({ dryRun: true, render: { color: true } });
      const text = coloured.lines.join("\n");
      expect(text).toContain("\x1B[38;2;227;179;65m▲\x1B[0m This removes");
      expect(text).toContain("\x1B[38;2;102;209;181m✓\x1B[0m Dry run");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const plain = await runUninstallCommand({ dryRun: true, render: { color: false } });
    expect(plain.lines.join("\n")).not.toMatch(/\x1B\[/);
  });
});

describe("hooks/uninstall-cli — who decides the daemon's fate", () => {
  // There is ONE question now (D17), and its text names the service. Yes to it
  // is yes to the whole plan, exactly what --yes means; the old second question
  // ("remove the service too?") is gone. Keeping the daemon while removing the
  // hooks is `failproofai policies --uninstall`, which takes out only the hooks.

  it("a confirmed uninstall removes the service, asking for sudo FIRST", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ confirm: async () => true });

    expect(res.exitCode).toBe(0);
    // The prompt comes BEFORE the removal, or the removal fails on `sudo -n` and
    // prints a unit file to delete by hand — the whole point of asking.
    expect(calls.indexOf("primeElevation")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("primeElevation")).toBeLessThan(calls.indexOf("uninstallDaemonService"));
    expect(existsSync(servicePath)).toBe(false);
    expect(res.lines).toContain("✓ Stopped and removed the failproofaid service.");
  });

  it("asks once, and only the one question: the plan it shows names the service", async () => {
    const confirm = vi.fn(async (_planLines: string[]) => true);
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    await runUninstallCommand({ confirm });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0][0]).toMatch(/the failproofaid service \(needs sudo\)/);
  });

  it("removes nothing when there is nobody to ask", async () => {
    // No TTY and no --yes: the confirm hook is absent, and that is a refusal.
    // Removing a service nobody agreed to remove is not recoverable.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({});

    expect(calls).not.toContain("uninstallDaemonService");
    expect(existsSync(servicePath)).toBe(true);
    expect(res.exitCode).toBe(1);
  });

  it("--purge removes it, because it deletes the binary", async () => {
    // Purge deletes ~/.failproofai, where the daemon binary lives. Leaving an
    // enabled unit whose ExecStart has just been deleted crash-loops the service
    // at every boot — so "keep the daemon" is not an option purge can offer.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ purge: true, confirm: async () => true });

    expect(calls).toContain("uninstallDaemonService");
    expect(calls.indexOf("primeElevation")).toBeLessThan(calls.indexOf("uninstallDaemonService"));
    expect(res.exitCode).toBe(0);
  });

  it("--yes still removes it — the flag means yes to the plan", async () => {
    // Scripted uninstalls rely on this. Making --yes keep the daemon would
    // silently start leaving a service behind on every automated run.
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    await runUninstallCommand({ yes: true });

    expect(calls).toContain("uninstallDaemonService");
  });

  it("says in the plan that the service goes, and that it needs sudo", async () => {
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ dryRun: true });
    expect(res.lines[0]).toMatch(/the failproofaid service \(needs sudo\)/);

    const purged = await runUninstallCommand({ purge: true, dryRun: true });
    expect(purged.lines[0]).toMatch(/the failproofaid service \(needs sudo\)/);
  });

  it("says what to run as root when the service survives the removal", async () => {
    serviceExists = false; // the mock then leaves the file in place
    const { runUninstallCommand } = await import("../../src/hooks/uninstall-cli");
    const res = await runUninstallCommand({ yes: true });

    const at = res.lines.findIndex((l) => l.startsWith("✕ The failproofaid service is still there"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(res.lines.slice(at + 1, at + 6)).toEqual([
      "  Remove it as root:",
      "    sudo systemctl disable --now failproofaid@tester.service",
      `    sudo rm -f ${servicePath}`,
      "    sudo systemctl daemon-reload",
      "  Check it with  systemctl status failproofaid@tester",
    ]);
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
