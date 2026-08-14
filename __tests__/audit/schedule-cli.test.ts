// @vitest-environment node
/**
 * `failproofai audit --schedule` / `--no-schedule` / `--status`.
 *
 * The property worth defending here is the one the user asked for by name: the
 * CLI and the dashboard must always agree. That is structural — both call
 * `updateConfig` and both read `audit/session.json` — so what these tests pin is
 * the shape that makes it structural, plus the two orderings that decide whether
 * a half-finished command leaves state behind:
 *
 *   - a bad day count must be rejected BEFORE anything is written or any code is
 *     emailed, or a typo costs a login;
 *   - turning scheduling ON requires a session (a timer with nobody to tell is a
 *     switch that reads as on and produces nothing), while turning it OFF never
 *     checks — an expired session must not trap somebody into keeping a feature
 *     they are trying to disable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readConfig, updateConfig } from "../../src/hooks/fp-config";
import { writeAuth, readAuth, deleteAuth, type StoredAuth } from "../../lib/auth/auth-store";
import { runScheduleOn, runScheduleOff, runScheduleStatus, ScheduleCliError } from "../../src/audit/schedule-cli";

/**
 * The daemon's real state is a property of the machine running the tests — this
 * repo's own dev box has a `failproofaid@sidd` unit, CI has none — so reading it
 * for real would make these tests pass or fail on where they ran. It is stubbed,
 * and the two answers that change what the command prints are asserted directly.
 */
const daemonStatus = vi.hoisted(() => ({ value: "running" as string }));
vi.mock("../../src/hooks/daemon-service", () => ({
  daemonServiceStatus: () => daemonStatus.value,
  isDaemonSupportedPlatform: () => true,
}));

let home: string;
let prevHome: string | undefined;
let out: string[];
let err: string[];

const SESSION: StoredAuth = {
  access_token: "at",
  refresh_token: "rt",
  access_expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: { id: "u_1", email: "you@example.com" },
};

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-schedcli-"));
  process.env.FAILPROOFAI_HOME = home;
  out = [];
  err = [];
  daemonStatus.value = "running";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const stdout = () => out.join("");
const stderr = () => err.join("");

describe("audit --schedule", () => {
  it("turns scheduling on and records the interval", async () => {
    writeAuth(SESSION);
    await runScheduleOn("3");

    const config = readConfig();
    expect(config.audit.auto).toBe(true);
    expect(config.audit.intervalDays).toBe(3);
    // The address is named, because that is the half of the decision a person
    // is most likely to have forgotten.
    expect(stdout()).toContain("you@example.com");
    expect(stdout()).toContain("every 3 days");
  });

  it("keeps the existing interval when no day count is given", async () => {
    writeAuth(SESSION);
    updateConfig({ audit: { intervalDays: 14 } });

    await runScheduleOn(undefined);

    expect(readConfig().audit.auto).toBe(true);
    expect(readConfig().audit.intervalDays).toBe(14);
  });

  it("prints the interval the config actually kept, not the one asked for", async () => {
    writeAuth(SESSION);
    // 90 is the ceiling `readIntervalDays` enforces. The CLI rejects anything
    // above it outright, so the clamp is exercised at the boundary instead.
    await runScheduleOn("90");
    expect(readConfig().audit.intervalDays).toBe(90);
    expect(stdout()).toContain("every 90 days");
  });

  it.each(["0", "91", "-1", "2.5", "soon", ""])(
    "rejects %o without writing anything or asking for a code",
    async (bad) => {
      // No session on disk: if the command reached the sign-in step it would
      // throw a LoginError about a non-interactive terminal instead, and the
      // day count would have gone unchecked until after an email was sent.
      await expect(runScheduleOn(bad)).rejects.toBeInstanceOf(ScheduleCliError);
      expect(readConfig().audit.auto).toBe(false);
    },
  );

  it("refuses to turn scheduling on with no session and no terminal", async () => {
    // vitest runs without a TTY, so `canPrompt()` is false — the same state a
    // cron line or a CI runner is in. It must fail with a sentence rather than
    // hang on a prompt nobody will answer.
    await expect(runScheduleOn("7")).rejects.toThrow(/interactive terminal/i);
    expect(readConfig().audit.auto).toBe(false);
  });
});

describe("audit --no-schedule", () => {
  it("turns scheduling off and leaves the session alone", async () => {
    writeAuth(SESSION);
    await runScheduleOn("7");
    out = [];

    runScheduleOff();

    expect(readConfig().audit.auto).toBe(false);
    // Signing out is a separate decision, and the command says so — the session
    // file is untouched, so re-enabling later costs no second round of OTP.
    expect(readAuth()?.user.email).toBe("you@example.com");
    expect(stdout()).toContain("off");
  });

  it("works when signed out — an expired session must not trap anyone", () => {
    updateConfig({ audit: { auto: true } });
    deleteAuth();

    runScheduleOff();

    expect(readConfig().audit.auto).toBe(false);
  });

  it("says so when it was already off, rather than claiming it changed something", () => {
    runScheduleOff();
    expect(stdout()).toContain("already off");
  });
});

describe("audit --status", () => {
  it("reports off, with no email, on a fresh machine", () => {
    runScheduleStatus();
    expect(stdout()).toContain("scheduled audit");
    expect(stdout()).toContain("off");
    expect(stdout()).toContain("signed out");
  });

  it("reports on, the interval, and where reports go", async () => {
    writeAuth(SESSION);
    await runScheduleOn("5");
    out = [];

    runScheduleStatus();

    expect(stdout()).toContain("on");
    expect(stdout()).toContain("5 days");
    expect(stdout()).toContain("you@example.com");
  });

  it("names the scans-continue-digests-pause state when scheduling outlives the session", async () => {
    writeAuth(SESSION);
    await runScheduleOn("7");
    deleteAuth();
    out = [];

    runScheduleStatus();

    // The exact state `report-harm.ts` reports as "signed-out". Silence about
    // it would look like the feature failing.
    expect(stdout()).toMatch(/scans continue/i);
  });

  it("never throws on a home with no schedule, cache or machine file", () => {
    expect(() => runScheduleStatus()).not.toThrow();
  });
});

describe("CLI ⟷ dashboard parity", () => {
  it("writes the same keys the dashboard's server actions read", async () => {
    writeAuth(SESSION);
    await runScheduleOn("11");

    // `getScheduledAuditAction` reads exactly these two off `readConfig()`.
    // Same file, same reader, same writer — there is no second copy to drift.
    const { audit } = readConfig();
    expect({ auto: audit.auto, intervalDays: audit.intervalDays }).toEqual({
      auto: true,
      intervalDays: 11,
    });
  });

  it("a dashboard-side write is what the CLI reports", () => {
    updateConfig({ audit: { auto: true, intervalDays: 21 } });
    runScheduleStatus();
    expect(stdout()).toContain("21 days");
  });
});

describe("daemon reporting", () => {
  it("warns when scheduling is on but nothing will run it", async () => {
    daemonStatus.value = "not-installed";
    writeAuth(SESSION);
    await runScheduleOn("7");
    // Config says on; nothing runs it. Saying only "on" would leave the machine
    // in the same on-but-silent state the settings panel exists to make visible.
    expect(readConfig().audit.auto).toBe(true);
    expect(stderr()).toMatch(/nothing will run/i);
    expect(stderr()).toContain("failproofai config");
  });

  it("stays quiet when the daemon is up — a warning with no action is noise", async () => {
    writeAuth(SESSION);
    await runScheduleOn("7");
    expect(stderr()).toBe("");
  });

  it("--status names the repair for every state the daemon can be in", () => {
    for (const [status, expected] of [
      ["running", /running/],
      ["stopped", /failproofai config/],
      ["not-installed", /not installed/],
      ["condition-failed", /binary is missing/],
    ] as const) {
      out = [];
      daemonStatus.value = status;
      runScheduleStatus();
      expect(stdout(), status).toMatch(expected);
    }
  });
});
