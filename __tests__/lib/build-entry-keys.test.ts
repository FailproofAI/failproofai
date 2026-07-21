// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildEntryKeys } from "@/lib/entry-keys";
import type { LogEntry } from "@/lib/log-entries";

/**
 * Regression coverage for the virtualized log viewer's row identity.
 *
 * Duplicate React keys strand orphaned DOM nodes on top of live rows in the
 * virtualized list (a Codex session with 93 colliding timestamps rendered
 * three overlapping copies of index 3). Every entry must get a unique key,
 * and that key must be stable across rebuilds.
 */

const entry = (over: Partial<LogEntry> = {}): LogEntry =>
  ({
    type: "user",
    _source: "session",
    uuid: "",
    parentUuid: null,
    timestamp: "2026-05-15T11:57:43.872Z",
    timestampMs: 1778846263872,
    timestampFormatted: "May 15, 2026, 5:27:43 PM.872",
    message: { role: "user", content: "hi" },
    ...over,
  }) as LogEntry;

describe("lib/log-entries: buildEntryKeys", () => {
  it("gives uuid-less entries sharing a timestamp distinct keys", () => {
    // The exact Codex shape: no uuid, identical timestamps.
    const entries = [entry(), entry(), entry()];

    const keys = buildEntryKeys(entries);
    const values = entries.map((e) => keys.get(e));

    expect(new Set(values).size).toBe(3);
    expect(values.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });

  it("keeps every key unique across a run of colliding timestamps", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry({ timestamp: i % 2 === 0 ? "2026-05-15T11:57:43.872Z" : "2026-05-15T11:57:52.077Z" }),
    );

    const keys = buildEntryKeys(entries);

    expect(new Set(entries.map((e) => keys.get(e))).size).toBe(50);
  });

  it("prefers a real uuid when the transcript supplies one", () => {
    const a = entry({ uuid: "uuid-a" });
    const b = entry({ uuid: "uuid-b" });

    const keys = buildEntryKeys([a, b]);

    expect(keys.get(a)).toBe("uuid-a");
    expect(keys.get(b)).toBe("uuid-b");
  });

  it("still disambiguates if a transcript repeats a uuid", () => {
    const a = entry({ uuid: "dupe" });
    const b = entry({ uuid: "dupe" });

    const keys = buildEntryKeys([a, b]);

    expect(keys.get(a)).not.toBe(keys.get(b));
  });

  it("does not collide across sources that share a timestamp", () => {
    const a = entry({ _source: "session" });
    const b = entry({ _source: "agent-1" });

    const keys = buildEntryKeys([a, b]);

    expect(keys.get(a)).not.toBe(keys.get(b));
  });

  it("assigns stable keys across rebuilds of the same list", () => {
    // The virtualizer caches measured heights by key, so an unstable key would
    // replay one entry's height onto another after a collapse/expand.
    const entries = [entry(), entry(), entry({ uuid: "x" })];

    const first = buildEntryKeys(entries);
    const second = buildEntryKeys(entries);

    for (const e of entries) {
      expect(second.get(e)).toBe(first.get(e));
    }
  });

  it("handles an empty list", () => {
    expect(buildEntryKeys([]).size).toBe(0);
  });
});
