import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveEsm } from "../src/node-require.js";

/**
 * Which copy of a dual-published framework an adapter patches.
 *
 * The first release resolved every framework with `createRequire`, which can
 * only name the CommonJS build — so in an ES-module application, the default
 * for a new TypeScript project, `instrument()` patched a copy nothing used and
 * recorded nothing. These tests build a fake dual package on disk and run
 * `requireModuleCopies` from REAL entry points of each module system, because
 * "which module system is the entry" is a property of the process and cannot be
 * faked from inside a test runner.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let app: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A copy that says which build it is and records that it was loaded. */
const copy = (marker: string, esm: boolean): string =>
  esm
    ? `globalThis.__loaded = [...(globalThis.__loaded ?? []), "${marker}"];\nexport const marker = "${marker}";\nexport class Thing {}\n`
    : `globalThis.__loaded = [...(globalThis.__loaded ?? []), "${marker}"];\nexports.marker = "${marker}";\nexports.Thing = class Thing {};\n`;

beforeAll(() => {
  app = mkdtempSync(join(tmpdir(), "failproofai-copies-"));
  const modules = join(app, "node_modules");

  // A dual package with a root entry, a subpath and a pattern, conditions
  // nested the way real frameworks publish them (`@langchain/core` does
  // exactly `{ import: { types, default }, require: { types, default } }`).
  write(
    join(modules, "dualfw", "package.json"),
    JSON.stringify({
      name: "dualfw",
      version: "1.2.3",
      exports: {
        ".": { import: { types: "./x.d.ts", default: "./esm/index.js" }, require: "./cjs/index.cjs" },
        "./callbacks/manager": { import: "./esm/manager.js", require: "./cjs/manager.cjs" },
        "./tools/*": { node: { import: "./esm/tools/*.js", require: "./cjs/tools/*.cjs" } },
      },
    }),
  );
  write(join(modules, "dualfw", "esm", "index.js"), copy("esm", true));
  write(join(modules, "dualfw", "cjs", "index.cjs"), copy("cjs", false));
  write(join(modules, "dualfw", "esm", "manager.js"), copy("esm-manager", true));
  write(join(modules, "dualfw", "cjs", "manager.cjs"), copy("cjs-manager", false));
  write(join(modules, "dualfw", "esm", "tools", "search.js"), copy("esm-search", true));
  write(join(modules, "dualfw", "cjs", "tools", "search.cjs"), copy("cjs-search", false));

  // ESM-only: no `require` condition, so CommonJS resolution cannot find it.
  write(
    join(modules, "@scope", "esmonly", "package.json"),
    JSON.stringify({ name: "@scope/esmonly", exports: { ".": { import: "./index.js" } } }),
  );
  write(join(modules, "@scope", "esmonly", "index.js"), copy("esmonly", true));

  // No exports map: Node reads `main` for both, so there is one copy.
  write(join(modules, "plainfw", "package.json"), JSON.stringify({ name: "plainfw", main: "main.js" }));
  write(join(modules, "plainfw", "main.js"), copy("plain", false));
});

afterAll(() => {
  rmSync(app, { recursive: true, force: true });
});

describe("resolveEsm", () => {
  const inApp = <T>(fn: () => T): T => {
    const cwd = process.cwd();
    process.chdir(app);
    try {
      return fn();
    } finally {
      process.chdir(cwd);
    }
  };

  it("names the import build of a dual package, root and subpath", () => {
    inApp(() => {
      expect(resolveEsm("dualfw")).toBe(join(app, "node_modules", "dualfw", "esm", "index.js"));
      expect(resolveEsm("dualfw/callbacks/manager")).toBe(
        join(app, "node_modules", "dualfw", "esm", "manager.js"),
      );
    });
  });

  it("expands a subpath pattern through nested conditions", () => {
    inApp(() => {
      expect(resolveEsm("dualfw/tools/search")).toBe(
        join(app, "node_modules", "dualfw", "esm", "tools", "search.js"),
      );
    });
  });

  it("finds an ESM-only package that CommonJS resolution cannot", () => {
    inApp(() => {
      expect(resolveEsm("@scope/esmonly")).toBe(join(app, "node_modules", "@scope", "esmonly", "index.js"));
    });
  });

  it("returns null where there is no separate ESM copy or no such module", () => {
    inApp(() => {
      expect(resolveEsm("plainfw")).toBeNull();
      expect(resolveEsm("dualfw/not-exported")).toBeNull();
      expect(resolveEsm("not-installed-anywhere")).toBeNull();
    });
  });
});

describe("requireModuleCopies", () => {
  /** Run `body` in a fresh process whose ENTRY is an ES module or CommonJS. */
  const run = (entry: "esm" | "cjs", body: string): string[] => {
    const compat =
      entry === "esm"
        ? pathToFileURL(join(root, "dist", "esm", "integrations", "compat.js")).href
        : join(root, "dist", "cjs", "integrations", "compat.js");
    const file = join(app, entry === "esm" ? "main.mjs" : "main.cjs");
    const header =
      entry === "esm"
        ? `import { createRequire } from "node:module";\nimport * as compat from ${JSON.stringify(compat)};\nconst require = createRequire(import.meta.url);\n`
        : `const compat = require(${JSON.stringify(compat)});\n`;
    write(
      file,
      `${header}(async () => {\n${body}\nconsole.log(JSON.stringify({ result, loaded: globalThis.__loaded ?? [] }));\n})().catch((e) => { console.log(JSON.stringify({ error: String(e.message) })); });\n`,
    );
    const child = spawnSync(process.execPath, [file], { cwd: app, encoding: "utf8" });
    expect(child.stderr).toBe("");
    const parsed = JSON.parse(child.stdout.trim()) as { result?: string[]; loaded?: string[]; error?: string };
    if (parsed.error !== undefined) return [`error: ${parsed.error}`];
    return [...parsed.result!, "|", ...parsed.loaded!];
  };

  const markers = 'const result = (await compat.requireModuleCopies(SPEC, "npm i x")).map((m) => m.marker);';

  it("patches the ES-module copy for an ES-module app, and loads nothing else", () => {
    expect(run("esm", markers.replace("SPEC", '"dualfw"'))).toEqual(["esm", "|", "esm"]);
  });

  it("also patches the CommonJS copy when something already required it", () => {
    const body = `require("dualfw");\n${markers.replace("SPEC", '"dualfw"')}`;
    expect(run("esm", body)).toEqual(["esm", "cjs", "|", "cjs", "esm"]);
  });

  it("patches the CommonJS copy for a CommonJS app, without loading the ESM build", () => {
    expect(run("cjs", markers.replace("SPEC", '"dualfw"'))).toEqual(["cjs", "|", "cjs"]);
    expect(run("cjs", markers.replace("SPEC", '"dualfw/callbacks/manager"'))).toEqual([
      "cjs-manager",
      "|",
      "cjs-manager",
    ]);
  });

  it("uses the one copy an ESM-only or exports-less package has", () => {
    expect(run("esm", markers.replace("SPEC", '"@scope/esmonly"'))).toEqual(["esmonly", "|", "esmonly"]);
    expect(run("cjs", markers.replace("SPEC", '"@scope/esmonly"'))).toEqual(["esmonly", "|", "esmonly"]);
    expect(run("esm", markers.replace("SPEC", '"plainfw"'))).toEqual(["plain", "|", "plain"]);
  });

  it("throws with the install command when the framework is absent", () => {
    const [line] = run("esm", markers.replace("SPEC", '"not-installed-anywhere"'));
    expect(line).toMatch(/not importable\. Install it with: {2}npm i x/);
  });
});
