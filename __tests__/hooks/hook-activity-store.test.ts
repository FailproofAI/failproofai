// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistHookActivity,
  getHookActivityPage,
  getHookActivityPageCount,
  getAllHookActivityEntries,
  searchHookActivity,
  getHookActivityHistory,
  _resetForTest,
  PAGE_SIZE,
  type HookActivityEntry,
} from "../../src/hooks/hook-activity-store";

function makeEntry(overrides: Partial<HookActivityEntry> = {}): HookActivityEntry {
  return {
    timestamp: Date.now(),
    eventType: "PreToolUse",
    toolName: "Bash",
    policyName: "block-sudo",
    decision: "deny",
    reason: "sudo blocked",
    durationMs: 1,
    ...overrides,
  };
}

describe("hooks/hook-activity-store", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "hook-activity-test-"));
    _resetForTest(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("persistHookActivity", () => {
    it("writes a single entry", () => {
      persistHookActivity(makeEntry());
      const entries = getHookActivityPage(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].policyName).toBe("block-sudo");
    });

    it("writes multiple entries", () => {
      for (let i = 0; i < 5; i++) {
        persistHookActivity(makeEntry({ timestamp: 1000 + i }));
      }
      const entries = getHookActivityPage(1);
      expect(entries).toHaveLength(5);
    });
  });

  describe("rotation", () => {
    it("rotates at PAGE_SIZE", () => {
      for (let i = 0; i < PAGE_SIZE + 3; i++) {
        persistHookActivity(makeEntry({ timestamp: 1000 + i }));
      }
      // Should have 2 pages: current with 3 entries, archive with 25
      expect(getHookActivityPageCount()).toBe(2);
      expect(getHookActivityPage(1)).toHaveLength(3);
      expect(getHookActivityPage(2)).toHaveLength(PAGE_SIZE);
    });

    // 80 entries, each a full synchronous round trip: acquire the advisory lock,
    // read the count, sometimes rotate, append, rewrite the count, rewrite the
    // stats file through a temp + rename, release the lock. That is well over
    // five hundred filesystem operations, and vitest's 5s default is sized for
    // in-memory tests — under a loaded machine running 191 files in parallel it
    // is not enough, and this timed out at 20s while passing in 24ms on its own.
    // The timeout is raised rather than the work reduced, because the number of
    // rotations IS what the test is for.
    it("rotates multiple times", () => {
      for (let i = 0; i < PAGE_SIZE * 3 + 5; i++) {
        persistHookActivity(makeEntry({ timestamp: 1000 + i }));
      }
      expect(getHookActivityPageCount()).toBe(4);
      expect(getHookActivityPage(1)).toHaveLength(5);
    }, 30_000);
  });

  describe("getHookActivityPage", () => {
    it("returns empty for page < 1", () => {
      expect(getHookActivityPage(0)).toEqual([]);
    });

    it("returns empty for page beyond range", () => {
      persistHookActivity(makeEntry());
      expect(getHookActivityPage(100)).toEqual([]);
    });

    it("returns entries in reverse chronological order", () => {
      persistHookActivity(makeEntry({ timestamp: 1000 }));
      persistHookActivity(makeEntry({ timestamp: 2000 }));
      persistHookActivity(makeEntry({ timestamp: 3000 }));
      const entries = getHookActivityPage(1);
      expect(entries[0].timestamp).toBe(3000);
      expect(entries[2].timestamp).toBe(1000);
    });
  });

  describe("getAllHookActivityEntries", () => {
    it("returns all entries across pages in reverse order", () => {
      for (let i = 0; i < PAGE_SIZE + 5; i++) {
        persistHookActivity(makeEntry({ timestamp: 1000 + i }));
      }
      const all = getAllHookActivityEntries();
      expect(all).toHaveLength(PAGE_SIZE + 5);
      // First entry should be the newest
      expect(all[0].timestamp).toBe(1000 + PAGE_SIZE + 4);
    });
  });

  describe("pre-rename cloud attribution", () => {
    // These pages are written by the DAEMON, so a machine that was cloud-connected
    // before `cloudRevision`→`cloudVersion` / `cloudGeneration`→`cloudDeployment`
    // has real rows on disk naming the old keys. Nothing validates the shape here —
    // a line is `JSON.parse`d and cast — so those rows do not error, they simply
    // carry keys nothing reads, and every pre-upgrade cloud-decided decision
    // renders as unattributed. Which is the one question these fields exist to
    // answer: "how much is my org's policy actually doing".
    it("reads cloudRevision/cloudGeneration written before the rename", () => {
      // Written as raw JSONL, because that is how the old daemon wrote it — going
      // through `persistHookActivity` would emit today's spelling and test nothing.
      // `testDir` — the store dir this suite overrides via `_resetForTest`.
      const page = join(testDir, "page-1700000000-0.jsonl");
      writeFileSync(
        page,
        JSON.stringify({
          timestamp: 1700000000,
          eventType: "PreToolUse",
          decision: "deny",
          policySource: "cloud",
          cloudPolicyId: "block-curl",
          cloudRevision: 3,
          cloudGeneration: 9,
        }) + "\n",
      );

      const all = getAllHookActivityEntries();
      const row = all.find((e) => e.cloudPolicyId === "block-curl");

      expect(row?.cloudVersion).toBe(3);
      expect(row?.cloudDeployment).toBe(9);
    });

    it("prefers the current spelling when both somehow appear", () => {
      const page = join(testDir, "page-1700000001-0.jsonl");
      writeFileSync(
        page,
        JSON.stringify({
          timestamp: 1700000001,
          cloudPolicyId: "both",
          cloudVersion: 5,
          cloudRevision: 3,
        }) + "\n",
      );

      const row = getAllHookActivityEntries().find((e) => e.cloudPolicyId === "both");
      expect(row?.cloudVersion).toBe(5);
    });
  });

  describe("searchHookActivity", () => {
    beforeEach(() => {
      persistHookActivity(makeEntry({ decision: "deny", eventType: "PreToolUse", policyName: "block-sudo" }));
      persistHookActivity(makeEntry({ decision: "allow", eventType: "PreToolUse", policyName: null }));
      persistHookActivity(makeEntry({ decision: "deny", eventType: "PostToolUse", policyName: "sanitize-jwt" }));
      persistHookActivity(makeEntry({ decision: "allow", eventType: "PostToolUse", policyName: null }));
    });

    it("filters by decision", () => {
      const result = searchHookActivity({ decision: "deny" }, 1);
      expect(result.entries).toHaveLength(2);
      expect(result.entries.every((e) => e.decision === "deny")).toBe(true);
    });

    it("filters by eventType", () => {
      const result = searchHookActivity({ eventType: "PostToolUse" }, 1);
      expect(result.entries).toHaveLength(2);
      expect(result.entries.every((e) => e.eventType === "PostToolUse")).toBe(true);
    });

    it("filters by policyName (case-insensitive)", () => {
      const result = searchHookActivity({ policyName: "SUDO" }, 1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].policyName).toBe("block-sudo");
    });

    it("combines filters", () => {
      const result = searchHookActivity({ decision: "deny", eventType: "PreToolUse" }, 1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].policyName).toBe("block-sudo");
    });

    it("filters by integration (cli)", () => {
      persistHookActivity(makeEntry({ integration: "claude", policyName: "claude-only" }));
      persistHookActivity(makeEntry({ integration: "codex", policyName: "codex-only" }));
      persistHookActivity(makeEntry({ integration: "codex", policyName: "codex-other" }));

      const codex = searchHookActivity({ integration: "codex" }, 1);
      expect(codex.entries).toHaveLength(2);
      expect(codex.entries.every((e) => e.integration === "codex")).toBe(true);

      const claude = searchHookActivity({ integration: "claude" }, 1);
      expect(claude.entries).toHaveLength(1);
      expect(claude.entries[0].policyName).toBe("claude-only");
    });

    it("paginates filtered results", () => {
      // Add many entries to test pagination
      for (let i = 0; i < PAGE_SIZE + 5; i++) {
        persistHookActivity(makeEntry({ decision: "deny", timestamp: 5000 + i }));
      }
      const page1 = searchHookActivity({ decision: "deny" }, 1);
      expect(page1.entries).toHaveLength(PAGE_SIZE);
      expect(page1.totalPages).toBe(2);

      const page2 = searchHookActivity({ decision: "deny" }, 2);
      expect(page2.entries.length).toBeGreaterThan(0);
    });
  });

  describe("getHookActivityHistory", () => {
    it("returns page with metadata", () => {
      persistHookActivity(makeEntry());
      const result = getHookActivityHistory(1);
      expect(result.entries).toHaveLength(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  describe("_resetForTest", () => {
    it("resets store to a new directory", () => {
      persistHookActivity(makeEntry());
      const newDir = mkdtempSync(join(tmpdir(), "hook-activity-reset-"));
      _resetForTest(newDir);
      expect(getHookActivityPage(1)).toHaveLength(0);
      rmSync(newDir, { recursive: true, force: true });
    });
  });
});
