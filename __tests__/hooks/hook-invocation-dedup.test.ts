// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimHookInvocation,
  createHookRuntimeIdentity,
  setHookInvocationDedupDirForTests,
  setHookInvocationDedupTimingForTests,
} from "../../src/hooks/hook-invocation-dedup";

describe("hook invocation deduplication", () => {
  const tempDirs: string[] = [];
  const runtimeIdentity = "runtime-a";
  let activeDir = "";

  async function useTempDir(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "failproofai-hook-dedup-"));
    tempDirs.push(dir);
    activeDir = dir;
    setHookInvocationDedupDirForTests(dir);
  }

  afterEach(async () => {
    setHookInvocationDedupTimingForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("elects one owner and replays its response to a duplicate process", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const owner = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(owner.role).toBe("owner");
    if (owner.role !== "owner") throw new Error("expected owner claim");

    const duplicatePromise = claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    await owner.complete({ exitCode: 2, stdout: "", stderr: "blocked" });
    const duplicate = await duplicatePromise;

    expect(duplicate).toEqual({
      role: "duplicate",
      response: { exitCode: 2, stdout: "", stderr: "blocked" },
    });
    await expect(claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity)).resolves.toEqual({
      role: "duplicate",
      response: { exitCode: 2, stdout: "", stderr: "blocked" },
    });
  });

  it("does not combine different tool uses or hook events", async () => {
    await useTempDir();
    const first = await claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    }, runtimeIdentity);
    const differentTool = await claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-2",
    }, runtimeIdentity);
    const differentEvent = await claimHookInvocation("PostToolUse", "claude", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    }, runtimeIdentity);

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
    const first = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(first.role).toBe("owner");
    if (first.role !== "owner") throw new Error("expected owner claim");
    await first.release();

    const retry = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(retry.role).toBe("owner");
    if (retry.role === "owner") await retry.release();
  });

  it("only deduplicates Claude payloads with stable invocation identifiers", async () => {
    await useTempDir();
    await expect(claimHookInvocation("PreToolUse", "codex", {
      session_id: "session-1",
      tool_use_id: "tool-1",
    }, runtimeIdentity)).resolves.toEqual({ role: "independent" });
    await expect(claimHookInvocation("PreToolUse", "claude", {
      session_id: "session-1",
    }, runtimeIdentity)).resolves.toEqual({ role: "independent" });
  });

  it("keeps different binaries or merged configurations independent", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const first = await claimHookInvocation("PreToolUse", "claude", payload, "runtime-a");
    const differentRuntime = await claimHookInvocation("PreToolUse", "claude", payload, "runtime-b");

    expect(first.role).toBe("owner");
    expect(differentRuntime.role).toBe("owner");
    if (first.role === "owner") await first.release();
    if (differentRuntime.role === "owner") await differentRuntime.release();

    const originalRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
    process.env.FAILPROOFAI_PACKAGE_ROOT = "/tmp/failproofai-a";
    const identityA = createHookRuntimeIdentity({ enabledPolicies: ["block-sudo"] }, []);
    process.env.FAILPROOFAI_PACKAGE_ROOT = "/tmp/failproofai-b";
    const identityB = createHookRuntimeIdentity({ enabledPolicies: ["block-sudo"] }, []);
    const identityC = createHookRuntimeIdentity({ enabledPolicies: ["block-rm-rf"] }, []);
    const identityD = createHookRuntimeIdentity(
      { enabledPolicies: ["block-rm-rf"] },
      [{ name: "custom-a", fn: async () => ({ decision: "deny" }) }],
    );
    const identityE = createHookRuntimeIdentity(
      { enabledPolicies: ["block-rm-rf"] },
      [{ name: "custom-a", fn: async () => ({ decision: "deny" }) }],
      "/tmp/another-project",
    );
    if (originalRoot === undefined) delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    else process.env.FAILPROOFAI_PACKAGE_ROOT = originalRoot;

    expect(identityA).not.toBe(identityB);
    expect(identityB).not.toBe(identityC);
    expect(identityC).not.toBe(identityD);
    expect(identityD).not.toBe(identityE);
  });

  it("takes over immediately when the lock owner process is dead", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const crashedOwner = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(crashedOwner.role).toBe("owner");
    const lockName = (await readdir(activeDir)).find((name) => name.endsWith(".lock"));
    if (!lockName) throw new Error("expected lock file");
    await writeFile(join(activeDir, lockName), JSON.stringify({ pid: 2_147_483_647 }), "utf8");

    const replacement = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);

    expect(replacement.role).toBe("owner");
    if (replacement.role === "owner") await replacement.release();
  });

  it("falls back independently after the bounded wait for a live owner", async () => {
    await useTempDir();
    setHookInvocationDedupTimingForTests({ waitTimeoutMs: 30, pollIntervalMs: 5 });
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const owner = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(owner.role).toBe("owner");

    await expect(
      claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity),
    ).resolves.toEqual({ role: "independent" });
    if (owner.role === "owner") await owner.release();
  });

  it("replaces an expired result and publishes the new response", async () => {
    await useTempDir();
    const payload = { session_id: "session-1", tool_use_id: "tool-1" };
    const first = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    if (first.role !== "owner") throw new Error("expected owner claim");
    await first.complete({ exitCode: 0, stdout: "old", stderr: "" });
    const resultName = (await readdir(activeDir)).find((name) => name.endsWith(".json"));
    if (!resultName) throw new Error("expected result file");
    const old = new Date(Date.now() - 10_000);
    await utimes(join(activeDir, resultName), old, old);
    setHookInvocationDedupTimingForTests({ resultTtlMs: 1_000 });

    const replacement = await claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity);
    expect(replacement.role).toBe("owner");
    if (replacement.role !== "owner") throw new Error("expected replacement owner");
    await replacement.complete({ exitCode: 2, stdout: "", stderr: "new" });

    await expect(
      claimHookInvocation("PreToolUse", "claude", payload, runtimeIdentity),
    ).resolves.toEqual({
      role: "duplicate",
      response: { exitCode: 2, stdout: "", stderr: "new" },
    });
  });
});
