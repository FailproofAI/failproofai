import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** An `exports` value: a target, or conditions that nest (`require.types`). */
type Conditions = string | { [condition: string]: Conditions };

/** Every `[condition path, target]` under one `exports` entry. */
const targetsOf = (value: Conditions, path: string[] = []): Array<[string[], string]> =>
  typeof value === "string"
    ? [[path, value]]
    : Object.entries(value).flatMap(([condition, next]) => targetsOf(next, [...path, condition]));

/** The single target the given condition path selects, e.g. `["require", "default"]`. */
const targetAt = (value: Conditions, ...path: string[]): string => {
  const found = targetsOf(value).filter(([p]) => p.join(".") === path.join("."));
  if (found.length !== 1) throw new Error(`no single target at ${path.join(".")}`);
  return found[0]![1];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  type: string;
  bin: Record<string, string>;
  exports: Record<string, Conditions>;
  main: string;
  types: string;
  typesVersions?: Record<string, Record<string, string[]>>;
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
      for (const [path, target] of targetsOf(conditions)) {
        expect(existsSync(join(root, target)), `${entry}.${path.join(".")} -> ${target}`).toBe(true);
      }
    }
  });

  it("hands each module system the declarations of its own half", () => {
    // A `.d.ts` takes its module format from the nearest package.json, exactly
    // like a `.js`. ESM declarations under `require` told every CommonJS
    // project on `module: node16` that a CommonJS file was an ES module
    // (TS1479 on every import).
    for (const [entry, conditions] of Object.entries(manifest.exports)) {
      if (entry === "./package.json") continue;
      if (entry === "./sandbox-worker") {
        // CommonJS only, for both module systems: types and code agree.
        for (const [path, target] of targetsOf(conditions)) {
          expect(target.startsWith("./dist/cjs/"), `${entry}.${path.join(".")}`).toBe(true);
        }
        continue;
      }
      for (const [half, dir] of [
        ["import", "./dist/esm/"],
        ["require", "./dist/cjs/"],
      ] as const) {
        const types = targetAt(conditions, half, "types");
        const code = targetAt(conditions, half, "default");
        expect(types.startsWith(dir), `${entry}.${half}.types -> ${types}`).toBe(true);
        expect(code.startsWith(dir), `${entry}.${half}.default -> ${code}`).toBe(true);
        expect(types, entry).toBe(code.replace(/\.js$/, ".d.ts"));
      }
    }
  });

  it("gives moduleResolution: node (node10) every subpath, as CommonJS declarations", () => {
    // node10 ignores `exports`; `typesVersions` is its only route to a subpath,
    // and `types` to the root. A node10 project compiles to CommonJS.
    expect(manifest.types).toBe("./dist/cjs/index.d.ts");
    expect(manifest.main).toBe("./dist/cjs/index.js");
    const mapping = manifest.typesVersions?.["*"] ?? {};
    const subpaths = Object.keys(manifest.exports)
      .filter((entry) => entry !== "." && entry !== "./package.json")
      .map((entry) => entry.slice(2));
    expect(Object.keys(mapping).sort()).toEqual(subpaths.sort());
    for (const subpath of subpaths) {
      const conditions = manifest.exports[`./${subpath}`]!;
      const expected =
        subpath === "sandbox-worker"
          ? targetAt(conditions, "types")
          : targetAt(conditions, "require", "types");
      expect(mapping[subpath], subpath).toEqual([expected]);
    }
  });

  it("builds the CommonJS declarations the require conditions point at", () => {
    const cjs = readFileSync(join(root, "dist/cjs/index.d.ts"), "utf8");
    expect(cjs).toContain("export declare function configure");
    expect(existsSync(join(root, "dist/cjs/evaluator/sandbox-worker.d.ts"))).toBe(true);
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
      const target = targetAt(manifest.exports[subpath]!, "require", "default");
      expect(existsSync(join(root, target))).toBe(true);
      expect(() => require_(join(root, target))).not.toThrow();
    }
  });

  it("applies configure() from one copy to every copy in the process", async () => {
    // Next.js without withFailproofai bundles a copy per route beside the one
    // instrumentation.ts configures; the dual build loads ESM and CommonJS
    // side by side. Per-copy settings sent the route's events out as `dev`,
    // into whatever spool that copy defaulted to.
    const dir = mkdtempSync(join(tmpdir(), "fpai-copies-"));
    try {
      const child = await runNode(`
        const esm = await import(${JSON.stringify(indexUrl())});
        const { createRequire } = await import("node:module");
        const cjs = createRequire(${JSON.stringify(join(root, "anchor.js"))})(${JSON.stringify(join(root, "dist/cjs/index.js"))});
        if (esm.configure === cjs.configure) throw new Error("expected two copies");
        esm.configure({ environment: "prod-eu", baseDir: ${JSON.stringify(dir)} });
        cjs.event.agentStart({ sessionId: "copies" });
        await cjs.flush();
      `);
      expect(child.stderr).toBe("");
      const events = readdirSync(join(dir, "events"))
        .flatMap((f) => readFileSync(join(dir, "events", f), "utf8").split("\n").filter(Boolean))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.map((e) => [e.session_id, e.environment])).toEqual([["copies", "prod-eu"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs an evaluator module written as CommonJS or as ESM through the bin", () => {
    // The bin is the ESM build. A CommonJS evals file gets `Evaluator` from
    // `dist/cjs` — a second copy of the class — so an `instanceof` check in the
    // loader refused it with "resolved to Evaluator, not an Evaluator", and the
    // commonest setup (plain `tsc` output, no "type": "module") could not start.
    const dir = mkdtempSync(join(tmpdir(), "fpai-evals-"));
    const cjsEntry = JSON.stringify(join(root, targetAt(manifest.exports["./evaluator"]!, "require", "default")));
    const esmEntry = JSON.stringify(
      pathToFileURL(join(root, targetAt(manifest.exports["./evaluator"]!, "import", "default"))).href,
    );
    writeFileSync(
      join(dir, "evals.cjs"),
      `const { Evaluator } = require(${cjsEntry});\nexports.app = new Evaluator({ name: "cjs", version: "1" });\n`,
    );
    writeFileSync(
      join(dir, "evals.mjs"),
      `import { Evaluator } from ${esmEntry};\nexport const app = new Evaluator({ name: "esm", version: "1" });\n`,
    );
    writeFileSync(join(dir, "not-evals.cjs"), "exports.app = { runFromEnv() {} };\n");

    const run = (file: string) => {
      const env = { ...process.env };
      delete env.FAILPROOFAI_EVALUATOR_URL;
      delete env.FAILPROOFAI_EVALUATOR_TOKEN;
      try {
        execFileSync(process.execPath, [join(root, manifest.bin["failproofai-evaluator"]!), join(dir, file)], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return "";
      } catch (error) {
        return String((error as { stderr?: string }).stderr ?? error);
      }
    };
    try {
      // Loading succeeded when the worker gets as far as reading its config.
      expect(run("evals.cjs")).toContain("FAILPROOFAI_EVALUATOR_URL is required");
      expect(run("evals.mjs")).toContain("FAILPROOFAI_EVALUATOR_URL is required");
      expect(run("not-evals.cjs")).toContain("not an Evaluator");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
