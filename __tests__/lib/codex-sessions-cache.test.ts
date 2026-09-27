// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// findCodexTranscript walks ~/.codex/sessions and writes its cache under
// FAILPROOFAI_HOME/state - point both at a scratch dir.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.__TEST_HOME as string };
});

describe("lib/codex-sessions: findCodexTranscript cache writes", () => {
  let home: string;
  let fpHome: string;
  let sessionFile: string;
  const sessionId = "atomic-cache-test-session";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    fpHome = mkdtempSync(join(tmpdir(), "codex-fp-"));
    process.env.__TEST_HOME = home;
    process.env.FAILPROOFAI_HOME = fpHome;
    const today = new Date();
    const dir = join(
      home, ".codex", "sessions",
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, "0"),
      String(today.getUTCDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    sessionFile = join(dir, `rollout-${sessionId}.jsonl`);
    writeFileSync(sessionFile, "", "utf-8");
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.__TEST_HOME;
    delete process.env.FAILPROOFAI_HOME;
    chmodSync(fpHome, 0o700);
    try {
      chmodSync(join(fpHome, "state"), 0o700);
    } catch {
      // state dir never created
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(fpHome, { recursive: true, force: true });
  });

  it("writes a readable cache entry for the discovered transcript", async () => {
    const { findCodexTranscript } = await import("@/lib/codex-sessions");
    expect(findCodexTranscript(sessionId)).toBe(sessionFile);
    const cachePath = join(fpHome, "state", "codex-session-paths.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, string>;
    expect(cache[sessionId]).toBe(sessionFile);
  });

  it("removes the temp file when the write itself fails", async () => {
    const stateDir = join(fpHome, "state");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o500);
    const { findCodexTranscript } = await import("@/lib/codex-sessions");
    expect(() => findCodexTranscript(sessionId)).not.toThrow();
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("removes the temp file when the rename fails", async () => {
    // A non-empty directory where the cache file belongs makes rename(2) fail
    // after the temp write succeeded - the path that used to leak .tmp files.
    const stateDir = join(fpHome, "state");
    mkdirSync(join(stateDir, "codex-session-paths.json", "blocking"), { recursive: true });
    const { findCodexTranscript } = await import("@/lib/codex-sessions");
    expect(() => findCodexTranscript(sessionId)).not.toThrow();
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves no .tmp files behind after the write", async () => {
    const { findCodexTranscript } = await import("@/lib/codex-sessions");
    findCodexTranscript(sessionId);
    const stateDir = join(fpHome, "state");
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
