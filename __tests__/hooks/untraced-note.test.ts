import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../../src/hooks/hook-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hook-logger")>();
  return { ...actual, hookLogInfo: vi.fn() };
});

import { noteUntracedAgent, untracedNotePath } from "../../src/hooks/untraced-note";
import { hookLogInfo } from "../../src/hooks/hook-logger";
import { readConfig, updateConfig } from "../../src/hooks/fp-config";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-untraced-"));
  process.env.FAILPROOFAI_HOME = home;
  vi.mocked(hookLogInfo).mockClear();
});
afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("noteUntracedAgent", () => {
  it("says nothing when there is no selection, which traces every agent", () => {
    expect(noteUntracedAgent("goose", "s1")).toBe(false);
    expect(hookLogInfo).not.toHaveBeenCalled();
  });

  it("says nothing for a traced agent", () => {
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });
    expect(noteUntracedAgent("claude", "s1")).toBe(false);
  });

  it("notes an untraced agent once per session, and never decides anything", () => {
    updateConfig({ agents: { selected: ["claude"], seen: ["claude", "goose"] } });
    expect(noteUntracedAgent("goose", "s1")).toBe(true);
    expect(noteUntracedAgent("goose", "s1")).toBe(false);
    expect(noteUntracedAgent("goose", "s2")).toBe(true);
    expect(hookLogInfo).toHaveBeenCalledTimes(2);
    expect(vi.mocked(hookLogInfo).mock.calls[0]![0]).toContain("evaluated as usual");
  });

  it("keeps the record bounded however many sessions pass", () => {
    // Seeded full rather than filled by 200 writes, which is slow enough on a
    // loaded machine to time out; the bound is the same either way.
    const config = { ...readConfig(), agents: { selected: ["claude"], seen: [] } };
    mkdirSync(dirname(untracedNotePath()), { recursive: true });
    writeFileSync(untracedNotePath(), JSON.stringify(Array.from({ length: 200 }, (_, i) => `goose:old${i}`)));
    for (let i = 0; i < 5; i++) noteUntracedAgent("goose", `s${i}`, config);
    const kept = JSON.parse(readFileSync(untracedNotePath(), "utf8")) as string[];
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("goose:old5");
    expect(kept[199]).toBe("goose:s4");
  });

  it("never throws on the hook path", () => {
    const broken = { agents: { selected: null } } as unknown as Parameters<typeof noteUntracedAgent>[2];
    expect(() => noteUntracedAgent("goose", "s1", broken)).not.toThrow();
  });
});
