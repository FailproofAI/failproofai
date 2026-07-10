// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseHermesSessionList } from "@/lib/hermes-projects";

describe("lib/hermes-projects: parseHermesSessionList", () => {
  it("extracts chat, cron, and short-form session IDs and dedupes", () => {
    const output = [
      "20260709_112532_9bfa1bc9  slack/group  Greeting Chetan",
      "20260709_102452_37117862  slack/group  Creating PR for issue 286",
      "cron_4c5aef2aa8ae_20260706_090030  cron  Weekly Health Check",
      "20260709_112532_9bfa1bc9  (duplicate line)",
    ].join("\n");
    const refs = parseHermesSessionList(output);
    const ids = refs.map((r) => r.sessionId);
    expect(ids).toContain("20260709_112532_9bfa1bc9");
    expect(ids).toContain("20260709_102452_37117862");
    expect(ids).toContain("cron_4c5aef2aa8ae_20260706_090030");
    // Deduped.
    expect(ids.filter((id) => id === "20260709_112532_9bfa1bc9")).toHaveLength(1);
  });

  it("derives mtime from the datetime embedded in the ID (newest first)", () => {
    const refs = parseHermesSessionList(
      "20260706_090030_aaaa\n20260709_112532_bbbb",
    );
    // 07-09 is newer than 07-06 → sorted first.
    expect(refs[0].sessionId).toBe("20260709_112532_bbbb");
    expect(new Date(refs[0].mtimeMs).getUTCFullYear()).toBe(2026);
    expect(new Date(refs[0].mtimeMs).getUTCDate()).toBe(9);
  });

  it("returns [] for output with no recognizable IDs", () => {
    expect(parseHermesSessionList("no sessions found")).toEqual([]);
    expect(parseHermesSessionList("")).toEqual([]);
  });
});
