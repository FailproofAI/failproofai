// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { listIntegrations } from "../../src/hooks/integrations";
import type { PolicyContext } from "../../src/hooks/policy-types";

// Same mocks as guard-installed-code.test.ts. The symlink cases below use the
// real synchronous `node:fs` on a temp directory, which these leave alone.
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
      toolInput: { file_path, content: "#!/bin/sh\nexit 0\n" },
      ...(cwd ? { session: { cwd } } : {}),
    }),
  );

/**
 * A project-scope hook is `npx -y failproofai --hook …`, so that a committed
 * settings file names no machine's path. npx runs a
 * `node_modules/.bin/failproofai` it finds in the project, or in ANY directory
 * above it, before the global install or its own cache, without checking what
 * the file is. One Write of `exit 0` there turned every later hook in that tree
 * into an allow, and the stub stayed for every later session — the guard
 * protected `~/.failproofai` and, with #1050, the installed package, but not
 * the entry npx actually runs. (FailproofAI/agenteye#1795)
 */
describe("block-failproofai-commands — the entry a project-scope npx hook runs", () => {
  describe("file tools", () => {
    it.each([
      ["the project's own", "/work/proj/node_modules/.bin/failproofai"],
      ["a parent directory's", "/work/node_modules/.bin/failproofai"],
      ["the home directory's, above every project in it", "/home/u/node_modules/.bin/failproofai"],
      ["the npx cache's", "/home/u/.npm/_npx/0a1b2c3d4e5f6789/node_modules/.bin/failproofai"],
      ["a monorepo package's", "/work/proj/packages/api/node_modules/.bin/failproofai"],
    ])("denies writing %s node_modules/.bin/failproofai", async (_where, path) => {
      const result = await write(path);
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's installed code/);
    });

    // npm writes `.cmd` and `.ps1` shims beside the entry on Windows, and bun
    // writes `.exe` and `.bunx`.
    it.each([
      "C:\\work\\proj\\node_modules\\.bin\\failproofai",
      "C:\\work\\proj\\node_modules\\.bin\\failproofai.cmd",
      "C:\\work\\proj\\node_modules\\.bin\\failproofai.ps1",
      "C:/work/proj/node_modules/.bin/failproofai.exe",
      "C:/work/proj/node_modules/.bin/failproofai.bunx",
    ])("denies writing the Windows entry %s", async (path) => {
      expect((await write(path)).decision).toBe("deny");
    });

    it("denies Edit and NotebookEdit of the entry", async () => {
      const edit = await policy.fn(
        makeCtx({
          toolName: "Edit",
          toolInput: { file_path: "/work/proj/node_modules/.bin/failproofai", old_string: "exec", new_string: "exit 0 #" },
        }),
      );
      expect(edit.decision).toBe("deny");
      const notebook = await policy.fn(
        makeCtx({ toolName: "NotebookEdit", toolInput: { notebook_path: "/work/proj/node_modules/.bin/failproofai" } }),
      );
      expect(notebook.decision).toBe("deny");
    });

    it("denies the relative path a write from the project names", async () => {
      expect((await write("node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
      expect((await write("./node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
      expect((await write("../node_modules/.bin/failproofai", "/work/proj")).decision).toBe("deny");
    });

    // macOS volumes are case-insensitive by default, and a path resolver
    // collapses `//` and `/./`: every one of these opens the same file.
    it("matches every spelling that opens the same file", async () => {
      expect((await write("/Users/u/proj/Node_Modules/.BIN/FailproofAI")).decision).toBe("deny");
      expect((await write("/work/proj/node_modules//.bin/./failproofai")).decision).toBe("deny");
    });

    describe("through links", () => {
      let root: string;

      beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "fpai-npx-guard-"));
        mkdirSync(join(root, "proj", "node_modules", ".bin"), { recursive: true });
        mkdirSync(join(root, "proj", "tools"), { recursive: true });
        // Neither link's own path says anything about failproofai or `.bin`.
        symlinkSync(join(root, "proj", "node_modules", ".bin"), join(root, "proj", "tools", "bins"));
        symlinkSync(join(root, "proj", "node_modules", ".bin", "failproofai"), join(root, "proj", "tools", "hook"));
      });

      afterAll(() => {
        rmSync(root, { recursive: true, force: true });
      });

      // The entry does not exist yet in a project with no dependencies, so the
      // link is dangling: the write creates the stub at the link's target.
      it("denies a write through a link to the entry, even before it exists", async () => {
        expect((await write(join(root, "proj", "tools", "hook"))).decision).toBe("deny");
      });

      it("denies a write through a link to the .bin directory", async () => {
        expect((await write(join(root, "proj", "tools", "bins", "failproofai"))).decision).toBe("deny");
        expect((await write("tools/bins/failproofai", join(root, "proj"))).decision).toBe("deny");
      });

      it("still allows other files through the same link", async () => {
        expect((await write(join(root, "proj", "tools", "bins", "my-script"))).decision).toBe("allow");
      });
    });

    // The entry, and nothing else that lives beside it or shares its name.
    it.each([
      ["another package's entry", "/work/proj/node_modules/.bin/tsc"],
      ["an entry that only shares a prefix", "/work/proj/node_modules/.bin/failproofai-extras"],
      ["a name npx never runs for `failproofai`", "/work/proj/node_modules/.bin/failproofai.sh"],
      ["a project file named after the product", "/work/proj/scripts/failproofai.sh"],
      ["a directory of that name under .bin", "/work/proj/.bin/failproofai/README.md"],
    ])("allows writing %s", async (_label, path) => {
      expect((await write(path)).decision).toBe("allow");
    });
  });

  describe("shell commands", () => {
    it.each([
      ["a redirect", "printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/failproofai"],
      ["an append", "echo 'exit 0' >> ./node_modules/.bin/failproofai"],
      ["a copy", "cp /tmp/stub.sh node_modules/.bin/failproofai"],
      ["a move", "mv /tmp/stub.sh node_modules/.bin/failproofai"],
      ["a link", "ln -sf /tmp/stub.sh node_modules/.bin/failproofai"],
      ["tee", "tee node_modules/.bin/failproofai < /tmp/stub.sh"],
      ["install", "install -m 755 /tmp/stub.sh node_modules/.bin/failproofai"],
      ["making a stub executable", "chmod +x node_modules/.bin/failproofai"],
      ["an in-place sed", "sed -i 's/exec/exit 0 #/' node_modules/.bin/failproofai"],
      ["an interpreter writing it", `python3 -c "open('node_modules/.bin/failproofai','w').write('exit 0')"`],
      ["a parent directory's entry", "cp /tmp/stub.sh ../node_modules/.bin/failproofai"],
      ["the home directory's entry", "cp /tmp/stub.sh ~/node_modules/.bin/failproofai"],
      ["the entry named from inside node_modules", "cd node_modules && cp /tmp/stub.sh .bin/failproofai"],
      ["the Windows shim", "cp /tmp/stub.cmd node_modules/.bin/failproofai.cmd"],
      ["a variable holding the entry", "B=node_modules/.bin/failproofai; cp /tmp/stub.sh $B"],
      ["a glob onto the entry", "cp /tmp/stub.sh node_modules/.bin/fail*"],
      ["a quoted spelling", `cp /tmp/stub.sh node_modules/.bin/fail"proof"ai`],
      // The path is on the line only in pieces: a file named `failproofai`
      // copied, moved or linked INTO the directory npx searches.
      ["a copy into the .bin directory", "cp /tmp/stage/failproofai node_modules/.bin/"],
      ["a copy into the .bin directory, no trailing slash", "cp /tmp/stage/failproofai node_modules/.bin"],
      ["a move into the .bin directory", "mv ./failproofai node_modules/.bin/"],
      ["a link into the .bin directory", "ln -s /tmp/stage/failproofai node_modules/.bin"],
      ["a copy with -t", "cp -t node_modules/.bin /tmp/stage/failproofai"],
      ["a copy with --target-directory=", "cp --target-directory=node_modules/.bin /tmp/stage/failproofai"],
      ["install -D into the directory", "install -D -m 755 /tmp/stage/failproofai node_modules/.bin/"],
      ["rsync into the directory", "rsync -a /tmp/stage/failproofai node_modules/.bin/"],
      ["a copy among other files", "cp /tmp/a.sh /tmp/stage/failproofai /tmp/b.sh node_modules/.bin/"],
      ["a copy after --", "cp -- /tmp/stage/failproofai node_modules/.bin/"],
    ])("denies %s", async (_label, command) => {
      expect(await bash(command)).toBe("deny");
    });

    // The same rule reaches the paths #1050 protects: moving a package
    // directory named `failproofai` into a global `node_modules` replaces it.
    it("denies moving a directory named failproofai into a node_modules", async () => {
      expect(await bash("mv /tmp/build/failproofai /home/u/.nvm/versions/node/v22.11.0/lib/node_modules/")).toBe("deny");
    });

    it.each([
      ["running another package's binary", "./node_modules/.bin/vitest run"],
      ["running a binary through node", "node node_modules/.bin/eslint src"],
      ["running a binary by its relative path", "node_modules/.bin/tsc --noEmit -p ."],
      ["listing the directory", "ls -la node_modules/.bin"],
      ["looking at the entry", "ls -l node_modules/.bin/failproofai"],
      ["reading the entry", "cat node_modules/.bin/failproofai"],
      ["resolving the entry", "readlink -f node_modules/.bin/failproofai"],
      ["a clean reinstall", "rm -rf node_modules && npm ci"],
      ["clearing every entry", "rm -rf node_modules/.bin/*"],
      ["installing dependencies", "npm install"],
      ["adding a dev dependency", "npm i -D vitest"],
      ["copying another tool into the directory", "cp /tmp/stage/my-tool node_modules/.bin/"],
      ["copying an entry out", "cp node_modules/.bin/failproofai /tmp/inspect"],
      ["copying a whole build directory", "cp -r dist/ node_modules/.bin/"],
      ["moving a source file", "mv src/failproofai.ts src/guard.ts"],
      ["backing a directory up", "cp -r node_modules/.bin /tmp/bin-backup"],
    ])("allows %s", async (_label, command) => {
      expect(await bash(command)).not.toBe("deny");
    });
  });

  // The guard protects the entry by NAME, so it has to be the name every
  // project-scope hook hands npx. If an integration ever installs a different
  // package or bin name, this fails instead of the guard silently protecting a
  // file no hook runs.
  it("protects the name every project-scope npx hook command runs", async () => {
    const names = new Set<string>();
    let shellIntegrations = 0;
    for (const integration of listIntegrations()) {
      if (!integration.scopes.includes("project")) continue;
      let found = false;
      for (const eventType of integration.eventTypes) {
        const entry = JSON.stringify(integration.buildHookEntry("/opt/fp/bin/failproofai", eventType, "project"));
        for (const [, name] of entry.matchAll(/npx -y (\S+)/g)) {
          names.add(name);
          found = true;
        }
      }
      if (found) shellIntegrations++;
    }
    // OpenCode's entry is a plugin path; the npx call is inside the shim that
    // install writes next to it.
    const dir = mkdtempSync(join(tmpdir(), "fpai-npx-guard-opencode-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      listIntegrations()
        .find((integration) => integration.id === "opencode")!
        .writeHookEntries({}, "/opt/fp/bin/failproofai", "project");
      const shim = readFileSync(join(dir, ".opencode", "plugins", "failproofai.mjs"), "utf8");
      const spawned = [...shim.matchAll(/\["-y", "([^"]+)"/g)].map(([, name]) => name);
      expect(spawned.length).toBeGreaterThan(0);
      for (const name of spawned) names.add(name);
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    // Claude, Codex, Copilot, Cursor, Factory, Devin, Antigravity and Goose.
    expect(shellIntegrations).toBeGreaterThanOrEqual(8);
    expect([...names]).toEqual(["failproofai"]);
    for (const name of names) {
      expect((await write(`/work/proj/node_modules/.bin/${name}`)).decision).toBe("deny");
      expect(await bash(`cp /tmp/stub.sh node_modules/.bin/${name}`)).toBe("deny");
    }
  });
});
