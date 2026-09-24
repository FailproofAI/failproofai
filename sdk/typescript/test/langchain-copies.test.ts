import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nestedCopies, resolveExportsAt } from "../src/node-require.js";

/**
 * A SECOND `@langchain/core`, nested under a dependency that pinned its own.
 *
 * A provider declaring `@langchain/core` as a hard dependency on a range the
 * application's copy does not satisfy gets its own copy at
 * `node_modules/<provider>/node_modules/@langchain/core`, and everything it
 * exports is built on it. `instrument()` resolved `@langchain/core` from the
 * application and patched that copy only — so a run the provider's classes
 * started as a ROOT went through the nested copy's untouched `configure` and was
 * recorded nowhere (reproduced end to end in
 * `integration/fixtures/langchain-dup-core`). These tests pin the two halves of
 * the fix with fake copies on disk: finding every nested copy, and patching the
 * build of each that the application's module system will load.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let app: string;
let modules: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A fake `@langchain/core` whose `CallbackManager.configure` records, per copy
 * and per build, whether it was handed the failproofai handler.
 */
function fakeCore(dir: string, marker: string, version: string): void {
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@langchain/core",
      version,
      exports: {
        "./callbacks/manager": {
          import: { types: "./x.d.ts", default: "./esm/manager.js" },
          require: { types: "./x.d.cts", default: "./cjs/manager.cjs" },
        },
        "./package.json": "./package.json",
      },
    }),
  );
  const body = (build: string) =>
    `class CallbackManager {\n` +
    `  static configure(inheritable) {\n` +
    `    const ours = Array.isArray(inheritable) && inheritable.some((h) => h && h.name === "failproofai");\n` +
    `    globalThis.__seen = [...(globalThis.__seen ?? []), "${marker}-${build}:" + ours];\n` +
    `    return undefined;\n` +
    `  }\n` +
    `}\n` +
    `globalThis.__loaded = [...(globalThis.__loaded ?? []), "${marker}-${build}"];\n`;
  write(join(dir, "esm", "manager.js"), `${body("esm")}export { CallbackManager };\n`);
  write(join(dir, "cjs", "manager.cjs"), `${body("cjs")}exports.CallbackManager = CallbackManager;\n`);
}

beforeAll(() => {
  app = realpathSync(mkdtempSync(join(tmpdir(), "failproofai-lc-copies-")));
  modules = join(app, "node_modules");
  // The application's own copy.
  fakeCore(join(modules, "@langchain", "core"), "app", "1.2.12");
  // A provider that pinned 0.3 — the layout this is about.
  fakeCore(join(modules, "lc-provider", "node_modules", "@langchain", "core"), "provider", "0.3.80");
  write(join(modules, "lc-provider", "package.json"), JSON.stringify({ name: "lc-provider" }));
  // Nested two levels down, under a scoped package.
  fakeCore(
    join(modules, "@acme", "agents", "node_modules", "tools", "node_modules", "@langchain", "core"),
    "deep",
    "1.1.0",
  );
  // Outside the declared range: found, but never loaded or patched.
  fakeCore(join(modules, "ancient", "node_modules", "@langchain", "core"), "ancient", "0.1.52");
  // pnpm's virtual store, with the provider's copy symlinked beside it the way
  // pnpm lays a dependency out — ONE copy, however many links point at it.
  fakeCore(join(modules, ".pnpm", "@langchain+core@1.0.4", "node_modules", "@langchain", "core"), "pnpm", "1.0.4");
  mkdirSync(join(modules, ".pnpm", "prov@1.0.0", "node_modules", "@langchain"), { recursive: true });
  symlinkSync(
    join(modules, ".pnpm", "@langchain+core@1.0.4", "node_modules", "@langchain", "core"),
    join(modules, ".pnpm", "prov@1.0.0", "node_modules", "@langchain", "core"),
  );
});

afterAll(() => {
  rmSync(app, { recursive: true, force: true });
});

const inApp = <T>(fn: () => T): T => {
  const cwd = process.cwd();
  process.chdir(app);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
};

describe("nestedCopies", () => {
  it("finds every copy nested under a dependency, and the pnpm store's, but never the app's own", () => {
    const found = inApp(() => nestedCopies("@langchain/core")).sort();
    expect(found).toEqual(
      [
        join(modules, ".pnpm", "@langchain+core@1.0.4", "node_modules", "@langchain", "core"),
        join(modules, "@acme", "agents", "node_modules", "tools", "node_modules", "@langchain", "core"),
        join(modules, "ancient", "node_modules", "@langchain", "core"),
        join(modules, "lc-provider", "node_modules", "@langchain", "core"),
      ].sort(),
    );
  });

  it("finds nothing where nothing is nested", () => {
    expect(inApp(() => nestedCopies("not-installed-anywhere"))).toEqual([]);
  });
});

describe("resolveExportsAt", () => {
  it("names each build of a subpath, through nested conditions", () => {
    const provider = join(modules, "lc-provider", "node_modules", "@langchain", "core");
    expect(resolveExportsAt(provider, "./callbacks/manager", "import")).toBe(join(provider, "esm", "manager.js"));
    expect(resolveExportsAt(provider, "./callbacks/manager", "require")).toBe(join(provider, "cjs", "manager.cjs"));
    expect(resolveExportsAt(provider, "./not-exported", "import")).toBeNull();
    expect(resolveExportsAt(join(app, "nowhere"), "./callbacks/manager", "import")).toBeNull();
  });
});

describe("instrument('langchain') with a nested @langchain/core", () => {
  /**
   * Install the adapter from a real entry point of each module system — which
   * copy the application's imports reach is a property of the process — then
   * call `configure` on every copy and report which ones handed it our handler.
   */
  const run = (entry: "esm" | "cjs", before = "", after = ""): { seen: string[]; loaded: string[] } => {
    const adapter =
      entry === "esm"
        ? pathToFileURL(join(root, "dist", "esm", "integrations", "langchain.js")).href
        : join(root, "dist", "cjs", "integrations", "langchain.js");
    const file = join(app, entry === "esm" ? "main.mjs" : "main.cjs");
    const header =
      entry === "esm"
        ? `import { createRequire } from "node:module";\nimport { pathToFileURL } from "node:url";\nimport * as lc from ${JSON.stringify(adapter)};\nconst require = createRequire(import.meta.url);\nconst load = async (p) => (p.endsWith(".cjs") ? require(p) : import(pathToFileURL(p).href));\n`
        : `const lc = require(${JSON.stringify(adapter)});\nconst load = async (p) => require(p);\n`;
    const copies = ["@langchain/core", "lc-provider/node_modules/@langchain/core", "@acme/agents/node_modules/tools/node_modules/@langchain/core", ".pnpm/@langchain+core@1.0.4/node_modules/@langchain/core", "ancient/node_modules/@langchain/core"];
    write(
      file,
      `${header}(async () => {\n${before}\nawait lc.adapter.install();\n` +
        `for (const dir of ${JSON.stringify(copies)}) {\n` +
        `  for (const build of ["${entry === "esm" ? "esm/manager.js" : "cjs/manager.cjs"}"]) {\n` +
        `    const m = await load(${JSON.stringify(modules)} + "/" + dir + "/" + build);\n` +
        `    m.CallbackManager.configure(undefined);\n` +
        `  }\n` +
        `}\n` +
        `${after}\n` +
        `lc.adapter.uninstall();\n` +
        `console.log(JSON.stringify({ seen: globalThis.__seen ?? [], loaded: globalThis.__loaded ?? [] }));\n` +
        `})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.stack) })); });\n`,
    );
    const child = spawnSync(process.execPath, [file], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, FAILPROOFAI_HOME: join(app, ".home") },
    });
    const parsed = JSON.parse(child.stdout.trim()) as { seen?: string[]; loaded?: string[]; error?: string };
    if (parsed.error !== undefined) throw new Error(parsed.error);
    return { seen: parsed.seen!, loaded: parsed.loaded! };
  };

  it("patches every in-range copy's ES-module build for an ES-module app", () => {
    const { seen, loaded } = run("esm");
    expect(seen).toEqual(["app-esm:true", "provider-esm:true", "deep-esm:true", "pnpm-esm:true", "ancient-esm:false"]);
    // The CommonJS builds nothing required are never loaded.
    expect(loaded.filter((name) => name.endsWith("-cjs"))).toEqual([]);
  });

  it("patches every in-range copy's CommonJS build for a CommonJS app, loading no ES module", () => {
    const { seen, loaded } = run("cjs");
    expect(seen).toEqual(["app-cjs:true", "provider-cjs:true", "deep-cjs:true", "pnpm-cjs:true", "ancient-cjs:false"]);
    expect(loaded.filter((name) => name.endsWith("-esm"))).toEqual([]);
  });

  it("also patches a nested copy's CommonJS build when something already required it", () => {
    // An ES-module app whose CommonJS dependency pulled the provider's copy in
    // before `instrument()`: both builds are live, both are patched.
    const provider = JSON.stringify(join(modules, "lc-provider", "node_modules", "@langchain", "core", "cjs", "manager.cjs"));
    const { seen } = run("esm", `require(${provider});`, `require(${provider}).CallbackManager.configure(undefined);`);
    expect(seen).toContain("provider-esm:true");
    expect(seen).toContain("provider-cjs:true");
  });

  it("never loads a copy outside the declared range", () => {
    // Loaded by nothing but the test's own probe, which runs after install.
    const { loaded } = run("esm", "", "");
    expect(loaded.slice(0, 4).sort()).toEqual(["app-esm", "deep-esm", "pnpm-esm", "provider-esm"]);
    expect(loaded.slice(4)).toEqual(["ancient-esm"]);
  });
});
