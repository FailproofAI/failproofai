// @vitest-environment node
//
// `failproofai jev status` prints what jevStats() returns — not a hard-coded
// empty block, and not a different window than the default. jevStats is mocked
// with non-zero numbers so the output can only come from the call, in every
// state status can be in: configured, absent and refused.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { jevStatsMock } = vi.hoisted(() => ({ jevStatsMock: vi.fn() }));
vi.mock("../../src/hooks/semantic/jev-stats", () => ({
  DEFAULT_JEV_STATS_WINDOW_MS: 24 * 60 * 60 * 1000,
  jevStats: jevStatsMock,
}));

import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath } from "../../src/hooks/semantic/jev-config";
import type { JevStats } from "../../src/hooks/semantic/jev-stats";

const KEY = ["stats", "test", "0123456789abcdef"].join("-");
const posix = process.platform !== "win32";

const STATS: JevStats = {
  windowMs: 24 * 3_600_000,
  total: 217,
  fallbackRate: 0.037,
  fallbackReasons: { "http-429": 5, "out-of-credits": 3 },
  latencyP50Ms: 41.2,
  latencyP95Ms: 212.7,
  clearsByPolicy: { "block-read-outside-cwd": 12 },
};

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");

/** Every figure of STATS, as the status block renders it. */
function expectStatsShown(r: JevCliResult): void {
  const out = text(r);
  expect(out).toContain("last 24 hours");
  expect(out).toContain("evaluations 217");
  expect(out).toContain("fell back to regex 3.7% (http-429 ×5, out-of-credits ×3)");
  expect(out).toContain("p50 41 ms · p95 213 ms");
  expect(out).toContain("cleared block-read-outside-cwd ×12");
  expect(out).not.toContain("No Jev evaluations recorded");
}

/** jevStats was called once for this status, over the default window. */
function expectOneDefaultCall(): void {
  expect(jevStatsMock).toHaveBeenCalledTimes(1);
  const args = jevStatsMock.mock.calls[0] as unknown[];
  expect((args[0] as { windowMs?: number } | undefined)?.windowMs).toBeUndefined();
}

describe("failproofai jev status — activity comes from jevStats()", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-stats-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
    jevStatsMock.mockReset();
    jevStatsMock.mockResolvedValue(STATS);
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("configured: human output shows the stats, and --json carries them verbatim", async () => {
    expect((await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY))).exitCode).toBe(0);
    jevStatsMock.mockClear();

    const human = await runJevCommand(["status"], RENDER);
    expect(human.exitCode).toBe(0);
    expectStatsShown(human);
    expect(text(human)).not.toContain(KEY);
    expectOneDefaultCall();

    jevStatsMock.mockClear();
    const json = await runJevCommand(["status", "--json"], RENDER);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.json as string).stats).toEqual(STATS);
    expectOneDefaultCall();
  });

  it("absent: activity is still shown when there is no config", async () => {
    const human = await runJevCommand(["status"], RENDER);
    expect(human.exitCode).toBe(0);
    expect(text(human)).toContain("Jev is off");
    expectStatsShown(human);
    expectOneDefaultCall();

    jevStatsMock.mockClear();
    const json = await runJevCommand(["status", "--json"], RENDER);
    expect(JSON.parse(json.json as string)).toMatchObject({ status: "absent", stats: STATS });
    expectOneDefaultCall();
  });

  it.skipIf(!posix)("refused: activity is still shown for a config that was refused", async () => {
    await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    chmodSync(jevConfigPath(), 0o644);
    jevStatsMock.mockClear();

    const human = await runJevCommand(["status"], RENDER);
    expect(human.exitCode).toBe(1);
    expect(text(human)).toContain("refused");
    expectStatsShown(human);
    expectOneDefaultCall();

    jevStatsMock.mockClear();
    const json = await runJevCommand(["status", "--json"], RENDER);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.json as string)).toMatchObject({ status: "refused", reason: "too-open", stats: STATS });
    expectOneDefaultCall();
  });

  it("shadow mode's would-be clears are printed, not reported as 'cleared nothing'", async () => {
    // T8's jevStats() counts a clear that CHANGED an outcome in clearsByPolicy
    // — which only enforce mode can do — and shadow mode's would-be clears in
    // shadowClearsByPolicy. A renderer reading only the first tells a shadow
    // user nothing was cleared, which is the one number shadow mode exists to
    // show. The field is optional on the stats this branch builds against.
    jevStatsMock.mockResolvedValue({
      ...STATS,
      clearsByPolicy: {},
      shadowClearsByPolicy: { "block-read-outside-cwd": 9, "protect-env-vars": 2 },
    } as JevStats);
    await runJevCommand(["setup", "--provider", "typesafe", "--mode", "shadow", "--key-stdin"], withKey(KEY));

    const human = await runJevCommand(["status"], RENDER);
    expect(human.exitCode).toBe(0);
    const out = text(human);
    expect(out).toContain("would have cleared (shadow) block-read-outside-cwd ×9, protect-env-vars ×2");
    expect(out).toContain("cleared nothing");
  });

  it("a jevStats() that throws is reported as unreadable, not as no activity", async () => {
    jevStatsMock.mockRejectedValue(new Error("activity store is corrupt"));
    const human = await runJevCommand(["status"], RENDER);
    expect(human.exitCode).toBe(0);
    expect(text(human)).toContain("Activity could not be read.");
    expect(text(human)).not.toContain("No Jev evaluations recorded");

    const json = await runJevCommand(["status", "--json"], RENDER);
    expect(JSON.parse(json.json as string).stats).toBeNull();
  });
});
