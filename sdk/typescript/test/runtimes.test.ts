import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { appImportsReachCommonJs, entryIsCommonJs, isCommonJsMain, isNextServer } from "../src/node-require.js";

/**
 * Runtime differences the SDK core has to read correctly. The end-to-end proof
 * for each is in `integration/runtimes.*.test.ts` and `integration/nextjs.test.ts`;
 * these pin the decisions.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("isCommonJsMain", () => {
  it("reads Node's undefined and Deno's null alike: an ES-module entry", () => {
    // Deno sets `require.main` to null for an ES-module entry. Treating that as
    // CommonJS patched the frameworks' CommonJS copies in every ES-module Deno
    // app, while the app ran the ES-module copies — nothing was recorded.
    expect(isCommonJsMain(undefined)).toBe(false);
    expect(isCommonJsMain(null)).toBe(false);
  });

  it("reads a module object as a CommonJS entry", () => {
    expect(isCommonJsMain({ filename: "/app/index.cjs", id: "." })).toBe(true);
  });
});

describe("appImportsReachCommonJs", () => {
  const saved = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = saved;
  });

  it("follows the entry point outside Next.js", () => {
    delete process.env.NEXT_RUNTIME;
    expect(isNextServer()).toBe(false);
    expect(appImportsReachCommonJs()).toBe(entryIsCommonJs());
  });

  it("is false in a Next.js server, whatever the (CommonJS) launcher is", () => {
    process.env.NEXT_RUNTIME = "nodejs";
    expect(isNextServer()).toBe(true);
    expect(appImportsReachCommonJs()).toBe(false);
  });
});

/**
 * The same decision from a real CommonJS entry, the shape `next start` has:
 * Next's launcher is CommonJS, and it `import()`s every server-external
 * package — so inside a Next server the ES-module copy is the one to patch.
 */
describe("requireModuleCopies under a CommonJS launcher", () => {
  let app: string;

  beforeAll(() => {
    app = mkdtempSync(join(tmpdir(), "failproofai-launcher-"));
    const pkg = join(app, "node_modules", "dualfw");
    mkdirSync(join(pkg, "esm"), { recursive: true });
    mkdirSync(join(pkg, "cjs"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "dualfw", exports: { ".": { import: "./esm/index.js", require: "./cjs/index.cjs" } } }),
    );
    writeFileSync(join(pkg, "esm", "index.js"), 'export const marker = "esm";\n');
    writeFileSync(join(pkg, "esm", "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(pkg, "cjs", "index.cjs"), 'exports.marker = "cjs";\n');
    const compat = join(root, "dist", "cjs", "integrations", "compat.js");
    writeFileSync(
      join(app, "launcher.cjs"),
      `const compat = require(${JSON.stringify(compat)});\n` +
        `compat.requireModuleCopies("dualfw", "npm i dualfw").then((copies) => ` +
        `console.log(JSON.stringify(copies.map((m) => m.marker))));\n`,
    );
  });

  afterAll(() => rmSync(app, { recursive: true, force: true }));

  const run = (env: Record<string, string>) => {
    const child = spawnSync(process.execPath, [join(app, "launcher.cjs")], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, NEXT_RUNTIME: "", ...env },
    });
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout.trim()) as string[];
  };

  it("patches the CommonJS copy for a plain CommonJS app", () => {
    expect(run({})).toEqual(["cjs"]);
  });

  it("patches the ES-module copy inside a Next.js server", () => {
    expect(run({ NEXT_RUNTIME: "nodejs" })).toEqual(["esm"]);
  });
});
