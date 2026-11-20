// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve, dirname } from "path";

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

describe("hooks/loader-utils - findDistIndex", () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: originalExecPath, writable: true, configurable: true });
    delete process.env.FAILPROOFAI_DIST_PATH;
    vi.resetAllMocks();
  });

  it("returns FAILPROOFAI_DIST_PATH/index.js when env var is set and file exists", async () => {
    const distDir = "/some/explicit/dist";
    process.env.FAILPROOFAI_DIST_PATH = distDir;

    const { access } = await import("fs/promises");
    vi.mocked(access).mockResolvedValue(undefined);

    const { findDistIndex } = await import("../../src/hooks/loader-utils");
    const result = await findDistIndex();
    expect(result).toBe(resolve(distDir, "index.js"));
  });

  it("returns binary-relative assets/dist/index.js for packaged install when cwd paths are absent", async () => {
    delete process.env.FAILPROOFAI_DIST_PATH;
    const fakeExecPath = "/usr/local/lib/failproofai/bin/failproofai-linux-x64";
    Object.defineProperty(process, "execPath", { value: fakeExecPath, writable: true, configurable: true });

    const expectedPath = resolve(dirname(fakeExecPath), "..", "assets", "dist", "index.js");

    const { access } = await import("fs/promises");
    vi.mocked(access).mockImplementation(async (path) => {
      if (path === expectedPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { findDistIndex } = await import("../../src/hooks/loader-utils");
    const result = await findDistIndex();
    expect(result).toBe(expectedPath);
  });

  it("falls back to cwd/dist/index.js when binary-relative path does not exist", async () => {
    delete process.env.FAILPROOFAI_DIST_PATH;
    const cwdPath = resolve(process.cwd(), "dist", "index.js");

    const { access } = await import("fs/promises");
    vi.mocked(access).mockImplementation(async (path) => {
      if (path === cwdPath) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { findDistIndex } = await import("../../src/hooks/loader-utils");
    const result = await findDistIndex();
    expect(result).toBe(cwdPath);
  });

  it("returns null when no candidate path exists", async () => {
    delete process.env.FAILPROOFAI_DIST_PATH;

    const { access } = await import("fs/promises");
    vi.mocked(access).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { findDistIndex } = await import("../../src/hooks/loader-utils");
    const result = await findDistIndex();
    expect(result).toBeNull();
  });
});

describe("hooks/loader-utils - isCommonJsSource", () => {
  it("is CommonJS with require or module.exports and no import/export", async () => {
    const { isCommonJsSource } = await import("../../src/hooks/loader-utils");
    expect(isCommonJsSource(`const { deny } = require("failproofai");`)).toBe(true);
    expect(isCommonJsSource(`module.exports = { a: 1 };`)).toBe(true);
    expect(isCommonJsSource(`exports.a = 1;`)).toBe(true);
    // Dynamic import() is allowed in CommonJS.
    expect(isCommonJsSource(`const m = require("x");\nconst later = import("y");`)).toBe(true);
  });

  it("is not CommonJS once a real import, export or import.meta appears", async () => {
    const { isCommonJsSource } = await import("../../src/hooks/loader-utils");
    expect(isCommonJsSource(`import { deny } from "failproofai";`)).toBe(false);
    expect(isCommonJsSource(`export const a = 1;\nconst b = require("x");`)).toBe(false);
    expect(isCommonJsSource(`const r = createRequire(import.meta.url);\nr("x");`)).toBe(false);
    // Neither kind of marker: left as an ES module, as before.
    expect(isCommonJsSource(`globalThis.x = 1;`)).toBe(false);
  });

  it("ignores import and require that only appear in comments", async () => {
    const { isCommonJsSource } = await import("../../src/hooks/loader-utils");
    expect(isCommonJsSource(`// import x from "y"\nconst a = require("a");`)).toBe(true);
    expect(isCommonJsSource(`/* require("a") */\nglobalThis.x = 1;`)).toBe(false);
    // A URL's "//" is not a comment start.
    expect(isCommonJsSource(`const u = "http://x";\nmodule.exports = u;`)).toBe(true);
  });
});
