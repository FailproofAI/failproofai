// @vitest-environment node
/**
 * An install of failproofai resolves nothing by range and runs no
 * third-party install script (FailproofAI/agenteye#1798).
 * `scripts/runtime-deps.mjs` is the gate that keeps it that way: it runs
 * first in `bun run build`, before either release job packs anything.
 *
 * The fixture tests pin each refusal. The last block checks this repository
 * itself, so a pull request that adds a ranged runtime dependency, one with
 * dependencies of its own, or a dependency update that brings an install
 * script, fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import {
  DAEMON_PACKAGES,
  EXACT_VERSION,
  INSTALL_SCRIPTS,
  checkRuntimeDependencies,
  externalsOf,
  packageOf,
  parseBunLock,
} from "../../scripts/runtime-deps.mjs";

const REPO = resolve(__dirname, "../..");
const SHA = "sha512-AAAA";

describe("parseBunLock", () => {
  it("drops trailing commas before a closing bracket, and only there", () => {
    const text = `{
      "a": [1, 2,],
      "b": { "c": "x,}", "d": "y\\",]", },
      "e": ",",
    }`;
    expect(parseBunLock(text)).toEqual({ a: [1, 2], b: { c: "x,}", d: 'y",]' }, e: "," });
  });

  it("reads this repository's bun.lock exactly as a JSONC parser does", () => {
    const text = readFileSync(join(REPO, "bun.lock"), "utf8");
    expect(parseBunLock(text)).toEqual(parseJsonc(text, [], { allowTrailingComma: true }));
  });
});

describe("build-script externals", () => {
  it("names the package each external flag of a bun build leaves out of the bundle", () => {
    expect(packageOf("sql.js/dist/sql-asm.js")).toBe("sql.js");
    expect(packageOf("@posthog/core/dist/x.js")).toBe("@posthog/core");
    expect(
      externalsOf({
        "build:cli":
          "bun build bin/a.mjs --external sql.js --external=@scope/pkg -e yaml/dist/x.js && " +
          `node -e "const fs=require('fs');fs.writeFileSync('dist/a.mjs', 'x')"`,
        "build:worker": "bun build bin/w.mjs --packages=external",
        "build:index": "bun build src/index.ts --packages external && bun run build:cli",
        test: "vitest -e nothing",
      }),
    ).toEqual([
      { name: "sql.js", script: "build:cli" },
      { name: "@scope/pkg", script: "build:cli" },
      { name: "yaml", script: "build:cli" },
      { name: "*", script: "build:worker" },
      { name: "*", script: "build:index" },
    ]);
  });

  it("still reads a bun build that the environment is set for", () => {
    expect(
      externalsOf({
        "build:worker": "NODE_ENV=production bun build bin/w.mjs --external yaml",
        "build:cli": "env FOO=1 BAR=2 bun build bin/a.mjs -e smol-toml && FOO=1 node -e \"require('x')\"",
      }),
    ).toEqual([
      { name: "yaml", script: "build:worker" },
      { name: "smol-toml", script: "build:cli" },
    ]);
  });

  it("reads this repository's build scripts the way bun does", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(externalsOf(pkg.scripts)).toEqual([
      { name: "sql.js", script: "build:cli" },
      { name: "sql.js", script: "build:worker" },
    ]);
  });

  it("accepts exact versions only", () => {
    for (const ok of ["1.17.0", "1.0.18-beta.0", "2.0.0+build.1"]) expect(EXACT_VERSION.test(ok)).toBe(true);
    for (const bad of ["^1.17.0", "~1.17.0", "1.17", "1.x", ">=1.0.0", "latest", "*", "1.17.0 || 1.18.0"]) {
      expect(EXACT_VERSION.test(bad)).toBe(false);
    }
  });
});

describe("checkRuntimeDependencies", () => {
  let root: string;

  /** A bun.lock `packages` entry: [spec, registry, meta, integrity]. */
  const entry = (spec: string, meta: Record<string, unknown> = {}, registry = "") => [spec, registry, meta, SHA];

  /** Writes a fixture repository and returns its root. */
  function fixture(
    {
      pkg = {} as Record<string, unknown>,
      lockDependencies = undefined as Record<string, string> | undefined,
      packages = { lib: entry("lib@1.2.3") } as Record<string, unknown[]>,
      installed = { lib: { name: "lib", version: "1.2.3" } } as Record<string, Record<string, unknown>>,
    } = {},
  ) {
    const manifest: Record<string, any> = {
      name: "fixture",
      version: "9.9.9",
      scripts: { "build:cli": "bun build bin/cli.mjs --external lib" },
      dependencies: { lib: "1.2.3" },
      ...pkg,
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    const lock = {
      lockfileVersion: 1,
      workspaces: { "": { name: "fixture", dependencies: lockDependencies ?? manifest.dependencies ?? {} } },
      packages,
    };
    // With the trailing commas bun itself writes.
    writeFileSync(join(root, "bun.lock"), JSON.stringify(lock, null, 2).replace(/(["\]}\d])\n(\s*[}\]])/g, "$1,\n$2"));
    for (const [path, body] of Object.entries(installed)) {
      const dir = join(root, "node_modules", path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify(body));
    }
    return root;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fp-runtime-deps-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes an exact, dependency-free, script-free runtime dependency", () => {
    expect(checkRuntimeDependencies(fixture())).toEqual([{ name: "lib", version: "1.2.3" }]);
  });

  it("passes a package with no runtime dependencies at all", () => {
    expect(
      checkRuntimeDependencies(fixture({ pkg: { scripts: {}, dependencies: undefined }, packages: {}, installed: {} })),
    ).toEqual([]);
  });

  it("refuses a range", () => {
    expect(() =>
      checkRuntimeDependencies(fixture({ pkg: { dependencies: { lib: "^1.2.3" } }, lockDependencies: { lib: "^1.2.3" } })),
    ).toThrow(/runtime dependency "lib" is "\^1\.2\.3", a range/);
  });

  it.each([
    ["dependencies", { dependencies: { sub: "^1.0.0" } }],
    ["optionalDependencies", { optionalDependencies: { "sub-linux": "1.0.0" } }],
    ["a required peer", { peerDependencies: { sub: "*" } }],
  ])("refuses a runtime dependency with %s of its own", (_label, meta) => {
    expect(() => checkRuntimeDependencies(fixture({ packages: { lib: entry("lib@1.2.3", meta) } }))).toThrow(
      /lib@1\.2\.3 depends on sub(-linux)?, which every install would resolve by range/,
    );
  });

  it("allows an optional peer, which npm does not install", () => {
    const meta = { peerDependencies: { sub: "*" }, optionalPeers: ["sub"] };
    expect(() => checkRuntimeDependencies(fixture({ packages: { lib: entry("lib@1.2.3", meta) } }))).not.toThrow();
  });

  it.each(INSTALL_SCRIPTS)("refuses a runtime dependency with a %s script", (event) => {
    const installed = { lib: { name: "lib", version: "1.2.3", scripts: { [event]: "node steal.js" } } };
    expect(() => checkRuntimeDependencies(fixture({ installed }))).toThrow(
      new RegExp(`lib@1\\.2\\.3 has an install-time script \\(${event}\\)`),
    );
  });

  it("allows scripts npm never runs for an installed package", () => {
    const installed = { lib: { name: "lib", version: "1.2.3", scripts: { prepare: "tsc", test: "vitest" } } };
    expect(() => checkRuntimeDependencies(fixture({ installed }))).not.toThrow();
  });

  it("refuses a binding.gyp, which npm compiles on install, unless gypfile is false", () => {
    const repo = fixture();
    writeFileSync(join(repo, "node_modules", "lib", "binding.gyp"), "{}");
    expect(() => checkRuntimeDependencies(repo)).toThrow(/lib@1\.2\.3 ships a binding\.gyp/);
    writeFileSync(join(repo, "node_modules", "lib", "package.json"), JSON.stringify({ name: "lib", version: "1.2.3", gypfile: false }));
    expect(() => checkRuntimeDependencies(repo)).not.toThrow();
  });

  it("refuses a runtime dependency that is not installed, or installed at another version", () => {
    expect(() => checkRuntimeDependencies(fixture({ installed: {} }))).toThrow(/lib@1\.2\.3 is not installed/);
    expect(() =>
      checkRuntimeDependencies(fixture({ installed: { lib: { name: "lib", version: "1.2.4" } } })),
    ).toThrow(/node_modules holds lib@1\.2\.4/);
  });

  it("refuses a bun.lock that no longer matches package.json", () => {
    expect(() => checkRuntimeDependencies(fixture({ lockDependencies: { lib: "1.2.2" } }))).toThrow(
      /bun\.lock records "lib" as "1\.2\.2"/,
    );
    expect(() => checkRuntimeDependencies(fixture({ packages: { lib: entry("lib@1.2.2") } }))).toThrow(
      /bun\.lock resolves "lib" to lib@1\.2\.2/,
    );
    expect(() => checkRuntimeDependencies(fixture({ packages: {} }))).toThrow(/"lib" is not in bun\.lock/);
  });

  it("refuses a runtime dependency that did not come from the registry with an integrity", () => {
    const packages = { lib: entry("lib@1.2.3", {}, "https://mirror.example/") };
    expect(() => checkRuntimeDependencies(fixture({ packages }))).toThrow(
      /lib@1\.2\.3 is not a registry package with a sha512 integrity/,
    );
  });

  it("refuses a package a bundle leaves external but the install would not carry", () => {
    const pkg = { scripts: { "build:worker": "bun build bin/w.mjs --external lib --external posthog-node" } };
    expect(() => checkRuntimeDependencies(fixture({ pkg }))).toThrow(
      /"posthog-node" is left external by the build:worker script but is not a runtime dependency/,
    );
  });

  it("refuses a build that leaves every package external", () => {
    const pkg = { scripts: { "build:cli": "bun build bin/cli.mjs --external lib", "build:worker": "bun build w.mjs --packages external" } };
    expect(() => checkRuntimeDependencies(fixture({ pkg }))).toThrow(
      /the build:worker script leaves every package external/,
    );
  });

  it.each(INSTALL_SCRIPTS)("refuses a %s script on the package itself", (event) => {
    const pkg = { scripts: { "build:cli": "bun build bin/cli.mjs --external lib", [event]: "node x.js" } };
    expect(() => checkRuntimeDependencies(fixture({ pkg }))).toThrow(new RegExp(`package\\.json has a ${event} script`));
  });

  it("refuses a peer dependency on the package itself", () => {
    expect(() => checkRuntimeDependencies(fixture({ pkg: { peerDependencies: { react: "*" } } }))).toThrow(
      /declares the peer "react"/,
    );
  });

  it("allows only the daemon platform packages as optional dependencies, pinned to this version", () => {
    const pinned = Object.fromEntries(DAEMON_PACKAGES.map((name: string) => [name, "9.9.9"]));
    expect(() => checkRuntimeDependencies(fixture({ pkg: { optionalDependencies: pinned } }))).not.toThrow();

    const stale = { ...pinned, [DAEMON_PACKAGES[0]]: "9.9.8" };
    expect(() => checkRuntimeDependencies(fixture({ pkg: { optionalDependencies: stale } }))).toThrow(
      /pinned to "9\.9\.8", not to this version \(9\.9\.9\)/,
    );
    expect(() =>
      checkRuntimeDependencies(fixture({ pkg: { optionalDependencies: { fsevents: "2.3.3" } } })),
    ).toThrow(/optional dependency "fsevents" would be resolved from the registry/);
  });

  it("fails the build from the command line, including when run through a symlink", () => {
    const repo = fixture({ pkg: { dependencies: { lib: "^1.2.3" } }, lockDependencies: { lib: "^1.2.3" } });
    const link = join(repo, "gate-link.mjs");
    symlinkSync(join(REPO, "scripts", "runtime-deps.mjs"), link);
    for (const script of [join(REPO, "scripts", "runtime-deps.mjs"), link]) {
      const result = spawnSync(process.execPath, [script, "--root", repo], { encoding: "utf8" });
      expect(result.status, script).toBe(1);
      expect(result.stderr).toContain('runtime dependency "lib" is "^1.2.3", a range');
    }
  });
});

describe("this repository", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

  it("installs nothing by range and nothing with an install script", () => {
    const runtime = checkRuntimeDependencies(REPO);
    // Every package a bundle leaves external is shipped as an exact pin...
    for (const { name } of externalsOf(pkg.scripts)) {
      expect(runtime.map((dep: { name: string }) => dep.name)).toContain(name);
    }
    // ...and nothing else is a runtime dependency: what the bundles compile in
    // is a devDependency, resolved once, from bun.lock, at build time.
    expect(runtime.map((dep: { name: string }) => dep.name).sort()).toEqual(
      [...new Set(externalsOf(pkg.scripts).map((e: { name: string }) => e.name))].sort(),
    );
  });

  it("runs the check first in `bun run build`, which both release jobs run before they pack", () => {
    expect(pkg.scripts.build.startsWith("node scripts/runtime-deps.mjs && ")).toBe(true);

    const wf = parseYaml(readFileSync(join(REPO, ".github/workflows/publish.yml"), "utf8"));
    const packing: [string, string][] = [
      ["cli-tarball", "Pack the CLI tarball"],
      ["publish", "Publish"],
    ];
    for (const [job, packStep] of packing) {
      const steps = wf.jobs[job].steps as Record<string, any>[];
      const build = steps.findIndex((s) => String(s.with?.command ?? s.run ?? "").trim() === "bun run build");
      const pack = steps.findIndex((s) => s.name === packStep);
      expect(build, `${job} builds`).toBeGreaterThanOrEqual(0);
      expect(pack, `${job} packs after it builds`).toBeGreaterThan(build);
    }
  });
});
