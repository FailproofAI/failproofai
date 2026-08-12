// @vitest-environment node
/**
 * The headless audit entry point and the lock it shares with the interactive one.
 *
 * Two things are being pinned here. First, `runScheduledAudit` must be a real
 * second entry point — no TTY animation, no browser, no dashboard server left
 * running — reporting through an exit code, because the process that spawns it
 * has no other channel. Second, `failproofai audit` and the scheduled run must
 * actually contend: all three audit entry points write the same sha1-keyed
 * cache files, and until now the only lock lived inside the Next.js server
 * where neither of these two could see it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LAYOUT_VERSION } from "../../src/hooks/fp-home";
import type { AuditResult } from "../../src/audit/types";
import { acquireAuditLock } from "../../src/audit/audit-lock";
import { auditLockFile } from "../../src/hooks/fp-home";

const h = vi.hoisted(() => ({
  trackHookEvent: vi.fn(),
  runAudit: vi.fn(),
  writeDashboardCache: vi.fn(() => true),
  openWhenReady: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: h.trackHookEvent }));
vi.mock("../../src/audit/index", () => ({ runAudit: h.runAudit }));
vi.mock("../../src/audit/dashboard-cache", () => ({ writeDashboardCache: h.writeDashboardCache }));
vi.mock("../../src/audit/open-browser", () => ({ openWhenReady: h.openWhenReady }));
vi.mock("../../scripts/launch", () => ({ launch: h.launch }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: () => "test-instance" }));

import { runAuditCli, runScheduledAudit, EXIT_AUDIT_ALREADY_RUNNING } from "../../src/audit/cli";

function result(over: Partial<AuditResult> = {}): AuditResult {
  return {
    version: 2,
    scannedAt: "2026-08-05T00:00:00.000Z",
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 3, skipped: 0, errors: 0, durationMs: 0 },
    results: [],
    totals: { hits: 0, projectsWithHits: 0 },
    projectsScanned: [],
    eventsScanned: 100,
    enabledBuiltinNames: [],
    ...over,
  };
}

let home: string;
let prevHome: string | undefined;
let exitCode: number | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  h.trackHookEvent.mockImplementation(() => Promise.resolve());
  h.writeDashboardCache.mockReturnValue(true);
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-sched-"));
  process.env.FAILPROOFAI_HOME = home;
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error("__EXIT__");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const names = () => h.trackHookEvent.mock.calls.map((c) => c[1] as string);

describe("runScheduledAudit", () => {
  it("scans, caches, and exits 0 without touching a browser or a server", async () => {
    h.runAudit.mockResolvedValue(result({ totals: { hits: 4, projectsWithHits: 2 } }));

    expect(await runScheduledAudit()).toBe(0);

    expect(h.writeDashboardCache).toHaveBeenCalledTimes(1);
    // The whole point of the headless path: nothing here waits for a human.
    expect(h.openWhenReady).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
  });

  it("reports the existing audit events tagged source=scheduled", async () => {
    // Reusing cli_audit_* verbatim keeps every scheduled run comparable with the
    // manual ones; `source` is the only thing that separates them.
    h.runAudit.mockResolvedValue(result({ totals: { hits: 4, projectsWithHits: 2 } }));

    await runScheduledAudit();

    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_completed", {
      source: "scheduled",
      events_scanned: 100,
      sessions_scanned: 3,
      total_hits: 4,
      findings: 0,
    });
  });

  it("awaits its telemetry — nothing keeps this process alive afterwards", async () => {
    // Unlike runAuditCli there is no dashboard server holding the event loop
    // open past the return, so a fire-and-forget send would simply be dropped.
    const landed: string[] = [];
    h.trackHookEvent.mockImplementation((_id: string, name: string) =>
      new Promise<void>((res) => setTimeout(() => { landed.push(name); res(); }, 5)),
    );
    h.runAudit.mockResolvedValue(result());

    await runScheduledAudit();

    expect(landed).toEqual(["cli_audit_started", "cli_audit_completed"]);
  });

  it("exits 1 and reports cli_audit_failed when the scan throws", async () => {
    h.runAudit.mockRejectedValue(new TypeError("disk exploded"));

    expect(await runScheduledAudit()).toBe(1);

    expect(names()).toEqual(["cli_audit_started", "cli_audit_failed"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith("test-instance", "cli_audit_failed", {
      source: "scheduled",
      error_type: "TypeError",
      error_message: "disk exploded",
    });
  });

  it("exits 1 when the result cannot be persisted", async () => {
    // The cache is the only channel by which an unattended run reaches anyone.
    h.runAudit.mockResolvedValue(result());
    h.writeDashboardCache.mockReturnValue(false);

    expect(await runScheduledAudit()).toBe(1);
  });

  it("does not overwrite a real cached audit with an empty scan", async () => {
    // Unattended: a history rotation, or a service unit resolving HOME
    // elsewhere, would otherwise blank the dashboard with nobody watching.
    h.runAudit.mockResolvedValue(
      result({ eventsScanned: 0, transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 } }),
    );

    expect(await runScheduledAudit()).toBe(0);
    expect(h.writeDashboardCache).not.toHaveBeenCalled();
    // Still counted — a machine with no agent history is a real outcome.
    expect(names()).toEqual(["cli_audit_started", "cli_audit_completed"]);
  });

  it("exits 75 without scanning or reporting when another audit holds the lock", async () => {
    acquireAuditLock("dashboard");

    expect(await runScheduledAudit()).toBe(EXIT_AUDIT_ALREADY_RUNNING);

    expect(h.runAudit).not.toHaveBeenCalled();
    // A run that never started must not be counted as one that did.
    expect(names()).toEqual([]);
  });

  it("releases the lock on both the success and the failure path", async () => {
    h.runAudit.mockResolvedValue(result());
    await runScheduledAudit();
    expect(existsSync(auditLockFile())).toBe(false);

    h.runAudit.mockRejectedValue(new Error("nope"));
    await runScheduledAudit();
    expect(existsSync(auditLockFile())).toBe(false);
  });
});

describe("the scan stays on this machine", () => {
  it("uploads nothing, however much it finds", async () => {
    // The scheduled scan reads the CONTENTS of every session transcript on
    // disk — prompts, file contents, pasted credentials, command output. It
    // once POSTed a counters-only projection of that to FailproofAI Cloud; that
    // path is gone, and this pins that it does not come back by accident.
    //
    // `fetch` is the seam because it is the only way anything here reaches the
    // network. The unit-test network guard in `__tests__/setup.ts` would also
    // reject a real external call, but a spy states the intent locally and
    // catches a POST to a loopback address too.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    h.runAudit.mockResolvedValue(result({ totals: { hits: 12, projectsWithHits: 4 } }));

    expect(await runScheduledAudit()).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    // Still does its real job: the dashboard cache is the channel the user sees.
    expect(h.writeDashboardCache).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("`failproofai audit --scheduled`", () => {
  it("routes to the headless path and exits with its code", async () => {
    h.runAudit.mockResolvedValue(result());

    await expect(runAuditCli(["--scheduled"])).rejects.toThrow("__EXIT__");

    expect(exitCode).toBe(0);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("propagates the already-running code", async () => {
    acquireAuditLock("cli");

    await expect(runAuditCli(["--scheduled"])).rejects.toThrow("__EXIT__");

    expect(exitCode).toBe(EXIT_AUDIT_ALREADY_RUNNING);
  });

  it("still rejects stray arguments", async () => {
    // Adding a headless path must not turn `audit` into a command that quietly
    // ignores whatever else it was handed.
    await expect(runAuditCli(["--scheduled", "--since", "7d"])).rejects.toThrow("__EXIT__");
    expect(exitCode).toBe(1);
    expect(h.runAudit).not.toHaveBeenCalled();
  });
});

describe("the interactive `failproofai audit` shares the lock", () => {
  it("refuses to start a second scan and exits 75", async () => {
    acquireAuditLock("scheduled");

    await expect(runAuditCli([])).rejects.toThrow("__EXIT__");

    expect(exitCode).toBe(EXIT_AUDIT_ALREADY_RUNNING);
    expect(h.runAudit).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });

  it("releases the lock BEFORE parking on the dashboard", async () => {
    // launch() keeps the process alive for as long as the user leaves the
    // dashboard open. Holding the lock that long would block every scheduled
    // run until the one-hour stale ceiling expired.
    h.runAudit.mockResolvedValue(result());

    await runAuditCli([]);

    expect(h.launch).toHaveBeenCalledWith("start");
    expect(existsSync(auditLockFile())).toBe(false);
  });

  it("takes the lock before any telemetry, so a refusal is never counted as a run", async () => {
    // The order matters: acquiring after cli_audit_started would report a scan
    // that never happened every time two audits collided.
    acquireAuditLock("scheduled");
    await expect(runAuditCli([])).rejects.toThrow("__EXIT__");
    expect(h.trackHookEvent).not.toHaveBeenCalled();
  });
});

/**
 * The binary-level half of "headless".
 *
 * `runScheduledAudit` above is headless inside src/audit/cli.ts, but the daemon
 * does not call it — it spawns `failproofai audit --scheduled`, so everything
 * bin/failproofai.mjs does BEFORE dispatch runs unattended too. One of those
 * things deletes config.toml and credentials.toml. These tests therefore drive
 * the real binary as a subprocess, because that is the only place the bug lives.
 */
describe("the binary-level scheduled entry point", () => {
  // Each case boots `bun` and, in one case, runs a real scan. Vitest's 5s default
  // is fine for these in isolation and not fine when the whole suite is running
  // in parallel around them, which is the only way CI ever sees them.
  const SUBPROCESS_TIMEOUT_MS = 120_000;
  const REPO_ROOT = resolve(__dirname, "../..");
  let box: string;

  /** A home the CLI will read as an older layout: markers, but no VERSION. */
  function staleHome(): string {
    const home = mkdtempSync(resolve(tmpdir(), "fpai-stale-"));
    const fp = resolve(home, ".failproofai");
    mkdirSync(fp, { recursive: true });
    writeFileSync(
      resolve(fp, "config.toml"),
      '[mode]\nkind = "cloud"\n\n[telemetry]\nenabled = false\n\n[audit]\nauto = true\ninterval_days = 7\n',
    );
    // Layout 2's filenames on purpose — this fixture IS an old home. Converting
    // these to layout 3's `.json` names would mean the test no longer builds
    // the thing it is named after.
    writeFileSync(resolve(fp, "credentials.toml"), '[cloud]\ntoken = "secret-token"\n');
    // `config.toml` above is what makes `detectLayout` say "stale": layout 3
    // reuses layout 1's `policies-config.json` path, so that file alone no
    // longer proves an old layout.
    writeFileSync(resolve(fp, "policies-config.json"), "{}\n");
    return home;
  }

  function run(home: string, ...args: string[]) {
    return spawnSync("bun", [resolve(REPO_ROOT, "bin/failproofai.mjs"), ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FAILPROOFAI_HOME: resolve(home, ".failproofai"),
        FAILPROOFAI_TELEMETRY_DISABLED: "1",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
  }

  afterEach(() => {
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it("reports a stale layout instead of resetting it", () => {
    // The failure this prevents: the reset deletes config.toml and
    // credentials.toml, so one unattended tick silently revokes the user's
    // `[telemetry] enabled = false`, drops their cloud enrolment, and switches
    // off `[audit] auto` — the setting that scheduled the run. Nobody is
    // watching, and the explanation goes only to the service journal.
    box = staleHome();
    const fp = resolve(box, ".failproofai");

    const out = run(box, "audit", "--scheduled");

    expect(out.status).toBe(1);
    expect(out.stderr).toContain("failproofai config");
    expect(existsSync(resolve(fp, "config.toml"))).toBe(true);
    expect(readFileSync(resolve(fp, "config.toml"), "utf8")).toContain("auto = true");
    expect(readFileSync(resolve(fp, "config.toml"), "utf8")).toContain("enabled = false");
    expect(readFileSync(resolve(fp, "credentials.toml"), "utf8")).toContain("secret-token");
  }, SUBPROCESS_TIMEOUT_MS);

  it("still resets a stale layout for a command a human typed", () => {
    // The guard must be specific to the unattended path. An interactive command
    // resetting an old home — visibly, with the reason on screen — is the
    // behaviour the layout mechanism exists for, and it must not be collateral.
    box = staleHome();
    const fp = resolve(box, ".failproofai");

    const out = run(box, "policies");

    expect(out.stderr).toContain("reorganised");
    expect(existsSync(resolve(fp, "config.toml"))).toBe(false);
  }, SUBPROCESS_TIMEOUT_MS);

  it("runs the scan on a home whose layout is current", () => {
    // The other direction: the guard must not be "the scheduled run never
    // works". A current home scans and reports normally.
    box = mkdtempSync(resolve(tmpdir(), "fpai-current-"));
    const fp = resolve(box, ".failproofai");
    mkdirSync(fp, { recursive: true });
    writeFileSync(resolve(fp, "VERSION"), JSON.stringify({ layout: LAYOUT_VERSION, cli: "test" }));
    writeFileSync(resolve(fp, "config.json"), JSON.stringify({ audit: { auto: true, interval_days: 7 } }));

    const out = run(box, "audit", "--scheduled");

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("audit complete");
    // Survives untouched: a current home is not reset, so its config is still
    // there afterwards.
    expect(existsSync(resolve(fp, "config.json"))).toBe(true);
  }, SUBPROCESS_TIMEOUT_MS);
});
