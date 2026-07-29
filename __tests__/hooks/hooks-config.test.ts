// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
}));

const CONFIG_PATH = resolve(homedir(), ".failproofai", "policies-config.json");

describe("hooks/hooks-config", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  describe("readHooksConfig", () => {
    it("returns empty enabledPolicies when file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { readHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readHooksConfig();
      expect(config).toEqual({ enabledPolicies: [] });
    });

    it("reads and parses existing config", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ enabledPolicies: ["block-sudo", "block-rm-rf"] }),
      );
      const { readHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readHooksConfig();
      expect(config.enabledPolicies).toEqual(["block-sudo", "block-rm-rf"]);
    });

    it("returns empty enabledPolicies on invalid JSON", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("not json");
      const { readHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readHooksConfig();
      expect(config).toEqual({ enabledPolicies: [] });
    });
  });

  describe("writeHooksConfig", () => {
    it("writes config to the correct path", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const { writeHooksConfig } = await import("../../src/hooks/hooks-config");
      writeHooksConfig({ enabledPolicies: ["block-sudo"] });
      expect(writeFileSync).toHaveBeenCalledOnce();
      const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(CONFIG_PATH);
      const parsed = JSON.parse(content as string);
      expect(parsed.enabledPolicies).toEqual(["block-sudo"]);
    });

    it("creates directory if it does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { writeHooksConfig } = await import("../../src/hooks/hooks-config");
      writeHooksConfig({ enabledPolicies: [] });
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".failproofai"),
        { recursive: true },
      );
    });
  });

  describe("readMergedHooksConfig", () => {
    const CWD = "/tmp/test-project";
    const projectPath = resolve(CWD, ".failproofai", "policies-config.json");
    const localPath = resolve(CWD, ".failproofai", "policies-config.local.json");
    const globalPath = resolve(homedir(), ".failproofai", "policies-config.json");

    function mockFiles(files: Record<string, object>): void {
      vi.mocked(existsSync).mockImplementation((p) => String(p) in files);
      vi.mocked(readFileSync).mockImplementation((p) => {
        const key = String(p);
        if (key in files) return JSON.stringify(files[key]);
        throw new Error("ENOENT");
      });
    }

    it("returns empty enabledPolicies when no config files exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.enabledPolicies).toEqual([]);
      expect(config.policyParams).toBeUndefined();
      expect(config.customPoliciesPath).toBeUndefined();
    });

    it("returns global config when only global exists", async () => {
      mockFiles({
        [globalPath]: { enabledPolicies: ["block-sudo", "sanitize-jwt"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.enabledPolicies).toEqual(expect.arrayContaining(["block-sudo", "sanitize-jwt"]));
    });

    it("unions enabledPolicies across all three scopes", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: ["block-sudo"] },
        [localPath]: { enabledPolicies: ["block-rm-rf"] },
        [globalPath]: { enabledPolicies: ["sanitize-jwt"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.enabledPolicies).toEqual(
        expect.arrayContaining(["block-sudo", "block-rm-rf", "sanitize-jwt"]),
      );
      expect(config.enabledPolicies).toHaveLength(3);
    });

    it("deduplicates enabledPolicies across scopes", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: ["block-sudo", "sanitize-jwt"] },
        [globalPath]: { enabledPolicies: ["block-sudo", "block-rm-rf"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      const names = config.enabledPolicies;
      // block-sudo should appear only once
      expect(names.filter((n) => n === "block-sudo")).toHaveLength(1);
      expect(names).toHaveLength(3);
    });

    it("policyParams: project scope wins over global for same policy", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], policyParams: { "block-sudo": { allowPatterns: ["sudo systemctl"] } } },
        [globalPath]: { enabledPolicies: [], policyParams: { "block-sudo": { allowPatterns: ["sudo make"] } } },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.policyParams?.["block-sudo"]).toEqual({ allowPatterns: ["sudo systemctl"] });
    });

    it("policyParams: global fills in policies absent from project", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], policyParams: { "block-sudo": { allowPatterns: ["sudo make"] } } },
        [globalPath]: { enabledPolicies: [], policyParams: { "block-rm-rf": { allowPaths: ["/tmp"] } } },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.policyParams?.["block-sudo"]).toEqual({ allowPatterns: ["sudo make"] });
      expect(config.policyParams?.["block-rm-rf"]).toEqual({ allowPaths: ["/tmp"] });
    });

    it("policyParams: local overrides global, project overrides local", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], policyParams: { "block-push-master": { protectedBranches: ["release"] } } },
        [localPath]: { enabledPolicies: [], policyParams: { "block-push-master": { protectedBranches: ["main", "staging"] } } },
        [globalPath]: { enabledPolicies: [], policyParams: { "block-push-master": { protectedBranches: ["main"] } } },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      // project wins for block-push-master
      expect(config.policyParams?.["block-push-master"]).toEqual({ protectedBranches: ["release"] });
    });

    it("customPoliciesPath: first scope that defines it wins", async () => {
      mockFiles({
        [localPath]: { enabledPolicies: [], customPoliciesPath: "/local/hooks.js" },
        [globalPath]: { enabledPolicies: [], customPoliciesPath: "/global/hooks.js" },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.customPoliciesPaths).toEqual(["/local/hooks.js"]);
    });

    it("customPoliciesPath: project scope wins over local", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], customPoliciesPath: "/project/hooks.js" },
        [localPath]: { enabledPolicies: [], customPoliciesPath: "/local/hooks.js" },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.customPoliciesPaths).toEqual(["/project/hooks.js"]);
    });

    it("normalizes a legacy customPoliciesPath to customPoliciesPaths", async () => {
      mockFiles({
        [globalPath]: { enabledPolicies: [], customPoliciesPath: "/global/hooks.js" },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.customPoliciesPaths).toEqual(["/global/hooks.js"]);
    });

    it("customPoliciesPaths: preserves multiple paths from the highest defining scope", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], customPoliciesPaths: ["/project/a.js", "/project/b.js"] },
        [globalPath]: { enabledPolicies: [], customPoliciesPaths: ["/global/hooks.js"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.customPoliciesPaths).toEqual(["/project/a.js", "/project/b.js"]);
    });

    it("disabledCustomPolicies: unions and deduplicates IDs across scopes", async () => {
      mockFiles({
        [projectPath]: { enabledPolicies: [], disabledCustomPolicies: ["custom:/a.js:rule"] },
        [localPath]: { enabledPolicies: [], disabledCustomPolicies: ["custom:/b.js:rule"] },
        [globalPath]: { enabledPolicies: [], disabledCustomPolicies: ["custom:/a.js:rule"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      expect(readMergedHooksConfig(CWD).disabledCustomPolicies).toEqual([
        "custom:/a.js:rule",
        "custom:/b.js:rule",
      ]);
    });

    it("disabledCustomPolicies: omits an empty merged set", async () => {
      mockFiles({ [globalPath]: { enabledPolicies: [], disabledCustomPolicies: [] } });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      expect(readMergedHooksConfig(CWD).disabledCustomPolicies).toBeUndefined();
    });

    it("returns no policyParams key when no params configured", async () => {
      mockFiles({
        [globalPath]: { enabledPolicies: ["block-sudo"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig(CWD);
      expect(config.policyParams).toBeUndefined();
    });
  });

  describe("walk-up resolution (#200)", () => {
    /**
     * Mock files-on-disk + the `.failproofai` directory markers that the walk-up
     * resolver looks for. For each file path, infer its containing `.failproofai`
     * dir and report it as a directory via statSync.
     */
    function mockFilesWithDirs(files: Record<string, object>): void {
      const failproofaiDirs = new Set<string>();
      for (const p of Object.keys(files)) {
        let d = dirname(p);
        while (d && d !== dirname(d)) {
          if (d.endsWith("/.failproofai")) failproofaiDirs.add(d);
          d = dirname(d);
        }
      }
      vi.mocked(existsSync).mockImplementation((p) => String(p) in files);
      vi.mocked(readFileSync).mockImplementation((p) => {
        const key = String(p);
        if (key in files) return JSON.stringify(files[key]);
        throw new Error("ENOENT");
      });
      vi.mocked(statSync).mockImplementation((p) => {
        if (failproofaiDirs.has(String(p))) {
          return { isDirectory: () => true } as ReturnType<typeof statSync>;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
    }

    it("finds project config when CWD is in an immediate subdir", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [projectPath]: { enabledPolicies: ["block-sudo"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig("/tmp/proj/sub");
      expect(config.enabledPolicies).toEqual(["block-sudo"]);
    });

    it("finds project config when CWD is a deep subdir", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [projectPath]: { enabledPolicies: ["sanitize-jwt"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig("/tmp/proj/a/b/c/d");
      expect(config.enabledPolicies).toEqual(["sanitize-jwt"]);
    });

    it("falls through to global when no .failproofai exists in any parent", async () => {
      const globalPath = resolve(homedir(), ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [globalPath]: { enabledPolicies: ["block-rm-rf"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      // /tmp/orphan and parents don't have .failproofai
      const config = readMergedHooksConfig("/tmp/orphan/sub");
      expect(config.enabledPolicies).toEqual(["block-rm-rf"]);
    });

    it("does not pick up ~/.failproofai (the global dir) as a project root", async () => {
      const globalPath = resolve(homedir(), ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [globalPath]: { enabledPolicies: ["sanitize-jwt"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      // CWD is under home but no project-level .failproofai exists.
      // Walk must NOT treat ~/.failproofai as the project root.
      const config = readMergedHooksConfig(resolve(homedir(), "some-proj/sub"));
      // If walk had wrongly picked up ~ as project root, it would have read
      // ~/.failproofai/policies-config.json as a "project" config — same enabled
      // policies but `customPoliciesPath` would resolve relative to ~ which the
      // user never asked for. The merge result is still the global config; this
      // test mainly asserts no crash and that we read globalPath via the
      // global-fallback path.
      expect(config.enabledPolicies).toEqual(["sanitize-jwt"]);
    });

    it("first match wins — does not escape into a parent project", async () => {
      const innerPath = resolve("/tmp/A", ".failproofai", "policies-config.json");
      const outerPath = resolve("/tmp", ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [innerPath]: { enabledPolicies: ["inner-policy"] },
        [outerPath]: { enabledPolicies: ["outer-policy"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig("/tmp/A/sub");
      expect(config.enabledPolicies).toContain("inner-policy");
      expect(config.enabledPolicies).not.toContain("outer-policy");
    });

    it("local-only config (no policies-config.json) is found via the .failproofai dir marker", async () => {
      const localPath = resolve("/tmp/proj", ".failproofai", "policies-config.local.json");
      mockFilesWithDirs({
        [localPath]: { enabledPolicies: ["block-push-master"] },
      });
      const { readMergedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readMergedHooksConfig("/tmp/proj/sub");
      expect(config.enabledPolicies).toEqual(["block-push-master"]);
    });

    it("getConfigPathForScope walks up for project scope", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [projectPath]: { enabledPolicies: [] },
      });
      const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
      expect(getConfigPathForScope("project", "/tmp/proj/sub")).toBe(projectPath);
    });

    it("getConfigPathForScope walks up for local scope", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      mockFilesWithDirs({
        [projectPath]: { enabledPolicies: [] },
      });
      const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
      expect(getConfigPathForScope("local", "/tmp/proj/a/b")).toBe(
        resolve("/tmp/proj", ".failproofai", "policies-config.local.json"),
      );
    });

    it("rejects a `.failproofai` file (non-directory) as a project marker", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      const strayFile = resolve("/tmp/A", ".failproofai");
      // /tmp/A/.failproofai is a regular file (not a directory). Walk should
      // skip it and continue up to /tmp/proj.
      mockFilesWithDirs({ [projectPath]: { enabledPolicies: ["block-sudo"] } });
      vi.mocked(statSync).mockImplementation((p) => {
        const s = String(p);
        if (s === resolve("/tmp/proj", ".failproofai")) {
          return { isDirectory: () => true } as ReturnType<typeof statSync>;
        }
        if (s === strayFile) {
          return { isDirectory: () => false } as ReturnType<typeof statSync>;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      const { findProjectConfigDir } = await import("../../src/hooks/hooks-config");
      // Walk from /tmp/A/sub: must skip the stray file at /tmp/A/.failproofai
      // and not return /tmp/A. With nothing else above, walks to root and returns start.
      expect(findProjectConfigDir("/tmp/A/sub")).toBe("/tmp/A/sub");
    });
  });

  describe("getConfigPathForScope", () => {
    it("returns global path for user scope", async () => {
      const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
      expect(getConfigPathForScope("user")).toBe(
        resolve(homedir(), ".failproofai", "policies-config.json"),
      );
    });

    it("returns project path for project scope", async () => {
      const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
      expect(getConfigPathForScope("project", "/tmp/my-project")).toBe(
        resolve("/tmp/my-project", ".failproofai", "policies-config.json"),
      );
    });

    it("returns local path for local scope", async () => {
      const { getConfigPathForScope } = await import("../../src/hooks/hooks-config");
      expect(getConfigPathForScope("local", "/tmp/my-project")).toBe(
        resolve("/tmp/my-project", ".failproofai", "policies-config.local.json"),
      );
    });
  });

  describe("readScopedHooksConfig", () => {
    it("reads from project scope path", async () => {
      const projectPath = resolve("/tmp/proj", ".failproofai", "policies-config.json");
      vi.mocked(existsSync).mockImplementation((p) => String(p) === projectPath);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p) === projectPath) return JSON.stringify({ enabledPolicies: ["block-sudo"] });
        throw new Error("ENOENT");
      });
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readScopedHooksConfig("project", "/tmp/proj");
      expect(config.enabledPolicies).toEqual(["block-sudo"]);
    });

    it("returns empty config when scope file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readScopedHooksConfig("project", "/tmp/proj");
      expect(config).toEqual({ enabledPolicies: [] });
    });

    it("reads from user scope (global path)", async () => {
      const globalPath = resolve(homedir(), ".failproofai", "policies-config.json");
      vi.mocked(existsSync).mockImplementation((p) => String(p) === globalPath);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p) === globalPath) return JSON.stringify({ enabledPolicies: ["sanitize-jwt"] });
        throw new Error("ENOENT");
      });
      const { readScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      const config = readScopedHooksConfig("user");
      expect(config.enabledPolicies).toEqual(["sanitize-jwt"]);
    });
  });

  describe("writeScopedHooksConfig", () => {
    it("writes to project scope path", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      writeScopedHooksConfig({ enabledPolicies: ["block-sudo"] }, "project", "/tmp/proj");
      const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(resolve("/tmp/proj", ".failproofai", "policies-config.json"));
      expect(JSON.parse(content as string).enabledPolicies).toEqual(["block-sudo"]);
    });

    it("writes to local scope path", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      writeScopedHooksConfig({ enabledPolicies: ["block-rm-rf"] }, "local", "/tmp/proj");
      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(resolve("/tmp/proj", ".failproofai", "policies-config.local.json"));
    });

    it("writes to user scope (global path)", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      writeScopedHooksConfig({ enabledPolicies: ["sanitize-jwt"] }, "user");
      const [path] = vi.mocked(writeFileSync).mock.calls[0];
      expect(path).toBe(resolve(homedir(), ".failproofai", "policies-config.json"));
    });

    it("creates directory if it does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { writeScopedHooksConfig } = await import("../../src/hooks/hooks-config");
      writeScopedHooksConfig({ enabledPolicies: [] }, "project", "/tmp/proj");
      expect(mkdirSync).toHaveBeenCalledWith(
        resolve("/tmp/proj", ".failproofai"),
        { recursive: true },
      );
    });
  });
});
