import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  PAUSE_CEILING_MS,
  PAUSE_DEFAULT_MS,
  clearAllPauses,
  clearPause,
  formatDuration,
  listActivePauses,
  parsePauseDuration,
  pauseStateDir,
  readActivePause,
  writePause,
} from "../../src/hooks/session-pause";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(resolve(tmpdir(), "fpai-pause-"));
  process.env.FAILPROOFAI_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.FAILPROOFAI_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("parsePauseDuration", () => {
  it("defaults to 30 minutes when given nothing", () => {
    expect(parsePauseDuration(undefined)).toBe(PAUSE_DEFAULT_MS);
    expect(parsePauseDuration("")).toBe(PAUSE_DEFAULT_MS);
  });

  it("reads s / m / h suffixes, and a bare number as minutes", () => {
    expect(parsePauseDuration("90s")).toBe(90_000);
    expect(parsePauseDuration("10m")).toBe(600_000);
    expect(parsePauseDuration("2h")).toBe(7_200_000);
    expect(parsePauseDuration("45")).toBe(45 * 60_000);
  });

  it("REFUSES a duration over the ceiling rather than silently clamping", () => {
    // Clamping would hand back a shorter pause than the user believes they
    // asked for — they'd think enforcement was off for 12h when it resumed
    // after 8. Saying no is the only honest answer.
    expect(() => parsePauseDuration("12h")).toThrow(/exceeds the maximum pause of 8h/);
  });

  it("honours a lowered ceiling, and still refuses above it", () => {
    expect(parsePauseDuration("1h", 2 * 3_600_000)).toBe(3_600_000);
    expect(() => parsePauseDuration("4h", 2 * 3_600_000)).toThrow(/maximum pause of 2h/);
  });

  it("caps the implicit default at a ceiling lower than the default", () => {
    // A project that sets a 10m ceiling must not get 30m from a bare --pause.
    expect(parsePauseDuration(undefined, 600_000)).toBe(600_000);
  });

  it("rejects garbage and non-positive durations", () => {
    expect(() => parsePauseDuration("soon")).toThrow(/Invalid duration/);
    expect(() => parsePauseDuration("-5m")).toThrow(/Invalid duration/);
    expect(() => parsePauseDuration("0m")).toThrow(/greater than zero/);
  });
});

describe("pause state", () => {
  it("round-trips a pause for a session", () => {
    const now = 1_000_000;
    writePause({ sessionId: "sess-a", durationMs: 600_000, cwd: "/tmp/x", now });
    const active = readActivePause("sess-a", now + 1000);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe("sess-a");
    expect(active!.expiresAt).toBe(now + 600_000);
    expect(active!.cwd).toBe("/tmp/x");
  });

  it("is scoped to one session — a pause never leaks to another", () => {
    const now = 1_000_000;
    writePause({ sessionId: "sess-a", durationMs: 600_000, now });
    expect(readActivePause("sess-b", now)).toBeNull();
  });

  it("goes inert the moment it expires, with no sweeper involved", () => {
    const now = 1_000_000;
    writePause({ sessionId: "sess-a", durationMs: 60_000, now });
    expect(readActivePause("sess-a", now + 59_999)).not.toBeNull();
    expect(readActivePause("sess-a", now + 60_000)).toBeNull();
    expect(readActivePause("sess-a", now + 10_000_000)).toBeNull();
    // The file is still on disk — expiry is evaluated at read time, so a stale
    // file left by a crash cannot resurrect a pause.
    expect(readdirSync(pauseStateDir()).length).toBe(1);
  });

  it("treats an unreadable or malformed state file as NOT paused", () => {
    // Fail toward enforcement: a corrupt file must never read as "policies off".
    mkdirSync(pauseStateDir(), { recursive: true });
    for (const name of readdirSync(pauseStateDir())) rmSync(resolve(pauseStateDir(), name));
    writePause({ sessionId: "sess-a", durationMs: 600_000, now: 1_000 });
    const file = resolve(pauseStateDir(), readdirSync(pauseStateDir())[0]);
    writeFileSync(file, "{ this is not json");
    expect(readActivePause("sess-a", 2_000)).toBeNull();
  });

  it("rejects a state file from a future schema version", () => {
    writePause({ sessionId: "sess-a", durationMs: 600_000, now: 1_000 });
    const file = resolve(pauseStateDir(), readdirSync(pauseStateDir())[0]);
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 99, sessionId: "sess-a", pausedAt: 1_000, expiresAt: 9_999_999 }),
    );
    expect(readActivePause("sess-a", 2_000)).toBeNull();
  });

  it("survives a session id containing path separators", () => {
    // Session ids come from twelve CLIs and are not a format we control; the
    // filename is a digest precisely so `../` can't escape the state dir.
    const nasty = "../../etc/passwd";
    writePause({ sessionId: nasty, durationMs: 600_000, now: 1_000 });
    expect(readActivePause(nasty, 2_000)?.sessionId).toBe(nasty);
    expect(readdirSync(pauseStateDir()).every((n) => n.endsWith(".json"))).toBe(true);
  });

  it("clearPause ends it early and reports whether anything was there", () => {
    writePause({ sessionId: "sess-a", durationMs: 600_000, now: 1_000 });
    expect(clearPause("sess-a")).toBe(true);
    expect(readActivePause("sess-a", 2_000)).toBeNull();
    expect(clearPause("sess-a")).toBe(false);
  });

  it("re-pausing an already paused session extends from now", () => {
    writePause({ sessionId: "sess-a", durationMs: 600_000, now: 1_000 });
    const second = writePause({ sessionId: "sess-a", durationMs: 600_000, now: 500_000 });
    expect(second.expiresAt).toBe(1_100_000);
    expect(readActivePause("sess-a", 700_000)).not.toBeNull();
  });

  it("listActivePauses omits expired entries and sorts newest first", () => {
    writePause({ sessionId: "old", durationMs: 60_000, now: 1_000 });
    writePause({ sessionId: "live-1", durationMs: 600_000, now: 2_000 });
    writePause({ sessionId: "live-2", durationMs: 600_000, now: 3_000 });
    const active = listActivePauses(100_000);
    expect(active.map((p) => p.sessionId)).toEqual(["live-2", "live-1"]);
  });

  it("has no unbounded form — every pause carries a finite expiry", () => {
    const pause = writePause({ sessionId: "sess-a", durationMs: PAUSE_CEILING_MS, now: 1_000 });
    expect(Number.isFinite(pause.expiresAt)).toBe(true);
    expect(pause.expiresAt - pause.pausedAt).toBeLessThanOrEqual(PAUSE_CEILING_MS);
  });

  // The ceiling was measured from `pausedAt`, which every renewal reset to now.
  // So `--pause 8h` re-issued every seven hours suspended enforcement forever,
  // one individually-legal command at a time, and every single check passed.
  it("measures the ceiling from the start of the run, not the latest renewal", () => {
    const start = 1_000_000;
    writePause({ sessionId: "sess-r", durationMs: PAUSE_CEILING_MS, now: start });

    // Renewed after seven hours, asking for another full eight.
    const sevenHours = 7 * 3_600_000;
    const renewed = writePause({
      sessionId: "sess-r",
      durationMs: PAUSE_CEILING_MS,
      now: start + sevenHours,
    });

    expect(renewed.firstPausedAt).toBe(start);
    expect(renewed.expiresAt).toBe(start + PAUSE_CEILING_MS);
    // i.e. one more hour, not another eight.
    expect(renewed.expiresAt - (start + sevenHours)).toBe(3_600_000);
  });

  it("starts a fresh ceiling once a pause has actually lapsed", () => {
    // The bound is on one unbroken stretch of suspended enforcement, not a
    // daily quota — otherwise a machine could be permanently unable to pause.
    const start = 2_000_000;
    writePause({ sessionId: "sess-l", durationMs: 60_000, now: start });
    const later = start + PAUSE_CEILING_MS * 2;
    const fresh = writePause({ sessionId: "sess-l", durationMs: 60_000, now: later });

    expect(fresh.firstPausedAt).toBe(later);
    expect(fresh.expiresAt).toBe(later + 60_000);
  });

  it("clamps an expiry that was written by hand past the ceiling", () => {
    // The state directory is owner-writable by design, so the bound has to hold
    // against a file this process did not write — otherwise editing one number
    // buys a pause that never ends.
    const start = 3_000_000;
    writePause({ sessionId: "sess-h", durationMs: 60_000, now: start });
    const [file] = readdirSync(pauseStateDir());
    writeFileSync(
      resolve(pauseStateDir(), file),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "sess-h",
        pausedAt: start,
        firstPausedAt: start,
        expiresAt: start + 365 * 24 * 3_600_000,
        setBy: "hand-edited",
      }),
    );

    const read = readActivePause("sess-h", start + 1000);
    expect(read?.expiresAt).toBe(start + PAUSE_CEILING_MS);
    // And it is genuinely inert once the ceiling passes.
    expect(readActivePause("sess-h", start + PAUSE_CEILING_MS + 1)).toBeNull();
  });

  // The clamp above measures the ceiling from `firstPausedAt`, which comes from
  // the same file. Moving the START out of reach moved the ceiling with it: a
  // file dated 2100 read as live on every tool call until then — a single forged
  // write that outlasted every session on the machine (FailproofAI/agenteye#1796).
  describe("a pause that claims to start in the future", () => {
    const forge = (fields: Record<string, unknown>) => {
      writePause({ sessionId: "sess-f", durationMs: 60_000, now: 1_000 });
      const [file] = readdirSync(pauseStateDir());
      writeFileSync(
        resolve(pauseStateDir(), file),
        JSON.stringify({ schemaVersion: 1, sessionId: "sess-f", setBy: "cli", ...fields }),
      );
    };
    const now = Date.UTC(2026, 10, 24);
    const year2100 = Date.UTC(2100, 0, 1);

    it("is not a pause at all", () => {
      forge({ pausedAt: year2100, firstPausedAt: year2100, expiresAt: year2100 });
      expect(readActivePause("sess-f", now)).toBeNull();
      expect(readActivePause("sess-f", now + 30 * 24 * 3_600_000)).toBeNull();
      expect(listActivePauses(now)).toEqual([]);
    });

    it("is refused when only the start of the run is in the future", () => {
      forge({ pausedAt: now, firstPausedAt: year2100, expiresAt: now + 60_000 });
      expect(readActivePause("sess-f", now)).toBeNull();
    });

    it("is refused when the run starts after its latest renewal", () => {
      forge({ pausedAt: now - 60_000, firstPausedAt: now - 1_000, expiresAt: now + 60_000 });
      expect(readActivePause("sess-f", now)).toBeNull();
    });

    // The writer and the reader share one clock, so a legitimate file is never
    // ahead of it by more than a clock correction. Refusing would only ever turn
    // enforcement back ON, but a pause that vanishes after a small clock step
    // would just be re-issued, so a minute of slack costs nothing.
    it("tolerates a small clock step backwards", () => {
      forge({ pausedAt: now + 30_000, firstPausedAt: now + 30_000, expiresAt: now + 90_000 });
      expect(readActivePause("sess-f", now)?.expiresAt).toBe(now + 90_000);
    });

    it("never lets a forged start carry into a real renewal", () => {
      forge({ pausedAt: year2100, firstPausedAt: year2100, expiresAt: year2100 });
      const renewed = writePause({ sessionId: "sess-f", durationMs: 60_000, now });
      expect(renewed.firstPausedAt).toBe(now);
      expect(renewed.expiresAt).toBe(now + 60_000);
    });

    // A renewal carries the run's start forward. After a small clock step back,
    // that start reads as later than the renewal, and the reader would refuse
    // the very pause the CLI had just reported extended.
    it("survives a renewal issued just after the clock stepped back", () => {
      writePause({ sessionId: "sess-c", durationMs: 600_000, now });
      const renewed = writePause({ sessionId: "sess-c", durationMs: 600_000, now: now - 30_000 });
      expect(renewed.firstPausedAt).toBe(now - 30_000);
      expect(readActivePause("sess-c", now - 30_000)?.expiresAt).toBe(now + 570_000);
    });

    // Not honoured yet is not the same as gone: a file dated an hour ahead turns
    // live in an hour. Ending every pause has to end that one too.
    it("is removed by clearAllPauses, which counts only the active ones", () => {
      forge({ pausedAt: now + 3_600_000, firstPausedAt: now + 3_600_000, expiresAt: now + 9 * 3_600_000 });
      writePause({ sessionId: "sess-live", durationMs: 600_000, now });
      expect(clearAllPauses(now)).toEqual({ cleared: 1, incomplete: false });
      expect(readdirSync(pauseStateDir())).toEqual([]);
      expect(readActivePause("sess-f", now + 2 * 3_600_000)).toBeNull();
    });
  });
});

// A pause file that stays behind is still read by the hook, so it must never be
// counted as cleared (found in review). Root ignores directory modes, so these
// only mean something for an ordinary user, which is what CI runs as.
describe.skipIf(process.getuid?.() === 0)("clearAllPauses when a file will not go", () => {
  const now = Date.UTC(2026, 10, 24);
  const withMode = (mode: number, body: () => void) => {
    chmodSync(pauseStateDir(), mode);
    try {
      body();
    } finally {
      chmodSync(pauseStateDir(), 0o700);
    }
  };

  it("does not count a pause it could not remove, and says so", () => {
    writePause({ sessionId: "sess-ro", durationMs: 600_000, now });
    withMode(0o500, () => {
      expect(clearAllPauses(now)).toEqual({ cleared: 0, incomplete: true });
    });
    expect(readActivePause("sess-ro", now)).not.toBeNull();
  });

  // Without read permission the directory cannot be listed, but the hook opens
  // each pause by name and still finds it — so "nothing listed" is not "nothing
  // paused".
  it("reports a directory it cannot list instead of calling it empty", () => {
    writePause({ sessionId: "sess-nolist", durationMs: 600_000, now });
    withMode(0o300, () => {
      expect(clearAllPauses(now)).toEqual({ cleared: 0, incomplete: true });
      expect(readActivePause("sess-nolist", now)).not.toBeNull();
    });
  });
});

describe("formatDuration", () => {
  it("renders seconds, minutes and hours readably", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(PAUSE_CEILING_MS)).toBe("8h");
  });
});
