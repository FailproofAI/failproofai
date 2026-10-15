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
    // Signing out is a separate decision — the session file is untouched, so
    // re-enabling later costs no second round of OTP. (The command no longer
    // says so in a line of its own: the redesign removes explanatory lines,
    // decision D6.)
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
    // Was a `scheduled audit  off` row before the 2026-10 screen language: the
    // heading now says what the block is about, and states read as words.
    expect(stdout()).toMatch(/^ {2}scans +○ Off$/m);
    expect(stdout()).toMatch(/^ {2}reports to +Signed out$/m);
  });

  it("is a screen in the new language: the Audit header, one heading, aligned rows", () => {
    runScheduleStatus();
    const lines = stdout().split("\n");
    expect(lines[1]).toMatch(/^failproof ai {2}v\S+ {2}· {2}Audit$/);
    expect(lines).toContain("SCHEDULE");
    // Every value starts on one column, whatever its label.
    const rows = lines.filter((l) => /^ {2}(scans|reports to|daemon|last result) /.test(l));
    expect(rows.length).toBe(4);
    const column = (l: string) => l.search(/(?<=\S {2,})\S/);
    expect(new Set(rows.map(column)).size).toBe(1);
    // No spine, no logomark, no hand-padded title.
    expect(stdout()).not.toMatch(/[│◆◇└▀▄█]/u);
    expect(stdout()).not.toContain("failproofai audit ");
  });

  it("states a schedule that is on with the on glyph and its interval", async () => {
    writeAuth(SESSION);
    await runScheduleOn("1");
    out = [];
    runScheduleStatus();
    expect(stdout()).toMatch(/^ {2}scans +● Every day$/m);
    expect(stdout()).toMatch(/^ {2}reports to +you@example\.com$/m);
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
    // A ▲ with the command that fixes it, rather than a pink row.
    expect(stdout()).toContain(
      "▲ Scans continue, but digests are paused until you sign in.  ·  failproofai audit --schedule",
    );
  });

  it("names a schedule that predates the consent stamp, with the fix", () => {
    // `audit.auto` set by a release where it only meant "scan locally": signed
    // in, scheduled, and still sending nothing until somebody opts in.
    writeAuth(SESSION);
    updateConfig({ audit: { auto: true } });
    runScheduleStatus();
    expect(stdout()).toContain("▲ Scans continue, but digests need a fresh opt-in.  ·  failproofai audit --schedule");
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
    // `running` is matched without case since the redesign, which capitalises
    // a state: `● Running`.
    for (const [status, expected] of [
      ["running", /running/i],
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

  it("--status gives the daemon a row and, when it needs fixing, one ▲ with the fix", () => {
    daemonStatus.value = "stopped";
    runScheduleStatus();
    expect(stdout()).toMatch(/^ {2}daemon +○ Stopped$/m);
    expect(stdout()).toContain("▲ The daemon is stopped.  ·  failproofai config");

    out = [];
    daemonStatus.value = "running";
    runScheduleStatus();
    expect(stdout()).toMatch(/^ {2}daemon +● Running$/m);
    expect(stdout()).not.toContain("▲");
  });

  it("warns on stderr in the new language when nothing will run the schedule", async () => {
    daemonStatus.value = "not-installed";
    writeAuth(SESSION);
    await runScheduleOn("7");
    expect(stderr()).toContain(
      "▲ The daemon is not installed, so nothing will run on the timer yet.  ·  failproofai config",
    );
  });
});

describe("audit --schedule, the screen", () => {
  it("states the result, then what each report sends, then where to look next", async () => {
    writeAuth(SESSION);
    await runScheduleOn("7");
    const lines = stdout().split("\n");
    expect(lines[1]).toMatch(/^failproof ai {2}v\S+ {2}· {2}Audit$/);
    expect(stdout()).toContain("✓ Scheduled audits to report to you@example.com every 7 days.\n");
    expect(stdout()).toContain("See when the next scan runs:  failproofai audit --status");
    expect(stdout()).not.toMatch(/[│◆◇└▀▄█]/u);
  });

  it("keeps the disclosure of what leaves the machine — the consent stamp certifies it was read", async () => {
    // `reportsConsentedAt` records that a person READ this line before anything
    // was sent, so it is part of the consent, not fine print, and the one
    // explanatory line the redesign keeps (decision D6). Removing it changes
    // what every stamp already written means.
    writeAuth(SESSION);
    await runScheduleOn("7");
    expect(stdout()).toContain(
      "\n  Each report sends finding counts, redacted example commands and this machine's name.\n",
    );
    expect(readConfig().audit.reportsConsentedAt).toEqual(expect.any(Number));
  });

  it("says every day, not every 1 days", async () => {
    writeAuth(SESSION);
    await runScheduleOn("1");
    expect(stdout()).toContain("every day.");
  });
});

describe("audit --no-schedule, the screen", () => {
  it("opens with the Audit header and states the result as a sentence", async () => {
    writeAuth(SESSION);
    await runScheduleOn("7");
    out = [];
    runScheduleOff();
    expect(stdout()).toMatch(/^\nfailproof ai {2}v\S+ {2}· {2}Audit\n\n✓ Turned off scheduled audits\.\n\n$/);
  });

  it("says plainly when there was nothing to turn off", () => {
    runScheduleOff();
    expect(stdout()).toContain("\nScheduled audits were already off.\n");
  });
});

describe("--email", () => {
  it("signs in without asking for the address", async () => {
    // The point of the flag: one command, then the only thing left to do is
    // read the code out of the email and type it.
    writeAuth(SESSION);
    await runScheduleOn("7", "you@example.com");

    expect(readConfig().audit.auto).toBe(true);
    expect(readConfig().audit.intervalDays).toBe(7);
  });

  it("matches the stored address case-insensitively, as a mail server would", async () => {
    writeAuth(SESSION);
    await expect(runScheduleOn("7", "YOU@Example.COM")).resolves.toBeUndefined();
    expect(readConfig().audit.auto).toBe(true);
  });

  it("refuses a DIFFERENT address rather than silently re-pointing the machine", async () => {
    // Where a machine's digests go is not something a flag should change
    // quietly — that is a thing nobody notices until they stop arriving.
    writeAuth(SESSION);

    await expect(runScheduleOn("7", "someone.else@example.com")).rejects.toThrow(
      /already signed in as you@example\.com/i,
    );
    // And nothing was written on the way to refusing.
    expect(readConfig().audit.auto).toBe(false);
  });

  it("rejects an address that is not one, before anything is sent", async () => {
    // No session on disk: reaching the sign-in would throw about a
    // non-interactive terminal instead, which is how we know this failed at the
    // flag rather than after a code had already gone out.
    for (const bad of ["nope", "a@b", "@example.com", ""]) {
      await expect(runScheduleOn("7", bad)).rejects.toThrow(/--email/);
    }
    expect(readConfig().audit.auto).toBe(false);
  });

  it("still requires a terminal for the code itself", async () => {
    // The flag answers the first question, not the second. vitest has no TTY,
    // which is the same position a cron line is in.
    await expect(runScheduleOn("7", "new@example.com")).rejects.toThrow(/interactive terminal/i);
  });
});
