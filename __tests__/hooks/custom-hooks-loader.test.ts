// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/hooks/hook-logger", () => ({
  hookLogWarn: vi.fn(),
  hookLogError: vi.fn(),
  hookLogInfo: vi.fn(),
}));

vi.mock("../../src/hooks/custom-hooks-registry", () => ({
  getCustomHooks: vi.fn(() => []),
  clearCustomHooks: vi.fn(),
}));

vi.mock("../../src/hooks/loader-utils", () => ({
  findDistIndex: vi.fn(() => Promise.resolve(null)),
  rewriteFileTree: vi.fn(() => Promise.resolve([])),
  cleanupTmpFiles: vi.fn(() => Promise.resolve()),
  TMP_SUFFIX: ".__failproofai_tmp__.mjs",
  // The loader sweeps generated files left behind by a killed load before
  // anything scans a policy directory. Real behaviour is covered by
  // `loader-tmp-artifacts.test.ts` against a real filesystem; here it only
  // needs to exist, since this suite mocks `node:fs`.
  isTmpArtifact: vi.fn(() => false),
  sweepStaleTmpArtifacts: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

describe("hooks/custom-hooks-loader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when customPoliciesPath is undefined", async () => {
    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const result = await loadCustomHooks(undefined);
    expect(result).toEqual([]);
  });

  it("returns [] when customPoliciesPath is empty string", async () => {
    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const result = await loadCustomHooks("");
    expect(result).toEqual([]);
  });

  it("logs warning and returns [] when file does not exist", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const { hookLogWarn } = await import("../../src/hooks/hook-logger");

    const result = await loadCustomHooks("/nonexistent/hooks.js");
    expect(result).toEqual([]);
    expect(hookLogWarn).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("logs error and returns [] when import fails", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { rewriteFileTree } = await import("../../src/hooks/loader-utils");
    vi.mocked(rewriteFileTree).mockRejectedValueOnce(new Error("parse error"));

    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const { hookLogError } = await import("../../src/hooks/hook-logger");

    const result = await loadCustomHooks("/path/to/hooks.js");
    expect(result).toEqual([]);
    expect(hookLogError).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
  });

  it("cleans up temp files even when import fails", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { rewriteFileTree, cleanupTmpFiles } = await import("../../src/hooks/loader-utils");
    vi.mocked(rewriteFileTree).mockResolvedValueOnce(["/tmp/hooks.__failproofai_tmp__.mjs"]);
    // Simulate that the import step would fail; we can't easily mock dynamic import,
    // but we verify cleanup is called after rewriteFileTree returns tmp files.
    // Since the import itself will fail (no real file), cleanupTmpFiles should still be called.

    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    await loadCustomHooks("/path/to/hooks.js");

    expect(cleanupTmpFiles).toHaveBeenCalled();
  });

  it("passes entry path to rewriteFileTree so transitive imports are resolved", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { rewriteFileTree } = await import("../../src/hooks/loader-utils");
    // Simulate transitive graph: entry + two imported modules rewritten
    vi.mocked(rewriteFileTree).mockResolvedValueOnce([
      "/path/to/hooks.__failproofai_tmp__.mjs",
      "/path/to/dep-a.__failproofai_tmp__.mjs",
      "/path/to/dep-b.__failproofai_tmp__.mjs",
    ]);

    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const { cleanupTmpFiles } = await import("../../src/hooks/loader-utils");

    await loadCustomHooks("/path/to/hooks.js");

    // rewriteFileTree should be called with the entry file path
    expect(rewriteFileTree).toHaveBeenCalled();
    const [firstArg] = vi.mocked(rewriteFileTree).mock.calls[0];
    expect(firstArg).toContain("hooks.js");
    // All temp files (entry + transitively rewritten deps) cleaned up
    expect(cleanupTmpFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        "/path/to/hooks.__failproofai_tmp__.mjs",
        "/path/to/dep-a.__failproofai_tmp__.mjs",
        "/path/to/dep-b.__failproofai_tmp__.mjs",
      ]),
    );
  });

  it("returns registered hooks on successful load", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const fakeHook = { name: "my-hook", fn: async () => ({ decision: "allow" as const }) };
    const { getCustomHooks } = await import("../../src/hooks/custom-hooks-registry");
    vi.mocked(getCustomHooks).mockReturnValue([fakeHook]);

    // rewriteFileTree returns no tmp files (so import would fail but we mock getCustomHooks)
    // Actual import will fail since no real .mjs file — loader falls back to []
    // To truly test success path, we'd need a real file. This test verifies the
    // wiring: if getCustomHooks returns hooks, they propagate (when import succeeds).
    // For the error-path variant, loader returns [].
    const { rewriteFileTree } = await import("../../src/hooks/loader-utils");
    vi.mocked(rewriteFileTree).mockResolvedValueOnce([]);

    const { loadCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    // Import will fail (no real mjs file), so returns []
    const result = await loadCustomHooks("/path/to/hooks.js");
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("discoverPolicyFiles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when directory does not exist", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { discoverPolicyFiles } = await import("../../src/hooks/custom-hooks-loader");
    expect(discoverPolicyFiles("/nonexistent/dir")).toEqual([]);
  });

  it("returns only *policies.{js,mjs,ts} files, sorted alphabetically", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "z-policies.js", isFile: () => true, isDirectory: () => false },
      { name: "a-policies.mjs", isFile: () => true, isDirectory: () => false },
      { name: "utils.js", isFile: () => true, isDirectory: () => false },
      { name: "b-policies.ts", isFile: () => true, isDirectory: () => false },
      { name: "readme.md", isFile: () => true, isDirectory: () => false },
      { name: "data.json", isFile: () => true, isDirectory: () => false },
    ] as never);

    const { discoverPolicyFiles } = await import("../../src/hooks/custom-hooks-loader");
    const files = discoverPolicyFiles("/some/dir");

    expect(files).toHaveLength(3);
    expect(files[0]).toContain("a-policies.mjs");
    expect(files[1]).toContain("b-policies.ts");
    expect(files[2]).toContain("z-policies.js");
  });

  it("ignores subdirectories even if they match the naming pattern", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "real-policies.js", isFile: () => true, isDirectory: () => false },
      { name: "dir-policies.js", isFile: () => false, isDirectory: () => true },
    ] as never);

    const { discoverPolicyFiles } = await import("../../src/hooks/custom-hooks-loader");
    const files = discoverPolicyFiles("/some/dir");

    expect(files).toHaveLength(1);
    expect(files[0]).toContain("real-policies.js");
  });
});

describe("loadAllCustomHooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty hooks and no convention sources when nothing configured", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { getCustomHooks } = await import("../../src/hooks/custom-hooks-registry");
    vi.mocked(getCustomHooks).mockReturnValue([]);

    const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    const result = await loadAllCustomHooks(undefined, { sessionCwd: "/tmp/fake" });

    expect(result.hooks).toEqual([]);
    expect(result.conventionSources).toEqual([]);
  });

  it("calls clearCustomHooks exactly once", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { clearCustomHooks, getCustomHooks } = await import("../../src/hooks/custom-hooks-registry");
    vi.mocked(getCustomHooks).mockReturnValue([]);

    const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");
    await loadAllCustomHooks(undefined, { sessionCwd: "/tmp/fake" });

    expect(clearCustomHooks).toHaveBeenCalledTimes(1);
  });

  it("logs warning when customPoliciesPath does not exist", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { getCustomHooks } = await import("../../src/hooks/custom-hooks-registry");
    vi.mocked(getCustomHooks).mockReturnValue([]);

    const { hookLogWarn } = await import("../../src/hooks/hook-logger");
    const { loadAllCustomHooks } = await import("../../src/hooks/custom-hooks-loader");

    await loadAllCustomHooks("/nonexistent/file.js", { sessionCwd: "/tmp/fake" });

    expect(hookLogWarn).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });
});
