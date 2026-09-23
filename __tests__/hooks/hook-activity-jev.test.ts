// @vitest-environment node
/**
 * Persistence of the Jev (two-tier evaluator) activity fields, and the
 * windowed read `failproofai jev status` is built on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistHookActivity,
  getHookActivityPage,
  getAllHookActivityEntries,
  getHookActivityEntriesSince,
  searchHookActivity,
  _resetForTest,
  PAGE_SIZE,
  ROTATION_CLOCK_SLACK_MS,
  type HookActivityEntry,
} from "../../src/hooks/hook-activity-store";

function makeEntry(overrides: Partial<HookActivityEntry> = {}): HookActivityEntry {
  return {
    timestamp: Date.now(),
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 44,
    sessionId: "sess-1",
    ...overrides,
  };
}

const JEV_ANSWERED: Partial<HookActivityEntry> = {
  evaluator: "jev",
  jevDecision: "allow",
  jevCleared: ["block-read-outside-cwd"],
  jevLatencyMs: 38,
  jevModel: "jev-1.13.0",
  jevMode: "enforce",
};

describe("hook-activity-store: Jev fields", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "hook-activity-jev-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  const rawLines = () =>
    readFileSync(join(testDir, "current.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("round-trips every Jev field of an answered call", () => {
    persistHookActivity(makeEntry(JEV_ANSWERED));
    const [read] = getHookActivityPage(1);
    for (const [k, v] of Object.entries(JEV_ANSWERED)) {
      expect(read[k as keyof HookActivityEntry]).toEqual(v);
    }
  });

  it("round-trips a fallback", () => {
    persistHookActivity(
      makeEntry({
        decision: "deny",
        policyName: "block-env-files",
        reason: "Reading .env files is blocked",
        evaluator: "jev-fallback",
        jevFallbackReason: "http-429",
        jevLatencyMs: 12,
        jevMode: "enforce",
      }),
    );
    const [read] = getHookActivityPage(1);
    expect(read.evaluator).toBe("jev-fallback");
    expect(read.jevFallbackReason).toBe("http-429");
    expect(read.jevLatencyMs).toBe(12);
    expect(read.jevMode).toBe("enforce");
    expect(read).not.toHaveProperty("jevDecision");
  });

  it("writes a row without Jev fields byte for byte as before", () => {
    // The unconfigured path must be today's, byte for byte.
    const e = makeEntry({ decision: "deny", policyName: "block-sudo", reason: "sudo blocked" });
    persistHookActivity(e);
    const line = readFileSync(join(testDir, "current.jsonl"), "utf-8");
    expect(line).toBe(JSON.stringify(e) + "\n");
  });

  it("stores a free-text fallback reason as its code, never the text", () => {
    const command = ["rm", "-rf", "/home/u/secret-project"].join(" ");
    persistHookActivity(
      makeEntry({ evaluator: "jev-fallback", jevFallbackReason: `prepare: could not scan ${command}` }),
    );
    const [row] = rawLines();
    expect(row.jevFallbackReason).toBe("prepare-error");
    expect(readFileSync(join(testDir, "current.jsonl"), "utf-8")).not.toContain("secret-project");
  });

  it("drops invalid Jev values on write but keeps the row", () => {
    persistHookActivity(
      makeEntry({
        evaluator: "jev",
        jevDecision: "perhaps" as never,
        jevMode: "yolo" as never,
        jevLatencyMs: Number.POSITIVE_INFINITY,
        jevCleared: ["block-env-files", "not a policy name"],
      }),
    );
    const [row] = rawLines();
    expect(row.evaluator).toBe("jev");
    expect(row).not.toHaveProperty("jevDecision");
    expect(row).not.toHaveProperty("jevMode");
    expect(row).not.toHaveProperty("jevLatencyMs");
    expect(row.jevCleared).toEqual(["block-env-files"]);
    expect(row.durationMs).toBe(44);
  });

  it("keeps the fields across a page rotation", () => {
    for (let i = 0; i < PAGE_SIZE + 3; i++) {
      persistHookActivity(makeEntry({ timestamp: 1_000 + i, ...JEV_ANSWERED, jevLatencyMs: i }));
    }
    const all = getAllHookActivityEntries();
    expect(all).toHaveLength(PAGE_SIZE + 3);
    expect(all.every((e) => e.evaluator === "jev" && e.jevModel === "jev-1.13.0")).toBe(true);
    expect(all.map((e) => e.jevLatencyMs).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: PAGE_SIZE + 3 }, (_, i) => i),
    );
  });

  it("is visible to the dashboard search like any other row", () => {
    persistHookActivity(makeEntry({ decision: "deny", policyName: "block-env-files", ...JEV_ANSWERED, jevDecision: "deny" }));
    const { entries } = searchHookActivity({ decision: "deny" }, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].jevDecision).toBe("deny");
  });
});

describe("getHookActivityEntriesSince", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "hook-activity-since-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(testDir, { recursive: true, force: true });
  });

  const line = (ts: number, extra: Partial<HookActivityEntry> = {}) =>
    JSON.stringify(makeEntry({ timestamp: ts, ...extra })) + "\n";

  it("returns only entries at or after the cutoff, newest first", () => {
    for (const ts of [100, 200, 300, 400]) persistHookActivity(makeEntry({ timestamp: ts }));
    expect(getHookActivityEntriesSince(250).map((e) => e.timestamp)).toEqual([400, 300]);
    expect(getHookActivityEntriesSince(300).map((e) => e.timestamp)).toEqual([400, 300]);
    expect(getHookActivityEntriesSince(0)).toHaveLength(4);
    expect(getHookActivityEntriesSince(1_000)).toEqual([]);
  });

  it("reads across rotated pages inside the window", () => {
    writeFileSync(join(testDir, "page-2000-0.jsonl"), line(1_500) + line(2_000));
    writeFileSync(join(testDir, "page-3000-1.jsonl"), line(2_500) + line(3_000));
    writeFileSync(join(testDir, "current.jsonl"), line(3_500));
    expect(getHookActivityEntriesSince(1_800).map((e) => e.timestamp)).toEqual([3_500, 3_000, 2_500, 2_000]);
  });

  it("stops at the first page rotated before the window opened", () => {
    // Every entry in a page is at or before the page's rotation time, so a page
    // rotated before the cutoff cannot hold anything in the window — and
    // neither can any older page. These pages break that invariant on purpose:
    // if they were read, their entries would show up.
    const cutoff = 100_000_000;
    const old = cutoff - ROTATION_CLOCK_SLACK_MS - 1;
    writeFileSync(join(testDir, `page-${old - 500}-0.jsonl`), line(cutoff + 9_000));
    writeFileSync(join(testDir, `page-${old}-1.jsonl`), line(cutoff + 9_100));
    writeFileSync(join(testDir, `page-${cutoff + 5_000}-2.jsonl`), line(cutoff + 4_500));
    writeFileSync(join(testDir, "current.jsonl"), line(cutoff + 5_500));
    expect(getHookActivityEntriesSince(cutoff).map((e) => e.timestamp)).toEqual([cutoff + 5_500, cutoff + 4_500]);
    // Sanity: the full read does see them.
    expect(getAllHookActivityEntries()).toHaveLength(4);
    expect(readdirSync(testDir).filter((f) => f.startsWith("page-"))).toHaveLength(3);
  });

  it("reads a page rotated just before the window, in case the clock stepped back", () => {
    // A clock stepped back between two writes can leave a newer entry in a page
    // named with an earlier time. Within the slack, that page is still read.
    const cutoff = 100_000_000;
    writeFileSync(join(testDir, `page-${cutoff - 60_000}-0.jsonl`), line(cutoff + 10) + line(cutoff - 70_000));
    writeFileSync(join(testDir, "current.jsonl"), line(cutoff + 20));
    expect(getHookActivityEntriesSince(cutoff).map((e) => e.timestamp)).toEqual([cutoff + 20, cutoff + 10]);
  });

  it("returns nothing for an empty store", () => {
    expect(getHookActivityEntriesSince(0)).toEqual([]);
  });
});
