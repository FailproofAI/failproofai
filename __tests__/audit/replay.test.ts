// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { resetReplay, replayEvent } from "../../src/audit/replay";
import type { NormalizedToolEvent } from "../../src/audit/types";

function bash(command: string): NormalizedToolEvent {
  return {
    cli: "claude",
    sessionId: "sess-1",
    transcriptPath: "/tmp/t.jsonl",
    cwd: "/home/u/proj",
    timestamp: "2026-05-21T00:00:00.000Z",
    toolName: "Bash",
    rawToolName: "Bash",
    toolInput: { command },
  };
}

describe("replay engine", () => {
  beforeEach(() => {
    resetReplay();
  });

  it("triggers protect-env-vars on `env`", async () => {
    const hits = await replayEvent(bash("env"));
    const names = hits.map((h) => h.policyName);
    expect(names.some((n) => n.includes("protect-env-vars"))).toBe(true);
  });

  it("triggers block-force-push on `git push --force` to a non-protected branch", async () => {
    // Push to `feature` (not main/master) so block-push-master doesn't
    // short-circuit before block-force-push gets a chance to fire.
    const hits = await replayEvent(bash("git push --force origin feature"));
    const names = hits.map((h) => h.policyName);
    expect(names.some((n) => n.includes("block-force-push"))).toBe(true);
  });

  it("does not fire on a plain `ls`", async () => {
    const hits = await replayEvent(bash("ls -la"));
    expect(hits.filter((h) => h.decision === "deny")).toHaveLength(0);
  });

  it("synthesizes PostToolUse when toolResultText is set", async () => {
    // Fake JWT shape — three dot-separated base64 chunks — to trigger
    // sanitize-jwt on PostToolUse without using a real-looking API-key shape.
    const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "test-sig-xyz"].join(".");
    const event = bash("echo token");
    event.toolResultText = `Authorization: Bearer ${fakeJwt}`;
    const hits = await replayEvent(event);
    expect(hits.some((h) => h.eventType === "PostToolUse")).toBe(true);
  });
});
