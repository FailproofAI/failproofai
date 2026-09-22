import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";
import { runNode, indexUrl } from "./helpers.js";

/**
 * What a consumer actually gets.
 *
 * Everything else in this suite runs against `src/`. These cases run against
 * `dist/` and `package.json`, because the failures they guard — a missing
 * export condition, a CommonJS build Node reads as ESM, a dependency somebody
 * added with `--save` — are invisible from inside the source tree and total
 * from outside it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  type: string;
  bin: Record<string, string>;
  exports: Record<string, Record<string, string> | string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files: string[];
};

describe("zero runtime dependencies", () => {
  it("declares none, because every one would be a constraint the host inherits", () => {
    // This package installs into other people's agent processes. A dependency
    // we declare is a version they have to resolve against, in the process
    // whose reliability we are supposed to be improving.
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it("marks every peer dependency optional, so npm installs none of them", () => {
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
    }
  });

  it("imports nothing outside node: builtins", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
          const specifier = match[1]!;
          const bare = !specifier.startsWith(".") && !specifier.startsWith("node:");
          if (bare) offenders.push(`${path}: ${specifier}`);
        }
      }
    };
    walk(join(root, "src"));
    // Framework imports are DYNAMIC and guarded — a static one would make
    // `import "@failproofai/sdk"` pull LangChain into every process.
    expect(offenders).toEqual([]);
  });
});

describe("the published surface", () => {
  it("builds every path its exports map promises", () => {
    for (const [entry, conditions] of Object.entries(manifest.exports)) {
      if (typeof conditions === "string") {
        expect(existsSync(join(root, conditions)), `${entry} -> ${conditions}`).toBe(true);
        continue;
      }
      for (const [condition, target] of Object.entries(conditions)) {
        expect(existsSync(join(root, target)), `${entry}.${condition} -> ${target}`).toBe(true);
      }
    }
  });

  it("tells Node which half of the dual build is CommonJS", () => {
    // The package is `"type": "module"`, so without this every `.js` under
    // `dist/cjs` is read as ESM and its `require` calls are a syntax error.
    expect(manifest.type).toBe("module");
    expect(JSON.parse(readFileSync(join(root, "dist/cjs/package.json"), "utf8"))).toEqual({
      type: "commonjs",
    });
    expect(JSON.parse(readFileSync(join(root, "dist/esm/package.json"), "utf8"))).toEqual({
      type: "module",
    });
  });

  it("ships an executable CLI", () => {
    const cli = join(root, manifest.bin["failproofai-evaluator"]!);
    expect(existsSync(cli)).toBe(true);
    expect(statSync(cli).mode & 0o111).toBeGreaterThan(0);
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("prints usage rather than a stack trace when run with no arguments", () => {
    const cli = join(root, manifest.bin["failproofai-evaluator"]!);
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(output).toContain("Usage: failproofai-evaluator");
    expect(output).toContain("FAILPROOFAI_EVALUATOR_URL");
  });

  it("keeps the version in one place", () => {
    expect(manifest.version).toBe(VERSION);
  });

  it("includes only what a consumer needs", () => {
    expect(manifest.files).toContain("dist/");
    expect(manifest.files).not.toContain("src/");
    expect(manifest.files).not.toContain("test/");
  });
});

describe("both module systems load it", () => {
  it("works as ESM", async () => {
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      if (typeof fp.configure !== "function") throw new Error("configure is missing");
      if (typeof fp.agent !== "function") throw new Error("agent is missing");
      if (typeof fp.event.toolUse !== "function") throw new Error("event.toolUse is missing");
      console.log(fp.version);
    `);
    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe(VERSION);
  });

  it("works as CommonJS", async () => {
    const cjs = JSON.stringify(join(root, "dist/cjs/index.js"));
    const child = await runNode(`
      const { createRequire } = await import("node:module");
      const require_ = createRequire(${JSON.stringify(join(root, "anchor.js"))});
      const fp = require_(${cjs});
      if (typeof fp.configure !== "function") throw new Error("configure is missing");
      if (typeof fp.session !== "function") throw new Error("session is missing");
      console.log(fp.version);
    `);
    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe(VERSION);
  });

  it("loads the evaluator and the adapters from their subpaths", async () => {
    const require_ = createRequire(join(root, "anchor.js"));
    for (const subpath of ["./evaluator", "./ai", "./mastra", "./langchain", "./llamaindex"]) {
      const target = (manifest.exports[subpath] as Record<string, string>).require!;
      expect(existsSync(join(root, target))).toBe(true);
      expect(() => require_(join(root, target))).not.toThrow();
    }
  });

  it("does not pull a framework into the process just by being imported", async () => {
    const child = await runNode(`
      const fp = await import(${JSON.stringify(indexUrl())});
      const loaded = Object.keys(await import("node:module").then((m) => m.createRequire(process.cwd() + "/x.js").cache));
      const frameworks = loaded.filter((p) => /node_modules[\\\\/](@langchain|ai|@mastra|llamaindex)[\\\\/]/.test(p));
      console.log(JSON.stringify(frameworks));
    `);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout.trim())).toEqual([]);
  });
});
