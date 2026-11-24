// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";

// Same mocks as state-guard.test.ts. The symlink cases below use the real
// synchronous `node:fs` on a temp directory, which these leave alone.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  open: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return { eventType: "PreToolUse", payload: {}, toolName: undefined, toolInput: undefined, ...overrides };
}

const policy = BUILTIN_POLICIES.find((p) => p.name === "block-failproofai-commands")!;

const bash = async (command: string) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command } }))).decision;

const write = async (file_path: string, cwd?: string) =>
  policy.fn(
    makeCtx({
      toolName: "Write",
      toolInput: { file_path, content: "process.exit(0)\n" },
      ...(cwd ? { session: { cwd } } : {}),
    }),
  );

const edit = async (file_path: string) =>
  policy.fn(makeCtx({ toolName: "Edit", toolInput: { file_path, old_string: "deny(", new_string: "allow(" } }));

/** Where the user-scope hook command's `which failproofai` lands, per install method. */
const NVM_PKG = "/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/failproofai";
const INSTALLED_CLI = [
  ["nvm", `${NVM_PKG}/dist/cli.mjs`],
  ["Homebrew node", "/opt/homebrew/lib/node_modules/failproofai/dist/cli.mjs"],
  ["a system npm prefix", "/usr/local/lib/node_modules/failproofai/dist/cli.mjs"],
  ["Volta", "/home/u/.volta/tools/image/packages/failproofai/lib/node_modules/failproofai/dist/cli.mjs"],
  ["bun", "/home/u/.bun/install/global/node_modules/failproofai/dist/cli.mjs"],
  ["the npx cache", "/home/u/.npm/_npx/0a1b2c3d4e5f6789/node_modules/failproofai/dist/cli.mjs"],
  ["pnpm", "/home/u/.local/share/pnpm/global/5/.pnpm/failproofai@1.0.15/node_modules/failproofai/dist/cli.mjs"],
  ["yarn", "/home/u/.config/yarn/global/node_modules/failproofai/dist/cli.mjs"],
  ["a project install (npx)", "/work/proj/node_modules/failproofai/dist/cli.mjs"],
] as const;

/**
 * `block-failproofai-commands` protected failproofai's STATE (`~/.failproofai`)
 * and not the CODE that reads it. User-scope hooks run the absolute path `which
 * failproofai` returned, which for nvm, Homebrew, Volta, bun, pnpm and the npx
 * cache is a package directory the agent's own user can write — and the hook
 * client runs fresh from it on every tool call. Overwriting `dist/cli.mjs` with
 * `process.exit(0)` turns every hook into an allow on the next call, for every
 * session on the machine, and nothing reports it. (FailproofAI/agenteye#1796)
 */
describe("block-failproofai-commands — failproofai's installed code", () => {
  describe("file tools", () => {
    it.each(INSTALLED_CLI)("denies Write over the CLI installed by %s", async (_how, path) => {
      const result = await write(path);
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's installed code/);
    });

    it("denies Edit and NotebookEdit inside the installed package", async () => {
      expect((await edit(`${NVM_PKG}/dist/worker.mjs`)).decision).toBe("deny");
      expect((await edit(`${NVM_PKG}/dist/index.js`)).decision).toBe("deny");
      expect((await edit(`${NVM_PKG}/package.json`)).decision).toBe("deny");
      const notebook = await policy.fn(
        makeCtx({ toolName: "NotebookEdit", toolInput: { notebook_path: `${NVM_PKG}/x.ipynb` } }),
      );
      expect(notebook.decision).toBe("deny");
    });

    // The daemon binary ships as an optional dependency, and `failproofai
    // config` / `update` copies it into place — on Linux as root, under /opt.
    it("denies writing the failproofaid platform package", async () => {
      for (const path of [
        `${NVM_PKG}/node_modules/@failproofai/failproofaid-linux-x64/bin/failproofaid`,
        "/work/proj/node_modules/@failproofai/failproofaid-darwin-arm64/bin/failproofaid",
      ]) {
        expect((await write(path)).decision).toBe("deny");
      }
    });

    // The hook command names the bin entry, not the package: replacing it is
    // the same bypass without touching `node_modules` at all.
    it.each([
      ["nvm", "/home/u/.nvm/versions/node/v22.11.0/bin/failproofai"],
      ["a system npm prefix", "/usr/local/bin/failproofai"],
      ["Homebrew", "/opt/homebrew/bin/failproofai"],
      ["bun", "/home/u/.bun/bin/failproofai"],
      ["Volta", "/home/u/.volta/bin/failproofai"],
      ["yarn", "/home/u/.yarn/bin/failproofai"],
      ["pnpm on Linux", "/home/u/.local/share/pnpm/failproofai"],
      ["pnpm on macOS", "/Users/u/Library/pnpm/failproofai"],
    ])("denies replacing the hook entry point installed by %s", async (_how, path) => {
      expect((await write(path)).decision).toBe("deny");
    });

    // macOS volumes are case-insensitive by default, so every casing of a
    // protected path opens the real file.
    it("matches the protected paths case-insensitively", async () => {
      expect((await write("/Users/u/.nvm/versions/node/v22.11.0/lib/node_modules/FailproofAI/dist/cli.mjs")).decision).toBe("deny");
      expect((await write("/opt/homebrew/bin/FAILPROOFAI")).decision).toBe("deny");
      expect((await write("/Users/u/.FailproofAI/policies-config.json")).decision).toBe("deny");
    });

    it("sees through separators a path resolver collapses", async () => {
      expect((await write("/usr/local/lib/node_modules//failproofai/dist/cli.mjs")).decision).toBe("deny");
      expect((await write("/usr/local/lib/node_modules/./failproofai/dist/cli.mjs")).decision).toBe("deny");
    });

    describe("through links", () => {
      let root: string;
      let pkg: string;

      beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "fpai-guard-"));
        pkg = join(root, "lib", "node_modules", "failproofai");
        mkdirSync(join(pkg, "dist"), { recursive: true });
        writeFileSync(join(pkg, "dist", "cli.mjs"), "// real cli\n");
        mkdirSync(join(root, "elsewhere"), { recursive: true });
        // Neither link's own path says anything about failproofai.
        symlinkSync(join(pkg, "dist", "cli.mjs"), join(root, "elsewhere", "tool.mjs"));
        symlinkSync(pkg, join(root, "elsewhere", "pkg"));
      });

      afterAll(() => {
        rmSync(root, { recursive: true, force: true });
      });

      // A file tool writes THROUGH a symlink, so the path it was given is not
      // the path it changes. npm, nvm and bun all install the bin entry as one.
      it("denies a write whose symlink lands in the installed package", async () => {
        const result = await write(join(root, "elsewhere", "tool.mjs"));
        expect(result.decision).toBe("deny");
        expect(result.reason).toMatch(/failproofai's installed code/);
      });

      it("denies creating a new file under a linked package directory", async () => {
        expect((await write(join(root, "elsewhere", "pkg", "dist", "new-entry.mjs"))).decision).toBe("deny");
      });

      it("resolves a relative path against the session's cwd", async () => {
        expect((await write("elsewhere/tool.mjs", root)).decision).toBe("deny");
      });

      // `path.resolve` and Node's realpathSync collapse `..` as text before they
      // follow links, so this resolved to `elsewhere/dist/cli.mjs` — a path that
      // does not exist — while open(2) follows `pkg` first and writes the CLI.
      // (Template strings, not `join`, which would collapse the `..` right here.)
      it("steps out of a link the way the kernel does, not the way path.resolve does", async () => {
        expect((await write(`${root}/elsewhere/pkg/../failproofai/dist/cli.mjs`)).decision).toBe("deny");
        const viaDist = join(root, "elsewhere", "dist-link");
        symlinkSync(join(pkg, "dist"), viaDist);
        expect((await write(`${viaDist}/../dist/cli.mjs`)).decision).toBe("deny");
        // And the same `..` from a directory that is not a link lands next to it.
        expect((await write(`${root}/elsewhere/../elsewhere/notes.md`)).decision).toBe("allow");
      });

      // A directory that does not exist yet is not where the walk ends: a write
      // tool that runs `mkdir -p` on the parent first creates it, `..` steps back
      // out, and `tool.mjs` is the link into the package (found in review).
      it("walks through a directory that does not exist yet", async () => {
        expect((await write(`${root}/elsewhere/missing/../tool.mjs`)).decision).toBe("deny");
        expect((await write(`${root}/elsewhere/a/b/../../tool.mjs`)).decision).toBe("deny");
        expect((await write(`${root}/elsewhere/missing/../notes.md`)).decision).toBe("allow");
      });

      it("still allows an ordinary file next to the links", async () => {
        expect((await write(join(root, "elsewhere", "notes.md"))).decision).toBe("allow");
      });
    });

    // Tool input is untrusted JSON. A throw from the guard takes it out of the
    // evaluation entirely, so a malformed path must be judged, not crash it.
    it("judges a non-string path instead of throwing", async () => {
      const odd = async (file_path: unknown) =>
        (await policy.fn(makeCtx({ toolName: "Write", toolInput: { file_path, content: "x" }, session: { cwd: "/work/proj" } })))
          .decision;
      expect(await odd(42)).toBe("allow");
      expect(await odd({ path: "/tmp/x" })).toBe("allow");
      expect(await odd(["/usr/local/bin/failproofai"])).toBe("deny");
    });

    // Not a general file-write blocker: the package directory and the bin
    // entry, and nothing that merely carries the name.
    it.each([
      ["a source file in a failproofai checkout", "/home/u/src/failproofai/src/hooks/builtin-policies.ts"],
      ["the checkout's own bin script", "/home/u/src/failproofai/bin/failproofai.mjs"],
      ["the checkout's own build output", "/home/u/src/failproofai/dist/cli.mjs"],
      ["another package's file", "/work/proj/node_modules/react/index.js"],
      ["a package that only shares a prefix", "/work/proj/node_modules/failproofai-extras/index.js"],
      ["the TypeScript SDK", "/work/proj/node_modules/@failproofai/sdk/dist/index.js"],
      ["a project file named after the product", "/work/proj/src/failproofai.ts"],
      ["a project in a directory of that name under bin/", "/home/u/bin/failproofai/src/index.ts"],
    ])("allows writing %s", async (_label, path) => {
      expect((await write(path)).decision).toBe("allow");
    });
  });

  describe("shell commands", () => {
    it.each([
      ["a copy over the CLI", `cp /tmp/x.mjs ${NVM_PKG}/dist/cli.mjs`],
      ["a move over the CLI", `mv /tmp/x.mjs ${NVM_PKG}/dist/cli.mjs`],
      ["a redirect over the CLI", `cat /tmp/x.mjs > ${NVM_PKG}/dist/cli.mjs`],
      ["an in-place sed", `sed -i 's/deny(/allow(/' ${NVM_PKG}/dist/cli.mjs`],
      ["tee into the worker", `tee ${NVM_PKG}/dist/worker.mjs < /tmp/x.mjs`],
      ["removing the package", `rm -rf ${NVM_PKG}`],
      ["an interpreter writing the CLI", `python3 -c "open('${NVM_PKG}/dist/cli.mjs','w').write('')"`],
      ["cd into the package, then delete", `cd ${NVM_PKG} && rm -rf dist`],
      ["a project install", "rm -rf node_modules/failproofai"],
      ["a glob onto a project install", "rm -rf node_modules/fail*"],
      ["a dotted glob onto a project install", "rm -rf ./node_modules/fail*"],
      ["relinking the hook entry", "ln -sf /tmp/evil.sh /home/u/.nvm/versions/node/v22.11.0/bin/failproofai"],
      ["copying over the hook entry", "cp /tmp/evil.sh /usr/local/bin/failproofai"],
      ["installing over the hook entry", "install -m 755 /tmp/evil.sh /home/u/.bun/bin/failproofai"],
      // The variables nvm and pnpm export for the directory the entry lives in.
      ["copying over the entry through $NVM_BIN", 'cp /tmp/evil.sh "$NVM_BIN/failproofai"'],
      ["relinking the entry through ${PNPM_HOME}", "ln -sf /tmp/evil.sh ${PNPM_HOME}/failproofai"],
      // pnpm keeps the package one directory above its own node_modules.
      ["removing pnpm's store entry in a project", "rm -rf node_modules/.pnpm/failproofai@1.0.15"],
      ["removing pnpm's global store entry", "rm -rf /home/u/.local/share/pnpm/global/5/.pnpm/failproofai@1.0.15"],
      ["removing the daemon package from pnpm's store", "rm -rf node_modules/.pnpm/@failproofai+failproofaid-linux-x64@1.0.15"],
      ["a glob onto pnpm's store entry", "rm -rf node_modules/.pnpm/fail*"],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    it.each([
      ["reading the package manifest", `cat ${NVM_PKG}/package.json`],
      ["listing the build", `ls -la ${NVM_PKG}/dist`],
      ["searching the build", "grep -rn block-failproofai-commands node_modules/failproofai/dist"],
      ["hashing the CLI", `sha256sum ${NVM_PKG}/dist/cli.mjs`],
      ["resolving the hook entry", "readlink -f /home/u/.nvm/versions/node/v22.11.0/bin/failproofai"],
      ["backing the package up", "cp -r node_modules/failproofai /tmp/fp-backup"],
      ["a clean reinstall", "rm -rf node_modules && npm ci"],
      ["clearing every dependency", "rm -rf node_modules/*"],
      ["clearing pnpm's whole store", "rm -rf node_modules/.pnpm/*"],
      ["a test run inside a directory of that name under bin/", "vitest run --root /home/u/bin/failproofai/web"],
      ["clearing a build cache", "rm -rf node_modules/.cache"],
      ["removing a checkout of the repo", "rm -rf /home/u/src/failproofai"],
      ["cloning the repo", "git clone https://github.com/FailproofAI/failproofai"],
      ["asking the registry", "npm view failproofai version"],
    ])("allows %s", async (_label, command) => {
      expect(await bash(command)).not.toBe("deny");
    });
  });
});
