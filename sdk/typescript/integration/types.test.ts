import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, inject, it } from "vitest";

import { FIXTURES } from "./harness.js";

/**
 * The packed tarball's type declarations, as every kind of TypeScript project
 * sees them.
 *
 * The SDK's own tsconfig is `nodenext` ESM, the one setup in which a dual
 * package whose `exports` hand ESM declarations to `require` looks fine. Every
 * other setup a customer can carry was broken by exactly that, and silently
 * from here:
 *
 *   * a CommonJS project on `module: node16` (or `nodenext` before TS 5.8) got
 *     TS1479 — "the referenced file is an ECMAScript module" — on every import;
 *   * `moduleResolution: node` (node10, still what `module: commonjs` implies,
 *     e.g. every NestJS project) resolved the root and no subpath at all.
 *
 * So `agent.ts` — importing the root and every public subpath, using the names
 * in ways a wrong or `any` type would fail — is compiled under each consumer
 * mode, on the newest TypeScript and on the oldest one this package supports,
 * with `skipLibCheck: false` so the declarations themselves are checked too.
 * `@arethetypeswrong/cli` then runs over the same tarball: it checks JavaScript
 * and declarations AGREE on module format, which no compile of ours can see.
 *
 * Minimum TypeScript: 5.4. It is the oldest release in which every mode below
 * exists (`module: preserve` arrived in 5.4). The declarations themselves need
 * only a type for `Symbol.dispose` (the `using` scopes), which `@types/node`
 * supplies, as does `lib: esnext.disposable` from TS 5.2 — measured: 5.2
 * passes every mode it has; 5.0 passes them only with `skipLibCheck`, because
 * `@types/node` 22 itself no longer compiles there.
 */

const FIXTURE = "types";
const DIR = join(FIXTURES, FIXTURE);

interface Mode {
  /** The consumer file's extension, which fixes its module format under node16/nodenext. */
  ext: "ts" | "mts" | "cts";
  module: string;
  moduleResolution: string;
  /** Written as the mode directory's package.json `type`; absent = CommonJS. */
  type?: "module";
}

const MODES: Record<string, Mode> = {
  "ESM nodenext": { ext: "ts", module: "nodenext", moduleResolution: "nodenext", type: "module" },
  "CJS .cts nodenext": { ext: "cts", module: "nodenext", moduleResolution: "nodenext" },
  "CJS node16": { ext: "ts", module: "node16", moduleResolution: "node16" },
  "CJS commonjs + node10": { ext: "ts", module: "commonjs", moduleResolution: "node" },
  "esnext + bundler": { ext: "ts", module: "esnext", moduleResolution: "bundler" },
  "preserve + bundler": { ext: "ts", module: "preserve", moduleResolution: "bundler" },
};

/** The installed compiler packages, and the release each must be. */
const COMPILERS = { typescript: "5.9.3", "typescript-min": "5.4.5" } as const;

const ENTRYPOINTS = [".", "./ai", "./mastra", "./langchain", "./llamaindex", "./next", "./evaluator", "./sandbox-worker"];

function writeMode(name: string, mode: Mode): string {
  const dir = join(DIR, ".run", "types", name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = `agent.${mode.ext}`;
  copyFileSync(join(DIR, "agent.ts"), join(dir, file));
  // Every mode gets a package.json, so the fixture's own cannot decide the
  // format of a mode that expects the other one.
  writeFileSync(join(dir, "package.json"), JSON.stringify(mode.type ? { type: mode.type } : {}));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: mode.module,
        moduleResolution: mode.moduleResolution,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: [file],
    }),
  );
  return dir;
}

function tsc(compiler: string, project: string): string {
  const bin = join(DIR, "node_modules", compiler, "bin", "tsc");
  const result = spawnSync(process.execPath, [bin, "-p", project], { cwd: project, encoding: "utf8" });
  return (result.stdout + result.stderr).trim();
}

describe.each(Object.entries(COMPILERS))("TypeScript %s", (compiler, release) => {
  it(`is ${release}`, () => {
    const manifest = JSON.parse(readFileSync(join(DIR, "node_modules", compiler, "package.json"), "utf8"));
    expect(manifest.version).toBe(release);
  });

  it.each(Object.entries(MODES))("typechecks every entry point as a %s project", (name, mode) => {
    expect(tsc(compiler, writeMode(`${compiler}-${name}`, mode))).toBe("");
  });
});

describe("@arethetypeswrong/cli", () => {
  it("finds no problem in any entry point under any resolution mode", () => {
    const attw = join(DIR, "node_modules", "@arethetypeswrong", "cli", "dist", "index.js");
    // Into a file, not a pipe: attw calls process.exit() straight after
    // writing, which truncates a large report written to a pipe.
    const out = join(DIR, ".run", "attw.json");
    mkdirSync(dirname(out), { recursive: true });
    const fd = openSync(out, "w");
    let result;
    try {
      result = spawnSync(process.execPath, [attw, inject("tarball"), "--format", "json"], {
        cwd: DIR,
        encoding: "utf8",
        stdio: ["ignore", fd, "pipe"],
      });
    } finally {
      closeSync(fd);
    }
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      analysis: {
        entrypoints: Record<string, { resolutions: Record<string, unknown> }>;
        problems: unknown[];
      };
    };
    expect(Object.keys(report.analysis.entrypoints).filter((e) => e !== "./package.json").sort()).toEqual(
      [...ENTRYPOINTS].sort(),
    );
    for (const [entry, { resolutions }] of Object.entries(report.analysis.entrypoints)) {
      expect(Object.keys(resolutions).sort(), entry).toEqual(["bundler", "node10", "node16-cjs", "node16-esm"]);
    }
    expect(report.analysis.problems).toEqual([]);
    expect(result.status, result.stderr).toBe(0);
  });
});
