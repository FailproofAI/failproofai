// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FAKE_HOME = "/fake/home";

const NPM_GLOBAL_ROOT     = "/usr/lib/node_modules";
const NPM_GLOBAL_PKG      = `${NPM_GLOBAL_ROOT}/failproofai`;
const BUN_GLOBAL_PKG      = `${FAKE_HOME}/.bun/install/global/node_modules/failproofai`;
const BUN_BIN_REAL_TARGET = `${FAKE_HOME}/prs/failproofai-old/dist/cli.mjs`;
const BUN_LINKED_PKG      = `${FAKE_HOME}/prs/failproofai-old`;

vi.mock("node:fs", () => ({
  existsSync:  vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock("node:os", () => ({
  homedir:  vi.fn(() => FAKE_HOME),
  platform: vi.fn(() => "linux"),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

/**
 * Helper: build an existsSync responder driven by a set of paths that "exist".
 * Anything not in the set returns false.
 */
function existsForPaths(paths: Set<string>) {
  return (p: unknown) => (typeof p === "string" ? paths.has(p) : false);
}

/**
 * Helper: build a readFileSync responder for known package.json paths.
 * Throws ENOENT-equivalent for paths not in the map.
 */
function readForPackageJsons(map: Map<string, { name?: string; version?: string }>) {
  return (p: unknown) => {
    if (typeof p !== "string") throw new Error("ENOENT");
    if (map.has(p)) return JSON.stringify(map.get(p));
    throw new Error(`ENOENT: ${p}`);
  };
}

describe("diagnoseShadow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns shadowed=false when PATH resolves to the same install as self", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => p);
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${NPM_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${NPM_GLOBAL_PKG}/dist/cli.mjs\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });

    expect(diag.shadowed).toBe(false);
    expect(diag.recommendation).toBeNull();
    expect(diag.pathFirstPath).toBe(NPM_GLOBAL_PKG);
    expect(diag.pathFirstVersion).toBe("0.0.10-beta.0");
  });

  it("flags shadow when a bun-linked dev tree wins on PATH ahead of the just-installed npm copy", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    // bun bin symlink → bun-installed cli.mjs → realpath into the dev tree
    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === `${FAKE_HOME}/.bun/bin/failproofai`) return BUN_BIN_REAL_TARGET;
      return p;
    });
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${BUN_LINKED_PKG}/package.json`,
      `${BUN_LINKED_PKG}/dist`,
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
      // realpath result is a file inside the dev tree
      BUN_BIN_REAL_TARGET,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${BUN_LINKED_PKG}/package.json`,    { name: "failproofai", version: "0.0.9-beta.3" }],
      [`${NPM_GLOBAL_PKG}/package.json`,    { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${FAKE_HOME}/.bun/bin/failproofai\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });

    expect(diag.shadowed).toBe(true);
    expect(diag.pathFirstPath).toBe(BUN_LINKED_PKG);
    expect(diag.pathFirstVersion).toBe("0.0.9-beta.3");
    expect(diag.npmGlobalPath).toBe(NPM_GLOBAL_PKG);
    expect(diag.npmGlobalVersion).toBe("0.0.10-beta.0");
    expect(diag.shadowDescription).toContain("0.0.9-beta.3");
    expect(diag.shadowDescription).toContain("0.0.10-beta.0");
    // The dev-tree package root is NOT under ~/.bun, but the bin we invoke is —
    // recommendation must use that signal to produce the bun-style cleanup.
    expect(diag.recommendation).toContain("~/.bun/bin/failproofai");
  });

  it("flags shadow at runtime when the running binary IS PATH-first but a different npm global exists", async () => {
    // Scenario: user runs the stale bun-linked binary. selfPackageRoot ===
    // pathFirstPath. There's also a (newer) npm global install they wanted.
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === `${FAKE_HOME}/.bun/bin/failproofai`) return BUN_BIN_REAL_TARGET;
      return p;
    });
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${BUN_LINKED_PKG}/package.json`,
      BUN_LINKED_PKG,
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
      BUN_BIN_REAL_TARGET,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${BUN_LINKED_PKG}/package.json`, { name: "failproofai", version: "0.0.9-beta.3" }],
      [`${NPM_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${FAKE_HOME}/.bun/bin/failproofai\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    // Caller's selfPackageRoot equals pathFirstPath — the launch.ts case where
    // the running binary IS the shadow.
    const diag = diagnoseShadow({ selfPackageRoot: BUN_LINKED_PKG, selfVersion: "0.0.9-beta.3" });

    expect(diag.shadowed).toBe(true);
    expect(diag.pathFirstPath).toBe(BUN_LINKED_PKG);
    expect(diag.npmGlobalPath).toBe(NPM_GLOBAL_PKG);
    expect(diag.recommendation).toContain("~/.bun/bin/failproofai");
  });

  it("recommends `rm ~/.bun/bin/...` when the shadow lives under ~/.bun", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => {
      if (p === `${FAKE_HOME}/.bun/bin/failproofai`) return `${BUN_GLOBAL_PKG}/dist/cli.mjs`;
      return p;
    });
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${BUN_GLOBAL_PKG}/package.json`,
      BUN_GLOBAL_PKG,
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
      `${BUN_GLOBAL_PKG}/dist/cli.mjs`,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${BUN_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.9" }],
      [`${NPM_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${FAKE_HOME}/.bun/bin/failproofai\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });

    expect(diag.shadowed).toBe(true);
    expect(diag.recommendation).toContain("~/.bun/bin/failproofai");
    expect(diag.recommendation).toContain("rm");
  });

  it("recommends `npm rm -g failproofai` when the shadow is an npm install", async () => {
    const SECONDARY_NPM_PKG = "/opt/homebrew/lib/node_modules/failproofai";
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => p);
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${SECONDARY_NPM_PKG}/package.json`,
      SECONDARY_NPM_PKG,
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${SECONDARY_NPM_PKG}/package.json`, { name: "failproofai", version: "0.0.8" }],
      [`${NPM_GLOBAL_PKG}/package.json`,    { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${SECONDARY_NPM_PKG}/dist/cli.mjs\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });

    expect(diag.shadowed).toBe(true);
    expect(diag.recommendation).toBe("npm rm -g failproofai");
  });

  it("returns shadowed=false when `command -v` finds nothing", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => p);
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${NPM_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any) => {
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      // command -v fails — failproofai not on PATH
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });

    expect(diag.shadowed).toBe(false);
    expect(diag.pathFirstPath).toBeNull();
    expect(diag.recommendation).toBeNull();
  });

  it("treats unreadable package.json as null version without throwing", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => p);
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${NPM_GLOBAL_PKG}/package.json`,
      NPM_GLOBAL_PKG,
      `${BUN_GLOBAL_PKG}/package.json`,
      BUN_GLOBAL_PKG,
    ])));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (p === `${NPM_GLOBAL_PKG}/package.json`) return JSON.stringify({ name: "failproofai", version: "0.0.10-beta.0" });
      if (p === `${BUN_GLOBAL_PKG}/package.json`) return "{ this is not valid json";
      throw new Error("ENOENT");
    });
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${BUN_GLOBAL_PKG}/dist/cli.mjs\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    expect(() =>
      diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" })
    ).not.toThrow();
    const diag = diagnoseShadow({ selfPackageRoot: NPM_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });
    // Corrupt package.json on the bun side means we cannot identify it as failproofai
    // → the walk-up keeps going and may fail to resolve a package root, which is fine:
    // shadow detection requires both sides to be identifiable.
    expect(diag.pathFirstVersion).toBeNull();
  });

  it("reports `npm root -g` failure as no npm install found, never throws", async () => {
    const { existsSync, readFileSync, realpathSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");

    vi.mocked(realpathSync).mockImplementation((p: any) => p);
    vi.mocked(existsSync).mockImplementation(existsForPaths(new Set([
      `${BUN_GLOBAL_PKG}/package.json`,
      BUN_GLOBAL_PKG,
    ])));
    vi.mocked(readFileSync).mockImplementation(readForPackageJsons(new Map([
      [`${BUN_GLOBAL_PKG}/package.json`, { name: "failproofai", version: "0.0.10-beta.0" }],
    ])));
    vi.mocked(spawnSync).mockImplementation(((cmd: any, args: any) => {
      if (cmd === "sh" && args[1].startsWith("command -v")) {
        return { status: 0, stdout: `${BUN_GLOBAL_PKG}/dist/cli.mjs\n`, stderr: "", signal: null, output: [] as any, pid: 0 };
      }
      if (cmd === "npm") {
        return { status: 1, stdout: "", stderr: "npm not found", signal: null, output: [] as any, pid: 0 };
      }
      return { status: 1, stdout: "", stderr: "", signal: null, output: [] as any, pid: 0 };
    }) as any);

    const { diagnoseShadow } = await import("../../scripts/install-diagnosis.mjs");
    const diag = diagnoseShadow({ selfPackageRoot: BUN_GLOBAL_PKG, selfVersion: "0.0.10-beta.0" });
    expect(diag.npmGlobalPath).toBeNull();
    expect(diag.shadowed).toBe(false);
  });
});
