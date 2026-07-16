// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimHookInvocation,
  setHookInvocationDedupDirForTests,
} from "../../src/hooks/hook-invocation-dedup";

describe("hook invocation deduplication", () => {
  const tempDirs: string[] = [];

  async function useTempDir(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "failproofai-hook-dedup-"));
    tempDirs.push(dir);
    setHookInvocationDedupDirForTests(dir);
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("elects one owner and replays its response to a duplicate process", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const owner = await claimHookInvocation("PreToolUse", "claude", payload);
    expect(owner.role).toBe("owner");
    if (owner.role !== "owner") throw new Error("expected owner claim");

    const duplicatePromise = claimHookInvocation("PreToolUse", "claude", payload);
    await owner.complete({ exitCode: 2, stdout: "", stderr: "blocked" });
    const duplicate = await duplicatePromise;

    expect(duplicate).toEqual({
      role: "duplicate",
      response: { exitCode: 2, stdout: "", stderr: "blocked" },
    });
    await expect(claimHookInvocation("PreToolUse", "claude", payload)).resolves.toEqual({
      role: "duplicate",
      response: { exitCode: 2, stdout: "", stderr: "blocked" },
    });
  });

  it("does not combine different tool uses or hook events", async () => {
    await useTempDir();
    const first = await claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    });
    const differentTool = await claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-2",
    });
    const differentEvent = await claimHookInvocation("PostToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    });

    expect(first.role).toBe("owner");
    expect(differentTool.role).toBe("owner");
    expect(differentEvent.role).toBe("owner");
    if (first.role === "owner") await first.release();
    if (differentTool.role === "owner") await differentTool.release();
    if (differentEvent.role === "owner") await differentEvent.release();
  });

  it("lets another process take ownership when the first exits before publishing", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const first = await claimHookInvocation("PreToolUse", "claude", payload);
    expect(first.role).toBe("owner");
    if (first.role !== "owner") throw new Error("expected owner claim");
    await first.release();

    const retry = await claimHookInvocation("PreToolUse", "claude", payload);
    expect(retry.role).toBe("owner");
    if (retry.role === "owner") await retry.release();
  });

  it("only deduplicates Claude payloads with stable invocation identifiers", async () => {
    await useTempDir();
    await expect(claimHookInvocation("PreToolUse", "codex", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    })).resolves.toEqual({ role: "independent" });
    await expect(claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
    })).resolves.toEqual({ role: "independent" });
  });
});
