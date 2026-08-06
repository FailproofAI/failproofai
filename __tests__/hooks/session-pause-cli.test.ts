import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/hooks-config", () => ({ readMergedHooksConfig: vi.fn(() => ({ enabledPolicies: [] })) }));
vi.mock("../../src/hooks/hook-activity-store", () => ({ getAllHookActivityEntries: vi.fn(() => []) }));

import { runPauseCommand, effectiveCeilingMs } from "../../src/hooks/session-pause-cli";
import { readActivePause, writePause, PAUSE_CEILING_MS } from "../../src/hooks/session-pause";
import { readMergedHooksConfig } from "../../src/hooks/hooks-config";
import { getAllHookActivityEntries } from "../../src/hooks/hook-activity-store";

let stateDir: string;
const NOW = 1_000_000_000;

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

  it("always says the pause expires on its own, and that cloud keeps enforcing", () => {
    const out = runPauseCommand({ action: "pause", sessionId: "s1", cwd: "/tmp/p", now: NOW }).lines.join("\n");
    expect(out).toMatch(/resumes at/);
    expect(out).toMatch(/Cloud-managed policies keep enforcing/);
  });
});

describe("--resume", () => {
  it("clears the resolved session's pause", () => {
    writePause({ sessionId: "s1", durationMs: 600_000, now: NOW });
    const r = runPauseCommand({ action: "resume", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(readActivePause("s1", NOW)).toBeNull();
  });

  it("is a no-op, not an error, when nothing is paused", () => {
    const r = runPauseCommand({ action: "resume", sessionId: "s1", cwd: "/tmp/p", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.affected).toBe(0);
  });

  it("--all clears every active pause", () => {
    writePause({ sessionId: "s1", durationMs: 600_000, now: NOW });
    writePause({ sessionId: "s2", durationMs: 600_000, now: NOW });
    const r = runPauseCommand({ action: "resume", all: true, cwd: "/tmp/p", now: NOW });
    expect(r.affected).toBe(2);
    expect(readActivePause("s1", NOW)).toBeNull();
    expect(readActivePause("s2", NOW)).toBeNull();
  });
});

describe("--status", () => {
  it("says so plainly when nothing is paused", () => {
    const r = runPauseCommand({ action: "status", cwd: "/tmp/p", now: NOW });
    expect(r.lines.join("\n")).toMatch(/Enforcement is active/);
  });

  it("lists active pauses with time remaining, and omits expired ones", () => {
    writePause({ sessionId: "live", durationMs: 600_000, now: NOW });
    writePause({ sessionId: "dead", durationMs: 1_000, now: NOW - 60_000 });
    const out = runPauseCommand({ action: "status", cwd: "/tmp/p", now: NOW }).lines.join("\n");
    expect(out).toMatch(/live/);
    expect(out).not.toMatch(/dead/);
    expect(out).toMatch(/10m left/);
  });
});
