import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/hooks-config", () => ({ readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })) }));
vi.mock("../../src/hooks/hook-activity-store", () => ({ getAllHookActivityEntries: vi.fn(() => []) }));

import {
  runPauseCommand,
  effectiveCeilingMs,
  pauseClockTime,
  pauseDurationWords,
} from "../../src/hooks/session-pause-cli";
import { readActivePause, writePause, PAUSE_CEILING_MS } from "../../src/hooks/session-pause";
import { readMergedHooksConfig } from "../../src/hooks/hooks-config";
import { getAllHookActivityEntries } from "../../src/hooks/hook-activity-store";

let stateDir: string;
const NOW = 1_000_000_000; // 1970-01-12T13:46:40Z
// Pinned so the clock reads the same wherever the suite runs: today's locale
// behaviour is kept, but a test cannot depend on the machine's zone.
const CLOCK = { locale: "en-GB", timeZone: "UTC" };
const PLAIN = { color: false, cols: 104 };
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

/** Run `fn` as a truecolor terminal would, then put the environment back. */
function withTrueColor<T>(fn: () => T): T {
  const keys = ["COLORTERM", "TERM", "NO_COLOR"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.COLORTERM = "truecolor";
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMergedHooksConfig).mockReturnValue({ enabledPolicies: [] } as never);
  vi.mocked(getAllHookActivityEntries).mockReturnValue([]);
  stateDir = mkdtempSync(resolve(tmpdir(), "fpai-pausecli-"));
  process.env.FAILPROOFAI_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.FAILPROOFAI_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("effectiveCeilingMs", () => {
  // The three tests that stood here asserted a config lowering that could not
  // happen: `readMergedHooksConfig` builds its result field by field and never
  // emits `maxPauseMs`, so the lookup always read `undefined`. They passed only
  // because they `vi.mock`ed that function to return a field the real one
  // cannot produce — a mock asserting against itself. The knob is gone.
  it("is the hard ceiling, and nothing lowers it", () => {
    expect(effectiveCeilingMs()).toBe(PAUSE_CEILING_MS);
  });
});

describe("--pause", () => {
  it("refuses, rather than guessing, when no session can be resolved", () => {
    // Pausing the wrong session leaves the user believing enforcement is off
    // when it is on. Guessing is worse than failing.
    const r = runPauseCommand({ action: "pause", cwd: "/tmp/project", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/No recent agent session found/);
    expect(r.lines.join("\n")).toMatch(/--session <id>/);
  });

  it("pauses the newest session seen in this directory", () => {
    vi.mocked(getAllHookActivityEntries).mockReturnValue([
      { timestamp: NOW - 5_000, sessionId: "older", cwd: "/tmp/project" },
      { timestamp: NOW - 1_000, sessionId: "newest", cwd: "/tmp/project" },
      { timestamp: NOW - 500, sessionId: "elsewhere", cwd: "/tmp/other" },
    ] as never);
    const r = runPauseCommand({ action: "pause", cwd: "/tmp/project", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(readActivePause("newest", NOW)).not.toBeNull();
    expect(readActivePause("elsewhere", NOW)).toBeNull();
  });

  it("ignores sessions older than the lookback window", () => {
    vi.mocked(getAllHookActivityEntries).mockReturnValue([
      { timestamp: NOW - 48 * 3_600_000, sessionId: "ancient", cwd: "/tmp/project" },
    ] as never);
    expect(runPauseCommand({ action: "pause", cwd: "/tmp/project", now: NOW }).exitCode).toBe(1);
  });

  it("honours an explicit --session without consulting activity at all", () => {
    const r = runPauseCommand({ action: "pause", sessionId: "explicit", cwd: "/tmp/project", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(readActivePause("explicit", NOW)).not.toBeNull();
  });

  it("defaults to 30m and accepts an explicit duration", () => {
    runPauseCommand({ action: "pause", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(readActivePause("s1", NOW)!.expiresAt).toBe(NOW + 30 * 60_000);
    runPauseCommand({ action: "pause", duration: "10m", sessionId: "s2", cwd: "/tmp/p", now: NOW });
    expect(readActivePause("s2", NOW)!.expiresAt).toBe(NOW + 600_000);
  });

  it("reports a bad duration as an error and writes nothing", () => {
    const r = runPauseCommand({ action: "pause", duration: "12h", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/exceeds the maximum pause/);
    expect(readActivePause("s1", NOW)).toBeNull();
  });

  it("always says when the pause ends, that cloud keeps enforcing, and how to end it early", () => {
    vi.mocked(getAllHookActivityEntries).mockReturnValue([
      { timestamp: NOW - 1_000, sessionId: "here", cwd: "/tmp/p" },
    ] as never);
    const r = runPauseCommand({ action: "pause", cwd: "/tmp/p", now: NOW, render: PLAIN, clock: CLOCK });
    expect(r.lines).toEqual([
      "✓ Paused enforcement for this session until 14:16 (30 minutes).",
      "  Cloud-managed policies keep enforcing.",
      "  Resume early:  failproofai config --resume",
    ]);
  });

  it("says it extended a live pause, with the new end", () => {
    runPauseCommand({ action: "pause", duration: "10m", sessionId: "s1", cwd: "/tmp/p", now: NOW, render: PLAIN });
    const out = runPauseCommand({
      action: "pause",
      duration: "1h",
      sessionId: "s1",
      cwd: "/tmp/p",
      now: NOW + 60_000,
      render: PLAIN,
      clock: CLOCK,
    }).lines;
    expect(out[0]).toBe("✓ Extended the pause for session s1 until 14:47 (1 hour).");
    expect(out.join("\n")).not.toMatch(/Capped/);
  });

  it("shows the duration actually granted when the 8h ceiling cuts an extension short", () => {
    // The ceiling is measured from the FIRST pause in the run, so a renewal
    // seven hours in gets one hour however much it asked for. Repeating the
    // request would misstate when enforcement comes back.
    runPauseCommand({ action: "pause", duration: "8h", sessionId: "s1", cwd: "/tmp/p", now: NOW, render: PLAIN });
    const later = NOW + 7 * 3_600_000;
    const r = runPauseCommand({
      action: "pause",
      duration: "4h",
      sessionId: "s1",
      cwd: "/tmp/p",
      now: later,
      render: PLAIN,
      clock: CLOCK,
    });
    expect(readActivePause("s1", later)!.expiresAt).toBe(NOW + PAUSE_CEILING_MS);
    expect(r.lines[0]).toBe("✓ Extended the pause for session s1 until 21:46 (1 hour).");
    expect(r.lines[1]).toBe("  Capped at 8 hours from when this pause began.");
    expect(r.lines.join("\n")).toMatch(/Cloud-managed policies keep enforcing\./);
  });

  it("names an explicit session back, and resumes it by id", () => {
    const r = runPauseCommand({ action: "pause", sessionId: "abc-123", cwd: "/tmp/p", now: NOW, render: PLAIN, clock: CLOCK });
    expect(r.lines[0]).toBe("✓ Paused enforcement for session abc-123 until 14:16 (30 minutes).");
    expect(r.lines).toContain("  Resume early:  failproofai config --resume --session abc-123");
  });

  it("says why nothing was paused, with the command that names a session, in the screen language", () => {
    const r = runPauseCommand({ action: "pause", duration: "10m", cwd: "/tmp/project", now: NOW, render: PLAIN });
    expect(r.exitCode).toBe(1);
    expect(r.lines).toEqual([
      "✕ No recent agent session found for this directory.",
      "  Name one from the dashboard's activity view:  failproofai config --pause 10m --session <id>",
    ]);
  });

  it("paints the result for a terminal and leaves a pipe plain", () => {
    const painted = withTrueColor(() =>
      runPauseCommand({ action: "pause", sessionId: "s1", cwd: "/tmp/p", now: NOW, render: { color: true, cols: 104 }, clock: CLOCK }),
    ).lines;
    expect(painted[0]).toContain("\x1B[38;2;102;209;181m✓"); // mint: done
    expect(painted[2]).toContain("\x1B[38;2;228;88;125mfailproofai config --resume"); // pink: typeable
    expect(painted.map(strip)).toEqual(
      runPauseCommand({ action: "pause", sessionId: "s2", cwd: "/tmp/p", now: NOW, render: PLAIN, clock: CLOCK })
        .lines.map((l) => l.replace("s2", "s1")),
    );
    const plain = runPauseCommand({ action: "pause", sessionId: "s3", cwd: "/tmp/p", now: NOW, render: PLAIN }).lines.join("\n");
    expect(plain).not.toContain("\x1B");
  });
});

describe("pause wording helpers", () => {
  it("spells durations out", () => {
    expect(pauseDurationWords(30 * 60_000)).toBe("30 minutes");
    expect(pauseDurationWords(60_000)).toBe("1 minute");
    expect(pauseDurationWords(90 * 60_000)).toBe("1 hour 30 minutes");
    expect(pauseDurationWords(8 * 3_600_000)).toBe("8 hours");
    expect(pauseDurationWords(45_000)).toBe("45 seconds");
    expect(pauseDurationWords(1_000)).toBe("1 second");
  });

  it("writes the clock to the minute, in the locale it is given", () => {
    expect(pauseClockTime(NOW, CLOCK)).toBe("13:46");
    expect(pauseClockTime(NOW, { locale: "en-US", timeZone: "UTC" }).replace(/\s/g, " ")).toBe("1:46 PM");
  });
});

describe("--resume", () => {
  it("clears the resolved session's pause", () => {
    writePause({ sessionId: "s1", durationMs: 600_000, now: NOW });
    const r = runPauseCommand({ action: "resume", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(readActivePause("s1", NOW)).toBeNull();
  });

  it("confirms in the same shape as a pause", () => {
    vi.mocked(getAllHookActivityEntries).mockReturnValue([
      { timestamp: NOW - 1_000, sessionId: "here", cwd: "/tmp/p" },
    ] as never);
    writePause({ sessionId: "here", durationMs: 600_000, now: NOW });
    expect(runPauseCommand({ action: "resume", cwd: "/tmp/p", now: NOW, render: PLAIN }).lines).toEqual([
      "✓ Resumed enforcement for this session.",
    ]);
    writePause({ sessionId: "named", durationMs: 600_000, now: NOW });
    expect(runPauseCommand({ action: "resume", sessionId: "named", cwd: "/tmp/p", now: NOW, render: PLAIN }).lines).toEqual([
      "✓ Resumed enforcement for session named.",
    ]);
  });

  it("says plainly, without a tick, when there was nothing to resume", () => {
    expect(runPauseCommand({ action: "resume", cwd: "/tmp/p", now: NOW, render: PLAIN }).lines).toEqual([
      "Nothing was paused for this directory.",
    ]);
    expect(runPauseCommand({ action: "resume", sessionId: "gone", cwd: "/tmp/p", now: NOW, render: PLAIN }).lines).toEqual([
      "Nothing was paused for session gone.",
    ]);
    expect(runPauseCommand({ action: "resume", all: true, cwd: "/tmp/p", now: NOW, render: PLAIN }).lines).toEqual([
      "Nothing was paused.",
    ]);
  });

  it("is a no-op, not an error, when nothing is paused", () => {
    const r = runPauseCommand({ action: "resume", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.affected).toBe(0);
  });

  it("--all clears every active pause", () => {
    writePause({ sessionId: "s1", durationMs: 600_000, now: NOW });
    writePause({ sessionId: "s2", durationMs: 600_000, now: NOW });
    const r = runPauseCommand({ action: "resume", all: true, cwd: "/tmp/p", now: NOW, render: PLAIN });
    expect(r.affected).toBe(2);
    expect(r.lines).toEqual(["✓ Resumed enforcement for 2 sessions."]);
    expect(readActivePause("s1", NOW)).toBeNull();
    expect(readActivePause("s2", NOW)).toBeNull();
  });
});

// `--status` is a whole-machine screen now (config-status.ts). Its two tests
// moved with it, intent unchanged: config-status.test.ts → "says so plainly when
// nothing is paused" and "lists active pauses with time left, and omits expired
// ones".
